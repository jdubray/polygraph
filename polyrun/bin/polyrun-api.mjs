#!/usr/bin/env node
// polyrun-api — HTTP facade over a polyrun runtime (spec §5.1).
// Usage: node polyrun/bin/polyrun-api.mjs --config <polyrun.config.mjs> [--port 7071] [--host 127.0.0.1] [--workers]
//
// --workers additionally runs the effect/timer loops in this process (the
// single-process deployment shape); omit it when polyrun-worker runs
// separately.
'use strict';

import { createRuntime } from '../src/index.mjs';
import { loadConfig } from '../src/config.mjs';
import { createHttpServer } from '../src/http.mjs';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const has = (name) => args.includes(`--${name}`);

const configPath = flag('config');
if (!configPath) { console.error('usage: polyrun-api --config <polyrun.config.mjs> [--port 7071] [--host 127.0.0.1] [--workers]'); process.exit(2); }

const config = await loadConfig(configPath);
const rt = await createRuntime(config);
if (has('workers')) rt.startWorkers(config.poll ?? {});

const port = Number(flag('port') ?? 7071);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`invalid --port '${flag('port')}'`);
  process.exit(2);
}
const host = flag('host') ?? '127.0.0.1';
const server = createHttpServer(rt);
server.listen(port, host, () => {
  console.log(`[polyrun-api ${process.pid}] listening on http://${host}:${port} — machines: ${[...rt.machines.keys()].join(', ')}${has('workers') ? ' (+workers)' : ''}`);
});

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`[polyrun-api ${process.pid}] ${signal} — draining`);
  // Actually drain: stop accepting, let in-flight requests finish (with a
  // deadline), THEN close the store under nobody.
  server.closeIdleConnections?.();
  await Promise.race([
    new Promise((r) => server.close(r)),
    new Promise((r) => setTimeout(r, 10_000)),
  ]);
  rt.stopWorkers();
  await rt.close();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
