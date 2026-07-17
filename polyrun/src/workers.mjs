// polyrun workers — the effect runner and timer service (spec §5.4, M0
// in-process form).
//
// Both loops are exposed as single deterministic ticks (tickEffects/
// tickTimers) so tests drive them with an explicit clock; start() wraps them
// in intervals for real use. Ordering inside a tick is deliberate:
// handler → completion dispatch → mark done. A crash between any two of
// those re-runs the effect after lease expiry with the SAME idempotency key,
// and the completion dispatch is deduped by the kernel (FR-2.3) — so the
// guarantee is at-least-once execution, effectively-once completion.
'use strict';

export class Workers {
  constructor(runtime, { leaseMs = 30_000, batch = 16, defaultRetry = { maxAttempts: 5, baseMs: 500, timeoutMs: 30_000 } } = {}) {
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

  _manifestFor(instanceId, kind) {
    const inst = this.rt.store.getInstance(instanceId);
    const machine = inst && this.rt.machines.get(inst.machine_id);
    return (machine && machine.manifest && machine.manifest.effects && machine.manifest.effects[kind]) || {};
  }

  async tickEffects(now = this.rt.now()) {
    this.rt.store.recoverExpiredLeases(now);
    const claimed = this.rt.store.claimEffects(now, this.batch, this.leaseMs);
    await Promise.all(claimed.map((row) => this._runEffect(row, now)));
    return claimed.length;
  }

  async _runEffect(row, now) {
    const decl = this._manifestFor(row.instance_id, row.kind);
    const retry = { ...this.defaultRetry, ...(decl.retry || {}) };
    const handler = this.rt.handlers[row.kind];
    const attempts = row.attempts + 1;

    try {
      if (typeof handler !== 'function') throw new Error(`no handler registered for effect '${row.kind}'`);
      const result = await withTimeout(
        Promise.resolve(handler(row.payload, row.intent_id, { instanceId: row.instance_id, seq: row.seq, attempt: attempts })),
        retry.timeoutMs,
        `effect '${row.kind}' timed out after ${retry.timeoutMs}ms`
      );
      if (decl.onSuccess && decl.onSuccess.action) {
        const data = { ...(decl.onSuccess.data || {}), ...(result && typeof result === 'object' ? result : {}) };
        this.rt.dispatch(row.instance_id, decl.onSuccess.action, data, `${row.intent_id}:done`);
      }
      this.rt.store.markEffectDone(row.intent_id);
    } catch (err) {
      const message = String((err && err.message) || err);
      if (attempts >= retry.maxAttempts) {
        // DLQ + let VERIFIED logic decide what exhaustion means (FR-3.3).
        this.rt.store.markEffectDead(row.intent_id, attempts, message);
        const hook = decl.onExhausted || decl.onFailure;
        if (hook && hook.action) {
          this.rt.dispatch(row.instance_id, hook.action, { reason: 'exhausted', ...(hook.data || {}) }, `${row.intent_id}:exhausted`);
        }
      } else if (decl.onFailure && decl.onFailure.action && err && err.permanent) {
        // A handler may throw {permanent: true} to short-circuit retries
        // (e.g. card declined — a RESULT, not an infrastructure failure).
        this.rt.store.markEffectDead(row.intent_id, attempts, message);
        this.rt.dispatch(row.instance_id, decl.onFailure.action, { reason: message, ...(decl.onFailure.data || {}) }, `${row.intent_id}:failed`);
      } else {
        const backoff = retry.baseMs * 2 ** (attempts - 1) + Math.floor(Math.random() * retry.baseMs * 0.5);
        this.rt.store.markEffectRetry(row.intent_id, attempts, now + backoff, message);
      }
    }
  }

  tickTimers(now = this.rt.now()) {
    const due = this.rt.store.dueTimers(now, this.batch);
    for (const t of due) {
      // Dispatch first, mark second: a crash in between refires the timer and
      // the kernel dedupes on the timer-derived actionId. Staleness needs no
      // handling here at all — the machine rejects what no longer applies
      // (FR-4.2), observably.
      this.rt.dispatch(t.instance_id, t.action, t.data, `timer:${t.timer_id}`);
      this.rt.store.markTimerFired(t.timer_id);
    }
    return due.length;
  }
}

function withTimeout(promise, ms, message) {
  let handle;
  const timeout = new Promise((_, reject) => { handle = setTimeout(() => reject(new Error(message)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(handle));
}
