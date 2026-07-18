# polyvers — the versioning engine

**Your tests run against the code. Your fleet runs against the states.**

polyvers answers one question mechanically: *can I ship this change to a
running fleet?* Given two versions of a state machine and a source of live
fleet state, it classifies what actually changed, runs exactly the checks
that kind of change requires, and emits a compatibility report you can gate
a deploy on.

The fourth of five engines: Polygraph **audits**, polygen **authors**,
polyrun **executes**, polyvers **evolves**, polynv **elicits**.

## The problem: state outlives code

When you deploy a new version of a stateful system, the old states don't go
away. Instances that started under v1 are still sitting in the database
when v3 ships — and the set of states production actually holds isn't the
set your current code can produce. It's the union of everything that was
reachable under **every version you ever deployed**.

That gap has a name: a **landmine**. A state reachable under v1 but
unreachable under v3 is a state no test written against v3 will ever
construct — yet production still holds instances resting in it. Your test
suite is green. Your fleet is not.

And "compatible" turns out not to be one question. It's several, each with
a different failure mode:

- the **shape** of the state changed (which keys, which types) — old
  snapshots may not even load;
- the **rules** changed — a state that was fine under v1 can now be driven
  into a violation;
- the **vocabulary** changed — an action you deleted is still arriving from
  an in-flight timer or an old caller;
- your **intent** changed — you strengthened an invariant, and some live
  instances already violate it;
- the **shape migration** itself is a new piece of code that can be wrong;
- machines **compose** — a parent on v2 orchestrating a child on v1 is a
  version pairing nobody tested.

Each of those has a mechanical check. polyvers runs the ones your change
actually needs, against real fleet state, and refuses to report PASS over
an empty or unverifiable corpus.

## How it works

Point it at two artifact directories — the old version and the new one:

```bash
# 1. what kind of change is this, and what does it require?
npm run polyvers -- classify --old machines/order-v1 --new machines/order-v2

# 2. run those gates against real fleet state, write the report
npm run polyvers -- check --old machines/order-v1 --new machines/order-v2 \
  --snapshots archive/ --out out/compat
```

`classify` diffs the artifact family and fires **lanes** — the kinds of
change above. Each lane demands specific gates; `check` runs them and
writes a deterministic, PR-gateable `compat-report.{json,md}`. Exit 0 is
the gate.

The headline check is the **seeded model check**, which makes the essay's
definition of compatibility executable:

> v(n+1) is compatible with the fleet **iff no live v(n) state can be
> driven to an invariant violation under v(n+1)'s rules**, over the
> declared action/data domains.

Every fleet snapshot is seeded into the exhaustive exploration alongside
`init()` — so the checker asks not just "is the new machine correct from
scratch?" but "can anything production is *currently holding* be walked
into a violation?" That is the check that catches landmines, and a failure
names a witness state plus the shortest action path to the violation — a
ready-made repro.

An artifact dir is exactly what polygen emits: `contract.json` + the SAM v2
module + optional `invariants.mjs`, `effects.manifest.json`, `effects.cjs`,
and `migrate.cjs` when the shape changed.

## Corpus provenance is part of the verdict

The gates are only as good as the states you run them against, so polyvers
makes the source explicit in every report:

| tier | flag | what it is |
|---|---|---|
| fleet exports | `--snapshots <dir\|file>` | `polyrun archive` output, ndjson, or a `.json` array — the honest tier |
| synthesized | `--synthesize` | BFS-reachable states of the OLD machine — the weakest tier |

`--synthesize` contains only states the old *model* says are reachable,
which is exactly the assumption a landmine violates. It's better than
nothing and worse than reality, and the report says which one you used. An
empty corpus is refused outright — a vacuous PASS is not a PASS.

## The lanes

| lane | fires when | gates |
|---|---|---|
| semantic | the module changed | load · shape-roundtrip · invariants-pointwise · semantic-model-check |
| shape | contract `stateKeys` changed | load · migrate · shape-roundtrip |
| migration | `migrate.cjs` added or edited | load · migrate · shape-roundtrip |
| vocabulary | actions / reject reasons / effect kinds / terminal states changed | load · vocabulary · stimuli |
| intent | `invariants.mjs` changed | load · invariant-diff · invariants-pointwise · semantic-model-check |
| composition | `effects.cjs` added or edited | load (+ NOT RUN rows → `polyrun check-effects`, `polyvers matrix`, `polyvers product`) |

The doctrine behind the gates, in one paragraph: a removed action fails the
vocabulary gate (**deprecate, don't delete** — in-flight stimuli still
arrive); reject-reason renames are breaks, because those strings are public
API; removing a terminal state re-animates every instance resting in it; a
strengthened invariant is a fleet event, so the gate names the live states
that already violate it — the decision about what those instances *mean*
happens before the deploy, not after it. An invariant renamed with an
identical predicate is reported as a rename, not a weakening.

## Shape changes: scaffold the migration

```bash
npm run polyvers -- migrate scaffold --old machines/order-v1 --new machines/order-v2
```

Emits a `migrate.cjs` skeleton — complete for pure additions, with throwing
TODO holes where a retyped key needs a human decision — plus a
MIGRATION-NOTE template. Fill the holes, then re-run `check`: the migrate
gate validates it corpus-wide (pure, accepted by the new module,
projection-equal, invariants hold), and a validated migration then **swaps
the corpus**, so every downstream gate runs over the states the fleet will
hold *after* the migration. Applying it stays with `polyrun migrate
--apply`.

When no pure function has an honest image for some live state — not a shape
problem, a conceptual one — the gate fails loudly with the affected
instances named. That's a human decision arriving pre-deploy instead of
post-incident.

## Parent/child machines: rollout windows

During a rollout, parent {old,new} × child {old,new} all coexist. Two
commands, run both:

```bash
# the spawn/completion protocol and its delivery, per pairing
npm run polyvers -- matrix --parent-old machines/order-v1 --parent-new machines/order-v2 \
  --child-old machines/shipment-v1 --child-new machines/shipment-v1 --child-id shipment

# the JOINT state space per pairing, against cross-machine invariants
npm run polyvers -- product --parent-old machines/order-v1 --parent-new machines/order-v2 \
  --child-old machines/shipment-v1 --child-new machines/shipment-v1 \
  --parent-id order --child-id shipment --invariants machines/invariants.compose.mjs
```

`matrix` checks that nothing either side can deliver across the version
boundary is undefined behavior — every child terminal outcome lands in
every parent state, every parent-terminal cancel lands in every child
state, each as accepted or a *named* observable reject.

`product` checks the class `matrix` structurally cannot see: **joint
interleavings**. A child whose cancel window narrowed between versions
passes delivery cleanly — the cancel still rejects by name — but the
product check finds the reachable sequence where a shipment delivers under
a cancelled order, and prints the stimulus path that gets there. It needs
cross-machine invariants (`invariants.compose.mjs`, predicates over
`{ parent, children }`); see
[`docs/composition-semantics.md`](../docs/composition-semantics.md).

## Worked example

[`examples/polyvers-oms/`](../examples/polyvers-oms/README.md) versions the
OMS order machine end to end: a shape + rules + intent change, a scaffolded
migration, and committed compat, matrix, and product reports you can read
without running anything.

## Honest scope

- Every "exhaustive" gate is exhaustive **over the finite (action, data)
  domains the contract declares** — not over unbounded real data. The gap
  between declared domain and production data is where bugs hide, and no
  gate here measures it.
- Every guarantee is **relative to the invariants you wrote**. Semantic
  drift your invariants don't mention is invisible to all of this — which
  is why [polynv](../polynv/README.md) exists, and why the compat-report
  carries its invariant-adequacy trust tier.
- Still open, tracked in
  [`docs/composition-plan.md`](../docs/composition-plan.md): joint
  mid-flight seeding for `product` (pairings are explored from genesis),
  and grandchildren — a child with its own `effects.cjs` is refused rather
  than certified unmodeled.
- Deterministic, local, **no API key**. `npm run test:polyvers`.

Background: [`docs/VERSIONING.md`](../docs/VERSIONING.md) is the essay this
engine mechanizes — why versioning stateful systems is hard, the full
taxonomy, and what remains genuinely open. Implementation history and
design decisions: [`docs/polyvers-plan.md`](../docs/polyvers-plan.md).
