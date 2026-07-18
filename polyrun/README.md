# polyrun — durable execution for verified machines

**Temporal durably executes code you hope is correct. polyrun durably
executes code that was model-checked before it shipped — and keeps checking
it in production.**

polyrun takes what polygen produces — a model-checked, pure SAM v2
strict-profile state machine — and gives it what a workflow engine gives
arbitrary code: durable state, reliable side effects, durable timers, and
addressable long-lived instances.

The third of five engines: Polygraph **audits**, polygen **authors**,
polyrun **executes**, polyvers **evolves**, polynv **elicits**.

## The bet, inverted

Durable execution engines exist because long-running business processes
crash halfway through, and you want them to resume rather than corrupt.
Temporal solves that by replaying your workflow's event history to
reconstruct its state — which works, but the price is steep and structural:

- your code must be **deterministic on replay**, so no clocks, no random,
  no direct I/O, no iterating a map — a set of rules you can violate by
  accident and discover in production;
- changing a running workflow means **versioning patches** (`getVersion`,
  branch on it, keep the branch forever) because old histories must still
  replay through new code;
- and the engine has no idea whether the logic it's faithfully resuming is
  *correct*. It guarantees your bug survives a crash intact.

polyrun inverts both halves. The thing it runs is a **verified state
machine** with a single sealed state tree, which means resumption is just
**loading a snapshot** — not replaying a history. That one change removes
the determinism constraints and the versioning patches outright: there is
no replay to be nondeterministic, and no old history to keep compatible.

And because the artifact is a machine with a declared contract, the
runtime can keep checking it: **the production journal is a Polygraph trace
corpus**, so a deployed system is continuously auditable against an
independent reading of its own code.

## See it survive a crash

```bash
npm run demo:polyrun
```

The demo drives an order to the charge step, then `SIGKILL`s the worker at
the exact moment the charge request reaches the (file-backed,
idempotency-keyed) payment provider — the worst possible instant, after the
side effect left the process but before anything recorded that it did.

Restart. The lease expires, the charge retries under the same idempotency
key, the provider dedupes it, the order completes. **Exactly one charge.**
The journal it prints at the end is also a valid Polygraph trace corpus.

```bash
npm run test:polyrun     # kernel tests: no API key, in-memory SQLite, deterministic ticks
```

## How it works: one write path

Every state change in polyrun goes through a single function — `dispatch`
— and every dispatch is **one ACID transaction**:

> rehydrate the machine (`init()` + `setState()`) → fire
> `actions[name](data)` → classify the step via `lastStep()` → commit the
> snapshot, the journal row, the emitted effect intents, the timer rows,
> and the dedupe record **together, or not at all**.

Three consequences do most of the work:

- **Duplicates are free.** Dedupe is by `(instanceId, actionId)`, so a
  redelivered action returns the original step's result without
  re-executing. At-least-once delivery stops being a hazard.
- **Nothing unexpected is undefined.** A stale timer, a duplicate
  completion, an action that doesn't apply in this state — the strict
  profile makes each one an observable `reject(reason)`, journaled with its
  reason. Stale timers need no cancellation races: the machine simply
  rejects them, verifiably.
- **"Cannot happen" is loud.** If a *verified* module does something
  impossible — throws mid-step, mutates then rejects, produces an
  unreadable classification, emits an undeclared effect kind — the instance
  is **poisoned**: durably quarantined with the reason, never silently
  retried. A caller's schema-invalid payload is not that; it's an ordinary
  observable reject, and the instance stays healthy.

Effects live in a **pure mapper** (`effects.cjs`) that turns a transition
into declared intents. The kernel commits them to an outbox in the same
transaction; workers run them with leases, backoff, a DLQ, and an
`onExhausted` completion action, each under a derived idempotency key.
Effects are *emitted exactly once, executed at least once* — the honest
guarantee, with the machine absorbing the difference.

Machines compose as **parent/child** (`spawnChild`, `signalChild`, terminal
children notifying parents), and the whole cascade commits inside the
parent's transaction. That atomicity is what makes the composition checkers
below tractable: stimulus arrival order is a fleet's only nondeterminism.

## The verification flywheel

This is what polyrun has that a workflow engine doesn't. Every command
below is deterministic and needs no API key.

| command | what it checks |
|---|---|
| `polyrun deploy` | the release gate: modules load strict-clean, and every **live snapshot** round-trips through the new code with its invariants intact |
| `polyrun check-effects` | machine ∘ mapper: *"chargeCard is emitted at most once on any reachable path"*, *"no charge after cancel"* — over emissions, not just states |
| `polyrun check-product` | the **joint** parent×child state space vs cross-machine invariants: *"no delivered shipment under a cancelled order"*, with the shortest stimulus path to the violation |
| `polyrun simulate` | seeded DST against the real kernel — store faults, duplicate and stale deliveries, with the checker's model stepped in lockstep so model↔kernel drift surfaces as a finding |
| `polyrun audit` | replays the **production journal** through the module and reports drift — the deployed system, checked against itself, continuously |

The doctrine is uniform across all of them: a bounded or sampled run is
**not a pass** unless you accept it explicitly, an empty invariant set
refuses to run rather than certify nothing, and anything the tool cannot
model it **refuses** rather than quietly approximating.

```bash
polyrun check-product --config polyrun.config.mjs --parent order \
  --invariants invariants.compose.mjs        # + --abstract-child / --pct to scale
polyrun simulate --config polyrun.config.mjs --parent order \
  --invariants invariants.compose.mjs --seed 7
```

Details: [`docs/composition-semantics.md`](../docs/composition-semantics.md)
for the joint-state model and its soundness argument.

## Running it for real

- **Stores** — SQLite (`node:sqlite`, WAL) for one process per file;
  Postgres (`FOR UPDATE` row locks, `SKIP LOCKED` claims, jsonb + GIN) for
  any number of writers. The whole test suite runs against both: set
  `POLYRUN_PG_URL` and re-run.
- **Workers** (`bin/polyrun-worker.mjs`) — stateless effect and timer loops
  over a `polyrun.config.mjs`, scaled horizontally.
- **HTTP facade** (`bin/polyrun-api.mjs`) — create/dispatch/state/journal/
  traces/metrics for non-JS callers, loopback by default, with a read-only
  UI at `GET /` (instance search, state, journal timeline with reject
  classifications).
- **Operations** — `polyrun migrate` (a pure `migrate.cjs` validated over
  every live snapshot before `--apply` rewrites), `polyrun archive`
  (export-then-purge settled terminal instances; unsettled effects block
  the purge), `polyrun export-traces`, `polyrun dlq ls|retry|discard`.
- **Throughput** — ~1200 accepted steps/s on SQLite, ~990 on local-Docker
  Postgres, p99 ~20 ms (`npm run bench:polyrun`; the spec's target is ≥500).
- **Soak** — `test/soak.test.mjs` runs racing dispatchers with duplicate
  actionIds, stale actions, and a flaky provider while workers are live,
  then checks the durable state: journals dense and chaining, snapshots
  equal to the last accepted post, exactly one charge per completed order,
  nothing poisoned.

## Honest scope

- polyrun assumes the machine it hosts is a **verified strict-profile
  module**. It contains no business logic and adds no correctness of its
  own — it makes a verified artifact durable, and makes violations of the
  artifact's contract loud.
- **Effect handlers are yours**, and must be idempotent under the provided
  key — the same division as Temporal activities.
- Every "exhaustive" check is exhaustive **over the declared finite
  (action, data) domains**, not over unbounded real data.
- `check-product` is opt-in: it runs when you author cross-machine
  invariants. Fleets without them keep the always-on backstop (the domain
  gate, per-machine checks, the continuous audit). Version-pairing products
  are `polyvers product`'s job.
- Still open, tracked in
  [`docs/composition-plan.md`](../docs/composition-plan.md): grandchildren
  (a child with its own mapper is refused, not modeled) and joint
  mid-flight seeding.
- The demo machine is hand-authored in the exact shape polygen emits;
  re-authoring it with polygen and diffing is a recorded follow-up.

Full functional and technical specification, including the failure matrix
and the FR/NFR numbering the code comments reference:
[`docs/polyrun-spec.md`](../docs/polyrun-spec.md). Where this sits among
the five engines: [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md).
