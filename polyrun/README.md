# polyrun — durable execution for verified SAM machines (M0)

polyrun takes the artifact polygen produces — a model-checked, pure SAM v2
strict-profile module — and gives it what Temporal gives arbitrary code:
durable state, reliable side effects, durable timers, and addressable
long-lived instances. Without event-sourced replay: SAM's single sealed state
tree makes resumption a snapshot, so there are no determinism constraints and
no workflow-versioning patches.

Full functional/technical spec: [`docs/polyrun-spec.md`](../docs/polyrun-spec.md).

## Status: M2 (verification flywheel + composition)

M2 adds, on top of M1:

- **Effect-emission checker** (`src/check-effects.mjs`, `polyrun
  check-effects`) — explores the machine ∘ effect-mapper composition
  exhaustively (paths from init over the declared domains) and evaluates
  invariants over per-path EMISSIONS: "chargeCard emitted at most once on any
  reachable path", "no charge after cancel". Bounded runs are reported,
  never silent; an empty invariant set refuses to run (a vacuous pass is not
  a pass). Demo invariants: `demo/effect-invariants.mjs`.
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

## Not yet here (see spec milestones)

M3: concurrency soak, archival/retention, migration tooling over large
snapshot sets, lease extension for long handlers, published benchmarks.

Scope note: the spec's M2 named "effect invariants in polygen's self-repair
loop"; the implemented shape keeps polygen untouched and runs the same check
as a post-authoring gate (`polyrun check-effects`) — the polygen pipeline can
adopt it in-loop later without changes to the checker.

The demo machine is hand-authored in the exact shape polygen emits; the M0
follow-up is to re-author it with polygen and diff.
