// polyrun workers — the effect runner and timer service (spec §5.4, M0
// in-process form).
//
// Both loops are exposed as single deterministic ticks (tickEffects/
// tickTimers) so tests drive them with an explicit clock; start() wraps them
// in intervals for real use.
//
// Ordering rule, everywhere: DISPATCH THE COMPLETION FIRST, MARK THE ROW
// SECOND — on the success path AND the exhausted/permanent-failure paths. A
// crash between the two leaves the row recoverable (inflight → lease expiry
// → re-run with the SAME idempotency key) and the completion dispatch is
// deduped by the kernel (FR-2.3). Marking first would make a crash lose the
// completion forever: dead rows are never revisited, and the machine would
// wait on a decision that already happened.
'use strict';

const MAX_BACKOFF_MS = 60 * 60_000; // cap: an hour between attempts, never more

export class Workers {
  constructor(runtime, { leaseMs = 60_000, batch = 16, defaultRetry = { maxAttempts: 5, baseMs: 500, timeoutMs: 30_000 } } = {}) {
    this.rt = runtime;
    this.leaseMs = leaseMs;
    this.batch = batch;
    this.defaultRetry = defaultRetry;
    this._timers = [];
  }

  start({ effectPollMs = 250, timerPollMs = 250 } = {}) {
    const effectLoop = setInterval(() => { this.tickEffects().catch((e) => this._report(e)); }, effectPollMs);
    const timerLoop = setInterval(() => { try { this.tickTimers(); } catch (e) { this._report(e); } }, timerPollMs);
    effectLoop.unref?.(); timerLoop.unref?.();
    this._timers.push(effectLoop, timerLoop);
  }

  stop() { for (const t of this._timers) clearInterval(t); this._timers = []; }

  _report(err) { console.error('[polyrun worker]', err && err.message); }

  /** The manifest entry for a claimed row, or null when it CANNOT be known —
   *  instance gone, machine unregistered, or kind undeclared. null means
   *  "park, never execute": running a real-world handler whose completion
   *  wiring is unknowable would move money and silently drop the result. */
  _declFor(row) {
    const inst = this.rt.store.getInstance(row.instance_id);
    if (!inst) return null;
    const machine = this.rt.machines.get(inst.machine_id);
    if (!machine || !machine.manifest || !machine.manifest.effects) return null;
    return machine.manifest.effects[row.kind] ?? null;
  }

  _backoff(retry, attempts) {
    const raw = retry.baseMs * 2 ** (attempts - 1) + Math.floor(Math.random() * retry.baseMs * 0.5);
    return Math.min(raw, MAX_BACKOFF_MS);
  }

  async tickEffects(now = this.rt.now()) {
    this.rt.store.recoverExpiredLeases(now);
    const claimed = this.rt.store.claimEffects(now, this.batch, this.leaseMs);
    // allSettled: one effect's failure must never abort its batch-mates.
    const results = await Promise.allSettled(claimed.map((row) => this._runEffect(row, now)));
    for (const r of results) if (r.status === 'rejected') this._report(r.reason);
    return claimed.length;
  }

  async _runEffect(row, now) {
    const decl = this._declFor(row);
    if (decl === null) {
      // Park with a fixed backoff and WITHOUT burning an attempt — this is an
      // operator problem (machine not registered / manifest changed), not an
      // effect failure, and it must stay visible until resolved.
      this.rt.store.markEffectRetry(row.intent_id, row.attempts, now + 30_000,
        `parked: machine/manifest unavailable for effect '${row.kind}' — not executed`);
      return;
    }
    const retry = { ...this.defaultRetry, ...(decl.retry || {}) };
    const handler = this.rt.handlers[row.kind];

    // Re-claimed after a crash that followed exhaustion: don't run the
    // handler yet again — go straight to the (deduped) exhausted completion.
    if (row.attempts >= retry.maxAttempts) {
      return this._finishExhausted(row, decl, row.attempts, row.last_error ?? 'exhausted');
    }

    const attempts = row.attempts + 1;
    let result;
    try {
      if (typeof handler !== 'function') throw new Error(`no handler registered for effect '${row.kind}'`);
      result = await withTimeout(
        Promise.resolve(handler(row.payload, row.intent_id, { instanceId: row.instance_id, seq: row.seq, attempt: attempts })),
        retry.timeoutMs,
        `effect '${row.kind}' timed out after ${retry.timeoutMs}ms`
      );
    } catch (err) {
      const message = String((err && err.message) || err);
      if (attempts >= retry.maxAttempts) {
        return this._finishExhausted(row, decl, attempts, message);
      }
      if (decl.onFailure && decl.onFailure.action && err && err.permanent) {
        // A handler may throw {permanent: true} to short-circuit retries
        // (e.g. card declined — a RESULT, not an infrastructure failure).
        this.rt.dispatch(row.instance_id, decl.onFailure.action,
          mapCompletion(decl.onFailure, { error: err }, { reason: message }), `${row.intent_id}:failed`);
        this.rt.store.markEffectDead(row.intent_id, attempts, message);
        return;
      }
      this.rt.store.markEffectRetry(row.intent_id, attempts, now + this._backoff(retry, attempts), message);
      return;
    }

    // Success: completion first, mark second. A throw from the dispatch (or
    // between the two) leaves the row inflight; lease expiry re-runs the
    // handler (idempotent by contract) and the completion dedupes — the
    // handler's success is never reclassified as an attempt failure.
    if (decl.onSuccess && decl.onSuccess.action) {
      this.rt.dispatch(row.instance_id, decl.onSuccess.action,
        mapCompletion(decl.onSuccess, { result }, result && typeof result === 'object' ? result : {}),
        `${row.intent_id}:done`);
    }
    this.rt.store.markEffectDone(row.intent_id);
  }

  _finishExhausted(row, decl, attempts, message) {
    // DLQ + let VERIFIED logic decide what exhaustion means (FR-3.3).
    // Dispatch first (deduped by :exhausted), mark dead second — a crash in
    // between re-enters here via the attempts>=max fast path and converges.
    const hook = decl.onExhausted || decl.onFailure;
    if (hook && hook.action) {
      this.rt.dispatch(row.instance_id, hook.action,
        mapCompletion(hook, { error: { message } }, { reason: 'exhausted' }), `${row.intent_id}:exhausted`);
    }
    this.rt.store.markEffectDead(row.intent_id, attempts, message);
  }

  tickTimers(now = this.rt.now()) {
    const due = this.rt.store.dueTimers(now, this.batch);
    for (const t of due) {
      // Dispatch first, mark second: a crash in between refires the timer and
      // the kernel dedupes on the timer-derived actionId. Staleness needs no
      // handling here at all — the machine rejects what no longer applies
      // (FR-4.2), observably. Per-timer isolation: one erroring timer (e.g.
      // its machine not registered after a restart) must neither abort the
      // batch nor starve the head of the due queue — defer it and move on.
      try {
        this.rt.dispatch(t.instance_id, t.action, t.data, `timer:${t.timer_id}`);
        this.rt.store.markTimerFired(t.timer_id);
      } catch (err) {
        this._report(err);
        this.rt.store.deferTimer(t.timer_id, now + 5_000);
      }
    }
    return due.length;
  }
}

/** Resolve completion-action data. Precedence: manifest `data` literals,
 *  then `map` entries (dot-paths over {result, error}), else the fallback
 *  (spread of the raw handler result / built reason). */
function mapCompletion(hook, context, fallback) {
  const out = { ...(hook.data || {}) };
  if (hook.map && typeof hook.map === 'object') {
    for (const [field, path] of Object.entries(hook.map)) {
      out[field] = resolvePath(context, path);
    }
    return out;
  }
  return { ...fallback, ...out };
}

function resolvePath(context, path) {
  const clean = String(path).replace(/^\$\.?/, '');
  let v = context;
  for (const part of clean.split('.').filter(Boolean)) {
    if (v == null) return undefined;
    v = v[part];
  }
  return v;
}

function withTimeout(promise, ms, message) {
  let handle;
  const timeout = new Promise((_, reject) => { handle = setTimeout(() => reject(new Error(message)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(handle));
}
