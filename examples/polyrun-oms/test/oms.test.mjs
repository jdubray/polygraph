// OMS reference app tests — the multi-fulfillment order orchestrating
// shipment children, all machines polygen-authored.
// Run: node --test examples/polyrun-oms/test/oms.test.mjs
// Set POLYRUN_PG_URL to run the runtime tests against Postgres.
'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRuntime } from '../../../polyrun/src/index.mjs';
import { checkEffects } from '../../../polyrun/src/check-effects.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const oms = join(here, '..');

const checkOpts = {
  module: join(oms, 'machines', 'order', 'next.cjs'),
  mapper: join(oms, 'effects.cjs'),
  manifest: join(oms, 'effects.manifest.json'),
  contract: join(oms, 'machines', 'order-contract.json'),
  invariants: join(oms, 'effect-invariants.mjs'),
};

let schemaCounter = 0;
async function makeRuntime() {
  return createRuntime({
    store: process.env.POLYRUN_PG_URL
      ? { postgres: process.env.POLYRUN_PG_URL, schema: `polyoms_${process.pid}_${schemaCounter++}` }
      : { sqlite: ':memory:' },
    machines: [
      {
        machineId: 'order',
        module: join(oms, 'machines', 'order', 'next.cjs'),
        contract: join(oms, 'machines', 'order-contract.json'),
        effects: { mapper: join(oms, 'effects.cjs'), manifest: join(oms, 'effects.manifest.json') },
      },
      {
        machineId: 'shipment',
        module: join(oms, 'machines', 'shipment', 'next.cjs'),
        contract: join(oms, 'machines', 'shipment', 'authoring-contract.json'),
      },
    ],
    handlers: {},
  });
}

/** Drive an order to 'fulfilling' with N fulfillments via external dispatch. */
async function driveToFulfilling(rt, id, fulfillments) {
  await rt.create('order', id);
  await rt.dispatch(id, 'SUBMIT', { fulfillments, totalCents: 4400 }, `${id}:submit`);
  await rt.dispatch(id, 'FRAUD_PASSED', { itemsAvailable: true }, `${id}:fraud`);
  await rt.dispatch(id, 'CHARGE_SUCCEEDED', { txId: 'tx-1' }, `${id}:charge`);
  return rt.getState(id);
}

test('composition check: order ∘ mapper passes all effect invariants incl. spawn counting', async () => {
  const r = await checkEffects(checkOpts);
  assert.deepEqual(r.violations.map((v) => v.invariant), [], JSON.stringify(r.violations, null, 2));
  assert.equal(r.bounded, false, 'must be exhaustive within declared domains');
  assert.ok(r.statesSeen >= 15, `state space too small: ${r.statesSeen}`);
});

test('composition negative control: a mapper spawning one child too many is caught', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'polyrun-oms-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const badMapper = join(dir, 'overspawn.cjs');
  writeFileSync(badMapper, `
const real = require(${JSON.stringify(join(oms, 'effects.cjs'))});
module.exports.effects = (pre, action, data, post, stepKind) => {
  const out = real.effects(pre, action, data, post, stepKind);
  if (pre.orderState !== 'fulfilling' && post.orderState === 'fulfilling') {
    out.push({ kind: 'spawnChild', machineId: 'shipment', childKey: 'extra', onComplete: 'SHIPMENT_COMPLETED' });
  }
  return out;
};`);
  const r = await checkEffects({ ...checkOpts, mapper: badMapper });
  assert.ok(r.violations.some((v) => v.invariant === 'spawns-match-fulfillments'),
    `overspawn must violate spawns-match-fulfillments: ${JSON.stringify(r.violations.map((v) => v.invariant))}`);
});

test('happy path: two fulfillments, both delivered → completed with full rollup', async (t) => {
  const rt = await makeRuntime();
  t.after(() => rt.close());
  const st = await driveToFulfilling(rt, 'o2', 2);
  assert.equal(st.state.orderState, 'fulfilling');

  const f1 = await rt.store.findChild('o2', 'f1');
  const f2 = await rt.store.findChild('o2', 'f2');
  assert.ok(f1 && f2, 'both shipment children must exist');
  assert.equal(f1.state.shipState, 'preparing');

  await rt.dispatch(f1.instance_id, 'SHIP', {}, 's1');
  await rt.dispatch(f1.instance_id, 'DELIVER', {}, 'd1');
  let mid = await rt.getState('o2');
  assert.equal(mid.state.orderState, 'fulfilling', 'one of two delivered: still fulfilling');
  assert.equal(mid.state.shipmentsDelivered, 1);

  await rt.dispatch(f2.instance_id, 'SHIP', {}, 's2');
  await rt.dispatch(f2.instance_id, 'DELIVER', {}, 'd2');
  const done = await rt.getState('o2');
  assert.equal(done.state.orderState, 'completed');
  assert.equal(done.state.shipmentsDelivered, 2);
  assert.equal(done.state.shipmentsFailed, 0);
  assert.equal(done.status, 'terminal');
});

test('partial delivery: one child cancelled → partiallyDelivered', async (t) => {
  const rt = await makeRuntime();
  t.after(() => rt.close());
  await driveToFulfilling(rt, 'o3', 2);
  const f1 = await rt.store.findChild('o3', 'f1');
  const f2 = await rt.store.findChild('o3', 'f2');

  await rt.dispatch(f1.instance_id, 'SHIP', {}, 's1');
  await rt.dispatch(f1.instance_id, 'DELIVER', {}, 'd1');
  await rt.dispatch(f2.instance_id, 'CANCEL_SHIPMENT', {}, 'c2'); // still preparing → cancellable

  const done = await rt.getState('o3');
  assert.equal(done.state.orderState, 'partiallyDelivered');
  assert.equal(done.state.shipmentsDelivered, 1);
  assert.equal(done.state.shipmentsFailed, 1);
  assert.equal(done.status, 'terminal');
});

test('amend path: unavailable items → amend to one fulfillment → single child', async (t) => {
  const rt = await makeRuntime();
  t.after(() => rt.close());
  await rt.create('order', 'o4');
  await rt.dispatch('o4', 'SUBMIT', { fulfillments: 2, totalCents: 4400 }, 'a1');
  await rt.dispatch('o4', 'FRAUD_PASSED', { itemsAvailable: false }, 'a2');
  assert.equal((await rt.getState('o4')).state.orderState, 'awaitingAmend');

  await rt.dispatch('o4', 'AMEND', { fulfillments: 1, totalCents: 1900 }, 'a3');
  await rt.dispatch('o4', 'CHARGE_SUCCEEDED', { txId: 'tx-2' }, 'a4');
  const st = await rt.getState('o4');
  assert.equal(st.state.orderState, 'fulfilling');
  assert.equal(st.state.fulfillments, 1);
  assert.ok(await rt.store.findChild('o4', 'f1'));
  assert.equal(await rt.store.findChild('o4', 'f2'), null, 'amended order must spawn exactly one child');
});

test('cancel rules: blocked while charging and while fulfilling, with contract-anchored reasons', async (t) => {
  const rt = await makeRuntime();
  t.after(() => rt.close());
  await rt.create('order', 'o5');
  await rt.dispatch('o5', 'SUBMIT', { fulfillments: 1, totalCents: 2500 }, 'a1');
  await rt.dispatch('o5', 'FRAUD_PASSED', { itemsAvailable: true }, 'a2');
  const inCharging = await rt.dispatch('o5', 'CANCEL', { reason: 'x' }, 'c1');
  assert.equal(inCharging.stepKind, 'rejected');
  assert.equal(inCharging.rejectReason, 'cancel-blocked-while-charging');

  await rt.dispatch('o5', 'CHARGE_SUCCEEDED', { txId: 'tx' }, 'a3');
  const inFulfilling = await rt.dispatch('o5', 'CANCEL', { reason: 'x' }, 'c2');
  assert.equal(inFulfilling.stepKind, 'rejected');
  assert.equal(inFulfilling.rejectReason, 'fulfillment-in-progress');
});

test('at-least-once safety: duplicate and stale completions reject observably', async (t) => {
  const rt = await makeRuntime();
  t.after(() => rt.close());
  await driveToFulfilling(rt, 'o6', 1);
  const f1 = await rt.store.findChild('o6', 'f1');
  await rt.dispatch(f1.instance_id, 'SHIP', {}, 's1');
  await rt.dispatch(f1.instance_id, 'DELIVER', {}, 'd1');
  assert.equal((await rt.getState('o6')).state.orderState, 'completed');

  // duplicate child-terminal redelivery: deduped by the kernel
  const replay = await rt.dispatch(f1.instance_id, 'DELIVER', {}, 'd1');
  assert.equal(replay.deduped, true);
  assert.equal((await rt.getJournal('o6')).filter((r) => r.action === 'SHIPMENT_COMPLETED').length, 1);

  // stale charge completion after terminal: observable reject
  const stale = await rt.dispatch('o6', 'CHARGE_SUCCEEDED', { txId: 'tx-9' }, 'late-1');
  assert.equal(stale.stepKind, 'rejected');
  assert.equal(stale.rejectReason, 'terminal');
});

test('deploy gate + audit pass over a live OMS database', async (t) => {
  const { spawnSync } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'polyrun-oms-'));
  t.after(() => { try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* win */ } });
  // seed via the demo config pointed at a temp state dir
  const env = { ...process.env, POLYRUN_OMS_DIR: dir };
  delete env.POLYRUN_PG_URL; // this CLI test pins sqlite in the temp dir
  const { pathToFileURL } = await import('node:url');
  const seed = `
import { createRuntime } from ${JSON.stringify(pathToFileURL(join(oms, '..', '..', 'polyrun', 'src', 'index.mjs')).href)};
import { loadConfig } from ${JSON.stringify(pathToFileURL(join(oms, '..', '..', 'polyrun', 'src', 'config.mjs')).href)};
const config = await loadConfig(${JSON.stringify(join(oms, 'polyrun.config.mjs'))});
config.handlers = {};
const rt = await createRuntime(config);
await rt.create('order', 'seed-1');
await rt.dispatch('seed-1', 'SUBMIT', { fulfillments: 1, totalCents: 2500 }, 'a1');
await rt.close();
`;
  const seedPath = join(dir, 'seed.mjs');
  writeFileSync(seedPath, seed);
  const run = (...cmd) => {
    const res = spawnSync(process.execPath, ['--no-warnings', ...cmd], { cwd: join(oms, '..', '..'), encoding: 'utf8', env });
    return { code: res.status, out: `${res.stdout}${res.stderr}` };
  };
  assert.equal(run(seedPath).code, 0);

  const cli = join(oms, '..', '..', 'polyrun', 'bin', 'polyrun.mjs');
  const cfg = join(oms, 'polyrun.config.mjs');
  const deploy = run(cli, 'deploy', '--config', cfg);
  assert.equal(deploy.code, 0, deploy.out);
  assert.match(deploy.out, /DEPLOY GATE: PASS/);

  const audit = run(cli, 'audit', '--config', cfg);
  assert.equal(audit.code, 0, audit.out);
  assert.match(audit.out, /drift: NONE|0 instance/);

  const check = run(cli, 'check-effects', '--config', cfg);
  assert.equal(check.code, 0, check.out);
  assert.match(check.out, /effect invariants: PASS/);
});
