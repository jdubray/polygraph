// Tier 1 of the fleet study (docs/fleet-study-plan.md §4) — the seeded
// control catalogue.
//
// Every case declares, IN ADVANCE, what the correct verdict is and which
// gate should produce it. The runner reports whether reality matched. A
// disagreement is a finding about the tool OR about this expectation —
// either way it must be explained, never quietly re-fitted to the output.
//
// Two kinds of case:
//   positive — a planted incompatibility. Not catching it is a MISS.
//   negative — a change that is genuinely compatibility-safe. Flagging it
//              is a FALSE ALARM. A control with no negatives cannot
//              measure false positives at all, which is the number the
//              reviewer actually asked for.
'use strict';

/** Fixture dirs are resolved relative to polyvers/test/fixtures/. */
export const CASES = [
  // ---- positives: planted incompatibilities -----------------------------
  {
    id: 'semantic-landmine',
    lane: 'semantic',
    positive: true,
    defect: 'a live state that the OLD machine cannot reach (v0 residue) and that the NEW rules can drive into an invariant violation',
    old: 'order-v1', new: 'order-v2-landmine', fleet: 'landmine-fleet.json',
    expect: { compatible: false, caughtBy: 'semantic-model-check' },
    // The headline of the whole tier: this is the case the synthesized
    // corpus is EXPECTED to miss, because synthesis can only contain states
    // the old model says are reachable — precisely the assumption a
    // landmine violates. Predicted per tier rather than overall.
    expectByTier: { archive: 'CAUGHT', synthesized: 'MISSED' },
  },
  {
    id: 'shape-no-migration',
    lane: 'shape',
    positive: true,
    defect: 'the state shape changed and no migration ships with it, so live snapshots do not round-trip',
    old: 'order-v1', new: 'order-v2-shape', fleet: 'landmine-fleet.json',
    expect: { compatible: false, caughtBy: 'shape-roundtrip' },
  },
  {
    id: 'vocabulary-renamed',
    lane: 'vocabulary',
    positive: true,
    defect: 'an action/reject-reason was renamed, so in-flight stimuli built against the old vocabulary become undefined behavior',
    old: 'order-v1', new: 'order-v2-renamed', fleet: 'landmine-fleet.json',
    expect: { compatible: false, caughtBy: 'stimuli' },
  },
  {
    id: 'intent-strengthened',
    lane: 'intent',
    positive: true,
    defect: 'an invariant was strengthened past states the fleet already holds',
    old: 'order-v1', new: 'order-v2-stricter', fleet: 'landmine-fleet.json',
    expect: { compatible: false, caughtBy: 'invariants-pointwise' },
    // NOTE for adjudication: per the plan's taxonomy this is the archetypal
    // TI ("true but intended") — the tool is correct and the human decides
    // what the named instances mean. It is a positive case for RECALL
    // (the gate must fire) but must not be scored as a defect the tool
    // "caught" in the same sense as the landmine.
    taxonomy: 'TI',
  },

  // ---- negatives: compatibility-safe changes ----------------------------
  {
    id: 'rules-narrowed-cancel',
    lane: 'semantic',
    positive: false,
    defect: 'CANCEL is narrowed from pending|charging to pending only — a real behavior change, but every affected delivery still lands as a NAMED observable reject, so no live state can be driven to a violation',
    old: 'order-v1', new: 'order-v2-rules', fleet: 'landmine-fleet.json',
    expect: { compatible: true },
    // The specificity test: a naive differ would call a removed transition a
    // break. The paper's definition says otherwise, and this case holds the
    // tool to it.
  },
  {
    id: 'identical-versions',
    lane: '(none)',
    positive: false,
    defect: 'the artifacts are byte-identical — nothing to gate',
    old: 'order-v1', new: 'order-v1', fleet: 'landmine-fleet.json',
    expect: { compatible: true },
  },
];

/** Composition cases run `product`/`matrix` rather than `check`. */
export const COMPOSITION_CASES = [
  {
    id: 'composition-narrowed-cancel-window',
    lane: 'composition',
    positive: true,
    defect: "the child's cancel window narrowed between versions: delivery stays clean (a named reject), but a joint interleaving now leaves a shipment delivered under a cancelled order",
    parentOld: 'po-v1', parentNew: 'po-v1',
    childOld: 'ship-v1', childNew: 'ship-v2-lag',
    parentId: 'po', childId: 'shipment',
    invariants: 'compose-invariants.mjs',
    // The point of the case: the protocol/delivery matrix PASSES and the
    // joint product check FAILS. Both halves are asserted.
    expect: { matrix: 'PASS', product: 'FAIL' },
  },
  {
    id: 'composition-same-versions',
    lane: 'composition',
    positive: false,
    defect: 'the same child version on both sides — nothing should fire',
    parentOld: 'po-v1', parentNew: 'po-v1',
    childOld: 'ship-v1', childNew: 'ship-v1',
    parentId: 'po', childId: 'shipment',
    invariants: 'compose-invariants.mjs',
    expect: { matrix: 'PASS', product: 'PASS' },
  },
];
