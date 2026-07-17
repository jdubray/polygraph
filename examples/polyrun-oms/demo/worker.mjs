// OMS crash-demo worker — drives one two-fulfillment order end to end:
// submit → fraud → charge (run-demo.mjs SIGKILLs here on run 1) → two
// shipment children spawned → courier signals SHIP+DELIVER on both →
// rollup → completed. Provider ledger must show exactly one charge.
'use strict';

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRuntime } from '../../../polyrun/src/index.mjs';
import { loadConfig } from '../../../polyrun/src/config.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ORDER_ID = 'oms-demo-1';
const say = (msg) => console.log(`[oms-worker ${process.pid}] ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const config = await loadConfig(join(here, '..', 'polyrun.config.mjs'));
const rt = await createRuntime(config);
rt.startWorkers(config.poll ?? {});

const stateDir = process.env.POLYRUN_OMS_DIR;
const ledgerPath = join(stateDir, 'provider-ledger.json');

const { created } = await rt.create('order', ORDER_ID);
say(created ? 'created order (2 fulfillments — warehouses A and B)' : 'resuming existing order');
const submit = await rt.dispatch(ORDER_ID, 'SUBMIT', { fulfillments: 2, totalCents: 4400 }, 'submit:cart-1');
say(`SUBMIT → ${submit.deduped ? 'deduped (already journaled)' : submit.state.orderState}`);

// Wait for fulfilling (fraud + charge ride the effect runner; run 1 dies mid-charge).
const waitFor = async (cond, ms) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await sleep(150);
  }
  return false;
};

if (!(await waitFor(async () => (await rt.getState(ORDER_ID)).state.orderState === 'fulfilling', 20_000))) {
  say(`order stuck in ${(await rt.getState(ORDER_ID)).state.orderState}`);
  process.exit(1);
}
const mid = await rt.getState(ORDER_ID);
say(`order fulfilling (txId=${mid.state.txId}) — ${mid.state.fulfillments} shipment children spawned`);

// Courier: ship + deliver every child.
for (const key of ['f1', 'f2']) {
  const child = await rt.store.findChild(ORDER_ID, key);
  await rt.dispatch(child.instance_id, 'SHIP', {}, `ship:${key}`);
  await rt.dispatch(child.instance_id, 'DELIVER', {}, `deliver:${key}`);
  say(`courier: ${key} shipped + delivered`);
}

await waitFor(async () => (await rt.getState(ORDER_ID)).status === 'terminal', 10_000);

// ---- report ----
const { state, status } = await rt.getState(ORDER_ID);
console.log('\n=== order journal ===');
for (const row of await rt.getJournal(ORDER_ID)) {
  const kind = row.step_kind === 'accepted' ? 'accepted ' : `${row.step_kind} (${row.reject_reason})`;
  console.log(`  #${String(row.seq).padStart(2)} ${row.action.padEnd(20)} ${kind.padEnd(30)} → ${row.post.orderState} (${row.post.shipmentsDelivered}/${row.post.fulfillments})`);
}
const ledger = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, 'utf-8')) : { charges: [], requests: 0 };
console.log('\n=== payment provider ledger ===');
console.log(`  charge requests received : ${ledger.requests}`);
console.log(`  unique charges executed  : ${ledger.charges.length}`);

const ok = status === 'terminal' && state.orderState === 'completed'
  && state.shipmentsDelivered === 2 && state.shipmentsFailed === 0
  && ledger.charges.length === 1;
console.log(`\nRESULT: ${ok ? 'OK' : 'FAILED'} — orderState=${state.orderState}, delivered=${state.shipmentsDelivered}/${state.fulfillments}, uniqueCharges=${ledger.charges.length}`);

rt.stopWorkers();
await rt.close();
process.exit(ok ? 0 : 1);
