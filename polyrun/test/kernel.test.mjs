// polyrun M0 kernel tests — node:test, in-memory SQLite, deterministic worker
// ticks (no intervals, no sleeps except where a handler genuinely runs).
// Run: node --test polyrun/test/
'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRuntime, PoisonedError } from '../src/index.mjs';

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
