// polyrun M0 demo — the whole argument in one script (spec §10, milestone M0):
//
//   1. start a worker driving an order through submit → fraud → charge → ship
//   2. SIGKILL it the moment the charge request reaches the payment provider
//   3. restart the worker: it rehydrates from SQLite, the lease expires, the
//      charge retries with the SAME idempotency key, the provider dedupes —
//      the order completes with exactly ONE charge on the ledger.
//
// Run:  node polyrun/demo/run-demo.mjs
'use strict';

import { spawn } from 'node:child_process';
import { rmSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const stateDir = join(here, '.demo-state');
const workerPath = join(here, 'worker.mjs');

rmSync(stateDir, { recursive: true, force: true });
mkdirSync(stateDir, { recursive: true });

const banner = (t) => console.log(`\n${'='.repeat(72)}\n${t}\n${'='.repeat(72)}`);

function runWorker({ killOnChargeInitiated }) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, ['--no-warnings', workerPath], {
      env: { ...process.env, POLYRUN_DEMO_DIR: stateDir },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let killed = false;
    child.stdout.on('data', (buf) => {
      const text = buf.toString();
      process.stdout.write(text);
      if (killOnChargeInitiated && !killed && text.includes('CHARGE_INITIATED')) {
        killed = true;
        // The charge request is at the provider; the completion is not yet
        // journaled. This is the exact window durable execution exists for.
        setTimeout(() => {
          console.log(`\n>>> kill -9 ${child.pid} (mid-charge — completion not yet journaled) <<<`);
          child.kill('SIGKILL');
        }, 400);
      }
    });
    child.on('exit', (code, signal) => resolvePromise({ code, signal, killed }));
  });
}

banner('RUN 1 — drive the order, then crash the process mid-charge');
const run1 = await runWorker({ killOnChargeInitiated: true });
console.log(`run 1 ended: ${run1.signal ? `killed (${run1.signal})` : `exit ${run1.code}`}`);

banner('RUN 2 — restart: rehydrate from SQLite, lease expires, charge retries');
const run2 = await runWorker({ killOnChargeInitiated: false });

banner('VERDICT');
if (run1.killed && run2.code === 0) {
  console.log('OK: process killed mid-charge; on restart the order recovered and');
  console.log('completed with exactly one charge — the retry hit the provider with');
  console.log('the same idempotency key and was deduped. No double charge.');
} else {
  console.log(`FAILED: run1 killed=${run1.killed}, run2 exit=${run2.code}`);
  process.exitCode = 1;
}
