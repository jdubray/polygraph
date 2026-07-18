# polyvers worked example — versioning the OMS order machine

The [polygen-authored OMS order machine](../polyrun-oms/machines/order/)
gains a feature: **count how many times the customer amended the order**.
That one-sentence change is a *shape* change (new `amendCount` state key), a
*semantic* change (AMEND increments it), and an *intent* change (a new
invariant) — three compatibility lanes, and a fleet of live instances that
was persisted without the new key. This directory is the full polyvers run,
committed: every command below is reproducible from the repo root, no API
key anywhere.

- `order-v1/` — the deployed version (artifacts copied from
  `examples/polyrun-oms`: contract, machine, invariants, effect mapper +
  manifest)
- `order-v2/` — the new version (contract + machine + invariants edited,
  plus the scaffolded `migrate.cjs` and `MIGRATION-NOTE.md`)
- `shipment-v1/` — the shipment child, unchanged across the rollout
- `reports/` — the committed compat-report and matrix report (byte-identical
  when you re-run: polyvers reports are deterministic)

## 1. Classify — which lanes does this change touch?

```bash
node polyvers/bin/polyvers.mjs classify \
  --old examples/polyvers-oms/order-v1 --new examples/polyvers-oms/order-v2
```

Before the migration was scaffolded this reported `lanes: shape, intent,
semantic` — the shape lane demands a migration, so `check` would fail with
"start with `polyvers migrate scaffold`".

## 2. Scaffold the migration

```bash
node polyvers/bin/polyvers.mjs migrate scaffold \
  --old examples/polyvers-oms/order-v1 --new examples/polyvers-oms/order-v2
```

`amendCount` has an `initState` default (`0`), so the scaffold is
**complete** — pure addition, no TODO holes. For a retyped key it would
emit a throwing `HOLE(...)` a human must fill; unfilled holes fail the
migrate gate loudly. `MIGRATION-NOTE.md` is the template the human
completes either way.

## 3. Check — the gates, over fleet states

```bash
node polyvers/bin/polyvers.mjs check \
  --old examples/polyvers-oms/order-v1 --new examples/polyvers-oms/order-v2 \
  --synthesize --out examples/polyvers-oms/reports
```

See [`reports/2c284a8cc5c1/compat-report.md`](reports/2c284a8cc5c1/compat-report.md)
for the result: four lanes (the scaffolded migration fires the migration
lane too), six gates, all PASS over 33 fleet states —

- **migrate** validates `migrate.cjs` fleet-wide (pure by double
  application, accepted by the new module, projection-equal, state AND
  transition invariants hold), then **swaps the corpus**: every downstream
  gate runs over the states the fleet will hold *after* the migration.
- **shape-roundtrip** — the new module reproduces every migrated snapshot.
- **invariants-pointwise** — the strengthened rule holds on every fleet
  state (a violation here would NAME the condemned snapshots).
- **semantic-model-check** — the landmine hunt: an exhaustive model check
  *seeded from the fleet snapshots*, asking whether any live state can be
  DRIVEN to an invariant violation under v2's rules.

`--synthesize` is the weakest corpus tier (it contains only states the old
*model* says are reachable — exactly the assumption a landmine violates);
with a real fleet, export it (`polyrun archive`) and pass `--snapshots`.
Apply stays with `polyrun migrate` (dry run over live snapshots, then
`--apply`).

## 4. Matrix — the rollout window, parent × child

The order machine spawns shipment children. During the rollout, order
{v1,v2} × shipment {v1} coexist:

```bash
node polyvers/bin/polyvers.mjs matrix \
  --parent-old examples/polyvers-oms/order-v1 --parent-new examples/polyvers-oms/order-v2 \
  --child-old examples/polyvers-oms/shipment-v1 --child-new examples/polyvers-oms/shipment-v1 \
  --child-id shipment
```

See [`reports/matrix-report.md`](reports/matrix-report.md): spawn intents are
discovered from each parent version's own mapper (kernel-parity walk),
and all four pairings verify the wiring, every reachable shipment terminal
outcome delivered into every order state, and the parent-terminal cancel
into every shipment state — each landing as accepted or a *named*
observable reject. (Try renaming `CANCEL_SHIPMENT` in a copy of the child
to watch exactly the child-new pairings fail.)

## 5. Product — joint interleavings against cross-machine invariants

The matrix checks protocol and delivery; a delivery-clean pairing can still
hide an interleaving bug (a shipment that delivers under a cancelled order).
The product check explores the JOINT order×shipments state space per pairing
against [`invariants.compose.mjs`](invariants.compose.mjs) — rules neither
machine's own invariants can state:

```bash
node polyvers/bin/polyvers.mjs product \
  --parent-old examples/polyvers-oms/order-v1 --parent-new examples/polyvers-oms/order-v2 \
  --child-old examples/polyvers-oms/shipment-v1 --child-new examples/polyvers-oms/shipment-v1 \
  --parent-id order --child-id shipment \
  --invariants examples/polyvers-oms/invariants.compose.mjs
```

See [`reports/product-report.md`](reports/product-report.md): 45 joint
states per pairing, all four PASS — notable because the OMS shipment's
cancel window is narrow (preparing only); the order machine happens to
block CANCEL during fulfilling, which is exactly the kind of two-machine
coincidence you want a checker, not a code review, to certify. (Narrow the
order's cancel guard in a copy and the product check finds the
delivered-under-cancelled interleaving with a counterexample.)

> Same disclosure as the whole plugin: these are consistency checks, not
> proofs, and they are exactly as good as the invariants the artifacts
> state.
