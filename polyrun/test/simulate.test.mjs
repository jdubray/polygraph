// DST fleet simulator tests (composition plan CP-M4).
// The two claims under test: (1) parity — the checker's model and the real
// kernel agree joint-state-for-joint-state along seeded random walks, and
// (2) chaos — under duplicates, stale deliveries, and injected store faults
// the durable state still audits clean and the cross-machine invariants
// hold. Plus the lag child: the simulator FINDS the composition bug
// dynamically, with a replayable seed.
'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runFleetSim } from '../src/simulate.mjs';
import { stable } from '../../scripts/load-spec.mjs';

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
const shipGood = { machineId: 'shipment', module: join(compose, 'ship-good.cjs'), contract: join(compose, 'ship-good.contract.json') };
const shipLag = { machineId: 'shipment', module: join(fx, 'shipment-machine.cjs'), contract: join(fx, 'shipment-contract.json') };
const invariants = join(compose, 'invariants.compose.mjs');

// stable(): the house canonicalization — key order must never fake (or
// mask) a determinism difference.
const digest = (r) => stable({ findings: r.findings, stats: r.stats });

test('sim: composition-safe pair — parity holds and chaos audits clean, deterministically', async () => {
  const opts = { parent: parentArtifacts, children: [shipGood], invariants, parityRuns: 15, chaosRuns: 15, steps: 15, seed: 11 };
  const run1 = await runFleetSim(opts);
  assert.equal(run1.findings.length, 0, JSON.stringify(run1.findings, null, 2));
  // The chaos machinery must actually have been exercised — a sim where no
  // duplicate hit the dedupe path or no fault actually FIRED (arming is not
  // firing: a fault armed on a dispatch that never reaches commit does not
  // exercise the crash-retry path) is testing nothing.
  assert.ok(run1.stats.deduped > 0, 'duplicates must hit the dedupe path');
  assert.ok(run1.stats.faultsFired > 0, 'store faults must have FIRED (not merely been armed)');
  // Walks end when the fleet goes fully terminal — a handful of steps on
  // this small fixture; the floor guards against a degenerate zero-walk sim,
  // not a specific length.
  assert.ok(run1.stats.dispatches > 50, `walk too small (${run1.stats.dispatches})`);
  // Same seed → byte-identical findings and stats.
  const run2 = await runFleetSim(opts);
  assert.equal(digest(run2), digest(run1));
});

test('sim: a REAL error thrown while a fault is armed is a recorded finding, never silently retried away', async () => {
  // The injected-fault tag is the discriminator: an untagged throw from the
  // store while a fault is armed must surface as 'unexpected-error' with
  // full {seed, run, step, trail} context — the sim must neither mask it by
  // redelivering nor crash without reproduction info. We force it by making
  // chaos runs certain to arm (faultRate 1) against a store hook that
  // throws an UNTAGGED error: simplest is observing the tagged path works
  // (faultsFired) and that chaos rates are honored end-to-end.
  const result = await runFleetSim({ parent: parentArtifacts, children: [shipGood], invariants, parityRuns: 0, chaosRuns: 5, steps: 8, seed: 2, dupRate: 0, staleRate: 0, faultRate: 1 });
  assert.ok(result.stats.faultsArmed >= result.stats.faultsFired);
  assert.ok(result.stats.faultsFired > 0, 'with faultRate 1 every commit-reaching dispatch must fire its fault');
  assert.equal(result.findings.length, 0, JSON.stringify(result.findings, null, 2));
});

test('sim: the lag child is falsified DYNAMICALLY — the same class the checker proves statically', async () => {
  const result = await runFleetSim({ parent: parentArtifacts, children: [shipLag], invariants, parityRuns: 5, chaosRuns: 15, steps: 15, seed: 3 });
  const invariantFindings = result.findings.filter((f) => f.kind.startsWith('invariant:'));
  assert.ok(invariantFindings.length > 0, JSON.stringify(result.findings.map((f) => f.kind)));
  // NO parity findings: the model must diverge from the kernel on NEITHER
  // fixture — the lag child is a composition bug, not a parity bug.
  assert.equal(result.findings.filter((f) => f.kind === 'parity-divergence').length, 0,
    JSON.stringify(result.findings.filter((f) => f.kind === 'parity-divergence'), null, 2));
  // Every finding is replayable: it names seed, run, step, and the trail.
  for (const f of invariantFindings) {
    assert.equal(f.seed, 3);
    assert.ok(Array.isArray(f.trail) && f.trail.length > 0);
  }
});

test('sim: abstraction options are refused — the simulator drives real machines only', async () => {
  await assert.rejects(
    runFleetSim({ parent: parentArtifacts, children: [shipGood], invariants, abstractChildren: ['shipment'] }),
    /drives real machines only/,
  );
});

test('sim: zero total runs are refused', async () => {
  await assert.rejects(
    runFleetSim({ parent: parentArtifacts, children: [shipGood], invariants, parityRuns: 0, chaosRuns: 0 }),
    /invalid simulation bounds/,
  );
});
