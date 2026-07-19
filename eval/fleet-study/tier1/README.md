# Fleet study · Tier 1 — the seeded control

The first of the three tiers in [`docs/fleet-study-plan.md`](../../../docs/fleet-study-plan.md),
answering the reviewer ask for hit/false-positive numbers with the only
source of ground truth that is fully known: **defects we planted ourselves**.

```bash
node eval/fleet-study/tier1/run.mjs      # writes results.json + results.md
```

Deterministic, local, **no API key**. Exit code is 1 if any pre-registered
prediction breaks.

## What it does

`cases.mjs` is a catalogue of version pairs. Each declares — *before the
run* — whether the change is compatibility-safe and, if not, which gate
should catch it. `run.mjs` drives the real CLI (not the library, so the
numbers describe the path a user actually takes), scores each outcome, and
reports recall and false alarms **per corpus tier**:

- **archive** — a fleet snapshot corpus, which may hold states the old
  machine cannot reach (v0 residue, hot patches, manual edits);
- **synthesized** — BFS-reachable states of the old machine, the weakest
  tier.

Negative cases matter as much as positive ones: a control with no negatives
cannot measure false positives at all, which is the number the reviewer
actually asked for.

## The result that matters

| corpus tier | positives | caught | missed | recall | negatives | false alarms |
|---|---|---|---|---|---|---|
| archive | 4 | 4 | 0 | **1.00** | 2 | **0** |
| synthesized | 4 | 3 | 1 | **0.75** | 2 | **0** |

The single missed case is `semantic-landmine`, and it is missed **only** on
the synthesized tier. This was predicted in `cases.mjs` before the run
(`expectByTier: { archive: 'CAUGHT', synthesized: 'MISSED' }`) and the
prediction held.

That row is the paper's central claim about corpus provenance, quantified
rather than asserted: synthesis can only contain states the old *model*
says are reachable, which is exactly the assumption a landmine violates. A
tool run against a synthesized corpus reports PASS on a change that a real
fleet corpus proves unsafe — so **corpus provenance is part of the verdict,
not metadata about it**.

Two further results:

- **Zero false alarms on both tiers.** `rules-narrowed-cancel` narrows
  CANCEL from `pending|charging` to `pending` — a real behaviour change that
  a naive differ would flag as a break. Every affected delivery still lands
  as a *named* observable reject, so no live state can be driven to a
  violation, and the gates correctly stay silent. That is the specificity
  test.
- **The composition pair behaves as the CP-M3 design claims**: a child whose
  cancel window narrowed passes `matrix` (delivery is clean) and fails
  `product` (a joint interleaving leaves a shipment delivered under a
  cancelled order).

## Reading the numbers honestly

- Recall here is **against defects we chose**. It measures whether each gate
  fires on the class it claims, not whether the catalogue covers the space
  of real incompatibilities. Tier 3 (replaying real OSS version pairs
  against the maintainers' own migrations) is what supplies external ground
  truth.
- `intent-strengthened` is scored as a positive for recall, but under the
  plan's taxonomy it is a **TI — true but intended**: the gate is right, and
  a human decides what the named live instances mean. It is tagged
  `taxonomy: 'TI'` in the catalogue so it is never presented as a caught
  defect in the same sense as the landmine.
- Timings (~1s per case) are dominated by Node process startup, not by
  exploration; they are an upper bound on cost, not a benchmark.

## A defect this harness found

Scoring `identical-versions` was impossible on the first run: `polyvers
check --json` returned prose on the identical-artifacts and no-lane-fired
paths, so a machine consumer asking for JSON got a sentence. Fixed in
`polyvers/bin/polyvers.mjs` — both paths now emit a report object carrying
`gated: false`, which preserves the distinction the prose was making
(nothing *ran*, so it is not the same object as a PASS over a full gate
table).
