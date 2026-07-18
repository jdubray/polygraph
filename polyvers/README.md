# polyvers — the versioning engine (M0–M3)

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
under v(n+1)'s rules, over the declared (action, data) domains.* Seeds are exempt from the exploration cap (the cap
bounds what the BFS discovers, not how many snapshots the fleet holds), and
a FAIL names one witness per violated rule — a compatibility verdict, not
the affected-instance list. The landmine fixture (`test/fixtures/order-v2-landmine/`)
proves the point: its violation passes the pointwise gate AND the from-init
model check, and only the seeded check finds it. A BOUNDED exploration is a
failing gate unless accepted explicitly with `--allow-bounded`
(check-effects doctrine).

**M2** completes the lanes. The **migration lane**: `polyvers migrate
scaffold` emits a `migrate.cjs` skeleton (complete for pure additions,
throwing TODO holes for retyped keys) plus a MIGRATION-NOTE template, and
the **migrate gate** validates it corpus-wide — pure by double application,
accepted by the new module, projection-equal, invariants hold. A validated
migration then swaps the corpus: every downstream gate (round-trip,
stimuli, pointwise, seeded model check) runs over the states the fleet will
hold AFTER the migration; apply remains `polyrun migrate --apply`. The
**stimuli gate** checks cross-version delivery: every (action, data)
stimulus the old version could still deliver is fired at the new machine in
every fleet state, and each outcome must be accepted or a NAMED observable
reject — `unhandled`, a throw, or an unnamed reject fails, mirroring the
polyrun kernel's dispatch classification. An LLM-drafted fill of scaffold
TODO holes (polygen-style, self-repaired against the migrate gate) is a
recorded follow-up.

**M3** ships the plugin surfaces (`/polygraph:polyvers` command, the
`polyvers` skill and agent) and attempts the recorded open item: `polyvers
matrix` checks the parent {old,new} × child {old,new} rollout-window
pairings of the **spawn/completion protocol and its delivery** — spawn
wiring per pairing, every reachable child terminal outcome delivered into
every parent fleet state, the parent-terminal cancel delivered into every
child fleet state, all under the accepted-or-named-reject doctrine. Honest
scope, stated in every matrix report: this closes the undefined-behavior
class across the version boundary; the full product-space model check
(joint interleavings against cross-machine invariants) remains open. A
changed `effects.cjs` fires the **composition** lane, whose real gate is
`polyrun check-effects` — the report says so as a NOT RUN row.

## Usage

An artifact dir holds `contract.json` + the SAM v2 module (`next.cjs`,
`machine.cjs`, or the only `.cjs`) + optional `invariants.mjs` +
`effects.manifest.json` + optional `migrate.cjs` — exactly what polygen
emits, plus the migration when the shape changed.

```bash
# which lanes does this change touch, and what gates do they require?
npm run polyvers -- classify --old machines/order-v1 --new machines/order-v2

# run the gates against a snapshot corpus and write the compat-report
npm run polyvers -- check --old machines/order-v1 --new machines/order-v2 \
  --snapshots archive/ --out out/compat        # archived fleet state, or:
npm run polyvers -- check ... --synthesize     # BFS-reachable states of the OLD machine

# shape change? scaffold the migration, review/fill it, re-run check
npm run polyvers -- migrate scaffold --old machines/order-v1 --new machines/order-v2

# parent/child machines? check the rollout-window version pairings
npm run polyvers -- matrix --parent-old machines/order-v1 --parent-new machines/order-v2 \
  --child-old machines/shipment-v1 --child-new machines/shipment-v1 --child-id shipment

npm run test:polyvers
```

Worked example — versioning the OMS order machine (shape + rules + intent
change, scaffolded migration, committed compat-report and matrix report):
[`examples/polyvers-oms/`](../examples/polyvers-oms/README.md).

`--snapshots` accepts `polyrun archive` output (`*.ndjson`), bare ndjson of
state objects, or a `.json` array of states. `--synthesize` is the weakest
tier — it contains only states the old *model* says are reachable, which is
exactly the assumption a landmine violates — and the report says which
source was used: provenance is part of the verdict. An empty corpus is
refused, never a vacuous PASS.

## The lanes (decision table as data, `src/classify.mjs`)

| lane | fires when | gates |
|---|---|---|
| semantic | the module changed | load · shape-roundtrip · invariants-pointwise · semantic-model-check |
| shape | contract `stateKeys` changed | load · migrate · shape-roundtrip |
| migration | `migrate.cjs` added or edited | load · migrate · shape-roundtrip |
| vocabulary | actions / reject reasons / effect kinds / terminal states changed | load · vocabulary · stimuli |
| intent | `invariants.mjs` changed (state or transition invariants) | load · invariant-diff · invariants-pointwise · semantic-model-check |
| composition | `effects.cjs` added or edited | load (+ NOT RUN row → `polyrun check-effects`) |

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
