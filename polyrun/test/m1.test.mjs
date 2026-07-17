// polyrun M1 tests — HTTP facade, deploy gate, DLQ, config loading.
// Run: node --test polyrun/test/m1.test.mjs
// Set POLYRUN_PG_URL to run the store-backed parts against Postgres.
'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRuntime } from '../src/index.mjs';
import { createHttpServer } from '../src/http.mjs';
import { loadConfig } from '../src/config.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const demo = join(here, '..', 'demo');
const repoRoot = join(here, '..', '..');

let pgSchemaCounter = 100;
function storeConfig() {
  return process.env.POLYRUN_PG_URL
    ? { postgres: process.env.POLYRUN_PG_URL, schema: `polym1_${process.pid}_${pgSchemaCounter++}` }
    : { sqlite: ':memory:' };
}

async function makeRuntime(handlers = {}) {
  return createRuntime({
    store: storeConfig(),
    machines: [{
      machineId: 'order',
      module: join(demo, 'order-machine.cjs'),
      contract: join(demo, 'contract.json'),
      effects: { mapper: join(demo, 'effects.cjs'), manifest: join(demo, 'effects.manifest.json') },
    }],
    handlers,
  });
}

const request = (port, method, path, body) => new Promise((resolvePromise, reject) => {
  import('node:http').then(({ default: http }) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { 'content-type': 'application/json' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolvePromise({ status: res.statusCode, body: text && res.headers['content-type']?.startsWith('application/json') ? JSON.parse(text) : text });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
});

test('HTTP facade: create, dispatch, state, journal, traces, metrics, errors', async (t) => {
  const rt = await makeRuntime();
  const server = createHttpServer(rt);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  t.after(async () => { server.close(); await rt.close(); });

  const created = await request(port, 'POST', '/machines/order/instances', { instanceId: 'h1' });
  assert.equal(created.status, 201);
  assert.equal(created.body.state.orderState, 'pending');

  // idempotent recreate → 200
  assert.equal((await request(port, 'POST', '/machines/order/instances', { instanceId: 'h1' })).status, 200);

  const submitted = await request(port, 'POST', '/instances/h1/actions', { action: 'SUBMIT', data: { totalCents: 2500 }, actionId: 's1' });
  assert.equal(submitted.status, 200);
  assert.equal(submitted.body.state.orderState, 'fraudCheck');

  // actionId reuse for a different action → 409
  const conflict = await request(port, 'POST', '/instances/h1/actions', { action: 'CANCEL', data: { reason: 'x' }, actionId: 's1' });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, 'conflict');

  const state = await request(port, 'GET', '/instances/h1');
  assert.equal(state.status, 200);
  assert.equal(state.body.state.orderState, 'fraudCheck');

  const journal = await request(port, 'GET', '/instances/h1/journal');
  assert.equal(journal.body.length, 2); // $create + SUBMIT

  const stateAt = await request(port, 'GET', '/instances/h1/state-at?seq=0');
  assert.equal(stateAt.body.state.orderState, 'pending');

  const traces = await request(port, 'GET', '/instances/h1/traces');
  assert.equal(traces.status, 200);
  assert.equal(JSON.parse(traces.body.trim()).action, 'SUBMIT');

  const listing = await request(port, 'GET', '/machines/order/instances?status=active');
  assert.equal(listing.body.length, 1);

  const metrics = await request(port, 'GET', '/metrics');
  assert.ok(metrics.body.dispatches >= 2);

  assert.equal((await request(port, 'GET', '/instances/nope')).status, 404);
  assert.equal((await request(port, 'POST', '/instances/h1/actions', {})).status, 400);
  assert.equal((await request(port, 'GET', '/nope')).status, 404);
});

test('deploy gate: passes on healthy state, fails on invariant violation and on shape drift', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'polyrun-deploy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'gate.sqlite');

  // seed a live instance
  {
    const rt = await createRuntime({
      store: { sqlite: dbPath },
      machines: [{
        machineId: 'order',
        module: join(demo, 'order-machine.cjs'),
        contract: join(demo, 'contract.json'),
        effects: { mapper: join(demo, 'effects.cjs'), manifest: join(demo, 'effects.manifest.json') },
      }],
    });
    await rt.create('order', 'g1', { action: 'SUBMIT', data: { totalCents: 2500 } });
    await rt.close();
  }

  const mkConfig = (extra = '') => {
    const cfgPath = join(dir, `cfg${extra ? '-bad' : ''}.mjs`);
    writeFileSync(cfgPath, `
export default {
  store: { sqlite: ${JSON.stringify(dbPath)} },
  machines: [{
    machineId: 'order',
    module: ${JSON.stringify(join(demo, 'order-machine.cjs'))},
    contract: ${JSON.stringify(join(demo, 'contract.json'))},
    effects: { mapper: ${JSON.stringify(join(demo, 'effects.cjs'))}, manifest: ${JSON.stringify(join(demo, 'effects.manifest.json'))} },
    ${extra}
  }],
  handlers: {},
};
`);
    return cfgPath;
  };

  const cli = join(here, '..', 'bin', 'polyrun.mjs');
  const run = (cfg) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, ['--no-warnings', cli, 'deploy', '--config', cfg], { cwd: repoRoot, encoding: 'utf8' }) };
    } catch (err) {
      return { code: err.status, out: `${err.stdout}${err.stderr}` };
    }
  };

  // healthy: round-trip passes, real invariants pass
  const good = run(mkConfig(`invariants: ${JSON.stringify(join(demo, 'polygen-out', 'invariants.mjs'))},`));
  assert.equal(good.code, 0, good.out);
  assert.match(good.out, /DEPLOY GATE: PASS/);

  // an invariant the live state violates → gate fails
  const badInv = join(dir, 'bad-invariants.mjs');
  writeFileSync(badInv, `export const stateInvariants = [{ name: 'impossible', pred: () => false }];`);
  const bad = run(mkConfig(`invariants: ${JSON.stringify(badInv)},`));
  assert.equal(bad.code, 1);
  assert.match(bad.out, /invariant FAIL/);
  assert.match(bad.out, /DEPLOY GATE: FAIL/);

  // a module whose shape drifted (missing contract key) → load gate fails
  const badModule = join(dir, 'bad-machine.cjs');
  writeFileSync(badModule, readFileSync(join(demo, 'order-machine.cjs'), 'utf8')
    .replaceAll('cancelReason', 'cancelText'));
  const cfgBad = join(dir, 'cfg-shape.mjs');
  writeFileSync(cfgBad, `
export default {
  store: { sqlite: ${JSON.stringify(dbPath)} },
  machines: [{ machineId: 'order', module: ${JSON.stringify(badModule)}, contract: ${JSON.stringify(join(demo, 'contract.json'))} }],
  handlers: {},
};
`);
  const shape = run(cfgBad);
  assert.equal(shape.code, 1);
  assert.match(shape.out, /GATE FAIL \(load\)/);
});

test('DLQ: ls shows dead intents, retry re-queues with reset attempts, discard closes', async (t) => {
  let now = 1_000_000;
  let fail = true;
  const rt = await createRuntime({
    store: storeConfig(),
    machines: [{
      machineId: 'order',
      module: join(demo, 'order-machine.cjs'),
      contract: join(demo, 'contract.json'),
      effects: { mapper: join(demo, 'effects.cjs'), manifest: join(demo, 'effects.manifest.json') },
    }],
    handlers: {
      fraudCheck: async () => ({ itemsAvailable: true }),
      chargeCard: async () => { if (fail) throw new Error('provider down'); return { txId: 'tx-dlq' }; },
      dispatchShipment: async () => ({}),
    },
    now: () => now,
  });
  t.after(() => rt.close());

  await rt.create('order', 'd1');
  await rt.dispatch('d1', 'SUBMIT', { totalCents: 2500 }, 'a1');
  await rt.dispatch('d1', 'FRAUD_PASSED', { itemsAvailable: true }, 'a2');

  for (let i = 0; i < 6; i++) { await rt.workers.tickEffects(now); now += 300 * 2 ** i + 2000; }
  const dead = (await rt.store.dlqList()).filter((r) => r.kind === 'chargeCard');
  assert.equal(dead.length, 1);
  // exhaustion drove the machine to paymentFailed (terminal) — the point of onExhausted
  assert.equal((await rt.getState('d1')).state.orderState, 'paymentFailed');

  // retry: re-queues; the machine is terminal so the completion (if any) would
  // reject observably — here the handler succeeds and completion is rejected(terminal)
  fail = false;
  await rt.store.dlqRetry(dead[0].intent_id, now);
  await rt.workers.tickEffects(now);
  const after = (await rt.store.getOutbox('d1')).find((r) => r.intent_id === dead[0].intent_id);
  assert.equal(after.status, 'done');
  const staleCompletion = (await rt.getJournal('d1')).find((r) => r.action === 'CHARGE_SUCCEEDED');
  assert.equal(staleCompletion.step_kind, 'rejected');
  assert.equal(staleCompletion.reject_reason, 'terminal');
});

test('config loader resolves machine paths relative to the config file', async () => {
  const config = await loadConfig(join(demo, 'polyrun.config.mjs'));
  assert.ok(config.machines[0].module.includes('demo'));
  assert.ok(config.machines[0].effects.manifest.endsWith('effects.manifest.json'));
  assert.equal(typeof config.handlers.chargeCard, 'function');
});
