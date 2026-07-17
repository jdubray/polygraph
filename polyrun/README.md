# polyrun — durable execution for verified SAM machines (M0)

polyrun takes the artifact polygen produces — a model-checked, pure SAM v2
strict-profile module — and gives it what Temporal gives arbitrary code:
durable state, reliable side effects, durable timers, and addressable
long-lived instances. Without event-sourced replay: SAM's single sealed state
tree makes resumption a snapshot, so there are no determinism constraints and
no workflow-versioning patches.

Full functional/technical spec: [`docs/polyrun-spec.md`](../docs/polyrun-spec.md).

## Status: M1 (production shape)

M1 adds, on top of the M0 kernel:

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

M2: effect-emission invariants over the machine ∘ mapper composition,
first-class child machines, journal fan-out, continuous audit, read-only UI.
M3: soak, archival/retention, migration tooling, benchmarks.

The demo machine is hand-authored in the exact shape polygen emits; the M0
follow-up is to re-author it with polygen and diff.
