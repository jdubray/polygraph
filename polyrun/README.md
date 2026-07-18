# polyrun — durable execution for verified SAM machines (M0)

polyrun takes the artifact polygen produces — a model-checked, pure SAM v2
strict-profile module — and gives it what Temporal gives arbitrary code:
durable state, reliable side effects, durable timers, and addressable
long-lived instances. Without event-sourced replay: SAM's single sealed state
tree makes resumption a snapshot, so there are no determinism constraints and
no workflow-versioning patches.

Full functional/technical spec: [`docs/polyrun-spec.md`](../docs/polyrun-spec.md).

## Status: M3 (hardened) — all spec milestones implemented

M3 adds, on top of M2:

- **Concurrency soak** (`test/soak.test.mjs`) — instances × rounds of racing
  dispatchers (duplicate actionIds, stale actions, a flaky provider) with
  workers live, then a full durable-state invariant check: journals dense
  and chaining, snapshots equal to the last accepted post, exactly one
  charge intent per completed order, nothing poisoned.
- **Benchmarks** (`bench/bench.mjs`, `npm run bench:polyrun`) — NFR-1:
  ~1200 accepted steps/s SQLite, ~990 steps/s local-Docker Postgres
  (target ≥500), p99 ~20 ms.
- **Archival/retention** (`polyrun archive --before <t> --out <dir>
  [--apply]`, FR-1.2) — exports each settled terminal instance (journal +
  final state, ndjson) then purges; unsettled effects block the purge;
  `--apply` requires an export. SQLite's fan-out cursor moved to an explicit
  monotonic `global_seq` (rowid is unsafe under deletion).
- **Migration tooling** (`polyrun migrate [--apply]`, FR-6.2 step 4) — a
  pure `migrate.cjs` validated over every live snapshot (new module must
  accept the result; state invariants must hold) before `--apply` rewrites.
- **Lease extension** (FR-3.6 escape hatch) — `ctx.extendLease(ms)` in
  handlers extends both the lease and the attempt's timeout budget;
  request/callback remains the recommended pattern.

M2 (verification flywheel + composition) provides:

- **Effect-emission checker** (`src/check-effects.mjs`, `polyrun
  check-effects`) — explores the machine ∘ effect-mapper composition
  exhaustively (paths from init over the declared domains) and evaluates
  invariants over per-path EMISSIONS: "chargeCard emitted at most once on any
  reachable path", "no charge after cancel". Bounded runs are reported,
  never silent; an empty invariant set refuses to run (a vacuous pass is not
  a pass). Demo invariants: `demo/effect-invariants.mjs`.
- **Parent×child product checker** (`src/check-product.mjs`, `polyrun
  check-product --parent <machineId> --invariants <compose.mjs>`) — the
  composition plan's CP-M1 (docs/composition-plan.md,
  docs/composition-semantics.md): exhaustive BFS over the JOINT
  parent×children state space against cross-machine invariants ("no delivered
  shipment under a cancelled order"). Each transition is one external
  stimulus plus its full kernel cascade closure — sound because the kernel
  runs cascades atomically in the dispatching step's transaction, so stimulus
  order is the fleet's only nondeterminism. Reports author invariants plus
  the built-in doctrine classes (reachable poison, unhandled cascade
  delivery, unnamed rejects, childKey collisions); counterexamples are
  shortest stimulus sequences with the cascade journal inline; the test suite
  replays the invariant-violation counterexample class through the real
  kernel (poison/doctrine classes rely on the mirrored dispatch ladder until
  the shared `cascadeStep()` extraction lands — a recorded follow-up).
  Bounded runs fail unless `--allow-bounded`; an empty invariant set refuses.
  Fixture pair: `test/fixtures/compose/`. For products beyond exhaustive
  reach (CP-M2): `--abstract-child <id>` collapses a child to running +
  terminal outcomes (refinement-checked by an exhaustive, double-passed
  child BFS with its own `--abstract-max-states` cap — a PASS stays sound
  for status/terminal-reading invariants, a FAIL is an abstract witness to
  confirm concretely; poison-class cancels and refinement-unchecked
  deliveries surface as findings, never as silent over-approximation), and
  `--pct N --seed S` switches to seeded PCT sampling (random priority
  schedules; `--pct-depth` orders inter-target stimuli) — a sampler
  falsifies reproducibly but never proves, so a sampled result carries
  `ok: false` and a clean run fails unless `--allow-sampled`.
- **DST fleet simulator** (`src/simulate.mjs`, `polyrun simulate --parent
  <machineId> --invariants <compose.mjs>`) — CP-M4: seeded deterministic
  falsification against the REAL kernel (in-memory stores, injected clock,
  mulberry32 schedules). Parity runs step the product checker's model in
  lockstep — the durable joint state must equal the model's after every
  dispatch, so mirror drift surfaces as a `parity-divergence` finding
  instead of waiting for a wrong verdict. Chaos runs add duplicate
  actionIds (dedupe path), stale deliveries to terminal instances (FR-1.2
  status-reject), and mid-commit store faults with same-actionId redelivery
  (crash-retry atomicity), auditing the journals continuously. Every
  finding carries {seed, run, step, trail} for exact replay; a clean run is
  falsification evidence, never a proof — pair with check-product. Timers/
  outbox execution stay with the soak's worker storm (disclosed boundary).
- **Continuous audit** (`src/audit.mjs`, `polyrun audit`) — replays the
  production journal (which IS a Polygraph trace corpus) through the module:
  post-state mismatches and journaled-rejections-the-module-now-accepts
  surface as drift.
- **First-class child machines (FR-8)** — `spawnChild` (atomic with the
  parent's step, creation action included), `signalChild` (a rejecting child
  is journaled, not forced), and terminal children notifying parents in the
  same transaction, deduped by child id. Cascade depth capped; PG deadlock
  (parent↔child lock inversion) retried.
- **Journal fan-out (FR-7.5)** — `rt.events` emits 'step' post-commit only;
  cross-process consumers page `store.journalSince(cursor)` (SQLite rowid /
  PG bigserial).
- **Read-only UI** (`GET /` on polyrun-api) — instance search, state,
  journal timeline with reject classifications. Self-contained, no external
  assets.

M1 (production shape) provides:

- **Postgres adapter** (`src/store-pg.mjs`) — pool + `FOR UPDATE` row locks
  (multi-writer FR-2.4), `SKIP LOCKED` claims, jsonb state with GIN index.
  The whole test suite runs against it: start Postgres, set
  `POLYRUN_PG_URL=postgres://...`, run `npm run test:polyrun`.
- **Standalone worker** (`bin/polyrun-worker.mjs`) — stateless, horizontally
  scalable effect/timer loops over a `polyrun.config.mjs`.
- **HTTP facade** (`bin/polyrun-api.mjs`, `src/http.mjs`) — create/dispatch/
  state/journal/traces/metrics for non-JS callers; loopback by default.
- **CLI** (`bin/polyrun.mjs`) — `deploy` (the FR-6.2 gate: load gates +
  setState round-trip over live snapshots + pointwise state invariants),
  `export-traces`, `dlq ls|retry|discard`. No API key, ever (NFR-6).
- **Metrics** — `rt.metrics` counters, served at `/metrics`.

The async store interface serializes SQLite callers with a mutex +
AsyncLocalStorage txn context; one process per SQLite file, any number of
processes on Postgres.

What exists from M0:

- **Kernel** (`src/kernel.mjs`) — the one write path: rehydrate
  (`init()` + `setState()`), fire `actions[name](data)`, classify via
  `lastStep()`, commit snapshot + journal + effect intents + timers in one
  SQLite transaction. Dedupe by `(instanceId, actionId)`. Terminal and
  poisoned instances reject observably.
- **Workers** (`src/workers.mjs`) — effect runner (outbox, leases, retries
  with backoff, DLQ + `onExhausted`) and timer service. Stale timers need no
  cancellation races: the machine `reject(reason)`s them, verifiably.
- **Store** (`src/store.mjs`) — `node:sqlite`, WAL, four tables mirroring
  spec §5.2, with a fault-injection hook for atomicity tests.
- **Demo** (`demo/`) — the Temporal OMS reference app's order flow
  (submit → fraud check → charge → ship, with amend-on-unavailable + timeout),
  as a strict-profile machine + pure effect mapper + manifest.

## Run it

```bash
# kernel tests (no API key, in-memory SQLite, deterministic worker ticks)
npm run test:polyrun

# the M0 demo: kill -9 mid-charge, restart, recover — exactly one charge
npm run demo:polyrun
```

The demo starts a worker driving an order, SIGKILLs it the moment the charge
request reaches the (file-backed, idempotency-keyed) payment provider, then
restarts it. The lease expires, the charge retries with the same idempotency
key, the provider dedupes, the order completes. The journal it prints is also
a Polygraph trace corpus (`rt.exportTraces()`).

## Scope notes

- The spec's M2 named "effect invariants in polygen's self-repair loop"; the
  implemented shape keeps polygen untouched and runs the same check as a
  post-authoring gate (`polyrun check-effects`) — the polygen pipeline can
  adopt it in-loop later without changes to the checker.
- Compositional model checking of the parent∘child product is now available
  at HEAD versions via `polyrun check-product` (composition plan CP-M1: one
  parent, its direct children, exhaustive within declared domains or loudly
  BOUNDED). It is opt-in — it runs only when invoked with authored
  cross-machine invariants; for fleets without them, the always-on backstop
  is unchanged: the domain gate, per-machine checks, and the continuous
  audit cover the cross-machine surface as before. Version-pairing products
  (parent-vN × child-vM) are covered by `polyvers product` (CP-M3), which
  runs this same checker per rollout-window pairing. Still open, per
  docs/composition-plan.md: grandchildren (children with their own mappers —
  check-product refuses such configs rather than certifying an unmodeled
  fleet) and joint mid-flight seeding (parent + linked-children snapshots
  as BFS seeds).

The demo machine is hand-authored in the exact shape polygen emits; the M0
follow-up is to re-author it with polygen and diff.
