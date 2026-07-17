// Demo worker process — creates the runtime, registers handlers, drives one
// order to completion. run-demo.mjs SIGKILLs this process mid-charge on the
// first run; the second run recovers from the SQLite state and finishes.
//
// The "payment provider" is a JSON-file ledger that dedupes by idempotency
// key — the handler may be invoked twice (crash + lease-expiry retry), but a
// key can only ever be charged once. That is FR-3.2 made visible.
'use strict';

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRuntime } from '../src/index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const stateDir = process.env.POLYRUN_DEMO_DIR || here;
const dbPath = join(stateDir, 'demo.sqlite');
const ledgerPath = join(stateDir, 'provider-ledger.json');
const ORDER_ID = 'order-demo-1';

const say = (msg) => console.log(`[worker ${process.pid}] ${msg}`);

// ---- the external world: a payment provider with idempotency keys ----------

function providerCharge(idemKey, amountCents, attempt) {
  const ledger = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, 'utf-8')) : { charges: [], requests: 0 };
  ledger.requests += 1;
  let charge = ledger.charges.find((c) => c.idemKey === idemKey);
  if (charge) {
    say(`provider: idempotency key already charged (${charge.txId}) — returning existing tx, NOT charging again`);
  } else {
    charge = { idemKey, amountCents, txId: `tx-${ledger.charges.length + 1}-${idemKey.slice(0, 8)}`, attempt };
    ledger.charges.push(charge);
    say(`provider: charged ${amountCents}c → ${charge.txId} (attempt ${attempt})`);
  }
  writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
  return charge;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- runtime ----------------------------------------------------------------

const rt = await createRuntime({
  store: { sqlite: dbPath },
  machines: [{
    machineId: 'order',
    // POLYRUN_MACHINE swaps in an alternative module authored to the same
    // contract (e.g. the polygen-authored one under polygen-out/).
    module: process.env.POLYRUN_MACHINE || join(here, 'order-machine.cjs'),
    contract: join(here, 'contract.json'),
    effects: { mapper: join(here, 'effects.cjs'), manifest: join(here, 'effects.manifest.json') },
  }],
  handlers: {
    fraudCheck: async () => { await sleep(200); return { itemsAvailable: true }; },
    chargeCard: async (payload, idemKey, { attempt }) => {
      // The request reaches the provider (recorded, deduped by key), THEN the
      // "network" is slow — the crash window run-demo.mjs aims for.
      say(`CHARGE_INITIATED key=${idemKey.slice(0, 8)} attempt=${attempt}`);
      const charge = providerCharge(idemKey, payload.amountCents, attempt);
      await sleep(1500);
      return { txId: charge.txId };
    },
    dispatchShipment: async () => { await sleep(200); return {}; },
  },
  // Lease must outlive the slowest handler (1500ms sleep above), or a healthy
  // in-flight effect gets recovered and re-run mid-call — safe (idempotency
  // key dedupes) but noisy.
  worker: { leaseMs: 4000 },
});

rt.startWorkers({ effectPollMs: 150, timerPollMs: 150 });

const { created } = await rt.create('order', ORDER_ID);
say(created ? 'created order instance' : 'resuming existing order instance');
const submit = await rt.dispatch(ORDER_ID, 'SUBMIT', { totalCents: 2500 }, 'submit:cart-42');
say(`SUBMIT → ${submit.deduped ? 'deduped (already journaled)' : submit.state.orderState}`);

// Drive until terminal, then wait for the chargeTimeout timer to fire stale —
// the journal entry it leaves (rejected: stale-timer) is part of the demo.
const deadline = Date.now() + 30_000;
let printedTerminal = false;
while (Date.now() < deadline) {
  const { state, status } = await rt.getState(ORDER_ID);
  if (status !== 'active' && !printedTerminal) {
    printedTerminal = true;
    say(`order reached terminal state: ${state.orderState} (txId=${state.txId || '-'})`);
  }
  if (printedTerminal) {
    const scheduled = await rt.store.getTimers(ORDER_ID, 'scheduled');
    if (scheduled.length === 0) break; // all timers resolved (fired-stale or cancelled)
  }
  await sleep(150);
}

// ---- report -----------------------------------------------------------------

console.log('\n=== journal (the polyrun step log — also a Polygraph trace corpus) ===');
for (const row of await rt.getJournal(ORDER_ID)) {
  const kind = row.step_kind === 'accepted' ? 'accepted ' : `${row.step_kind} (${row.reject_reason})`;
  console.log(`  #${String(row.seq).padStart(2)} ${row.action.padEnd(20)} ${kind.padEnd(32)} → ${row.post.orderState}`);
}

const ledger = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, 'utf-8')) : { charges: [], requests: 0 };
console.log('\n=== payment provider ledger ===');
console.log(`  charge requests received : ${ledger.requests}`);
console.log(`  unique charges executed  : ${ledger.charges.length}`);

const { state, status } = await rt.getState(ORDER_ID);
const ok = status === 'terminal' && state.orderState === 'completed' && ledger.charges.length === 1;
console.log(`\nRESULT: ${ok ? 'OK' : 'FAILED'} — orderState=${state.orderState}, uniqueCharges=${ledger.charges.length}`);

rt.stopWorkers();
await rt.close();
process.exit(ok ? 0 : 1);
