# polyvers — the versioning engine (M0)

The fourth engine of the triad-now-quartet: Polygraph **audits**, polygen
**authors**, polyrun **executes**, polyvers **evolves**. It makes
[`docs/VERSIONING.md`](../docs/VERSIONING.md) executable: given two versions
of a machine's artifact family and a source of fleet state, it classifies
the change into the essay's compatibility lanes, runs exactly the gates
that lane requires, and emits a compatibility report a deploy can be gated
on. Plan: [`docs/polyvers-plan.md`](../docs/polyvers-plan.md).

**M0 status (implemented):** classifier + shape / vocabulary / intent gates
over archived or synthesized snapshot corpora. Deterministic, no API key.
The semantic model-check gate (live snapshots as initial states) is M1; the
migration lane and the in-flight-stimuli gate are M2 — reports disclose
deferred gates as NOT RUN rather than silently passing.

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
| semantic | the module changed | load · shape-roundtrip · invariants-pointwise | semantic model check (M1) |
| shape | contract `stateKeys` changed | load · shape-roundtrip | migrate (M2) |
| vocabulary | actions / reject reasons / effect kinds changed | load · vocabulary | stimuli (M2) |
| intent | `invariants.mjs` changed | load · invariant-diff · invariants-pointwise | semantic model check (M1) |

Gate doctrine, from the SDLC best-practices: a removed action fails the
vocabulary gate (deprecate, don't delete — in-flight stimuli still arrive);
reject-reason renames are vocabulary breaks (they are public API); a
strengthened invariant is a fleet event — the gate names the states that
already violate it, so the decision about what they mean happens before
the deploy, not after.
