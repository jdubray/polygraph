// polyvers CP-M3 tests — the JOINT product model check per version pairing.
// The headline case: a child whose cancel window NARROWED between versions
// passes the protocol/delivery matrix (the cancel still lands as a named
// reject) but fails the product check on the interleaving the reviewer
// named — shipment delivers under a cancelled order.
'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runProductMatrix, renderProductMatrix } from '../src/product.mjs';
import { runMatrix } from '../src/matrix.mjs';
import { loadArtifacts } from '../src/artifacts.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fix = (name) => join(here, 'fixtures', name);
const cli = join(here, '..', 'bin', 'polyvers.mjs');
const invariants = fix('compose-invariants.mjs');

// One helper so each test states only what varies (review finding, CP-M3).
const opts = (overrides = {}) => ({
  parentOldDir: fix('po-v1'), parentNewDir: fix('po-v1'),
  childOldDir: fix('ship-v1'), childNewDir: fix('ship-v1'),
  parentMachineId: 'po', childMachineId: 'shipment', invariants,
  ...overrides,
});
const cliArgs = (childNew = 'ship-v1', extra = []) => ['product',
  '--parent-old', fix('po-v1'), '--parent-new', fix('po-v1'),
  '--child-old', fix('ship-v1'), '--child-new', fix(childNew),
  '--parent-id', 'po', '--child-id', 'shipment', '--invariants', invariants, ...extra];

const runCli = (args) => {
  try {
    return { stdout: execFileSync(process.execPath, [cli, ...args], { encoding: 'utf-8' }), code: 0 };
  } catch (err) {
    return { stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? ''), code: err.status };
  }
};

test('product: same versions everywhere — all four pairings pass, ONE exploration', async () => {
  const result = await runProductMatrix(opts());
  assert.equal(result.ok, true, JSON.stringify(result.cells.map((c) => ({ pairing: c.pairing, refused: c.refused, violations: c.violations?.map((v) => v.invariant) })), null, 2));
  assert.equal(result.cells.length, 4);
  assert.equal(result.uniquePairings, 1);
});

test('product: the narrowed-cancel child fails EXACTLY the child-new pairings — the class the matrix passes', async () => {
  // First establish the contrast: the protocol/delivery matrix PASSES this
  // rollout (the narrowed cancel still lands as a named observable reject).
  const po = await loadArtifacts(fix('po-v1'));
  const shipOld = await loadArtifacts(fix('ship-v1'));
  const shipNew = await loadArtifacts(fix('ship-v2-lag'));
  const protocol = runMatrix({ parentOld: po, parentNew: po, childOld: shipOld, childNew: shipNew, childMachineId: 'shipment' });
  assert.equal(protocol.ok, true, 'the protocol/delivery matrix should PASS the narrowed cancel — that gap is exactly what the product check closes');

  // The product check finds the interleaving.
  const result = await runProductMatrix(opts({ childNewDir: fix('ship-v2-lag') }));
  assert.equal(result.ok, false);
  assert.equal(result.uniquePairings, 2);
  for (const cell of result.cells) {
    if (cell.pairing.endsWith('child-old')) {
      assert.equal(cell.ok, true, `${cell.pairing} should pass`);
    } else {
      assert.equal(cell.ok, false, `${cell.pairing} should fail`);
      const names = new Set(cell.violations.map((v) => v.invariant));
      assert.ok(names.has('no-delivered-shipment-under-cancelled-order'), JSON.stringify([...names]));
      assert.ok(names.has('terminal-parent-leaves-no-active-children'));
    }
  }
  const rendered = renderProductMatrix(result);
  assert.ok(rendered.includes('JOINT product model check'));
  assert.ok(rendered.includes('recorded follow-up'));
  // The dedup note names the pairing it refers to, never a bare 'above'.
  assert.ok(rendered.includes("(same version pairing as 'parent-old × child-new' — same findings)"));
  // The real parent machine id is invariant-visible, not a sentinel.
  const failing = result.cells.find((c) => !c.ok);
  const initJoint = failing.violations[0].path[0].joint;
  assert.equal(initJoint.parent.machineId, 'po');
});

test('product: a broken version DIR fails its cells, the checkable cells still run', async () => {
  // ship-v1 as parent has no effects.cjs — its two cells refuse; nothing else runs differently.
  const result = await runProductMatrix(opts({ parentNewDir: fix('ship-v1') }));
  assert.equal(result.ok, false);
  const refused = result.cells.filter((c) => c.refused);
  const passed = result.cells.filter((c) => c.ok);
  assert.equal(refused.length, 2);
  assert.ok(refused.every((c) => c.pairing.startsWith('parent-new') && /has no effects\.cjs/.test(c.refused)));
  assert.equal(passed.length, 2, 'the parent-old pairings must still be explored');
  const rendered = renderProductMatrix(result);
  assert.ok(rendered.includes('**REFUSED**'));
  assert.ok(rendered.includes('| —'), 'a refused cell shows no fabricated joint-state count');
});

test("product: a child with its own effects.cjs is REFUSED per cell — the CP-M2 soundness gate fires through this seam", async () => {
  // po-v1 as the CHILD carries effects.cjs: its cascades are unmodeled, so
  // certifying the pairing would be unsound.
  const result = await runProductMatrix(opts({ childOldDir: fix('po-v1'), childNewDir: fix('po-v1'), childMachineId: 'po', parentMachineId: 'po-parent' }));
  assert.equal(result.ok, false);
  assert.ok(result.cells.every((c) => c.refused && /has its own effects mapper/.test(c.refused)),
    JSON.stringify(result.cells.map((c) => ({ pairing: c.pairing, refused: c.refused, ok: c.ok }))));
});

test('product: an unloadable invariants module is ONE configuration error, not four REFUSED cells', async () => {
  await assert.rejects(
    runProductMatrix(opts({ invariants: fix('does-not-exist.mjs') })),
    /cannot load the cross-machine invariants module/,
  );
});

test('product: abstraction pass-through works per pairing', async () => {
  const result = await runProductMatrix(opts({ abstractChild: true }));
  assert.equal(result.ok, true, JSON.stringify(result.cells[0].violations, null, 2));
  assert.deepEqual(result.cells[0].abstracted, ['shipment']);
});

test('product: cli exit code is the verdict; scope note, --json, and flag validation', () => {
  const pass = runCli(cliArgs());
  assert.equal(pass.code, 0, pass.stdout + (pass.stderr ?? ''));
  assert.ok(pass.stdout.includes('Verdict: PASS'));
  assert.ok(pass.stdout.includes('JOINT product model check per version pairing'));

  const fail = runCli(cliArgs('ship-v2-lag'));
  assert.equal(fail.code, 1);
  assert.ok(fail.stdout.includes('no-delivered-shipment-under-cancelled-order'));

  // --json is honored (classify/check parity) and carries the cell data.
  const json = runCli(cliArgs('ship-v2-lag', ['--json']));
  assert.equal(json.code, 1);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.cells.length, 4);

  // Missing --invariants or --parent-id are usage errors (exit 2).
  const noInv = runCli(['product', '--parent-old', fix('po-v1'), '--parent-new', fix('po-v1'),
    '--child-old', fix('ship-v1'), '--child-new', fix('ship-v1'), '--parent-id', 'po', '--child-id', 'shipment']);
  assert.equal(noInv.code, 2);
  const noPid = runCli(['product', '--parent-old', fix('po-v1'), '--parent-new', fix('po-v1'),
    '--child-old', fix('ship-v1'), '--child-new', fix('ship-v1'), '--child-id', 'shipment', '--invariants', invariants]);
  assert.equal(noPid.code, 2);

  // --abstract-child with a wrong id is an error, never silently swallowed.
  const badAbs = runCli(cliArgs('ship-v1', ['--abstract-child', 'nope']));
  assert.equal(badAbs.code, 2);
  // …but the polyrun dialect (naming the child id) works.
  const goodAbs = runCli(cliArgs('ship-v1', ['--abstract-child', 'shipment']));
  assert.equal(goodAbs.code, 0, goodAbs.stdout + (goodAbs.stderr ?? ''));
});
