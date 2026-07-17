// polyrun M0 kernel tests — node:test, in-memory SQLite, deterministic worker
// ticks (no intervals, no sleeps except where a handler genuinely runs).
// Run: node --test polyrun/test/
'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRuntime, PoisonedError, ConflictError } from '../src/index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const demo = join(here, '..', 'demo');

// The machine under test is swappable: POLYRUN_MACHINE=<module path> runs
// this same suite as a conformance harness against any module authored to
// demo/contract.json (e.g. the polygen-authored one). Assertions pin exact
// reject-reason strings only where the contract's specialRules pin them;
// elsewhere they assert the classification, which is what the kernel
// actually depends on.
const machinePath = process.env.POLYRUN_MACHINE
  ? join(process.cwd(), process.env.POLYRUN_MACHINE)
  : join(demo, 'order-machine.cjs');

function makeRuntime({ handlers = {}, worker = {}, now } = {}) {
  return createRuntime({
    dbPath: ':memory:',
    machines: [{
      machineId: 'order',
      module: machinePath,
      contract: join(demo, 'contract.json'),
      effects: { mapper: join(demo, 'effects.cjs'), manifest: join(demo, 'effects.manifest.json') },
    }],
    handlers,
    worker: { leaseMs: 1000, ...worker },
    ...(now ? { now } : {}),
  });
}

/** Drive an order into 'charging' with externally-dispatched completions. */
function driveToCharging(rt, id = 'o1') {
  rt.create('order', id);
  rt.dispatch(id, 'SUBMIT', { totalCents: 2500 }, 'a1');
  rt.dispatch(id, 'FRAUD_PASSED', { itemsAvailable: true }, 'a2');
  return id;
}

test('create is idempotent; dispatch dedupes on actionId', (t) => {
  const rt = makeRuntime();
  t.after(() => rt.close());

  assert.equal(rt.create('order', 'o1').created, true);
  assert.equal(rt.create('order', 'o1').created, false);

  const first = rt.dispatch('o1', 'SUBMIT', { totalCents: 2500 }, 'submit:1');
  assert.equal(first.stepKind, 'accepted');
  assert.equal(first.state.orderState, 'fraudCheck');

  const replay = rt.dispatch('o1', 'SUBMIT', { totalCents: 9999 }, 'submit:1');
  assert.equal(replay.deduped, true);
  assert.equal(replay.seq, first.seq);
  assert.equal(replay.state.orderState, 'fraudCheck');
  // exactly one journal row despite two dispatches
  assert.equal(rt.getJournal('o1').filter((r) => r.action === 'SUBMIT').length, 1);
});

test('a not-applicable action is an observable rejected step: no state change, no effects', (t) => {
  const rt = makeRuntime();
  t.after(() => rt.close());
  const id = driveToCharging(rt);

  const before = rt.getState(id).state;
  const outboxBefore = rt.store.getOutbox(id).length;

  const res = rt.dispatch(id, 'CANCEL', { reason: 'changed my mind' }, 'c1');
  assert.equal(res.stepKind, 'rejected');
  // contract-anchored reason: the specialRule's name
  assert.equal(res.rejectReason, 'cancel-blocked-while-charging');
  assert.deepEqual(rt.getState(id).state, before);
  assert.equal(rt.store.getOutbox(id).length, outboxBefore);
  // ... but it IS journaled, with the reason
  const row = rt.getJournal(id).find((r) => r.action === 'CANCEL');
  assert.equal(row.step_kind, 'rejected');
  assert.equal(row.reject_reason, 'cancel-blocked-while-charging');
});

test('a schema-invalid payload is a caller error: observable reject, instance stays healthy', (t) => {
  const rt = makeRuntime();
  t.after(() => rt.close());
  const id = driveToCharging(rt);

  // CANCEL with an empty payload: on a machine with a required 'reason'
  // field this is a SamSchemaError (strict profile); on a loose-schema
  // machine it's an ordinary acceptor reject. Either way the kernel must
  // journal a rejected step and must NOT poison the instance.
  const res = rt.dispatch(id, 'CANCEL', {}, 'c-empty');
  assert.equal(res.stepKind, 'rejected');
  assert.ok(res.rejectReason);
  assert.equal(rt.getState(id).status, 'active');
  assert.equal(rt.getState(id).state.orderState, 'charging');
});

test('atomicity: a crash inside commitStep rolls back state, journal, outbox, and timers together', (t) => {
  const rt = makeRuntime();
  t.after(() => rt.close());
  rt.create('order', 'o1');
  rt.dispatch('o1', 'SUBMIT', { totalCents: 2500 }, 'a1');

  for (const point of ['after-journal', 'after-instance', 'after-outbox']) {
    rt.store.fault = (p) => { if (p === point) throw new Error(`injected crash at ${point}`); };
    assert.throws(() => rt.dispatch('o1', 'FRAUD_PASSED', { itemsAvailable: true }, `fp:${point}`), /injected crash/);
    rt.store.fault = null;

    // Nothing from the failed step may be visible: FRAUD_PASSED would move to
    // 'charging' and emit a chargeCard intent + chargeTimeout timer.
    assert.equal(rt.getState('o1').state.orderState, 'fraudCheck', `state leaked at ${point}`);
    assert.equal(rt.getJournal('o1').some((r) => r.action_id === `fp:${point}`), false, `journal leaked at ${point}`);
    assert.equal(rt.store.getOutbox('o1').filter((r) => r.kind === 'chargeCard').length, 0, `outbox leaked at ${point}`);
    assert.equal(rt.store.getTimers('o1', 'scheduled').length, 0, `timer leaked at ${point}`);
  }

  // After the faults clear, the same dispatch commits everything at once.
  const res = rt.dispatch('o1', 'FRAUD_PASSED', { itemsAvailable: true }, 'fp:clean');
  assert.equal(res.state.orderState, 'charging');
  assert.equal(rt.store.getOutbox('o1').filter((r) => r.kind === 'chargeCard').length, 1);
  assert.equal(rt.store.getTimers('o1', 'scheduled').length, 1);
});

test('effect success dispatches the manifest completion action exactly once', async (t) => {
  let calls = 0;
  const rt = makeRuntime({
    handlers: {
      fraudCheck: async () => ({ itemsAvailable: true }),
      chargeCard: async (_payload, idemKey) => { calls += 1; return { txId: `tx-${idemKey.slice(0, 6)}` }; },
    },
  });
  t.after(() => rt.close());
  rt.create('order', 'o1');
  rt.dispatch('o1', 'SUBMIT', { totalCents: 2500 }, 'a1');

  await rt.workers.tickEffects(); // runs fraudCheck → FRAUD_PASSED → charging (emits chargeCard)
  assert.equal(rt.getState('o1').state.orderState, 'charging');
  await rt.workers.tickEffects(); // runs chargeCard → CHARGE_SUCCEEDED → shipping
  assert.equal(calls, 1);
  assert.equal(rt.getState('o1').state.orderState, 'shipping');
  assert.match(rt.getState('o1').state.txId, /^tx-/);

  // a second tick finds nothing pending and changes nothing
  await rt.workers.tickEffects();
  assert.equal(calls, 1);
  assert.equal(rt.getState('o1').state.orderState, 'shipping');
});

test('retry then exhaustion: DLQ + onExhausted lets the machine decide', async (t) => {
  let now = 1_000_000;
  const rt = makeRuntime({
    now: () => now,
    handlers: { chargeCard: async () => { throw new Error('provider 503'); } },
  });
  t.after(() => rt.close());
  const id = driveToCharging(rt);

  // manifest: chargeCard maxAttempts 6, baseMs 300 — walk the clock past each backoff
  for (let i = 0; i < 6; i++) {
    await rt.workers.tickEffects(now);
    now += 300 * 2 ** i + 1000;
  }

  // (the fraudCheck intent from SUBMIT also dies here — no handler registered
  // in this test — so filter to the effect under test)
  const dead = rt.store.getOutbox(id, 'dead').filter((r) => r.kind === 'chargeCard');
  assert.equal(dead.length, 1);
  assert.equal(dead[0].attempts, 6);
  assert.match(dead[0].last_error, /provider 503/);
  // onExhausted → CHARGE_FAILED {reason: provider-unavailable} → paymentFailed (terminal)
  const st = rt.getState(id);
  assert.equal(st.state.orderState, 'paymentFailed');
  assert.equal(st.state.cancelReason, 'provider-unavailable');
  assert.equal(st.status, 'terminal');
});

test('permanent failure short-circuits retries via onFailure', async (t) => {
  const rt = makeRuntime({
    handlers: {
      chargeCard: async () => {
        const err = new Error('card declined');
        err.permanent = true;
        throw err;
      },
    },
  });
  t.after(() => rt.close());
  const id = driveToCharging(rt);

  await rt.workers.tickEffects();
  const st = rt.getState(id);
  assert.equal(st.state.orderState, 'paymentFailed');
  assert.equal(st.state.cancelReason, 'card declined');
  assert.equal(rt.store.getOutbox(id, 'dead').length, 1);
});

test('timers: due timer dispatches its action; stale timer is a verified reject', async (t) => {
  let now = 1_000_000;
  const rt = makeRuntime({ now: () => now, handlers: {} });
  t.after(() => rt.close());
  rt.create('order', 'o1');
  rt.dispatch('o1', 'SUBMIT', { totalCents: 2500 }, 'a1');
  rt.dispatch('o1', 'FRAUD_PASSED', { itemsAvailable: false }, 'a2'); // → awaitingAmend + amendWindow timer

  // not due yet
  assert.equal(rt.workers.tickTimers(now), 0);

  // customer amends before the window closes → charging (+ chargeTimeout timer)
  rt.dispatch('o1', 'AMEND', { totalCents: 1900 }, 'a3');
  assert.equal(rt.getState('o1').state.orderState, 'charging');

  // the amend-window timer still fires at its scheduled time — and the
  // machine rejects it observably instead of cancelling anything
  now += 9_000;
  assert.equal(rt.workers.tickTimers(now), 1);
  const stale = rt.getJournal('o1').find((r) => r.action === 'AMEND_WINDOW_EXPIRED');
  assert.equal(stale.step_kind, 'rejected');
  assert.ok(stale.reject_reason, 'stale timer rejection must carry a reason');
  assert.equal(rt.getState('o1').state.orderState, 'charging');

  // the charge-timeout timer, fired while still charging, IS applicable
  now += 13_000;
  assert.equal(rt.workers.tickTimers(now), 1);
  assert.equal(rt.getState('o1').state.orderState, 'paymentFailed');
  assert.equal(rt.getState('o1').status, 'terminal');
});

test('terminal instances cancel scheduled timers and reject further dispatch', (t) => {
  const rt = makeRuntime();
  t.after(() => rt.close());
  rt.create('order', 'o1');
  rt.dispatch('o1', 'SUBMIT', { totalCents: 2500 }, 'a1');
  rt.dispatch('o1', 'FRAUD_PASSED', { itemsAvailable: false }, 'a2'); // awaitingAmend + timer
  assert.equal(rt.store.getTimers('o1', 'scheduled').length, 1);

  rt.dispatch('o1', 'CANCEL', { reason: 'customer-request' }, 'a3'); // terminal
  assert.equal(rt.getState('o1').status, 'terminal');
  assert.equal(rt.store.getTimers('o1', 'scheduled').length, 0);

  const res = rt.dispatch('o1', 'SUBMIT', { totalCents: 100 }, 'a4');
  assert.equal(res.stepKind, 'rejected');
  assert.equal(res.rejectReason, 'terminal');
});

test('lease recovery: an inflight effect whose worker died is retried with the same idempotency key', async (t) => {
  let now = 1_000_000;
  const keys = [];
  let fail = true;
  const rt = makeRuntime({
    now: () => now,
    worker: { leaseMs: 1000 },
    handlers: {
      chargeCard: async (_payload, idemKey) => {
        keys.push(idemKey);
        if (fail) { fail = false; await new Promise(() => {}); } // first call hangs forever ("crashed worker")
        return { txId: 'tx-recovered' };
      },
      dispatchShipment: async () => ({}),
    },
  });
  t.after(() => rt.close());
  const id = driveToCharging(rt);

  // First tick claims the effect; the handler never resolves (simulated crash
  // holding the lease). Don't await it.
  const hung = rt.workers.tickEffects(now);
  assert.equal(rt.store.getOutbox(id, 'inflight').length, 1);

  // Lease expires; recovery flips it back to pending; the retry succeeds.
  now += 2_000;
  await rt.workers.tickEffects(now);
  assert.equal(rt.getState(id).state.orderState, 'shipping');
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1], 'retry must reuse the SAME idempotency key');
  hung.catch(() => {});
});

test('journal exports as Polygraph trace windows', (t) => {
  const rt = makeRuntime();
  t.after(() => rt.close());
  const id = driveToCharging(rt);
  rt.dispatch(id, 'CANCEL', {}, 'c1'); // rejected — must NOT appear in the trace

  const lines = rt.exportTraces(id).split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 2); // SUBMIT, FRAUD_PASSED
  for (const w of lines) {
    assert.deepEqual(Object.keys(w).sort(), ['action', 'data', 'post', 'pre']);
    assert.equal(typeof w.pre.orderState, 'string');
  }
  assert.equal(lines[1].post.orderState, 'charging');
});

test('unhandled action: journaled as unhandled, no state change, no effects', (t) => {
  const rt = makeRuntime();
  t.after(() => rt.close());
  const id = driveToCharging(rt);
  const res = rt.dispatch(id, 'NOT_AN_ACTION', {}, 'u1');
  assert.equal(res.stepKind, 'unhandled');
  assert.equal(rt.getState(id).state.orderState, 'charging');
  const row = rt.getJournal(id).find((r) => r.action === 'NOT_AN_ACTION');
  assert.equal(row.step_kind, 'unhandled');
});

test('create: journal row 0, idempotent recreate, conflict on different parameters, creation action', (t) => {
  const rt = makeRuntime();
  t.after(() => rt.close());

  const first = rt.create('order', 'o1', { action: 'SUBMIT', data: { totalCents: 2500 } });
  assert.equal(first.created, true);
  assert.equal(first.state.orderState, 'fraudCheck'); // creation action applied

  const journal = rt.getJournal('o1');
  assert.equal(journal[0].seq, 0);
  assert.equal(journal[0].action, '$create');

  // same parameters → idempotent
  assert.equal(rt.create('order', 'o1', { action: 'SUBMIT', data: { totalCents: 2500 } }).created, false);
  // different creation parameters → conflict
  assert.throws(() => rt.create('order', 'o1', { action: 'SUBMIT', data: { totalCents: 999 } }), ConflictError);
  // unknown creation action → error before anything is written
  assert.throws(() => rt.create('order', 'o2', { action: 'NOPE', data: {} }), /creation action 'NOPE'/);
  assert.equal(rt.store.getInstance('o2'), null);
});

test('dedupe: rejected-step redelivery returns the original result; terminal flag survives dedupe', (t) => {
  const rt = makeRuntime();
  t.after(() => rt.close());
  const id = driveToCharging(rt);

  rt.dispatch(id, 'CANCEL', { reason: 'x' }, 'c1'); // rejected: cancel-blocked-while-charging
  const replay = rt.dispatch(id, 'CANCEL', { reason: 'x' }, 'c1');
  assert.equal(replay.deduped, true);
  assert.equal(replay.stepKind, 'rejected');
  assert.equal(replay.rejectReason, 'cancel-blocked-while-charging');

  // drive to terminal, then replay the terminating actionId (crash-after-commit row)
  rt.dispatch(id, 'CHARGE_SUCCEEDED', { txId: 't1' }, 'cs1');
  const done = rt.dispatch(id, 'SHIPMENT_DELIVERED', {}, 'sd1');
  assert.equal(done.terminal, true);
  const dedupedDone = rt.dispatch(id, 'SHIPMENT_DELIVERED', {}, 'sd1');
  assert.equal(dedupedDone.deduped, true);
  assert.equal(dedupedDone.terminal, true, 'deduped replay must not drop the terminal flag');
});

test('actionId reused for a DIFFERENT action is a loud conflict, not a silent no-op', (t) => {
  const rt = makeRuntime();
  t.after(() => rt.close());
  const id = driveToCharging(rt);
  rt.dispatch(id, 'CHARGE_SUCCEEDED', { txId: 't1' }, 'req-42');
  assert.throws(() => rt.dispatch(id, 'CANCEL', { reason: 'x' }, 'req-42'), ConflictError);
});

test('same actionId retried after an injected crash executes fresh (not falsely deduped)', (t) => {
  const rt = makeRuntime();
  t.after(() => rt.close());
  rt.create('order', 'o1');
  rt.dispatch('o1', 'SUBMIT', { totalCents: 2500 }, 'a1');

  rt.store.fault = (p) => { if (p === 'after-journal') throw new Error('injected'); };
  assert.throws(() => rt.dispatch('o1', 'FRAUD_PASSED', { itemsAvailable: true }, 'fp1'), /injected/);
  rt.store.fault = null;

  const res = rt.dispatch('o1', 'FRAUD_PASSED', { itemsAvailable: true }, 'fp1');
  assert.equal(res.deduped, undefined);
  assert.equal(res.state.orderState, 'charging');
});

test('cancelTimer intent cancels the OLD timer, and cancel-and-rearm in one step keeps the NEW one', (t) => {
  let now = 1_000_000;
  const rt = makeRuntime({ now: () => now });
  t.after(() => rt.close());
  rt.create('order', 'o1');
  rt.dispatch('o1', 'SUBMIT', { totalCents: 2500 }, 'a1');
  rt.dispatch('o1', 'FRAUD_PASSED', { itemsAvailable: false }, 'a2'); // awaitingAmend + amendWindow timer
  assert.equal(rt.store.getTimers('o1', 'scheduled').length, 1);

  // sabotage the mapper: on AMEND, cancel-and-rearm the amendWindow timer
  const machine = rt.machines.get('order');
  const original = machine.mapper;
  machine.mapper = (pre, action) => action === 'AMEND'
    ? [{ kind: 'cancelTimer', key: 'amendWindow' },
       { kind: 'timer', key: 'amendWindow', fireInMs: 60_000, action: 'AMEND_WINDOW_EXPIRED', data: {} }]
    : [];
  t.after(() => { machine.mapper = original; });

  // also exercise the after-timers fault point: first attempt rolls back whole step
  rt.store.fault = (p) => { if (p === 'after-timers') throw new Error('injected timers crash'); };
  assert.throws(() => rt.dispatch('o1', 'AMEND', { totalCents: 1900 }, 'am1'), /injected timers crash/);
  rt.store.fault = null;
  assert.equal(rt.getState('o1').state.orderState, 'awaitingAmend', 'rollback must undo the step');
  assert.equal(rt.store.getTimers('o1', 'scheduled').length, 1, 'rollback must undo timer changes');

  const res = rt.dispatch('o1', 'AMEND', { totalCents: 1900 }, 'am1');
  assert.equal(res.state.orderState, 'charging');
  const scheduled = rt.store.getTimers('o1', 'scheduled');
  assert.equal(scheduled.length, 1, 'old timer cancelled, rearmed timer must survive its own step');
  assert.equal(scheduled[0].fire_at, now + 60_000);
});

test('crash between timer dispatch and markTimerFired: refire is deduped', (t) => {
  let now = 1_000_000;
  const rt = makeRuntime({ now: () => now });
  t.after(() => rt.close());
  rt.create('order', 'o1');
  rt.dispatch('o1', 'SUBMIT', { totalCents: 2500 }, 'a1');
  rt.dispatch('o1', 'FRAUD_PASSED', { itemsAvailable: false }, 'a2'); // awaitingAmend + timer

  const originalMark = rt.store.markTimerFired.bind(rt.store);
  let failOnce = true;
  rt.store.markTimerFired = (id) => {
    if (failOnce) { failOnce = false; throw new Error('crash before mark'); }
    originalMark(id);
  };
  t.after(() => { rt.store.markTimerFired = originalMark; });

  now += 10_000;
  rt.workers.tickTimers(now); // dispatches AMEND_WINDOW_EXPIRED, then "crashes" → deferred
  assert.equal(rt.getState('o1').state.orderState, 'cancelled');

  now += 10_000;
  rt.workers.tickTimers(now); // refire: deduped by the kernel, then marked fired
  const expiries = rt.getJournal('o1').filter((r) => r.action === 'AMEND_WINDOW_EXPIRED');
  assert.equal(expiries.length, 1, 'refire must dedupe, not re-execute');
  assert.equal(rt.store.getTimers('o1', 'scheduled').length, 0);
});

test('one erroring timer neither aborts its batch-mates nor starves the queue', (t) => {
  let now = 1_000_000;
  const rt = makeRuntime({ now: () => now });
  t.after(() => rt.close());
  // instance A: timer whose machine will be unregistered → dispatch throws
  rt.create('order', 'oa');
  rt.dispatch('oa', 'SUBMIT', { totalCents: 2500 }, 'a1');
  rt.dispatch('oa', 'FRAUD_PASSED', { itemsAvailable: false }, 'a2'); // amendWindow timer (fires first)
  // instance B: healthy, later timer
  now += 1_000;
  rt.create('order', 'ob');
  rt.dispatch('ob', 'SUBMIT', { totalCents: 2500 }, 'b1');
  rt.dispatch('ob', 'FRAUD_PASSED', { itemsAvailable: false }, 'b2');

  // sabotage: dispatches to 'oa' throw (simulates unregistered machine)
  const originalDispatch = rt.dispatch.bind(rt);
  rt.dispatch = (id, ...rest) => {
    if (id === 'oa') throw new Error('unregistered machine');
    return originalDispatch(id, ...rest);
  };
  t.after(() => { rt.dispatch = originalDispatch; });

  now += 20_000; // both timers due; oa's sorts first
  rt.workers.tickTimers(now);
  assert.equal(rt.getState('ob').state.orderState, 'cancelled', 'healthy timer must fire despite the erroring one');
  // the erroring timer is deferred, not wedged at the head of every batch
  const oaTimer = rt.store.getTimers('oa', 'scheduled')[0];
  assert.ok(oaTimer.fire_at > now, 'erroring timer must be deferred forward');
});

test('crash between completion dispatch and markEffectDone: handler re-runs, completion dedupes', async (t) => {
  let now = 1_000_000;
  let handlerRuns = 0;
  const rt = makeRuntime({
    now: () => now,
    worker: { leaseMs: 1_000 },
    handlers: { chargeCard: async () => { handlerRuns += 1; return { txId: 'tx-1' }; } },
  });
  t.after(() => rt.close());
  const id = driveToCharging(rt);

  const originalDone = rt.store.markEffectDone.bind(rt.store);
  let failOnce = true;
  rt.store.markEffectDone = (intentId) => {
    if (failOnce) { failOnce = false; throw new Error('crash before done'); }
    originalDone(intentId);
  };
  t.after(() => { rt.store.markEffectDone = originalDone; });

  await rt.workers.tickEffects(now); // handler ok, completion journaled, then "crash" → row stays inflight
  assert.equal(rt.getState(id).state.orderState, 'shipping');
  assert.equal(rt.store.getOutbox(id, 'inflight').filter((r) => r.kind === 'chargeCard').length, 1);

  now += 2_000; // lease expires → recovered → re-claimed → handler re-runs (idempotent)
  await rt.workers.tickEffects(now);
  assert.equal(handlerRuns, 2);
  assert.equal(rt.getJournal(id).filter((r) => r.action === 'CHARGE_SUCCEEDED' && r.step_kind === 'accepted').length, 1,
    'exactly one accepted completion despite the re-run');
  assert.equal(rt.store.getOutbox(id, 'done').filter((r) => r.kind === 'chargeCard').length, 1);
});

test('handler timeout counts as an attempt failure and retries', async (t) => {
  let now = 1_000_000;
  let calls = 0;
  const rt = makeRuntime({
    now: () => now,
    handlers: {
      chargeCard: async () => {
        calls += 1;
        if (calls === 1) await new Promise((r) => setTimeout(r, 300)); // exceeds timeoutMs
        return { txId: 'tx-late' };
      },
    },
  });
  t.after(() => rt.close());
  // narrow the timeout for this test via the manifest default override
  rt.workers.defaultRetry = { maxAttempts: 5, baseMs: 100, timeoutMs: 50 };
  const machine = rt.machines.get('order');
  const savedRetry = machine.manifest.effects.chargeCard.retry;
  machine.manifest.effects.chargeCard.retry = { maxAttempts: 5, baseMs: 100, timeoutMs: 50 };
  t.after(() => { machine.manifest.effects.chargeCard.retry = savedRetry; });

  const id = driveToCharging(rt);
  await rt.workers.tickEffects(now);
  const row = rt.store.getOutbox(id).find((r) => r.kind === 'chargeCard');
  assert.equal(row.status, 'pending');
  assert.match(row.last_error, /timed out/);

  now += 10_000;
  await rt.workers.tickEffects(now);
  assert.equal(rt.getState(id).state.orderState, 'shipping');
});

test('parked effect: machine unavailable → handler NOT executed, row stays visible', async (t) => {
  let ran = false;
  const rt = makeRuntime({ handlers: { chargeCard: async () => { ran = true; return { txId: 't' }; } } });
  t.after(() => rt.close());
  const id = driveToCharging(rt);

  const machine = rt.machines.get('order');
  rt.machines.delete('order'); // simulate restart without this machine registered
  t.after(() => rt.machines.set('order', machine));

  await rt.workers.tickEffects();
  assert.equal(ran, false, 'a handler must never run when its completion wiring is unknowable');
  const row = rt.store.getOutbox(id).find((r) => r.kind === 'chargeCard');
  assert.equal(row.status, 'pending');
  assert.equal(row.attempts, 0, 'parking must not burn attempts');
  assert.match(row.last_error, /parked/);
});

test('a mid-step module throw poisons the instance and cancels its timers', (t) => {
  const rt = makeRuntime();
  t.after(() => rt.close());
  rt.create('order', 'o1');
  rt.dispatch('o1', 'SUBMIT', { totalCents: 2500 }, 'a1');
  rt.dispatch('o1', 'FRAUD_PASSED', { itemsAvailable: false }, 'a2'); // awaitingAmend + scheduled timer
  assert.equal(rt.store.getTimers('o1', 'scheduled').length, 1);

  const machine = rt.machines.get('order');
  const original = machine.mod.actions.AMEND;
  machine.mod.actions.AMEND = () => { throw new Error('internal defect'); };
  t.after(() => { machine.mod.actions.AMEND = original; });

  assert.throws(() => rt.dispatch('o1', 'AMEND', { totalCents: 1900 }, 'am1'), PoisonedError);
  assert.equal(rt.getState('o1').status, 'poisoned');
  assert.equal(rt.store.getTimers('o1', 'scheduled').length, 0, 'poisoning must cancel scheduled timers');
});

test('unreadable step classification poisons instead of defaulting to accepted', (t) => {
  const rt = makeRuntime();
  t.after(() => rt.close());
  const id = driveToCharging(rt);

  const machine = rt.machines.get('order');
  const original = machine.mod.instance;
  machine.mod.instance = () => ({ lastStep: () => null });
  t.after(() => { machine.mod.instance = original; });

  assert.throws(() => rt.dispatch(id, 'CHARGE_SUCCEEDED', { txId: 't' }, 'x1'), PoisonedError);
  assert.equal(rt.getState(id).status, 'poisoned');
  assert.equal(rt.store.getOutbox(id).filter((r) => r.kind === 'dispatchShipment').length, 0,
    'no effects may be emitted for an unclassifiable step');
});

test('mapper defects poison: duplicate timer key, malformed duration', (t) => {
  const rt = makeRuntime();
  t.after(() => rt.close());
  const machine = rt.machines.get('order');
  const original = machine.mapper;
  t.after(() => { machine.mapper = original; });

  const id1 = driveToCharging(rt, 'p1');
  machine.mapper = () => [
    { kind: 'timer', key: 'k', fireInMs: 100, action: 'CHARGE_TIMED_OUT', data: {} },
    { kind: 'timer', key: 'k', fireInMs: 200, action: 'CHARGE_TIMED_OUT', data: {} },
  ];
  assert.throws(() => rt.dispatch(id1, 'CHARGE_SUCCEEDED', { txId: 't' }, 'x1'), /duplicate timer key/);
  assert.equal(rt.getState(id1).status, 'poisoned');

  machine.mapper = original;
  const id2 = driveToCharging(rt, 'p2');
  machine.mapper = () => [{ kind: 'timer', key: 'k', fireIn: 'garbage', action: 'CHARGE_TIMED_OUT', data: {} }];
  assert.throws(() => rt.dispatch(id2, 'CHARGE_SUCCEEDED', { txId: 't' }, 'x2'), /unparseable ISO-8601/);
  assert.equal(rt.getState(id2).status, 'poisoned');
});

test('timer durations: fireIn ISO-8601 and fireAt are honored', (t) => {
  let now = 1_000_000;
  const rt = makeRuntime({ now: () => now });
  t.after(() => rt.close());
  const machine = rt.machines.get('order');
  const original = machine.mapper;
  machine.mapper = (pre, action, data, post) => (post.orderState === 'charging' && pre.orderState !== 'charging')
    ? [{ kind: 'timer', key: 'iso', fireIn: 'PT2M', action: 'CHARGE_TIMED_OUT', data: {} },
       { kind: 'timer', key: 'abs', fireAt: now + 5_000, action: 'CHARGE_TIMED_OUT', data: {} }]
    : [];
  t.after(() => { machine.mapper = original; });

  const id = driveToCharging(rt);
  const timers = rt.store.getTimers(id, 'scheduled');
  assert.equal(timers.find((x) => x.key === 'iso').fire_at, now + 120_000);
  assert.equal(timers.find((x) => x.key === 'abs').fire_at, now + 5_000);
});

test('getStateAt returns historical state; exportTraces throws on unknown instance and skips $create', (t) => {
  const rt = makeRuntime();
  t.after(() => rt.close());
  const id = driveToCharging(rt); // seq1 SUBMIT→fraudCheck, seq2 FRAUD_PASSED→charging

  assert.equal(rt.getStateAt(id, 0).orderState, 'pending');
  assert.equal(rt.getStateAt(id, 1).orderState, 'fraudCheck');
  assert.equal(rt.getStateAt(id, 2).orderState, 'charging');
  assert.throws(() => rt.getStateAt('nope', 1), /unknown instance/);
  assert.throws(() => rt.exportTraces('nope'), /unknown instance/);
  const lines = rt.exportTraces(id).split('\n').map((l) => JSON.parse(l));
  assert.ok(lines.every((w) => w.action !== '$create'));
});

test('an effect mapper emitting an undeclared kind poisons the instance (domain gate, runtime belt)', (t) => {
  const rt = makeRuntime();
  t.after(() => rt.close());
  const id = driveToCharging(rt, 'o-poison');
  // Sabotage the mapper post-load to emit an undeclared kind.
  const machine = rt.machines.get('order');
  const original = machine.mapper;
  machine.mapper = () => [{ kind: 'launchMissiles', payload: {} }];
  t.after(() => { machine.mapper = original; });

  assert.throws(() => rt.dispatch(id, 'CHARGE_SUCCEEDED', { txId: 't' }, 'x1'), PoisonedError);
  assert.equal(rt.getState(id).status, 'poisoned');
  // poisoned instances reject observably, never error
  const res = rt.dispatch(id, 'CHARGE_FAILED', { reason: 'r' }, 'x2');
  assert.equal(res.stepKind, 'rejected');
  assert.equal(res.rejectReason, 'poisoned');
});
