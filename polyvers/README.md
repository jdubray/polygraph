# polyvers — the versioning engine (M0 + M1)

The fourth engine of the triad-now-quartet: Polygraph **audits**, polygen
**authors**, polyrun **executes**, polyvers **evolves**. It makes
[`docs/VERSIONING.md`](../docs/VERSIONING.md) executable: given two versions
of a machine's artifact family and a source of fleet state, it classifies
the change into the essay's compatibility lanes, runs exactly the gates
that lane requires, and emits a compatibility report a deploy can be gated
on. Plan: [`docs/polyvers-plan.md`](../docs/polyvers-plan.md).

**Status:** M0 (classifier + shape / vocabulary / intent gates) and M1 (the
**semantic model-check gate**) are implemented. Deterministic, no API key.
The M1 gate is the headline: `scripts/check.mjs` gained an `initialStates`
option (CLI: `--initial-states <states.json>`), so the exhaustive BFS runs
with every fleet snapshot seeded alongside `init()` — the essay's precise
compatibility definition, executable **for changes that touch the module or
the invariants** (the semantic and intent lanes): *v(n+1) is compatible with
the fleet iff no live v(n) state can be driven to an invariant violation
under v(n+1)'s rules.* Seeds are exempt from the exploration cap (the cap
bounds what the BFS discovers, not how many snapshots the fleet holds), and
a FAIL names one witness per violated rule — a compatibility verdict, not
the affected-instance list. The landmine fixture (`test/fixtures/order-v2-landmine/`)
proves the point: its violation passes the pointwise gate AND the from-init
model check, and only the seeded check finds it. A BOUNDED exploration is a
failing gate unless accepted explicitly with `--allow-bounded`
(check-effects doctrine). The migration lane and the in-flight-stimuli gate
are M2 — reports disclose deferred gates as NOT RUN rather than silently
passing.

## Usage

An artifact dir holds `contract.json` + the SAM v2 module (`next.cjs`,
`machine.cjs`, or the only `.cjs`) + optional `invariants.mjs` +
`effects.manifest.json` — exactly what polygen emits.

```bash
# which lanes does this change touch, and what gates do they require?
npm run polyvers -- classify --old machines/order-v1 --new machines/order-v2

# run the gates against a snapshot corpus and write the compat-report
npm run polyvers -- check --old machines/order-v1 --new machines/order-v2 \
  --snapshots archive/ --out out/compat        # archived fleet state, or:
npm run polyvers -- check ... --synthesize     # BFS-reachable states of the OLD machine

npm run test:polyvers
```

`--snapshots` accepts `polyrun archive` output (`*.ndjson`), bare ndjson of
state objects, or a `.json` array of states. `--synthesize` is the weakest
tier — it contains only states the old *model* says are reachable, which is
exactly the assumption a landmine violates — and the report says which
source was used: provenance is part of the verdict. An empty corpus is
refused, never a vacuous PASS.

## The lanes (decision table as data, `src/classify.mjs`)

| lane | fires when | M0 gates | deferred |
|---|---|---|---|
| semantic | the module changed | load · shape-roundtrip · invariants-pointwise · semantic-model-check | — |
| shape | contract `stateKeys` changed | load · shape-roundtrip | migrate (M2) |
| vocabulary | actions / reject reasons / effect kinds / terminal states changed | load · vocabulary | stimuli (M2) |
| intent | `invariants.mjs` changed (state or transition invariants) | load · invariant-diff · invariants-pointwise · semantic-model-check | — |

Gate doctrine, from the SDLC best-practices: a removed action fails the
vocabulary gate (deprecate, don't delete — in-flight stimuli still arrive);
reject-reason renames are vocabulary breaks (they are public API); removing
a terminal state re-animates every instance resting in it, so it fails too;
a strengthened invariant is a fleet event — the gate names the states that
already violate it, so the decision about what they mean happens before
the deploy, not after. An invariant renamed with an identical predicate is
reported as a rename, not a weakening. Machine modules load through the
pipeline's one loader (`scripts/load-spec.mjs`): fresh instance per load,
SAM library pinned to the vendored bundle, module console output to stderr.
