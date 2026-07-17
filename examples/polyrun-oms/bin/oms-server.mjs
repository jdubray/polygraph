#!/usr/bin/env node
// OMS demo server — the polyrun HTTP facade + workers + the storefront page.
// Usage: node examples/polyrun-oms/bin/oms-server.mjs [--port 7080]
//
//   http://127.0.0.1:7080/shop   → the User / Courier storefront
//   http://127.0.0.1:7080/       → the polyrun read-only ops console
//   everything else              → the polyrun JSON facade
'use strict';

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRuntime } from '../../../polyrun/src/index.mjs';
import { createHttpServer } from '../../../polyrun/src/http.mjs';
import { loadConfig } from '../../../polyrun/src/config.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };

const config = await loadConfig(join(here, '..', 'polyrun.config.mjs'));
const rt = await createRuntime(config);
rt.startWorkers(config.poll ?? {});

const facade = createHttpServer(rt);
const facadeListener = facade.listeners('request')[0];
const storefront = readFileSync(join(here, '..', 'web', 'storefront.html'), 'utf8');

const port = Number(flag('port') ?? 7080);
const server = http.createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (req.method === 'GET' && path === '/shop') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(storefront);
  }
  return facadeListener(req, res);
});
server.listen(port, '127.0.0.1', () => {
  console.log(`[oms] storefront:  http://127.0.0.1:${port}/shop`);
  console.log(`[oms] ops console: http://127.0.0.1:${port}/`);
});

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`[oms] ${signal} — draining`);
  server.closeIdleConnections?.();
  await Promise.race([new Promise((r) => server.close(r)), new Promise((r) => setTimeout(r, 10_000))]);
  rt.stopWorkers();
  await rt.close();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
