// check-product tests (composition plan CP-M1) — the parent×child product
// model check, plus the kernel-parity test: every counterexample the checker
// reports must replay through the REAL kernel to the same joint outcome
// (docs/composition-semantics.md §6 — parity is tested, not assumed).
'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { checkProduct } from '../src/check-product.mjs';
import { createRuntime } from '../src/index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fx = join(here, 'fixtures');
const compose = join(fx, 'compose');

const parentArtifacts = {
  machineId: 'po',
  module: join(compose, 'parent-po.cjs'),
  contract: join(compose, 'parent-po.contract.json'),
  mapper: join(compose, 'parent-po.effects.cjs'),
  manifest: join(compose, 'parent-po.effects.manifest.json'),
};
// The composition-safe child: cancel window covers every non-terminal state.
const shipGood = { machineId: 'shipment', module: join(compose, 'ship-good.cjs'), contract: join(compose, 'ship-good.contract.json') };
// The lag child (the pre-existing kernel fixture): cancels only from
// 'preparing' — an inTransit shipment survives the parent's cancel.
const shipLag = { machineId: 'shipment', module: join(fx, 'shipment-machine.cjs'), contract: join(fx, 'shipment-contract.json') };
const invariants = join(compose, 'invariants.compose.mjs');

test('composition-safe pair: no cross-machine violation is reachable', async () => {
  const result = await checkProduct({ parent: parentArtifacts, children: [shipGood], invariants });
  assert.equal(result.ok, true, JSON.stringify(result.violations, null, 2));
  assert.equal(result.capHit, false);
  assert.ok(result.statesExplored > 3);
  // The alphabet boundary must be DISCLOSED, not silent (semantics §3).
  assert.ok(result.notes.some((n) => n.includes("'CHILD_DONE' is cascade-owned")));
});

test('lag child: the interleaving class the matrix cannot see', async () => {
  const result = await checkProduct({ parent: parentArtifacts, children: [shipLag], invariants });
  assert.equal(result.ok, false);
  const byName = Object.fromEntries(result.violations.map((v) => [v.invariant, v]));

  // 1. Parent cancels while the shipment is inTransit: the cascade cancel is
  //    rejected ('cancel-too-late'), the child stays ACTIVE under a terminal
  //    parent.
  const active = byName['terminal-parent-leaves-no-active-children'];
  assert.ok(active, 'expected terminal-parent-leaves-no-active-children');
  assert.equal(active.kind, 'state');

  // 2. …and the still-running shipment then DELIVERs: delivered shipment
  //    under a cancelled order — the reviewer's canonical cross-machine bug.
  const delivered = byName['no-delivered-shipment-under-cancelled-order'];
  assert.ok(delivered, 'expected no-delivered-shipment-under-cancelled-order');
  // Shortest counterexample: START, SHIP, CANCEL, DELIVER (init + 4 steps).
  const stimuli = delivered.path.slice(1).map((s) => `${s.stimulus.target}:${s.stimulus.action}`);
  assert.deepEqual(stimuli, ['parent:START', 'c1:SHIP', 'parent:CANCEL', 'c1:DELIVER']);
  // The cancel step's cascade shows the rejected child cancel — the journal
  // production would write.
  const cancelStep = delivered.path[3];
  assert.ok(cancelStep.cascade.some((c) => c.target === 'c1' && c.action === 'CANCEL_SHIPMENT' && c.stepKind === 'rejected'));
  // The final joint state is the violation witness.
  const last = delivered.path[delivered.path.length - 1].joint;
  assert.equal(last.parent.state.poState, 'cancelled');
  assert.equal(last.children.c1.state.shipState, 'delivered');
});

test('kernel parity: the counterexample replays through the real kernel to the same joint outcome', async (t) => {
  const result = await checkProduct({ parent: parentArtifacts, children: [shipLag], invariants });
  const violation = result.violations.find((v) => v.invariant === 'no-delivered-shipment-under-cancelled-order');
  assert.ok(violation);

  const rt = await createRuntime({
    store: { sqlite: ':memory:' },
    machines: [
      { machineId: 'po', module: parentArtifacts.module, contract: parentArtifacts.contract, effects: { mapper: parentArtifacts.mapper, manifest: parentArtifacts.manifest } },
      { machineId: 'shipment', module: shipLag.module, contract: shipLag.contract },
    ],
  });
  t.after(() => rt.close());

  await rt.create('po', 'po-1');
  // Replay the checker's stimulus sequence verbatim; resolve child targets
  // (the model's childKey) to the kernel's spawned instance ids as they
  // appear.
  let n = 0;
  for (const step of violation.path.slice(1)) {
    const { target, action, data } = step.stimulus;
    let instanceId = 'po-1';
    if (target !== 'parent') {
      const children = await rt.list('shipment');
      assert.equal(children.length, 1, 'expected exactly one spawned shipment');
      instanceId = children[0].instance_id;
    }
    await rt.dispatch(instanceId, action, data, `replay:${n++}`);
  }

  // The kernel lands on the model's violation witness exactly.
  const modelFinal = violation.path[violation.path.length - 1].joint;
  const parentFinal = await rt.getState('po-1');
  assert.deepEqual(parentFinal.state, modelFinal.parent.state);
  assert.equal(parentFinal.status, 'terminal');
  const child = (await rt.list('shipment'))[0];
  assert.deepEqual(child.state, modelFinal.children.c1.state);
  assert.equal(child.status, 'terminal');
  // …including the cascade journal: the rejected cancel on the child and the
  // status-rejected completion on the terminal parent.
  const childJournal = await rt.getJournal(child.instance_id);
  assert.ok(childJournal.some((r) => r.action === 'CANCEL_SHIPMENT' && r.step_kind === 'rejected' && r.reject_reason === 'cancel-too-late'));
  const parentJournal = await rt.getJournal('po-1');
  assert.ok(parentJournal.some((r) => r.action === 'CHILD_DONE' && r.step_kind === 'rejected' && r.reject_reason === 'terminal'));
});

test('a child with its own effects mapper = refusal, not an unsound pass', async () => {
  await assert.rejects(
    checkProduct({
      parent: parentArtifacts,
      children: [{ ...shipGood, mapper: parentArtifacts.mapper }],
      invariants,
    }),
    /child-side cascades are not modeled/,
  );
});

test('no invariants = refusal, not a vacuous pass', async () => {
  await assert.rejects(
    checkProduct({ parent: parentArtifacts, children: [shipGood], invariants: {} }),
    /pass vacuously/,
  );
});

test('a bounded exploration is not a pass', async () => {
  const result = await checkProduct({ parent: parentArtifacts, children: [shipGood], invariants, maxStates: 2 });
  assert.equal(result.capHit, true);
  assert.equal(result.ok, false);
});
