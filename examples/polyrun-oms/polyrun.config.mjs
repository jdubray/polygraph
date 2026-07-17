// polyrun config for the OMS reference app (examples/polyrun-oms).
//   node polyrun/bin/polyrun-api.mjs    --config examples/polyrun-oms/polyrun.config.mjs --workers
//   node polyrun/bin/polyrun.mjs deploy --config examples/polyrun-oms/polyrun.config.mjs
//   node polyrun/bin/polyrun.mjs check-effects --config examples/polyrun-oms/polyrun.config.mjs
'use strict';

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const stateDir = process.env.POLYRUN_OMS_DIR || join(here, '.oms-state');
mkdirSync(stateDir, { recursive: true });
const ledgerPath = join(stateDir, 'provider-ledger.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A payment provider with idempotency keys, persisted across processes so
// the crash demo can prove single-charge across kill -9.
function providerCharge(idemKey, amountCents) {
  const ledger = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, 'utf-8')) : { charges: [], requests: 0 };
  ledger.requests += 1;
  let charge = ledger.charges.find((c) => c.idemKey === idemKey);
  if (!charge) {
    charge = { idemKey, amountCents, txId: `tx-${ledger.charges.length + 1}-${idemKey.slice(0, 8)}` };
    ledger.charges.push(charge);
  }
  writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
  return charge;
}

export default {
  store: process.env.POLYRUN_PG_URL
    ? { postgres: process.env.POLYRUN_PG_URL }
    : { sqlite: join(stateDir, 'oms.sqlite') },
  machines: [
    {
      machineId: 'order',
      module: 'machines/order/next.cjs',
      contract: 'machines/order-contract.json',
      effects: { mapper: 'effects.cjs', manifest: 'effects.manifest.json' },
      invariants: 'effect-invariants.mjs',
      effectInvariants: 'effect-invariants.mjs',
    },
    {
      machineId: 'shipment',
      module: 'machines/shipment/next.cjs',
      contract: 'machines/shipment/authoring-contract.json',
      invariants: 'machines/shipment/invariants.mjs',
    },
  ],
  handlers: {
    fraudCheck: async (payload) => {
      await sleep(150);
      // fixture rule: totals >= $100k are auto-declined by fraud review
      if (payload.totalCents >= 10_000_000) { const e = new Error('fraud-review-declined'); e.permanent = true; throw e; }
      return { itemsAvailable: process.env.POLYRUN_OMS_UNAVAILABLE === '1' ? false : true };
    },
    chargeCard: async (payload, idemKey) => {
      console.log(`CHARGE_INITIATED key=${idemKey.slice(0, 8)}`);
      const charge = providerCharge(idemKey, payload.amountCents);
      await sleep(Number(process.env.POLYRUN_OMS_CHARGE_LATENCY_MS ?? 300));
      return { txId: charge.txId };
    },
  },
  worker: { leaseMs: 5_000 },
  poll: { effectPollMs: 150, timerPollMs: 150 },
};
