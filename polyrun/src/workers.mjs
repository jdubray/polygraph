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
    const timerLoop = setInterval(() => { this.tickTimers().catch((e) => this._report(e)); }, timerPollMs);
    effectLoop.unref?.(); timerLoop.unref?.();
    this._timers.push(effectLoop, timerLoop);
  }

  stop() { for (const t of this._timers) clearInterval(t); this._timers = []; }

  _report(err) { console.error('[polyrun worker]', err && err.message); }

  /** The manifest entry for a claimed row, or null when it CANNOT be known —
   *  instance gone, machine unregistered, or kind undeclared. null means
   *  "park, never execute": running a real-world handler whose completion
   *  wiring is unknowable would move money and silently drop the result. */
  async _declFor(row) {
    const inst = await this.rt.store.getInstance(row.instance_id);
    if (!inst) return null;
    const machine = this.rt.machines.get(inst.machine_id);
    if (!machine || !machine.manifest || !machine.manifest.effects) return null;
    return machine.manifest.effects[row.kind] ?? null;
  }

  async _journaled(row, suffix) {
    return !!(await this.rt.store.getJournalByActionId(row.instance_id, `${row.intent_id}${suffix}`));
  }

  _backoff(retry, attempts) {
    const raw = retry.baseMs * 2 ** (attempts - 1) + Math.floor(Math.random() * retry.baseMs * 0.5);
    return Math.min(raw, MAX_BACKOFF_MS);
  }

  async tickEffects(now = this.rt.now()) {
    // Overlapping ticks are deliberate: a tick awaits its batch's handlers,
    // so WITHOUT overlap one slow handler would stall every other effect in
    // the process. Overlap is safe because claims are atomic (a claimed row
    // is no longer pending) and the timeout-below-lease clamp in _runEffect
    // guarantees a row is marked before its lease can expire — the same
    // intent cannot be claimed twice while its handler still runs.
    await this.rt.store.recoverExpiredLeases(now);
    const claimed = await this.rt.store.claimEffects(now, this.batch, this.leaseMs);
    // allSettled: one effect's failure must never abort its batch-mates.
    const results = await Promise.allSettled(claimed.map((row) => this._runEffect(row, now)));
    for (const r of results) if (r.status === 'rejected') this._report(r.reason);
    return claimed.length;
  }

  async _runEffect(row, now) {
    const decl = await this._declFor(row);
    if (decl === null) {
      // Park with a fixed backoff and WITHOUT burning an attempt — this is an
      // operator problem (machine not registered / manifest changed), not an
      // effect failure, and it must stay visible until resolved.
      await this.rt.store.markEffectRetry(row.intent_id, row.attempts, now + 30_000,
        `parked: machine/manifest unavailable for effect '${row.kind}' — not executed`);
      return;
    }
    const retry = { ...this.defaultRetry, ...(decl.retry || {}) };
    // A handler outliving its lease converts crash-at-least-once into
    // routinely-concurrently-twice — clamp so the lease always outlives the
    // timeout.
    if (retry.timeoutMs >= this.leaseMs) retry.timeoutMs = Math.max(1, Math.floor(this.leaseMs * 0.8));
    const handler = this.rt.handlers[row.kind];

    // Crash re-entry fences. A completion that was DISPATCHED but whose row
    // mark was lost must converge to the same terminal outcome — never to a
    // second handler run that could deliver a CONTRADICTORY completion
    // (":failed" journaled, crash, retry succeeds, ":done" dispatched).
    if (await this._journaled(row, ':done')) { await this.rt.store.markEffectDone(row.intent_id); return; }
    if (await this._journaled(row, ':failed')) { await this.rt.store.markEffectDead(row.intent_id, row.attempts, row.last_error ?? 'permanent (recovered)'); return; }
    if (row.attempts >= retry.maxAttempts) {
      return this._finishExhausted(row, decl, row.attempts, row.last_error ?? 'exhausted');
    }

    const attempts = row.attempts + 1;
    let result;
    try {
      if (typeof handler !== 'function') throw new Error(`no handler registered for effect '${row.kind}'`);
      // FR-3.6: request/callback is the recommended pattern for long
      // effects; extendLease is the deliberately second-class escape hatch
      // for providers with no callback mechanism. Extending the lease also
      // extends this attempt's timeout budget.
      let extraMs = 0;
      const ctx = {
        instanceId: row.instance_id, seq: row.seq, attempt: attempts,
        extendLease: async (ms) => {
          if (!Number.isFinite(ms) || ms <= 0) throw new Error(`extendLease: ms must be a positive number, got ${ms}`);
          extraMs += ms;
          // Heartbeat semantics: the lease horizon is re-based from NOW on
          // each call (never accumulated into the far future — a crash after
          // many extensions must still be recovered promptly), and never
          // shortened below the base lease.
          await this.rt.store.extendLease(row.intent_id, this.rt.now() + Math.max(this.leaseMs, ms));
        },
      };
      result = await withTimeout(
        Promise.resolve(handler(row.payload, row.intent_id, ctx)),
        retry.timeoutMs,
        `effect '${row.kind}' timed out after ${retry.timeoutMs}ms`,
        () => extraMs
      );
    } catch (err) {
      const message = String((err && err.message) || err);
      if (attempts >= retry.maxAttempts) {
        return this._finishExhausted(row, decl, attempts, message);
      }
      if (decl.onFailure && decl.onFailure.action && err && err.permanent) {
        // A handler may throw {permanent: true} to short-circuit retries
        // (e.g. card declined — a RESULT, not an infrastructure failure).
        await this.rt.dispatch(row.instance_id, decl.onFailure.action,
          mapCompletion(decl.onFailure, { error: err }, { reason: message }), `${row.intent_id}:failed`);
        await this.rt.store.markEffectDead(row.intent_id, attempts, message);
        return;
      }
      await this.rt.store.markEffectRetry(row.intent_id, attempts, now + this._backoff(retry, attempts), message);
      return;
    }

    // Success: completion first, mark second. A throw from the dispatch (or
    // between the two) leaves the row inflight; lease expiry re-runs the
    // handler (idempotent by contract) and the completion dedupes — the
    // handler's success is never reclassified as an attempt failure.
    if (decl.onSuccess && decl.onSuccess.action) {
      await this.rt.dispatch(row.instance_id, decl.onSuccess.action,
        mapCompletion(decl.onSuccess, { result }, result && typeof result === 'object' ? result : {}),
        `${row.intent_id}:done`);
    }
    await this.rt.store.markEffectDone(row.intent_id);
  }

  async _finishExhausted(row, decl, attempts, message) {
    // DLQ + let VERIFIED logic decide what exhaustion means (FR-3.3).
    // Dispatch first (deduped by :exhausted), mark dead second — a crash in
    // between re-enters here via the attempts>=max fast path and converges.
    const hook = decl.onExhausted || decl.onFailure;
    if (hook && hook.action) {
      await this.rt.dispatch(row.instance_id, hook.action,
        mapCompletion(hook, { error: { message } }, { reason: 'exhausted' }), `${row.intent_id}:exhausted`);
    }
    await this.rt.store.markEffectDead(row.intent_id, attempts, message);
  }

  async tickTimers(now = this.rt.now()) {
    if (this._timerTickRunning) return 0;
    this._timerTickRunning = true;
    try {
      return await this._tickTimers(now);
    } finally {
      this._timerTickRunning = false;
    }
  }

  async _tickTimers(now) {
    const due = await this.rt.store.dueTimers(now, this.batch);
    for (const t of due) {
      // Dispatch first, mark second: a crash in between refires the timer and
      // the kernel dedupes on the timer-derived actionId. Staleness needs no
      // handling here at all — the machine rejects what no longer applies
      // (FR-4.2), observably. Per-timer isolation: one erroring timer (e.g.
      // its machine not registered after a restart) must neither abort the
      // batch nor starve the head of the due queue — defer it and move on.
      try {
        await this.rt.dispatch(t.instance_id, t.action, t.data, `timer:${t.timer_id}`);
        await this.rt.store.markTimerFired(t.timer_id);
      } catch (err) {
        this._report(err);
        await this.rt.store.deferTimer(t.timer_id, now + 5_000);
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

function withTimeout(promise, ms, message, extraMs = () => 0) {
  let handle;
  const timeout = new Promise((_, reject) => {
    let consumed = 0;
    const fire = () => {
      // lease extensions granted while running extend the timeout budget
      const banked = extraMs() - consumed;
      if (banked > 0) { consumed += banked; handle = setTimeout(fire, banked); return; }
      reject(new Error(message));
    };
    handle = setTimeout(fire, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(handle));
}
