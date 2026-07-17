// polyrun NFR-1 benchmark — dispatch throughput and latency.
//
//   node polyrun/bench/bench.mjs [--instances 200] [--steps 2000] [--pg <url>]
//
// Measures the kernel's write path only (no workers): create N instances,
// then drive `steps` accepted dispatches round-robin, concurrently (bounded).
// Reports steps/s and latency percentiles. NFR-1 target: >=500 accepted
// steps/s sustained on server-class Postgres; SQLite numbers are for the
// single-process embedded shape.
'use strict';

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRuntime } from '../src/index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const demo = join(here, '..', 'demo');
const args = process.argv.slice(2);
const flag = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };

const INSTANCES = Number(flag('instances', 200));
const STEPS = Number(flag('steps', 2000));
const CONCURRENCY = Number(flag('concurrency', 16));
const PG = flag('pg', process.env.POLYRUN_PG_URL);

const dir = mkdtempSync(join(tmpdir(), 'polyrun-bench-'));
const rt = await createRuntime({
  store: PG ? { postgres: PG, schema: `polybench_${process.pid}` } : { sqlite: join(dir, 'bench.sqlite') },
  machines: [{
    machineId: 'order',
    module: join(demo, 'order-machine.cjs'),
    contract: join(demo, 'contract.json'),
    // no effects: measure the pure dispatch write path
  }],
  handlers: {},
});

console.log(`store: ${PG ? 'postgres' : 'sqlite (file, WAL)'} · instances: ${INSTANCES} · steps: ${STEPS} · concurrency: ${CONCURRENCY}`);

const ids = Array.from({ length: INSTANCES }, (_, i) => `bench-${i}`);
await Promise.all(ids.map((id) => rt.create('order', id)));

// Alternate SUBMIT-like accepted steps: the order machine accepts SUBMIT once,
// then we ping-pong CANCEL-rejects... instead drive FRAUD flow legitimately:
// SUBMIT once per instance, then alternate CHARGE/AMEND cycles are not
// possible — use the always-accepted pair on fresh sub-ids instead: each step
// dispatches SUBMIT to a FRESH instance id? That measures create+dispatch.
// Simplest sustained-accept workload: rotate instances through
// SUBMIT → FRAUD_PASSED(false) → AMEND → CHARGE_FAILED (terminal in 4 steps),
// creating replacements as instances terminate.
const latencies = [];
let dispatched = 0;
let cursor = 0;
const script = [
  ['SUBMIT', { totalCents: 2500 }],
  ['FRAUD_PASSED', { itemsAvailable: false }],
  ['AMEND', { totalCents: 1900 }],
  ['CHARGE_FAILED', { reason: 'bench' }],
];
const progress = new Map(ids.map((id) => [id, 0]));

async function pump() {
  while (dispatched < STEPS) {
    const id = ids[cursor % ids.length];
    cursor += 1;
    let step = progress.get(id) ?? 0;
    if (step >= script.length) {
      const fresh = `bench-${ids.length + cursor}`;
      ids[ids.indexOf(id)] = fresh;
      await rt.create('order', fresh);
      progress.set(fresh, 0);
      continue;
    }
    progress.set(id, step + 1);
    const [action, data] = script[step];
    const t0 = process.hrtime.bigint();
    await rt.dispatch(id, action, data, `${id}:${step}`);
    latencies.push(Number(process.hrtime.bigint() - t0) / 1e6);
    dispatched += 1;
  }
}

const started = Date.now();
await Promise.all(Array.from({ length: CONCURRENCY }, () => pump()));
const elapsed = (Date.now() - started) / 1000;

latencies.sort((a, b) => a - b);
const pct = (p) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))].toFixed(2);
console.log(`accepted steps : ${rt.metrics.accepted}`);
console.log(`throughput     : ${(dispatched / elapsed).toFixed(0)} steps/s over ${elapsed.toFixed(1)}s`);
console.log(`latency ms     : p50 ${pct(0.5)} · p95 ${pct(0.95)} · p99 ${pct(0.99)} · max ${latencies[latencies.length - 1].toFixed(2)}`);

await rt.close();
rmSync(dir, { recursive: true, force: true });
