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

let pgSchemaCounter = 0;
async function makeRuntime({ handlers = {}, worker = {}, now } = {}) {
  return createRuntime({
    // Postgres runs (POLYRUN_PG_URL set) isolate each runtime in its own
    // schema, standing in for SQLite's per-runtime ':memory:' database.
    store: process.env.POLYRUN_PG_URL
      ? { postgres: process.env.POLYRUN_PG_URL, schema: `polytest_${process.pid}_${pgSchemaCounter++}` }
      : { sqlite: ':memory:' },
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

/** Poll until an async condition holds (worker ticks are async in M1). */
async function waitFor(cond, { timeoutMs = 2_000, stepMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error('waitFor: condition not met in time');
}

/** Drive an order into 'charging' with externally-dispatched completions. */
async function driveToCharging(rt, id = 'o1') {
  await rt.create('order', id);
  await rt.dispatch(id, 'SUBMIT', { totalCents: 2500 }, 'a1');
  await rt.dispatch(id, 'FRAUD_PASSED', { itemsAvailable: true }, 'a2');
  return id;
}

test('create is idempotent; dispatch dedupes on actionId', async (t) => {
  const rt = await makeRuntime();
  t.after(() => rt.close());

  assert.equal((await rt.create('order', 'o1')).created, true);
  assert.equal((await rt.create('order', 'o1')).created, false);

  const first = await rt.dispatch('o1', 'SUBMIT', { totalCents: 2500 }, 'submit:1');
  assert.equal(first.stepKind, 'accepted');
  assert.equal(first.state.orderState, 'fraudCheck');

  const replay = await rt.dispatch('o1', 'SUBMIT', { totalCents: 9999 }, 'submit:1');
  assert.equal(replay.deduped, true);
  assert.equal(replay.seq, first.seq);
  assert.equal(replay.state.orderState, 'fraudCheck');
  // exactly one journal row despite two dispatches
  assert.equal((await rt.getJournal('o1')).filter((r) => r.action === 'SUBMIT').length, 1);
});

test('a not-applicable action is an observable rejected step: no state change, no effects', async (t) => {
  const rt = await makeRuntime();
  t.after(() => rt.close());
  const id = await driveToCharging(rt);

  const before = (await rt.getState(id)).state;
  const outboxBefore = (await rt.store.getOutbox(id)).length;

  const res = await rt.dispatch(id, 'CANCEL', { reason: 'changed my mind' }, 'c1');
  assert.equal(res.stepKind, 'rejected');
  // contract-anchored reason: the specialRule's name
  assert.equal(res.rejectReason, 'cancel-blocked-while-charging');
  assert.deepEqual((await rt.getState(id)).state, before);
  assert.equal((await rt.store.getOutbox(id)).length, outboxBefore);
  // ... but it IS journaled, with the reason
  const row = (await rt.getJournal(id)).find((r) => r.action === 'CANCEL');
  assert.equal(row.step_kind, 'rejected');
  assert.equal(row.reject_reason, 'cancel-blocked-while-charging');
});

test('a schema-invalid payload is a caller error: observable reject, instance stays healthy', async (t) => {
  const rt = await makeRuntime();
  t.after(() => rt.close());
  const id = await driveToCharging(rt);

  // CANCEL with an empty payload: on a machine with a required 'reason'
  // field this is a SamSchemaError (strict profile); on a loose-schema
  // machine it's an ordinary acceptor reject. Either way the kernel must
  // journal a rejected step and must NOT poison the instance.
  const res = await rt.dispatch(id, 'CANCEL', {}, 'c-empty');
  assert.equal(res.stepKind, 'rejected');
  assert.ok(res.rejectReason);
  assert.equal((await rt.getState(id)).status, 'active');
  assert.equal((await rt.getState(id)).state.orderState, 'charging');
});

test('atomicity: a crash inside commitStep rolls back state, journal, outbox, and timers together', async (t) => {
  const rt = await makeRuntime();
  t.after(() => rt.close());
  await rt.create('order', 'o1');
  await rt.dispatch('o1', 'SUBMIT', { totalCents: 2500 }, 'a1');

  for (const point of ['after-journal', 'after-instance', 'after-outbox']) {
    rt.store.fault = (p) => { if (p === point) throw new Error(`injected crash at ${point}`); };
    await assert.rejects(() => rt.dispatch('o1', 'FRAUD_PASSED', { itemsAvailable: true }, `fp:${point}`), /injected crash/);
    rt.store.fault = null;

    // Nothing from the failed step may be visible: FRAUD_PASSED would move to
    // 'charging' and emit a chargeCard intent + chargeTimeout timer.
    assert.equal((await rt.getState('o1')).state.orderState, 'fraudCheck', `state leaked at ${point}`);
    assert.equal((await rt.getJournal('o1')).some((r) => r.action_id === `fp:${point}`), false, `journal leaked at ${point}`);
    assert.equal((await rt.store.getOutbox('o1')).filter((r) => r.kind === 'chargeCard').length, 0, `outbox leaked at ${point}`);
    assert.equal((await rt.store.getTimers('o1', 'scheduled')).length, 0, `timer leaked at ${point}`);
  }

  // After the faults clear, the same dispatch commits everything at once.
  const res = await rt.dispatch('o1', 'FRAUD_PASSED', { itemsAvailable: true }, 'fp:clean');
  assert.equal(res.state.orderState, 'charging');
  assert.equal((await rt.store.getOutbox('o1')).filter((r) => r.kind === 'chargeCard').length, 1);
  assert.equal((await rt.store.getTimers('o1', 'scheduled')).length, 1);
});

test('effect success dispatches the manifest completion action exactly once', async (t) => {
  let calls = 0;
  const rt = await makeRuntime({
    handlers: {
      fraudCheck: async () => ({ itemsAvailable: true }),
      chargeCard: async (_payload, idemKey) => { calls += 1; return { txId: `tx-${idemKey.slice(0, 6)}` }; },
    },
  });
  t.after(() => rt.close());
  await rt.create('order', 'o1');
  await rt.dispatch('o1', 'SUBMIT', { totalCents: 2500 }, 'a1');

  await rt.workers.tickEffects(); // runs fraudCheck → FRAUD_PASSED → charging (emits chargeCard)
  assert.equal((await rt.getState('o1')).state.orderState, 'charging');
  await rt.workers.tickEffects(); // runs chargeCard → CHARGE_SUCCEEDED → shipping
  assert.equal(calls, 1);
  assert.equal((await rt.getState('o1')).state.orderState, 'shipping');
  assert.match((await rt.getState('o1')).state.txId, /^tx-/);

  // a second tick finds nothing pending and changes nothing
  await rt.workers.tickEffects();
  assert.equal(calls, 1);
  assert.equal((await rt.getState('o1')).state.orderState, 'shipping');
});

test('retry then exhaustion: DLQ + onExhausted lets the machine decide', async (t) => {
  let now = 1_000_000;
  const rt = await makeRuntime({
    now: () => now,
    handlers: { chargeCard: async () => { throw new Error('provider 503'); } },
  });
  t.after(() => rt.close());
  const id = await driveToCharging(rt);

  // manifest: chargeCard maxAttempts 6, baseMs 300 — walk the clock past each backoff
  for (let i = 0; i < 6; i++) {
    await rt.workers.tickEffects(now);
    now += 300 * 2 ** i + 1000;
  }

  // (the fraudCheck intent from SUBMIT also dies here — no handler registered
  // in this test — so filter to the effect under test)
  const dead = (await rt.store.getOutbox(id, 'dead')).filter((r) => r.kind === 'chargeCard');
  assert.equal(dead.length, 1);
  assert.equal(dead[0].attempts, 6);
  assert.match(dead[0].last_error, /provider 503/);
  // onExhausted → CHARGE_FAILED {reason: provider-unavailable} → paymentFailed (terminal)
  const st = await rt.getState(id);
  assert.equal(st.state.orderState, 'paymentFailed');
  assert.equal(st.state.cancelReason, 'provider-unavailable');
  assert.equal(st.status, 'terminal');
});

test('permanent failure short-circuits retries via onFailure', async (t) => {
  const rt = await makeRuntime({
    handlers: {
      chargeCard: async () => {
        const err = new Error('card declined');
        err.permanent = true;
        throw err;
      },
    },
  });
  t.after(() => rt.close());
  const id = await driveToCharging(rt);

  await rt.workers.tickEffects();
  const st = await rt.getState(id);
  assert.equal(st.state.orderState, 'paymentFailed');
  assert.equal(st.state.cancelReason, 'card declined');
  assert.equal((await rt.store.getOutbox(id, 'dead')).length, 1);
});

test('timers: due timer dispatches its action; stale timer is a verified reject', async (t) => {
  let now = 1_000_000;
  const rt = await makeRuntime({ now: () => now, handlers: {} });
  t.after(() => rt.close());
  await rt.create('order', 'o1');
  await rt.dispatch('o1', 'SUBMIT', { totalCents: 2500 }, 'a1');
  await rt.dispatch('o1', 'FRAUD_PASSED', { itemsAvailable: false }, 'a2'); // → awaitingAmend + amendWindow timer

  // not due yet
  assert.equal(await rt.workers.tickTimers(now), 0);

  // customer amends before the window closes → charging (+ chargeTimeout timer)
  await rt.dispatch('o1', 'AMEND', { totalCents: 1900 }, 'a3');
  assert.equal((await rt.getState('o1')).state.orderState, 'charging');

  // the amend-window timer still fires at its scheduled time — and the
  // machine rejects it observably instead of cancelling anything
  now += 9_000;
  assert.equal(await rt.workers.tickTimers(now), 1);
  const stale = (await rt.getJournal('o1')).find((r) => r.action === 'AMEND_WINDOW_EXPIRED');
  assert.equal(stale.step_kind, 'rejected');
  assert.ok(stale.reject_reason, 'stale timer rejection must carry a reason');
  assert.equal((await rt.getState('o1')).state.orderState, 'charging');

  // the charge-timeout timer, fired while still charging, IS applicable
  now += 13_000;
  assert.equal(await rt.workers.tickTimers(now), 1);
  assert.equal((await rt.getState('o1')).state.orderState, 'paymentFailed');
  assert.equal((await rt.getState('o1')).status, 'terminal');
});

test('terminal instances cancel scheduled timers and reject further dispatch', async (t) => {
  const rt = await makeRuntime();
  t.after(() => rt.close());
  await rt.create('order', 'o1');
  await rt.dispatch('o1', 'SUBMIT', { totalCents: 2500 }, 'a1');
  await rt.dispatch('o1', 'FRAUD_PASSED', { itemsAvailable: false }, 'a2'); // awaitingAmend + timer
  assert.equal((await rt.store.getTimers('o1', 'scheduled')).length, 1);

  await rt.dispatch('o1', 'CANCEL', { reason: 'customer-request' }, 'a3'); // terminal
  assert.equal((await rt.getState('o1')).status, 'terminal');
  assert.equal((await rt.store.getTimers('o1', 'scheduled')).length, 0);

  const res = await rt.dispatch('o1', 'SUBMIT', { totalCents: 100 }, 'a4');
  assert.equal(res.stepKind, 'rejected');
  assert.equal(res.rejectReason, 'terminal');
});

test('lease recovery: an inflight effect whose worker died is retried with the same idempotency key', async (t) => {
  let now = 1_000_000;
  const keys = [];
  let fail = true;
  let releaseHang;
  const gate = new Promise((r) => { releaseHang = r; });
  const rt = await makeRuntime({
    now: () => now,
    worker: { leaseMs: 1000 },
    handlers: {
      chargeCard: async (_payload, idemKey) => {
        keys.push(idemKey);
        if (fail) { fail = false; await gate; } // first call hangs ("crashed worker") until the test releases it
        return { txId: 'tx-recovered' };
      },
      dispatchShipment: async () => ({}),
    },
  });
  t.after(() => rt.close());

  const id = await driveToCharging(rt);

  // First tick claims the effect; the handler blocks on the gate (simulated
  // crash holding the lease). Don't await the tick — wait for the claim.
  const hung = rt.workers.tickEffects(now);
  await waitFor(async () => (await rt.store.getOutbox(id, 'inflight')).length === 1);

  // Lease expires; recovery flips it back to pending; the retry succeeds.
  now += 2_000;
  await rt.workers.tickEffects(now);
  assert.equal((await rt.getState(id)).state.orderState, 'shipping');
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1], 'retry must reuse the SAME idempotency key');

  // Unblock the first (stale) run BEFORE the store closes: its completion
  // dispatch dedupes and its fenced markEffectDone is a no-op.
  releaseHang();
  await hung;
});

test('journal exports as Polygraph trace windows', async (t) => {
  const rt = await makeRuntime();
  t.after(() => rt.close());
  const id = await driveToCharging(rt);
  await rt.dispatch(id, 'CANCEL', {}, 'c1'); // rejected — must NOT appear in the trace

  const lines = (await rt.exportTraces(id)).split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 2); // SUBMIT, FRAUD_PASSED
  for (const w of lines) {
    assert.deepEqual(Object.keys(w).sort(), ['action', 'data', 'post', 'pre']);
    assert.equal(typeof w.pre.orderState, 'string');
  }
  assert.equal(lines[1].post.orderState, 'charging');
});

test('unhandled action: journaled as unhandled, no state change, no effects', async (t) => {
  const rt = await makeRuntime();
  t.after(() => rt.close());
  const id = await driveToCharging(rt);
  const res = await rt.dispatch(id, 'NOT_AN_ACTION', {}, 'u1');
  assert.equal(res.stepKind, 'unhandled');
  assert.equal((await rt.getState(id)).state.orderState, 'charging');
  const row = (await rt.getJournal(id)).find((r) => r.action === 'NOT_AN_ACTION');
  assert.equal(row.step_kind, 'unhandled');
});

test('create: journal row 0, idempotent recreate, conflict on different parameters, creation action', async (t) => {
  const rt = await makeRuntime();
  t.after(() => rt.close());

  const first = await rt.create('order', 'o1', { action: 'SUBMIT', data: { totalCents: 2500 } });
  assert.equal(first.created, true);
  assert.equal(first.state.orderState, 'fraudCheck'); // creation action applied

  const journal = await rt.getJournal('o1');
  assert.equal(journal[0].seq, 0);
  assert.equal(journal[0].action, '$create');

  // same parameters → idempotent
  assert.equal((await rt.create('order', 'o1', { action: 'SUBMIT', data: { totalCents: 2500 } })).created, false);
  // different creation parameters → conflict
  await assert.rejects(() => rt.create('order', 'o1', { action: 'SUBMIT', data: { totalCents: 999 } }), ConflictError);
  // unknown creation action → error before anything is written
  await assert.rejects(() => rt.create('order', 'o2', { action: 'NOPE', data: {} }), /creation action 'NOPE'/);
  assert.equal(await rt.store.getInstance('o2'), null);
});

test('dedupe: rejected-step redelivery returns the original result; terminal flag survives dedupe', async (t) => {
  const rt = await makeRuntime();
  t.after(() => rt.close());
  const id = await driveToCharging(rt);

  await rt.dispatch(id, 'CANCEL', { reason: 'x' }, 'c1'); // rejected: cancel-blocked-while-charging
  const replay = await rt.dispatch(id, 'CANCEL', { reason: 'x' }, 'c1');
  assert.equal(replay.deduped, true);
  assert.equal(replay.stepKind, 'rejected');
  assert.equal(replay.rejectReason, 'cancel-blocked-while-charging');

  // drive to terminal, then replay the terminating actionId (crash-after-commit row)
  await rt.dispatch(id, 'CHARGE_SUCCEEDED', { txId: 't1' }, 'cs1');
  const done = await rt.dispatch(id, 'SHIPMENT_DELIVERED', {}, 'sd1');
  assert.equal(done.terminal, true);
  const dedupedDone = await rt.dispatch(id, 'SHIPMENT_DELIVERED', {}, 'sd1');
  assert.equal(dedupedDone.deduped, true);
  assert.equal(dedupedDone.terminal, true, 'deduped replay must not drop the terminal flag');
});

test('actionId reused for a DIFFERENT action is a loud conflict, not a silent no-op', async (t) => {
  const rt = await makeRuntime();
  t.after(() => rt.close());
  const id = await driveToCharging(rt);
  await rt.dispatch(id, 'CHARGE_SUCCEEDED', { txId: 't1' }, 'req-42');
  await assert.rejects(() => rt.dispatch(id, 'CANCEL', { reason: 'x' }, 'req-42'), ConflictError);
});

test('same actionId retried after an injected crash executes fresh (not falsely deduped)', async (t) => {
  const rt = await makeRuntime();
  t.after(() => rt.close());
  await rt.create('order', 'o1');
  await rt.dispatch('o1', 'SUBMIT', { totalCents: 2500 }, 'a1');

  rt.store.fault = (p) => { if (p === 'after-journal') throw new Error('injected'); };
  await assert.rejects(() => rt.dispatch('o1', 'FRAUD_PASSED', { itemsAvailable: true }, 'fp1'), /injected/);
  rt.store.fault = null;

  const res = await rt.dispatch('o1', 'FRAUD_PASSED', { itemsAvailable: true }, 'fp1');
  assert.equal(res.deduped, undefined);
  assert.equal(res.state.orderState, 'charging');
});

test('cancelTimer intent cancels the OLD timer, and cancel-and-rearm in one step keeps the NEW one', async (t) => {
  let now = 1_000_000;
  const rt = await makeRuntime({ now: () => now });
  t.after(() => rt.close());
  await rt.create('order', 'o1');
  await rt.dispatch('o1', 'SUBMIT', { totalCents: 2500 }, 'a1');
  await rt.dispatch('o1', 'FRAUD_PASSED', { itemsAvailable: false }, 'a2'); // awaitingAmend + amendWindow timer
  assert.equal((await rt.store.getTimers('o1', 'scheduled')).length, 1);

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
  await assert.rejects(() => rt.dispatch('o1', 'AMEND', { totalCents: 1900 }, 'am1'), /injected timers crash/);
  rt.store.fault = null;
  assert.equal((await rt.getState('o1')).state.orderState, 'awaitingAmend', 'rollback must undo the step');
  assert.equal((await rt.store.getTimers('o1', 'scheduled')).length, 1, 'rollback must undo timer changes');

  const res = await rt.dispatch('o1', 'AMEND', { totalCents: 1900 }, 'am1');
  assert.equal(res.state.orderState, 'charging');
  const scheduled = await rt.store.getTimers('o1', 'scheduled');
  assert.equal(scheduled.length, 1, 'old timer cancelled, rearmed timer must survive its own step');
  assert.equal(scheduled[0].fire_at, now + 60_000);
});

test('crash between timer dispatch and markTimerFired: refire is deduped', async (t) => {
  let now = 1_000_000;
  const rt = await makeRuntime({ now: () => now });
  t.after(() => rt.close());
  await rt.create('order', 'o1');
  await rt.dispatch('o1', 'SUBMIT', { totalCents: 2500 }, 'a1');
  await rt.dispatch('o1', 'FRAUD_PASSED', { itemsAvailable: false }, 'a2'); // awaitingAmend + timer

  const originalMark = rt.store.markTimerFired.bind(rt.store);
  let failOnce = true;
  rt.store.markTimerFired = (id) => {
    if (failOnce) { failOnce = false; throw new Error('crash before mark'); }
    originalMark(id);
  };
  t.after(() => { rt.store.markTimerFired = originalMark; });

  now += 10_000;
  await rt.workers.tickTimers(now); // dispatches AMEND_WINDOW_EXPIRED, then "crashes" → deferred
  assert.equal((await rt.getState('o1')).state.orderState, 'cancelled');

  now += 10_000;
  await rt.workers.tickTimers(now); // refire: deduped by the kernel, then marked fired
  const expiries = (await rt.getJournal('o1')).filter((r) => r.action === 'AMEND_WINDOW_EXPIRED');
  assert.equal(expiries.length, 1, 'refire must dedupe, not re-execute');
  assert.equal((await rt.store.getTimers('o1', 'scheduled')).length, 0);
});

test('one erroring timer neither aborts its batch-mates nor starves the queue', async (t) => {
  let now = 1_000_000;
  const rt = await makeRuntime({ now: () => now });
  t.after(() => rt.close());
  // instance A: timer whose machine will be unregistered → dispatch throws
  await rt.create('order', 'oa');
  await rt.dispatch('oa', 'SUBMIT', { totalCents: 2500 }, 'a1');
  await rt.dispatch('oa', 'FRAUD_PASSED', { itemsAvailable: false }, 'a2'); // amendWindow timer (fires first)
  // instance B: healthy, later timer
  now += 1_000;
  await rt.create('order', 'ob');
  await rt.dispatch('ob', 'SUBMIT', { totalCents: 2500 }, 'b1');
  await rt.dispatch('ob', 'FRAUD_PASSED', { itemsAvailable: false }, 'b2');

  // sabotage: dispatches to 'oa' throw (simulates unregistered machine)
  const originalDispatch = rt.dispatch.bind(rt);
  rt.dispatch = (id, ...rest) => {
    if (id === 'oa') throw new Error('unregistered machine');
    return originalDispatch(id, ...rest);
  };
  t.after(() => { rt.dispatch = originalDispatch; });

  now += 20_000; // both timers due; oa's sorts first
  await rt.workers.tickTimers(now);
  assert.equal((await rt.getState('ob')).state.orderState, 'cancelled', 'healthy timer must fire despite the erroring one');
  // the erroring timer is deferred, not wedged at the head of every batch
  const oaTimer = (await rt.store.getTimers('oa', 'scheduled'))[0];
  assert.ok(oaTimer.fire_at > now, 'erroring timer must be deferred forward');
});

test('crash between completion dispatch and markEffectDone: handler re-runs, completion dedupes', async (t) => {
  let now = 1_000_000;
  let handlerRuns = 0;
  const rt = await makeRuntime({
    now: () => now,
    worker: { leaseMs: 1_000 },
    handlers: { chargeCard: async () => { handlerRuns += 1; return { txId: 'tx-1' }; } },
  });
  t.after(() => rt.close());
  const id = await driveToCharging(rt);

  const originalDone = rt.store.markEffectDone.bind(rt.store);
  let failOnce = true;
  rt.store.markEffectDone = (intentId) => {
    if (failOnce) { failOnce = false; throw new Error('crash before done'); }
    originalDone(intentId);
  };
  t.after(() => { rt.store.markEffectDone = originalDone; });

  await rt.workers.tickEffects(now); // handler ok, completion journaled, then "crash" → row stays inflight
  assert.equal((await rt.getState(id)).state.orderState, 'shipping');
  assert.equal((await rt.store.getOutbox(id, 'inflight')).filter((r) => r.kind === 'chargeCard').length, 1);

  now += 2_000; // lease expires → recovered → re-claimed → the :done journal
  // fence detects the already-delivered completion and closes the row
  // WITHOUT re-running the handler.
  await rt.workers.tickEffects(now);
  assert.equal(handlerRuns, 1, 'the journal fence must prevent a needless handler re-run');
  assert.equal((await rt.getJournal(id)).filter((r) => r.action === 'CHARGE_SUCCEEDED' && r.step_kind === 'accepted').length, 1,
    'exactly one accepted completion');
  assert.equal((await rt.store.getOutbox(id, 'done')).filter((r) => r.kind === 'chargeCard').length, 1);
});

test('handler timeout counts as an attempt failure and retries', async (t) => {
  let now = 1_000_000;
  let calls = 0;
  const rt = await makeRuntime({
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

  const id = await driveToCharging(rt);
  await rt.workers.tickEffects(now);
  const row = (await rt.store.getOutbox(id)).find((r) => r.kind === 'chargeCard');
  assert.equal(row.status, 'pending');
  assert.match(row.last_error, /timed out/);

  now += 10_000;
  await rt.workers.tickEffects(now);
  assert.equal((await rt.getState(id)).state.orderState, 'shipping');
});

test('parked effect: machine unavailable → handler NOT executed, row stays visible', async (t) => {
  let ran = false;
  const rt = await makeRuntime({ handlers: { chargeCard: async () => { ran = true; return { txId: 't' }; } } });
  t.after(() => rt.close());
  const id = await driveToCharging(rt);

  const machine = rt.machines.get('order');
  rt.machines.delete('order'); // simulate restart without this machine registered
  t.after(() => rt.machines.set('order', machine));

  await rt.workers.tickEffects();
  assert.equal(ran, false, 'a handler must never run when its completion wiring is unknowable');
  const row = (await rt.store.getOutbox(id)).find((r) => r.kind === 'chargeCard');
  assert.equal(row.status, 'pending');
  assert.equal(row.attempts, 0, 'parking must not burn attempts');
  assert.match(row.last_error, /parked/);
});

test('a mid-step module throw poisons the instance and cancels its timers', async (t) => {
  const rt = await makeRuntime();
  t.after(() => rt.close());
  await rt.create('order', 'o1');
  await rt.dispatch('o1', 'SUBMIT', { totalCents: 2500 }, 'a1');
  await rt.dispatch('o1', 'FRAUD_PASSED', { itemsAvailable: false }, 'a2'); // awaitingAmend + scheduled timer
  assert.equal((await rt.store.getTimers('o1', 'scheduled')).length, 1);

  const machine = rt.machines.get('order');
  const original = machine.mod.actions.AMEND;
  machine.mod.actions.AMEND = () => { throw new Error('internal defect'); };
  t.after(() => { machine.mod.actions.AMEND = original; });

  await assert.rejects(() => rt.dispatch('o1', 'AMEND', { totalCents: 1900 }, 'am1'), PoisonedError);
  assert.equal((await rt.getState('o1')).status, 'poisoned');
  assert.equal((await rt.store.getTimers('o1', 'scheduled')).length, 0, 'poisoning must cancel scheduled timers');
});

test('unreadable step classification poisons instead of defaulting to accepted', async (t) => {
  const rt = await makeRuntime();
  t.after(() => rt.close());
  const id = await driveToCharging(rt);

  const machine = rt.machines.get('order');
  const original = machine.mod.instance;
  machine.mod.instance = () => ({ lastStep: () => null });
  t.after(() => { machine.mod.instance = original; });

  await assert.rejects(() => rt.dispatch(id, 'CHARGE_SUCCEEDED', { txId: 't' }, 'x1'), PoisonedError);
  assert.equal((await rt.getState(id)).status, 'poisoned');
  assert.equal((await rt.store.getOutbox(id)).filter((r) => r.kind === 'dispatchShipment').length, 0,
    'no effects may be emitted for an unclassifiable step');
});

test('mapper defects poison: duplicate timer key, malformed duration', async (t) => {
  const rt = await makeRuntime();
  t.after(() => rt.close());
  const machine = rt.machines.get('order');
  const original = machine.mapper;
  t.after(() => { machine.mapper = original; });

  const id1 = await driveToCharging(rt, 'p1');
  machine.mapper = () => [
    { kind: 'timer', key: 'k', fireInMs: 100, action: 'CHARGE_TIMED_OUT', data: {} },
    { kind: 'timer', key: 'k', fireInMs: 200, action: 'CHARGE_TIMED_OUT', data: {} },
  ];
  await assert.rejects(() => rt.dispatch(id1, 'CHARGE_SUCCEEDED', { txId: 't' }, 'x1'), /duplicate timer key/);
  assert.equal((await rt.getState(id1)).status, 'poisoned');

  machine.mapper = original;
  const id2 = await driveToCharging(rt, 'p2');
  machine.mapper = () => [{ kind: 'timer', key: 'k', fireIn: 'garbage', action: 'CHARGE_TIMED_OUT', data: {} }];
  await assert.rejects(() => rt.dispatch(id2, 'CHARGE_SUCCEEDED', { txId: 't' }, 'x2'), /unparseable ISO-8601/);
  assert.equal((await rt.getState(id2)).status, 'poisoned');
});

test('timer durations: fireIn ISO-8601 and fireAt are honored', async (t) => {
  let now = 1_000_000;
  const rt = await makeRuntime({ now: () => now });
  t.after(() => rt.close());
  const machine = rt.machines.get('order');
  const original = machine.mapper;
  machine.mapper = (pre, action, data, post) => (post.orderState === 'charging' && pre.orderState !== 'charging')
    ? [{ kind: 'timer', key: 'iso', fireIn: 'PT2M', action: 'CHARGE_TIMED_OUT', data: {} },
       { kind: 'timer', key: 'abs', fireAt: now + 5_000, action: 'CHARGE_TIMED_OUT', data: {} }]
    : [];
  t.after(() => { machine.mapper = original; });

  const id = await driveToCharging(rt);
  const timers = await rt.store.getTimers(id, 'scheduled');
  assert.equal(timers.find((x) => x.key === 'iso').fire_at, now + 120_000);
  assert.equal(timers.find((x) => x.key === 'abs').fire_at, now + 5_000);
});

test('getStateAt returns historical state; exportTraces throws on unknown instance and skips $create', async (t) => {
  const rt = await makeRuntime();
  t.after(() => rt.close());
  const id = await driveToCharging(rt); // seq1 SUBMIT→fraudCheck, seq2 FRAUD_PASSED→charging

  assert.equal((await rt.getStateAt(id, 0)).orderState, 'pending');
  assert.equal((await rt.getStateAt(id, 1)).orderState, 'fraudCheck');
  assert.equal((await rt.getStateAt(id, 2)).orderState, 'charging');
  await assert.rejects(() => rt.getStateAt('nope', 1), /unknown instance/);
  await assert.rejects(() => rt.exportTraces('nope'), /unknown instance/);
  const lines = (await rt.exportTraces(id)).split('\n').map((l) => JSON.parse(l));
  assert.ok(lines.every((w) => w.action !== '$create'));
});

test('an effect mapper emitting an undeclared kind poisons the instance (domain gate, runtime belt)', async (t) => {
  const rt = await makeRuntime();
  t.after(() => rt.close());
  const id = await driveToCharging(rt, 'o-poison');
  // Sabotage the mapper post-load to emit an undeclared kind.
  const machine = rt.machines.get('order');
  const original = machine.mapper;
  machine.mapper = () => [{ kind: 'launchMissiles', payload: {} }];
  t.after(() => { machine.mapper = original; });

  await assert.rejects(() => rt.dispatch(id, 'CHARGE_SUCCEEDED', { txId: 't' }, 'x1'), PoisonedError);
  assert.equal((await rt.getState(id)).status, 'poisoned');
  // poisoned instances reject observably, never error
  const res = await rt.dispatch(id, 'CHARGE_FAILED', { reason: 'r' }, 'x2');
  assert.equal(res.stepKind, 'rejected');
  assert.equal(res.rejectReason, 'poisoned');
});
