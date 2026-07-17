// polyrun M3 tests — archival/retention, migration tooling, lease extension.
// Run: node --test polyrun/test/m3.test.mjs
'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRuntime } from '../src/index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const demo = join(here, '..', 'demo');
const repoRoot = join(here, '..', '..');
const cli = join(here, '..', 'bin', 'polyrun.mjs');

const machineDef = {
  machineId: 'order',
  module: join(demo, 'order-machine.cjs'),
  contract: join(demo, 'contract.json'),
  effects: { mapper: join(demo, 'effects.cjs'), manifest: join(demo, 'effects.manifest.json') },
};

function runCli(cfgPath, ...cmd) {
  // spawnSync so stderr (skip reasons, gate detail) is captured on success too
  const res = spawnSync(process.execPath, ['--no-warnings', cli, ...cmd, '--config', cfgPath], { cwd: repoRoot, encoding: 'utf8' });
  return { code: res.status, out: `${res.stdout}${res.stderr}` };
}

function writeCfg(dir, dbPath, extraMachine = '') {
  const cfgPath = join(dir, 'cfg.mjs');
  writeFileSync(cfgPath, `
export default {
  store: { sqlite: ${JSON.stringify(dbPath)} },
  machines: [{
    machineId: 'order',
    module: ${JSON.stringify(machineDef.module)},
    contract: ${JSON.stringify(machineDef.contract)},
    effects: { mapper: ${JSON.stringify(machineDef.effects.mapper)}, manifest: ${JSON.stringify(machineDef.effects.manifest)} },
    ${extraMachine}
  }],
  handlers: {},
};
`);
  return cfgPath;
}

test('archive: dry run reports, --apply exports then purges, unsettled effects block', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'polyrun-m3-'));
  t.after(() => { try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* Windows WAL handle latency — temp dir, OS cleans it */ } });
  const dbPath = join(dir, 'arch.sqlite');
  let now = 1_000_000;
  {
    const rt = await createRuntime({ store: { sqlite: dbPath }, machines: [machineDef], handlers: {}, now: () => now });
    // terminal + settled: cancelled before any effect resolution matters
    await rt.create('order', 'old-1');
    await rt.dispatch('old-1', 'CANCEL', { reason: 'x' }, 'a1');
    // the SUBMIT-era fraudCheck effect never emitted (cancel from pending) —
    // journal has 2 rows, outbox empty → archivable
    // terminal but UNSETTLED: submit (emits fraudCheck effect, pending forever)
    await rt.create('order', 'old-2');
    await rt.dispatch('old-2', 'SUBMIT', { totalCents: 2500 }, 'b1');
    await rt.dispatch('old-2', 'FRAUD_FAILED', { reason: 'sus' }, 'b2'); // terminal; fraudCheck effect still pending
    // recent terminal: must NOT be archived
    now = 5_000_000;
    await rt.create('order', 'new-1');
    await rt.dispatch('new-1', 'CANCEL', { reason: 'y' }, 'c1');
    await rt.close();
  }
  const cfg = writeCfg(dir, dbPath);
  const outDir = join(dir, 'archive-out');

  const dry = runCli(cfg, 'archive', '--before', '2000000', '--out', outDir);
  assert.equal(dry.code, 0, dry.out);
  assert.match(dry.out, /eligible \(dry run/);

  const applied = runCli(cfg, 'archive', '--before', '2000000', '--out', outDir, '--apply');
  assert.equal(applied.code, 0, applied.out);
  assert.match(applied.out, /1 instance\(s\) exported\+purged/);
  assert.match(applied.out, /1 skipped/);
  assert.match(applied.out, /unsettled effect/);

  // export exists and carries the journal
  const exported = readdirSync(outDir);
  assert.ok(exported.includes('old-1.ndjson'));
  const lines = readFileSync(join(outDir, 'old-1.ndjson'), 'utf8').trim().split('\n');
  assert.equal(JSON.parse(lines[0]).archived.instance_id, 'old-1');
  assert.ok(lines.length >= 3); // header + $create + CANCEL

  // purged from the store; unsettled and recent instances remain
  const rt = await createRuntime({ store: { sqlite: dbPath }, machines: [machineDef], handlers: {} });
  t.after(() => rt.close());
  assert.equal(await rt.store.getInstance('old-1'), null);
  assert.ok(await rt.store.getInstance('old-2'));
  assert.ok(await rt.store.getInstance('new-1'));

  // fan-out cursor safety after purge: a new step's global_seq is strictly
  // above everything ever issued (never a reused rowid)
  await rt.create('order', 'post-archive');
  await rt.dispatch('post-archive', 'CANCEL', { reason: 'z' }, 'd1');
  const rows = await rt.store.journalSince(0, 1000);
  const seqs = rows.map((r) => r.global_seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  assert.ok(Math.max(...seqs) > 6, 'counter must not reset after purge');
});

test('migrate: dry-run validates via the module + invariants, --apply rewrites snapshots', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'polyrun-m3-'));
  t.after(() => { try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* Windows WAL handle latency — temp dir, OS cleans it */ } });
  const dbPath = join(dir, 'mig.sqlite');
  {
    const rt = await createRuntime({ store: { sqlite: dbPath }, machines: [machineDef], handlers: {} });
    await rt.create('order', 'm1');
    await rt.dispatch('m1', 'SUBMIT', { totalCents: 2500 }, 'a1');
    await rt.close();
  }
  // a pure migration: normalize totals (e.g. re-denominate)
  const migratePath = join(dir, 'migrate.cjs');
  writeFileSync(migratePath, `module.exports.migrate = (s) => ({ ...s, totalCents: s.totalCents * 10 });`);
  const cfg = writeCfg(dir, dbPath, `migrate: ${JSON.stringify(migratePath)},`);

  const dry = runCli(cfg, 'migrate');
  assert.equal(dry.code, 0, dry.out);
  assert.match(dry.out, /1 snapshot\(s\) validated \(dry run/);

  const applied = runCli(cfg, 'migrate', '--apply');
  assert.equal(applied.code, 0, applied.out);
  assert.match(applied.out, /1 snapshot\(s\) MIGRATED/);

  const rt = await createRuntime({ store: { sqlite: dbPath }, machines: [machineDef], handlers: {} });
  t.after(() => rt.close());
  assert.equal((await rt.getState('m1')).state.totalCents, 25000);
  // the migrated instance still dispatches fine
  const res = await rt.dispatch('m1', 'FRAUD_PASSED', { itemsAvailable: true }, 'a2');
  assert.equal(res.state.orderState, 'charging');

  // a migration producing module-rejected shapes fails the gate
  const badMigrate = join(dir, 'bad-migrate.cjs');
  writeFileSync(badMigrate, `module.exports.migrate = (s) => ({ ...s, totalCents: 'lots' });`);
  const cfgBad = writeCfg(dir, dbPath, `migrate: ${JSON.stringify(badMigrate)},`);
  const bad = runCli(cfgBad, 'migrate');
  assert.equal(bad.code, 1);
  assert.match(bad.out, /migrate FAIL/);
});

test('lease extension: a long handler that extends its lease is not re-claimed and completes once', async (t) => {
  let now = 1_000_000;
  let runs = 0;
  const rt = await createRuntime({
    store: { sqlite: ':memory:' },
    machines: [machineDef],
    handlers: {
      fraudCheck: async () => ({ itemsAvailable: true }),
      chargeCard: async (payload, idemKey, ctx) => {
        runs += 1;
        await ctx.extendLease(60_000); // provider with no callback mechanism
        await new Promise((r) => setTimeout(r, 50));
        return { txId: 'tx-slow' };
      },
      dispatchShipment: async () => ({}),
    },
    now: () => now,
    worker: { leaseMs: 1_000, defaultRetry: { maxAttempts: 5, baseMs: 100, timeoutMs: 500 } },
  });
  t.after(() => rt.close());
  await rt.create('order', 'l1');
  await rt.dispatch('l1', 'SUBMIT', { totalCents: 2500 }, 'a1');
  await rt.dispatch('l1', 'FRAUD_PASSED', { itemsAvailable: true }, 'a2');

  const tick = rt.workers.tickEffects(now);
  // while the handler sleeps, the base lease expires — but the extension
  // holds, so a second tick must NOT re-claim the row
  now += 2_000;
  await rt.workers.tickEffects(now);
  await tick;
  assert.equal(runs, 1, 'the extended lease must prevent re-claim');
  assert.equal((await rt.getState('l1')).state.orderState, 'shipping');
});

test('purge guards: active children and active parents block archival', async (t) => {
  const rt = await createRuntime({
    store: { sqlite: ':memory:' },
    machines: [
      machineDef,
      { machineId: 'shipment', module: join(here, 'fixtures', 'shipment-machine.cjs'),
        isTerminal: (s) => ['delivered', 'cancelledShipment'].includes(s.shipState) },
    ],
    handlers: {},
  });
  t.after(() => rt.close());
  const machine = rt.machines.get('order');
  const original = machine.mapper;
  machine.mapper = (pre, action, data, post) =>
    (pre.orderState !== 'shipping' && post.orderState === 'shipping')
      ? [{ kind: 'spawnChild', machineId: 'shipment', childKey: 'main', onComplete: 'SHIPMENT_DELIVERED' }]
      : [];
  t.after(() => { machine.mapper = original; });

  await rt.create('order', 'pg1');
  await rt.dispatch('pg1', 'SUBMIT', { totalCents: 2500 }, 'a1');
  await rt.dispatch('pg1', 'FRAUD_PASSED', { itemsAvailable: true }, 'a2');
  await rt.dispatch('pg1', 'CHARGE_SUCCEEDED', { txId: 't' }, 'a3'); // spawns child (preparing, active)
  const child = await rt.store.findChild('pg1', 'main');
  await rt.dispatch('pg1', 'SHIPMENT_DELIVERED', {}, 'a4'); // parent terminal, child still active

  // terminal parent with an ACTIVE child: purge must refuse — the child's
  // eventual terminal notify into a purged parent would roll back forever
  await assert.rejects(() => rt.store.purgeInstance('pg1'), /active child/);

  // child terminal, parent ACTIVE: purging the child must refuse (the parent
  // can still signalChild → poison). Wire onComplete to an action the parent
  // REJECTS in 'shipping' so the terminal notify leaves the parent active.
  machine.mapper = (pre, action, data, post) =>
    (pre.orderState !== 'shipping' && post.orderState === 'shipping')
      ? [{ kind: 'spawnChild', machineId: 'shipment', childKey: 'main', onComplete: 'CHARGE_FAILED' }]
      : [];
  await rt.create('order', 'pg2');
  await rt.dispatch('pg2', 'SUBMIT', { totalCents: 2500 }, 'b1');
  await rt.dispatch('pg2', 'FRAUD_PASSED', { itemsAvailable: true }, 'b2');
  await rt.dispatch('pg2', 'CHARGE_SUCCEEDED', { txId: 't' }, 'b3'); // spawns child of ACTIVE parent
  const child2 = await rt.store.findChild('pg2', 'main');
  await rt.dispatch(child2.instance_id, 'CANCEL_SHIPMENT', {}, 'b4'); // child terminal; notify rejected → parent stays active
  assert.equal((await rt.getState('pg2')).status, 'active');
  await assert.rejects(() => rt.store.purgeInstance(child2.instance_id), /active parent/);
});

test('migrate + audit: version-aware audit stays clean after a shape-preserving migration', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'polyrun-m3-'));
  t.after(() => { try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* win */ } });
  const dbPath = join(dir, 'aud.sqlite');
  {
    const rt = await createRuntime({ store: { sqlite: dbPath }, machines: [machineDef], handlers: {} });
    await rt.create('order', 'va1');
    await rt.dispatch('va1', 'SUBMIT', { totalCents: 2500 }, 'a1');
    await rt.close();
  }
  const migratePath = join(dir, 'migrate.cjs');
  writeFileSync(migratePath, `module.exports.migrate = (s) => ({ ...s, totalCents: s.totalCents * 10 });`);
  const cfg = writeCfg(dir, dbPath, `migrate: ${JSON.stringify(migratePath)},`);
  assert.equal(runCli(cfg, 'migrate', '--apply').code, 0);

  // the $migrate journal marker exists and chains pre -> post
  const rt = await createRuntime({ store: { sqlite: dbPath }, machines: [machineDef], handlers: {} });
  t.after(() => rt.close());
  const journal = await rt.getJournal('va1');
  const marker = journal.find((r) => r.action === '$migrate');
  assert.ok(marker, 'migration must leave a journal record');
  assert.equal(marker.post.totalCents, 25000);
  assert.equal((await rt.getState('va1')).seq, marker.seq, 'snapshot seq must match the marker');

  // pre-migration windows replay against the SAME module version here (the
  // module did not change), so a plain audit is clean; the marker is skipped
  const audit = runCli(cfg, 'audit');
  assert.equal(audit.code, 0, audit.out);
  assert.match(audit.out, /drift: NONE/);
});

test('migrate: validation failure on ONE instance applies NOTHING (two-phase gate)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'polyrun-m3-'));
  t.after(() => { try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* win */ } });
  const dbPath = join(dir, 'gate.sqlite');
  {
    const rt = await createRuntime({ store: { sqlite: dbPath }, machines: [machineDef], handlers: {} });
    await rt.create('order', 'g1');
    await rt.dispatch('g1', 'SUBMIT', { totalCents: 2500 }, 'a1');
    await rt.create('order', 'g2'); // pending: totalCents 0 → migration divides by it → NaN
    await rt.close();
  }
  const migratePath = join(dir, 'partial.cjs');
  writeFileSync(migratePath, `module.exports.migrate = (s) => ({ ...s, totalCents: s.totalCents > 0 ? s.totalCents * 10 : 'zero' });`);
  const cfg = writeCfg(dir, dbPath, `migrate: ${JSON.stringify(migratePath)},`);
  const res = runCli(cfg, 'migrate', '--apply');
  assert.equal(res.code, 1);
  assert.match(res.out, /migrate FAIL/);
  const rt = await createRuntime({ store: { sqlite: dbPath }, machines: [machineDef], handlers: {} });
  t.after(() => rt.close());
  assert.equal((await rt.getState('g1')).state.totalCents, 2500, 'the valid instance must NOT have been migrated');
});

test('migrate with no matching machine is a loud failure, not a silent pass', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'polyrun-m3-'));
  t.after(() => { try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* win */ } });
  const dbPath = join(dir, 'none.sqlite');
  const cfg = writeCfg(dir, dbPath); // no migrate key
  const res = runCli(cfg, 'migrate');
  assert.equal(res.code, 1);
  assert.match(res.out, /no machine with a migrate module/);
});
