// polyrun HTTP facade (M1) — a thin JSON layer over the library for non-JS
// callers. No auth: bind to loopback (the default) and put a real gateway in
// front for anything else.
//
// Retry safety: dispatch REQUIRES an actionId. HTTP is exactly where blind
// retries live (curl --retry, ingress timeouts), and a dispatch without a
// caller-stable actionId is at-least-once — which would contradict the
// system's effectively-once contract on its most retry-prone surface.
'use strict';

import http from 'node:http';
import { PoisonedError, ConflictError } from './kernel.mjs';

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const json = (res, code, body) => {
  if (res.writableEnded || res.destroyed) return;
  const text = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
};

const readBody = (req) => new Promise((resolvePromise, reject) => {
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > 1_000_000) {
      reject(new HttpError(413, 'body too large'));
      req.removeAllListeners('data');
      req.resume(); // drain without buffering so the 413 can be written
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => {
    if (chunks.length === 0) return resolvePromise({});
    try { resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
    catch { reject(new HttpError(400, 'invalid JSON body')); }
  });
  req.on('error', reject);
});

const decodeId = (part) => {
  try { return decodeURIComponent(part); }
  catch { throw new HttpError(400, 'malformed percent-encoding in path'); }
};

/** Build (but do not listen on) the facade server for a runtime. */
export function createHttpServer(rt, { log = console.error } = {}) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);

      if (req.method === 'GET' && url.pathname === '/healthz') return json(res, 200, { ok: true });
      if (req.method === 'GET' && url.pathname === '/metrics') return json(res, 200, rt.metrics);

      if (parts[0] === 'machines' && parts[2] === 'instances' && parts.length === 3) {
        const machineId = decodeId(parts[1]);
        if (req.method === 'POST') {
          const body = await readBody(req);
          const out = await rt.create(machineId, body.instanceId, body.creation);
          return json(res, out.created ? 201 : 200, out);
        }
        if (req.method === 'GET') {
          const rows = await rt.list(machineId, url.searchParams.get('status') || undefined);
          return json(res, 200, rows.map((r) => ({ instanceId: r.instance_id, status: r.status, seq: r.seq, state: r.state })));
        }
        return json(res, 405, { error: 'method not allowed' });
      }

      if (parts[0] === 'instances' && parts.length === 3 && parts[2] === 'actions') {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
        const body = await readBody(req);
        if (!body.action) throw new HttpError(400, 'action is required');
        if (!body.actionId) throw new HttpError(400, 'actionId is required: supply a caller-stable id so network retries dedupe instead of double-executing');
        const out = await rt.dispatch(decodeId(parts[1]), body.action, body.data ?? {}, body.actionId);
        return json(res, 200, out);
      }

      if (parts[0] === 'instances' && (parts.length === 2 || parts.length === 3)) {
        if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
        const id = decodeId(parts[1]);
        if (parts.length === 2) return json(res, 200, await rt.getState(id));
        if (parts[2] === 'journal') return json(res, 200, await rt.getJournal(id));
        if (parts[2] === 'state-at') {
          const raw = url.searchParams.get('seq');
          if (raw === null || !/^\d+$/.test(raw)) throw new HttpError(400, 'state-at requires an integer seq query parameter');
          return json(res, 200, { state: await rt.getStateAt(id, Number(raw)) });
        }
        if (parts[2] === 'traces') {
          const text = await rt.exportTraces(id);
          res.writeHead(200, { 'content-type': 'application/x-ndjson' });
          return res.end(text);
        }
      }

      return json(res, 404, { error: 'not found' });
    } catch (err) {
      if (err instanceof HttpError) return json(res, err.status, { error: err.message });
      if (err instanceof ConflictError) return json(res, 409, { error: err.message, code: 'conflict' });
      if (err instanceof PoisonedError) return json(res, 500, { error: err.message, code: 'poisoned' });
      const message = String(err?.message ?? err ?? 'unknown error');
      if (/unknown (instance|machine)/.test(message)) return json(res, 404, { error: message });
      if (/creation action|is not in machine/.test(message)) return json(res, 400, { error: message });
      // Anything else is internal: log the detail, return a generic body so
      // driver messages/paths never reach the wire.
      log(`[polyrun-api] 500: ${message}`);
      return json(res, 500, { error: 'internal error' });
    }
  });
}
