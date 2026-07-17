# polyrun — durable execution for verified SAM machines (M0)

polyrun takes the artifact polygen produces — a model-checked, pure SAM v2
strict-profile module — and gives it what Temporal gives arbitrary code:
durable state, reliable side effects, durable timers, and addressable
long-lived instances. Without event-sourced replay: SAM's single sealed state
tree makes resumption a snapshot, so there are no determinism constraints and
no workflow-versioning patches.

Full functional/technical spec: [`docs/polyrun-spec.md`](../docs/polyrun-spec.md).

## Status: M0 (kernel proof)

What exists:

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

M1: Postgres adapter, standalone worker process, HTTP facade, `polyrun deploy`
gate. M2: `check.mjs --effects` effect-emission invariants in polygen's
self-repair loop, first-class child machines, journal fan-out, read-only UI.

The demo machine is hand-authored in the exact shape polygen emits; the M0
follow-up is to re-author it with polygen and diff.
