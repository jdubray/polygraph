// OMS crash demo — the reference-app scenario under kill -9:
//   run 1: place a two-warehouse order, SIGKILL the process mid-charge
//   run 2: recover, charge dedupes at the provider, TWO shipment children
//          spawn, courier delivers both, rollup completes the order.
// Run:  node examples/polyrun-oms/demo/run-demo.mjs
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
      env: { ...process.env, POLYRUN_OMS_DIR: stateDir, POLYRUN_OMS_CHARGE_LATENCY_MS: '1500' },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let killed = false;
    child.stdout.on('data', (buf) => {
      const text = buf.toString();
      process.stdout.write(text);
      if (killOnChargeInitiated && !killed && text.includes('CHARGE_INITIATED')) {
        killed = true;
        setTimeout(() => {
          console.log(`\n>>> kill -9 ${child.pid} (mid-charge — completion not yet journaled) <<<`);
          child.kill('SIGKILL');
        }, 400);
      }
    });
    child.on('exit', (code, signal) => resolvePromise({ code, signal, killed }));
  });
}

banner('RUN 1 — place the order, crash mid-charge');
const run1 = await runWorker({ killOnChargeInitiated: true });
console.log(`run 1 ended: ${run1.signal ? `killed (${run1.signal})` : `exit ${run1.code}`}`);

banner('RUN 2 — recover, spawn both shipments, courier delivers, rollup completes');
const run2 = await runWorker({ killOnChargeInitiated: false });

banner('VERDICT');
if (run1.killed && run2.code === 0) {
  console.log('OK: crashed mid-charge; on restart the charge deduped at the provider,');
  console.log('two shipment children spawned atomically, the courier delivered both,');
  console.log('and the rollup completed the order. Exactly one charge.');
} else {
  console.log(`FAILED: run1 killed=${run1.killed}, run2 exit=${run2.code}`);
  process.exitCode = 1;
}
