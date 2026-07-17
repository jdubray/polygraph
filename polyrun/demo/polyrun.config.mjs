// polyrun config for the OMS demo — used by the M1 bins:
//   node polyrun/bin/polyrun-api.mjs    --config polyrun/demo/polyrun.config.mjs --workers
//   node polyrun/bin/polyrun-worker.mjs --config polyrun/demo/polyrun.config.mjs
//   node polyrun/bin/polyrun.mjs deploy --config polyrun/demo/polyrun.config.mjs
'use strict';

import { resolve } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default {
  store: process.env.POLYRUN_PG_URL
    ? { postgres: process.env.POLYRUN_PG_URL }
    : { sqlite: '.demo-state/demo.sqlite' },
  machines: [{
    machineId: 'order',
    // An env-supplied path is CWD-relative (resolve it here); bare strings in
    // this file are config-file-relative (the loader's rule).
    module: process.env.POLYRUN_MACHINE ? resolve(process.env.POLYRUN_MACHINE) : 'order-machine.cjs',
    contract: 'contract.json',
    effects: { mapper: 'effects.cjs', manifest: 'effects.manifest.json' },
    invariants: 'polygen-out/invariants.mjs',
  }],
  handlers: {
    fraudCheck: async () => { await sleep(200); return { itemsAvailable: true }; },
    chargeCard: async (payload, idemKey) => { await sleep(300); return { txId: `tx-${idemKey.slice(0, 8)}` }; },
    dispatchShipment: async () => { await sleep(200); return {}; },
  },
  worker: { leaseMs: 4000 },
  poll: { effectPollMs: 150, timerPollMs: 150 },
};
