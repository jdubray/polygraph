// polyrun HTTP facade (M1) — a thin JSON layer over the library for non-JS
// callers. No auth: bind to loopback (the default) and put a real gateway in
// front for anything else.
'use strict';

import http from 'node:http';
import { PoisonedError, ConflictError } from './kernel.mjs';

const json = (res, code, body) => {
  const text = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
};

const readBody = (req) => new Promise((resolvePromise, reject) => {
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > 1_000_000) { reject(new Error('body too large')); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => {
    if (chunks.length === 0) return resolvePromise({});
    try { resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
    catch { reject(new Error('invalid JSON body')); }
  });
  req.on('error', reject);
});

/** Build (but do not listen on) the facade server for a runtime. */
export function createHttpServer(rt) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);

      if (req.method === 'GET' && url.pathname === '/healthz') return json(res, 200, { ok: true });
      if (req.method === 'GET' && url.pathname === '/metrics') return json(res, 200, rt.metrics);

      // POST /machines/:machineId/instances  {instanceId?, creation?}
      if (req.method === 'POST' && parts[0] === 'machines' && parts[2] === 'instances' && parts.length === 3) {
        const body = await readBody(req);
        const out = await rt.create(decodeURIComponent(parts[1]), body.instanceId, body.creation);
        return json(res, out.created ? 201 : 200, out);
      }
      // GET /machines/:machineId/instances?status=
      if (req.method === 'GET' && parts[0] === 'machines' && parts[2] === 'instances' && parts.length === 3) {
        const rows = await rt.list(decodeURIComponent(parts[1]), url.searchParams.get('status') || undefined);
        return json(res, 200, rows.map((r) => ({ instanceId: r.instance_id, status: r.status, seq: r.seq, state: r.state })));
      }
      // POST /instances/:id/actions  {action, data?, actionId?}
      if (req.method === 'POST' && parts[0] === 'instances' && parts[2] === 'actions' && parts.length === 3) {
        const body = await readBody(req);
        if (!body.action) return json(res, 400, { error: 'action is required' });
        const out = await rt.dispatch(decodeURIComponent(parts[1]), body.action, body.data ?? {}, body.actionId);
        return json(res, 200, out);
      }
      // GET /instances/:id[/journal|/traces|/state-at?seq=]
      if (req.method === 'GET' && parts[0] === 'instances' && parts.length >= 2) {
        const id = decodeURIComponent(parts[1]);
        if (parts.length === 2) return json(res, 200, await rt.getState(id));
        if (parts[2] === 'journal') return json(res, 200, await rt.getJournal(id));
        if (parts[2] === 'state-at') return json(res, 200, { state: await rt.getStateAt(id, Number(url.searchParams.get('seq'))) });
        if (parts[2] === 'traces') {
          const text = await rt.exportTraces(id);
          res.writeHead(200, { 'content-type': 'application/x-ndjson' });
          return res.end(text);
        }
      }

      return json(res, 404, { error: 'not found' });
    } catch (err) {
      if (err instanceof ConflictError) return json(res, 409, { error: err.message, code: 'conflict' });
      if (err instanceof PoisonedError) return json(res, 500, { error: err.message, code: 'poisoned' });
      if (/unknown (instance|machine)/.test(err.message ?? '')) return json(res, 404, { error: err.message });
      return json(res, 500, { error: String(err && err.message) });
    }
  });
}
