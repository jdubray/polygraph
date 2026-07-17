// polyrun M3 soak — concurrent dispatch storm (spec §6.3's "Jepsen-style
// concurrent dispatch soak", scaled to CI time).
//
// Shape: many instances, many concurrent dispatchers per instance, duplicate
// actionIds injected on purpose, workers running the whole time. Afterwards,
// the INVARIANTS of the whole system are checked from the durable state
// alone — the properties FR-2 promises under any interleaving:
//   1. per-instance journal seq is dense (0..N, no gaps, no duplicates)
//   2. an actionId appears exactly once per instance
//   3. every accepted step chains: step.pre === previous accepted step.post
//   4. final snapshot === last accepted post
//   5. no instance is poisoned; every completed order charged exactly once
// Run: node --test polyrun/test/soak.test.mjs  (POLYRUN_PG_URL for Postgres)
'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRuntime } from '../src/index.mjs';
import { stable } from '../../scripts/load-spec.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const demo = join(here, '..', 'demo');

const INSTANCES = Number(process.env.POLYRUN_SOAK_INSTANCES ?? 25);
const ROUNDS = Number(process.env.POLYRUN_SOAK_ROUNDS ?? 8);

test(`soak: ${INSTANCES} instances × ${ROUNDS} rounds of racing dispatchers + workers`, async (t) => {
  const charges = new Map(); // idemKey -> count (the provider ledger)
  const rt = await createRuntime({
    store: process.env.POLYRUN_PG_URL
      ? { postgres: process.env.POLYRUN_PG_URL, schema: `polysoak_${process.pid}` }
      : { sqlite: ':memory:' },
    machines: [{
      machineId: 'order',
      module: join(demo, 'order-machine.cjs'),
      contract: join(demo, 'contract.json'),
      effects: { mapper: join(demo, 'effects.cjs'), manifest: join(demo, 'effects.manifest.json') },
    }],
    handlers: {
      fraudCheck: async () => ({ itemsAvailable: Math.random() < 0.8 }),
      chargeCard: async (payload, idemKey) => {
        charges.set(idemKey, (charges.get(idemKey) ?? 0) + 1);
        if (Math.random() < 0.15) throw new Error('flaky provider');
        return { txId: `tx-${idemKey.slice(0, 8)}` };
      },
      dispatchShipment: async () => ({}),
    },
    worker: { leaseMs: 5_000, defaultRetry: { maxAttempts: 8, baseMs: 5, timeoutMs: 2_000 } },
  });
  t.after(() => rt.close());
  rt.startWorkers({ effectPollMs: 10, timerPollMs: 10 });

  const ids = Array.from({ length: INSTANCES }, (_, i) => `soak-${i}`);
  await Promise.all(ids.map((id) => rt.create('order', id)));

  // The storm: every round fires a burst of dispatches per instance
  // CONCURRENTLY — including deliberate duplicate actionIds and actions that
  // are stale/not-applicable. Rejections are results, not errors.
  const safe = (p) => p.catch((err) => { if (err.name !== 'PoisonedError') return { error: err.message }; throw err; });
  for (let round = 0; round < ROUNDS; round++) {
    await Promise.all(ids.flatMap((id, i) => [
      safe(rt.dispatch(id, 'SUBMIT', { totalCents: 2500 }, `${id}:submit`)),
      safe(rt.dispatch(id, 'SUBMIT', { totalCents: 2500 }, `${id}:submit`)), // duplicate
      safe(rt.dispatch(id, 'AMEND', { totalCents: 1900 }, `${id}:amend:${round}`)),
      // only a fifth of the instances get cancel attempts, and only late —
      // most orders must live long enough to exercise charge + shipping
      ...(i % 5 === 0 && round >= ROUNDS - 2
        ? [safe(rt.dispatch(id, 'CANCEL', { reason: 'race' }, `${id}:cancel:${round}`))]
        : []),
      safe(rt.dispatch(id, 'SHIPMENT_DELIVERED', {}, `${id}:sd:${round}`)),
    ]));
    await new Promise((r) => setTimeout(r, 60)); // let workers make progress
  }

  // drain: wait for outbox/timers to settle
  const deadline = Date.now() + 20_000;
  for (;;) {
    const pending = (await Promise.all(ids.map(async (id) =>
      (await rt.store.getOutbox(id)).filter((r) => r.status === 'pending' || r.status === 'inflight').length
    ))).reduce((a, b) => a + b, 0);
    if (pending === 0 || Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  rt.stopWorkers();

  // ---- durable-state invariants ----
  let completed = 0, terminalCount = 0;
  for (const id of ids) {
    const inst = await rt.getState(id);
    assert.notEqual(inst.status, 'poisoned', `${id} poisoned`);
    if (inst.status === 'terminal') terminalCount += 1;

    const journal = await rt.getJournal(id);
    // 1. dense seq
    journal.forEach((row, i) => assert.equal(row.seq, i, `${id}: journal seq gap at ${i}`));
    // 2. actionId unique
    const seen = new Set();
    for (const row of journal) {
      assert.ok(!seen.has(row.action_id), `${id}: duplicate actionId ${row.action_id}`);
      seen.add(row.action_id);
    }
    // 3. accepted steps chain; rejected steps are observable no-ops
    let state = journal[0].post;
    for (const row of journal.slice(1)) {
      assert.equal(stable(row.pre), stable(state), `${id}#${row.seq}: pre does not chain`);
      if (row.step_kind === 'accepted') state = row.post;
      else assert.equal(stable(row.post), stable(row.pre), `${id}#${row.seq}: reject mutated state`);
    }
    // 4. snapshot equals the last accepted post
    assert.equal(stable(inst.state), stable(state), `${id}: snapshot diverged from journal`);

    // 5. completed orders charged exactly once (the whole point)
    if (inst.state.orderState === 'completed' || inst.state.orderState === 'shipping') {
      completed += 1;
      const chargeIntents = (await rt.store.getOutbox(id)).filter((r) => r.kind === 'chargeCard');
      assert.equal(chargeIntents.length, 1, `${id}: ${chargeIntents.length} charge intents emitted`);
    }
  }

  // sanity: the storm actually exercised the system END TO END — a soak
  // where nothing charges is testing the reject path only
  const m = rt.metrics;
  assert.ok(m.dispatches > INSTANCES * ROUNDS, 'storm too small');
  assert.ok(m.deduped > 0, 'duplicate actionIds must have hit the dedupe path');
  assert.ok(m.rejected > 0, 'stale actions must have hit the reject path');
  assert.ok(completed >= INSTANCES / 4, `too few orders reached charge+shipping (${completed}/${INSTANCES}) — workload degenerate`);
  console.log(`  soak: ${m.dispatches} dispatches · ${m.accepted} accepted · ${m.rejected} rejected · ${m.deduped} deduped · ${terminalCount}/${INSTANCES} terminal · ${completed} charged-and-shipping/completed · handler invocations ${[...charges.values()].reduce((a, b) => a + b, 0)}`);
});
