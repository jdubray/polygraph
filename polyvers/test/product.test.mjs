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

const runCli = (cliArgs) => {
  try {
    return { stdout: execFileSync(process.execPath, [cli, ...cliArgs], { encoding: 'utf-8' }), code: 0 };
  } catch (err) {
    return { stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? ''), code: err.status };
  }
};

test('product: same versions everywhere — all four pairings pass, ONE exploration', async () => {
  const result = await runProductMatrix({
    parentOldDir: fix('po-v1'), parentNewDir: fix('po-v1'),
    childOldDir: fix('ship-v1'), childNewDir: fix('ship-v1'),
    childMachineId: 'shipment', invariants,
  });
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
  const result = await runProductMatrix({
    parentOldDir: fix('po-v1'), parentNewDir: fix('po-v1'),
    childOldDir: fix('ship-v1'), childNewDir: fix('ship-v2-lag'),
    childMachineId: 'shipment', invariants,
  });
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
});

test('product: a missing parent mapper is a refusal, not a vacuous pass', async () => {
  await assert.rejects(
    runProductMatrix({
      parentOldDir: fix('ship-v1'), parentNewDir: fix('ship-v1'),
      childOldDir: fix('ship-v1'), childNewDir: fix('ship-v1'),
      childMachineId: 'shipment', invariants,
    }),
    /has no effects\.cjs/,
  );
});

test('product: abstraction pass-through works per pairing', async () => {
  const result = await runProductMatrix({
    parentOldDir: fix('po-v1'), parentNewDir: fix('po-v1'),
    childOldDir: fix('ship-v1'), childNewDir: fix('ship-v1'),
    childMachineId: 'shipment', invariants, abstractChild: true,
  });
  assert.equal(result.ok, true, JSON.stringify(result.cells[0].violations, null, 2));
  assert.deepEqual(result.cells[0].abstracted, ['shipment']);
});

test('product: cli exit code is the verdict, scope note included', () => {
  const pass = runCli(['product', '--parent-old', fix('po-v1'), '--parent-new', fix('po-v1'),
    '--child-old', fix('ship-v1'), '--child-new', fix('ship-v1'),
    '--child-id', 'shipment', '--invariants', invariants]);
  assert.equal(pass.code, 0, pass.stdout + (pass.stderr ?? ''));
  assert.ok(pass.stdout.includes('Verdict: PASS'));
  assert.ok(pass.stdout.includes('JOINT product model check per version pairing'));

  const fail = runCli(['product', '--parent-old', fix('po-v1'), '--parent-new', fix('po-v1'),
    '--child-old', fix('ship-v1'), '--child-new', fix('ship-v2-lag'),
    '--child-id', 'shipment', '--invariants', invariants]);
  assert.equal(fail.code, 1);
  assert.ok(fail.stdout.includes('no-delivered-shipment-under-cancelled-order'));

  const noInv = runCli(['product', '--parent-old', fix('po-v1'), '--parent-new', fix('po-v1'),
    '--child-old', fix('ship-v1'), '--child-new', fix('ship-v1'), '--child-id', 'shipment']);
  assert.equal(noInv.code, 2);
});
