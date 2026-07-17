#!/usr/bin/env node
// polyrun-worker — standalone effect runner + timer service (spec §5.1).
// Usage: node polyrun/bin/polyrun-worker.mjs --config <polyrun.config.mjs>
//
// Stateless and horizontally scalable: run N replicas against one Postgres;
// SKIP LOCKED claims and idempotency keys make overlap safe.
'use strict';

import { createRuntime } from '../src/index.mjs';
import { loadConfig } from '../src/config.mjs';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };

const configPath = flag('config');
if (!configPath) { console.error('usage: polyrun-worker --config <polyrun.config.mjs>'); process.exit(2); }

const config = await loadConfig(configPath);
const rt = await createRuntime(config);
rt.startWorkers(config.poll ?? {});
console.log(`[polyrun-worker ${process.pid}] running — machines: ${[...rt.machines.keys()].join(', ')}`);

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`[polyrun-worker ${process.pid}] ${signal} — draining`);
  rt.stopWorkers();
  await rt.close();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// keep the process alive (worker intervals are unref'd by design)
setInterval(() => {}, 1 << 30);
