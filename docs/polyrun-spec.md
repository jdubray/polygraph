# polyrun — a durable execution harness for verified SAM machines

**Status: DRAFT v0.2 — functional and technical specification.**
**v0.2:** the five v0.1 open questions are resolved (§11) and folded into the
body: polygen drafts the effect mapper (§4.3), child machines are first-class
in M2 (FR-8), request/callback is the recommended long-handler pattern
(FR-3.6), journal fan-out lands in M2 (FR-7.5), and the name is `polyrun`.
**M0 is implemented** — kernel, workers, SQLite store, kill-9 demo and
fault-injection tests live under [`polyrun/`](../polyrun/README.md)
(`npm run test:polyrun`, `npm run demo:polyrun`).
**Audience:** contributors to Polygraph/polygen; developers evaluating polyrun
against workflow engines (Temporal, Step Functions, Restate).

---

## 0. One-paragraph summary

polyrun is a thin runtime that takes the artifact polygen already produces — a
**model-checked, pure SAM v2 strict-profile module** plus its contract and
invariants — and gives it what Temporal gives arbitrary code: durable state,
reliable side effects, durable timers, addressable long-lived instances, and
an operational journal. It does this **without event-sourced replay**: SAM's
single sealed state tree makes dehydration/rehydration a snapshot, not a
re-execution, so polyrun has no determinism constraints on deploys, no
workflow-versioning patches, and no sandbox. The bet is inverted from
Temporal's: Temporal durably executes *unverified* logic; polyrun durably
executes logic that is *verified before it ships* — and its production journal
doubles as a Polygraph trace corpus, so the deployed system is continuously
auditable against an independent reading of its own code.

```
                    ┌──────────────────────────────────────────┐
                    │                 polyrun                  │
  actions (HTTP/    │  ┌──────────┐   ┌───────────────────┐   │
  queue/signal) ───▶│  │ dispatch │──▶│  SAM v2 module    │   │
                    │  │  kernel  │   │  (polygen output, │   │
  completions ─────▶│  │          │◀──│   pure, verified) │   │
                    │  └────┬─────┘   └───────────────────┘   │
                    │       │ one ACID txn per step            │
                    │  ┌────▼─────────────────────────────┐   │
                    │  │ store: state snapshot · journal  │   │
                    │  │        outbox · timers · dedupe  │   │
                    │  └────┬─────────────────┬───────────┘   │
                    │       │                 │                │
                    │  ┌────▼──────┐    ┌─────▼──────┐        │
                    │  │  effect   │    │   timer    │        │
                    │  │  runner   │    │  service   │        │
                    │  └────┬──────┘    └─────┬──────┘        │
                    └───────┼─────────────────┼───────────────┘
                            ▼                 ▼
                     idempotent side     fires as ordinary
                     effects (charge,    actions back into
                     ship, email…)       the machine
```

---

## 1. Positioning and scope

### 1.1 The problem

polygen ends at a deliberate handoff: it emits a pure module
(`module.exports = { instance, init, actions, getState, setState }`) and tells
the integrator "call it, don't reimplement it." Everything that makes that
module a *long-running business process* — surviving crashes mid-charge,
firing a 24-hour amend timeout, routing a courier's signal to the right order
instance, retrying a flaky shipping API — is left to the host application.
Teams that need those properties today reach for Temporal and get them, at the
cost of: event-sourced replay determinism, workflow versioning gymnastics, a
heavyweight service dependency, and **zero verification of the logic itself**.

### 1.2 The thesis

The hard correctness problems in a workflow engine split cleanly in two:

1. **Decision correctness** — can the logic ever reach a bad state ("charged
   twice", "shipped without payment")? This is what polygen/Polygraph already
   solve, exhaustively, before deploy.
2. **Execution correctness** — is the decided transition durably recorded, and
   is each decided effect performed at-least-once with a stable idempotency
   key? This is a *small, fixed, logic-free kernel* — the same few hundred
   lines for every machine — and therefore testable once, conventionally.

Temporal fuses the two and solves only the second. polyrun keeps them
separate: the part that varies per application (the state logic) is
machine-checked; the part that is invariant across applications (the durable
kernel) is small enough to test exhaustively by hand.

### 1.3 Explicit non-goals

- **Temporal-scale fleets.** polyrun targets thousands–hundreds of thousands
  of concurrent instances on a single Postgres, not hundreds of millions
  across regions. (§8 NFRs.)
- **Cross-language workflows.** polygen output is JS/TS; so is polyrun.
- **Arbitrary code in the durable core.** Only strict-profile SAM modules are
  hosted. This is a feature: the constraints are what make the logic
  checkable and the snapshot total.
- **Distributed transactions.** polyrun coordinates effects via outbox +
  idempotency, never 2PC.
- **A hosted service.** polyrun is a library plus two worker loops you run
  yourself, backed by a database you already operate.

---

## 2. Concepts and vocabulary

| term | definition |
|---|---|
| **machine** | A polygen-authored SAM v2 strict-profile module, identified by `machineId` + `machineVersion` (content hash of the module file). |
| **instance** | One long-lived execution of a machine (one order, one subscription), identified by `instanceId`. Owns exactly one state snapshot. |
| **action** | A named intent from the machine's contract, dispatched with a `data` payload drawn from the contract's schemas. The only way state changes. |
| **step** | One synchronized SAM acceptance: `(pre, action, data) → post`, classified by `lastStep()` as `accepted \| rejected \| unhandled`. |
| **journal** | The append-only per-instance log of steps. Each row is a Polygraph trace window `{pre, action, data, post}` — the journal **is** a trace corpus. |
| **effect intent** | A pure, declarative description of a side effect the outside world must perform (`chargeCard`, `dispatchShipment`), derived from a step by the effect mapper. Never executed inside the kernel. |
| **effect mapper** | A pure function `effects(pre, action, data, post, stepKind) → EffectIntent[]` shipped alongside the machine. Pure ⇒ model-checkable composed with the machine (§6.2). |
| **completion** | The result of an executed effect, fed back into the instance as an ordinary contract action (e.g. `chargeCard` → `CHARGE_SUCCEEDED` / `CHARGE_FAILED`). |
| **timer** | An effect intent of the built-in kind `timer`: "dispatch action A with data D at time T unless cancelled/stale". |
| **dedupe key** | Caller-supplied `actionId`, unique per instance, making external dispatch at-least-once-safe. |

---

## 3. Functional specification

### FR-1 Instance lifecycle

- **FR-1.1** `create(machineId, instanceId?, initData?)` creates an instance:
  runs the module's `init()`, applies optional creation action, persists the
  initial snapshot, journal row 0, and any effect intents — atomically.
  Returns `instanceId` (ULID if not supplied). Creating an existing
  `instanceId` with the same parameters is idempotent; with different
  parameters it fails with `CONFLICT`.
- **FR-1.2** An instance is `active` until its snapshot satisfies the
  contract's terminal-state predicate, then `terminal`. Terminal instances
  reject all further actions with an observable `rejected(terminal)` journal
  entry (never an error), cancel their outstanding timers, and are eligible
  for archival after a retention window.
- **FR-1.3** An instance whose dispatch throws a non-classifiable error (a
  kernel bug or a module that violates its own strict profile at runtime — by
  construction "cannot happen", so it must be loud) is marked `poisoned`:
  no further dispatch, alert raised, manual resolution required. Poisoning is
  the *only* state the kernel may enter that the model checker has not seen.

### FR-2 Dispatch — the one write path

- **FR-2.1** `dispatch(instanceId, action, data, actionId)` is the sole state
  mutation API. Exactly one step is journaled per accepted dispatch.
- **FR-2.2** **Atomicity:** the new snapshot, the journal row, all derived
  effect-intent rows (outbox), all timer creations/cancellations, and the
  dedupe record commit in **one database transaction**. There is no window in
  which the state says "charging" but no charge intent exists, or vice versa.
- **FR-2.3** **Dedupe:** a redelivered `(instanceId, actionId)` returns the
  original step's result without re-executing. Callers get at-least-once →
  effectively-once dispatch by supplying stable `actionId`s.
- **FR-2.4** **Ordering:** steps for one instance are totally ordered by a
  monotonic `seq`. Concurrent dispatches to the same instance serialize
  (§5.3); the loser re-reads and re-runs against the fresh snapshot — which
  may now legitimately `reject` it. Rejection is a *result*, not an error.
- **FR-2.5** **Observable no-ops:** `rejected` and `unhandled` steps are
  journaled with their `reject(reason)` classification but bump no state and
  emit no effects. This is the strict profile's gift to operations: a stale
  timer or duplicate webhook firing into the wrong state is *safe and
  explained*, not silently absorbed or crashed on.
- **FR-2.6** Dispatch returns `{seq, stepKind, rejectReason?, state}`
  synchronously (the SAM step is synchronous by construction).

### FR-3 Effects — the outbox contract

- **FR-3.1** Effects are **declared, not performed**, by pure code: the effect
  mapper runs inside the dispatch transaction and its output rows land in the
  outbox atomically with the state (transactional outbox pattern).
- **FR-3.2** The **effect runner** (worker loop) claims pending intents and
  invokes the registered handler with `(payload, idempotencyKey)` where
  `idempotencyKey = hash(instanceId, seq, intentName, ordinal)` — stable
  across retries and crashes. **Guarantee: at-least-once execution,
  exactly-once emission.** Handlers must be idempotent; the key makes that
  tractable (pass it to Stripe, use it as a natural key, etc.).
- **FR-3.3** Per-intent retry policy from the effect manifest (§4.2):
  exponential backoff with jitter, `maxAttempts`, per-attempt timeout.
  Exhausted intents go `dead` (DLQ) **and**, if the manifest declares an
  `onExhausted` action, that action is dispatched into the instance — so the
  *machine* decides what payment-provider-is-down means, in verified logic,
  rather than the infrastructure deciding it.
- **FR-3.4** On handler success/failure, the manifest's `onSuccess` /
  `onFailure` action is dispatched back into the instance with the handler's
  result mapped into the action's declared data schema. Completions use
  derived `actionId`s (`{idempotencyKey}:done`) so redelivery is deduped by
  FR-2.3.
- **FR-3.5** Effect handlers are ordinary async JS functions registered with
  the worker. They live **outside** the verified boundary and are the
  integrator's responsibility — same division of labor as Temporal activities.
- **FR-3.6** **Long-running effects: request/callback is the recommended
  pattern.** A handler should *initiate* the slow operation and return
  promptly (passing the idempotency key as the provider's correlation id);
  the eventual result arrives as an external dispatch — an ordinary contract
  action (webhook → `dispatch(instanceId, 'CHARGE_SUCCEEDED', …)`), with the
  machine modeling the intervening wait state. This keeps the waiting logic
  inside the verified boundary (the checker explores the
  completion-races-cancel interleavings) instead of hiding it in an opaque
  in-flight handler. Lease extension (a callback the handler can invoke to
  push out `claimed_until`) exists as the escape hatch for providers with no
  callback mechanism; it is deliberately second-class.

### FR-4 Timers

- **FR-4.1** A timer is an effect intent `{kind: 'timer', key, fireIn|fireAt,
  action, data}`. Creation is atomic with the step that decided it (FR-2.2).
- **FR-4.2** At `fireAt`, the timer service dispatches `(action, data)` into
  the instance with `actionId = timer:{key}:{seq-at-creation}`. **Staleness is
  handled by the machine, not the scheduler:** if the instance has moved on
  (order already amended before the 24 h window closed), the machine `reject`s
  the timer action observably — verified behavior, zero cancellation races.
- **FR-4.3** Explicit cancellation (`{kind: 'cancelTimer', key}`) exists as an
  optimization to keep the timers table small; correctness never depends on it.
- **FR-4.4** Timers survive restarts, fire at-least-once (deduped by FR-2.3),
  and support horizons from seconds to years. Precision target: within
  seconds of `fireAt` under nominal load (NFR-4).

### FR-5 Signals and queries

- **FR-5.1** A "signal" is just `dispatch()` addressed by `instanceId` — the
  courier's `SHIPMENT_DELIVERED` and a fraud analyst's `FRAUD_OVERRIDE` are
  ordinary contract actions. No separate signal machinery exists or is needed.
- **FR-5.2** A "query" is a read of the snapshot: `getState(instanceId)`
  (current) and `getStateAt(instanceId, seq)` (historical, reconstructed from
  the journal's `post`). Queries never touch the module and never block
  dispatch. SAM's single state tree means the query surface is *the whole
  observable state*, by construction — no per-query handler code.
- **FR-5.3** `list(machineId, filterOnStateFields, status)` supports
  operational search over snapshot fields (backed by JSONB indexes; the
  contract's observable fields are the search-attribute schema for free).

### FR-6 Versioning and migration — the replay-free deploy

- **FR-6.1** Because resumption is snapshot-based, deploying machine version
  N+1 requires only that N+1 **accepts version-N snapshots**. There is no
  replay determinism requirement: change the code freely.
- **FR-6.2** **Deploy gate** (CI, mechanical, no API key — reuses Polygraph's
  local checkers):
  1. `instance({}).validate()` strict-clean on the new module;
  2. `setState()` round-trips over a sample (or all) of live snapshots — the
     sealed-shape check makes incompatibility a hard error, not corruption;
  3. `check.mjs` model-checks the new machine **using live snapshots as
     initial states** against the invariants — proving no in-flight instance
     can be driven to a violation by the new code;
  4. if the state shape changed, a pure `migrate(oldState) → newState` is
     required, and step 3 runs over `migrate(snapshot)` — the migration itself
     is inside the checked boundary.
- **FR-6.3** Instances record `machineVersion` per step; mixed-version fleets
  are supported during rollout (each dispatch uses the newest deployed version
  whose gate passed).

### FR-7 Observability and the verification loop

- **FR-7.1** The journal exports as ndjson in Polygraph's trace-window format
  (`{pre, action, data, post}` projected to the contract's observable keys) —
  **zero-instrumentation trace capture**. `polyrun export-traces` feeds
  `/polygraph:verify` directly, closing the loop the polygen skill's Step 4
  mandates ("capture REAL traces from the running integration").
- **FR-7.2** A scheduled **continuous audit** replays the last N hours of
  journal against the machine's spec corpus and re-runs the model check with
  observed states as initial states. Drift between production and the verified
  model — the thing that silently accumulates in every workflow system —
  becomes a scheduled report.
- **FR-7.3** Metrics: dispatch latency, steps/s, outbox lag, timer lag, DLQ
  depth, reject-rate by reason (the `reject(reason)` taxonomy is a free,
  high-signal operational dimension no other engine has). Structured logs
  keyed by `instanceId`/`seq`.
- **FR-7.4** A minimal read-only web UI (later milestone): instance search,
  state view, journal timeline with reject classifications, DLQ, timer queue.
- **FR-7.5** **Journal fan-out (M2):** committed journal rows publish to a
  change stream for read models and projections — Postgres `LISTEN/NOTIFY`
  for the built-in path, with the schema stable enough for CDC (Debezium et
  al.) as the heavy-duty path. Consumers get the same
  `{instanceId, seq, action, data, pre, post, stepKind}` envelope as the
  trace export; the journal remains the single source of truth and fan-out is
  strictly derived (a lost notification is recoverable by re-reading from a
  consumer-held `seq` cursor).

### FR-8 Child machines (M2)

SAM's parent/child instance model maps directly onto workflow decomposition
(Order → Shipments), and polyrun makes it first-class:

- **FR-8.1** A parent spawns a child via a built-in effect intent
  `{kind: 'spawnChild', machineId, childKey, initData}` — atomic with the
  parent's step (FR-2.2), idempotent via
  `childInstanceId = hash(parentId, childKey, seq)`.
- **FR-8.2** The parent/child protocol is **completion actions, same as
  effects**: when a child reaches a terminal state, polyrun dispatches the
  manifest-declared completion action into the parent
  (`SHIPMENT_COMPLETED {childKey, outcome}`), deduped by the child's id. A
  parent may dispatch declared actions into its children
  (`{kind: 'signalChild', childKey, action, data}`) — e.g. propagating a
  cancel. No other coupling exists: each machine sees the other only through
  its own contract's action alphabet.
- **FR-8.3** Each machine is verified independently as today; the manifest
  cross-check (§4.2) extends to the parent/child wiring — every spawn's
  `machineId` must be deployed, every completion/signal action must exist in
  the target contract with a compatible schema. Compositional model checking
  of the parent∘child product (e.g. "no shipment dispatches after order
  cancel" as a cross-machine invariant) is future work beyond M2; until then
  the cross-machine surface is covered by the domain gate plus the continuous
  audit (FR-7.2), and v0.x guidance is to keep cross-machine rules expressible
  as single-machine invariants over completion actions where possible.
- **FR-8.4** Terminal parents cancel their non-terminal children by
  dispatching a manifest-declared cancel action into each (never by deleting
  state); a child that rejects it is journaled and surfaced, not forced.
- Until M2, the OMS-style decomposition is modeled as fields of the parent
  state (shipments as an array in the order machine) — fully supported, just
  coarser-grained.

---

## 4. Artifact extensions (what polygen additionally emits)

polyrun hosts the existing polygen output unchanged and adds two small,
**pure** artifacts, both inside the verifiable boundary:

### 4.1 `effects.cjs` — the effect mapper

```js
// Pure. No I/O, no clock, no randomness. Same discipline as the machine.
module.exports.effects = function effects(pre, action, data, post, stepKind) {
  if (stepKind !== 'accepted') return [];
  const out = [];
  if (pre.orderState !== 'charging' && post.orderState === 'charging') {
    out.push({ kind: 'chargeCard',
               payload: { orderId: post.orderId, amountCents: post.totalCents } });
    out.push({ kind: 'timer', key: 'chargeTimeout',
               fireIn: 'PT2M', action: 'CHARGE_TIMED_OUT', data: {} });
  }
  if (pre.orderState !== 'awaitingAmend' && post.orderState === 'awaitingAmend') {
    out.push({ kind: 'timer', key: 'amendWindow',
               fireIn: 'PT24H', action: 'AMEND_WINDOW_EXPIRED', data: {} });
  }
  return out;
};
```

Deriving effects from **state transitions** (edge-triggered on the snapshot)
rather than from actions keeps the mapper total and checkable: the model
checker already enumerates every reachable `(pre, action, data, post)` edge,
so composing the mapper into exploration is free (§6.2).

### 4.2 `effects.manifest.json` — the effect vocabulary (contract extension)

```json
{
  "effects": {
    "chargeCard": {
      "payloadSchema": { "orderId": "string", "amountCents": "number" },
      "onSuccess":  { "action": "CHARGE_SUCCEEDED", "map": { "txId": "$.result.id" } },
      "onFailure":  { "action": "CHARGE_FAILED",    "map": { "reason": "$.error.code" } },
      "onExhausted":{ "action": "CHARGE_FAILED",    "data": { "reason": "provider-unavailable" } },
      "retry": { "maxAttempts": 6, "backoff": "exponential", "baseMs": 500, "timeoutMs": 15000 }
    },
    "dispatchShipment": { "...": "..." }
  }
}
```

The manifest is to effects what `dataDomain` is to actions: the declared
universe. The same domain cross-check polygen already performs between
contract and code (the enum-spelling lesson of
`case-study-polygen-domain-gap.md`) applies verbatim: every `kind` the mapper
can emit must exist in the manifest; every `onSuccess`/`onFailure`/
`onExhausted` action must exist in the contract's action alphabet with a
compatible schema. Mismatch is a hard gate failure, not a runtime surprise.

### 4.3 polygen pipeline additions

- **polygen drafts `effects.cjs` + manifest** from the same intent, after the
  machine converges — the same rule as contract and invariants: the draft is
  the model's reading of your intent, and it requires human review before it
  is trusted. The report gets an "Effects" section listing every emission
  edge and its completion wiring, so the review is a read, not a hunt.
- Extend the self-repair loop with **effect invariants** (§6.2) over the
  composed exploration.
- Emit `polyrun.config.json` (machine id, version hash, manifest path) so
  `polyrun deploy` is one command.

---

## 5. Technical specification — the kernel

### 5.1 Components

| component | form | responsibility |
|---|---|---|
| `@polygraph/polyrun` | library | dispatch kernel, store adapters, module loader, journal export |
| `polyrun-worker` | process (N replicas) | effect runner + timer service loops |
| `polyrun-api` | optional process | thin HTTP facade over the library (create/dispatch/get/list) for non-JS callers |
| store | Postgres ≥ 14 (prod) / SQLite (dev, tests) | all durable state; the only stateful dependency |

No broker, no separate cluster: Postgres `FOR UPDATE SKIP LOCKED` queues are
sufficient at the target scale (NFR-1) and keep the operational footprint to
"a database you already run".

### 5.2 Data model (Postgres)

```sql
CREATE TABLE pr_instance (
  instance_id     text PRIMARY KEY,
  machine_id      text NOT NULL,
  machine_version text NOT NULL,          -- content hash of module file
  seq             bigint NOT NULL DEFAULT 0,   -- last journaled step
  status          text NOT NULL CHECK (status IN ('active','terminal','poisoned')),
  state           jsonb NOT NULL,         -- the dehydrated single state tree
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON pr_instance (machine_id, status);
CREATE INDEX ON pr_instance USING gin (state jsonb_path_ops);  -- FR-5.3

CREATE TABLE pr_journal (
  instance_id   text   NOT NULL REFERENCES pr_instance,
  seq           bigint NOT NULL,
  action        text   NOT NULL,
  data          jsonb  NOT NULL,
  pre           jsonb  NOT NULL,          -- observable projection
  post          jsonb  NOT NULL,          --   → Polygraph trace window
  step_kind     text   NOT NULL CHECK (step_kind IN ('accepted','rejected','unhandled')),
  reject_reason text,
  action_id     text   NOT NULL,          -- dedupe key (FR-2.3)
  at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (instance_id, seq),
  UNIQUE (instance_id, action_id)         -- dedupe enforced by the database
);

CREATE TABLE pr_outbox (
  intent_id       text PRIMARY KEY,       -- = idempotency key
  instance_id     text   NOT NULL,
  seq             bigint NOT NULL,        -- step that emitted it
  kind            text   NOT NULL,
  payload         jsonb  NOT NULL,
  status          text   NOT NULL CHECK (status IN ('pending','inflight','done','dead')),
  attempts        int    NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  claimed_until   timestamptz,            -- lease; crash recovery = lease expiry
  last_error      text
);
CREATE INDEX ON pr_outbox (status, next_attempt_at) WHERE status = 'pending';

CREATE TABLE pr_timer (
  timer_id    text PRIMARY KEY,           -- hash(instance_id, key, seq)
  instance_id text   NOT NULL,
  key         text   NOT NULL,
  fire_at     timestamptz NOT NULL,
  action      text   NOT NULL,
  data        jsonb  NOT NULL,
  status      text   NOT NULL CHECK (status IN ('scheduled','fired','cancelled'))
);
CREATE INDEX ON pr_timer (status, fire_at) WHERE status = 'scheduled';
```

Journal `pre`/`post` store the **observable projection** (contract keys), not
the full model — FR-7.1's export is then a `SELECT`. Full-state audit copies
are unnecessary because the strict profile forbids hidden bookkeeping state:
observable *is* total.

### 5.3 The dispatch algorithm

```
dispatch(instanceId, action, data, actionId):
  BEGIN;
    row ← SELECT * FROM pr_instance WHERE instance_id = $1 FOR UPDATE;   -- single writer
    if journal has (instanceId, actionId): COMMIT; return cached result; -- dedupe
    if row.status ≠ 'active': journal a rejected(terminal|poisoned) row; COMMIT; return;

    m ← moduleCache.get(row.machine_id, deployedVersion)                 -- loaded once per process
    m.setState(row.state)                                                -- rehydrate (total, strict)
    pre ← project(m.getState())
    m.actions[action](data)                                              -- the synchronized SAM step
    step ← m.lastStep()                                                  -- accepted|rejected|unhandled
    post ← project(m.getState())

    intents ← step.kind == 'accepted' ? effects(pre, action, data, post, step.kind) : []
    validate(intents against manifest)                                   -- belt over the checked braces

    INSERT journal row (seq = row.seq + 1, …, actionId);
    if step.kind == 'accepted':
      UPDATE pr_instance SET state = m.getState(), seq = seq+1,
             status = isTerminal(post) ? 'terminal' : 'active';
      INSERT pr_outbox rows (intent_id = hash(instanceId, seq, kind, ordinal));
      INSERT/UPDATE pr_timer rows; cancel timers per cancelTimer intents;
      if terminal: UPDATE pr_timer SET status='cancelled' WHERE instance_id=$1 AND status='scheduled';
  COMMIT;
  return { seq, stepKind, rejectReason?, state: post }
```

Notes:

- **Single-writer** per instance via the row lock; contention on one hot
  instance is inherent to serialized steps (as it is in Temporal) and bounded
  by step cost — a pure in-memory function call, typically <1 ms.
- **Module instances are pooled per process** and `setState()` fully
  overwrites the sealed shape, so pooling is safe by the strict profile's
  round-trip guarantee (and per the house rule: `getState()`/`setState()`
  only, never `instance({}).state()`).
- **Any throw** inside the region between `setState` and journal insert
  aborts the transaction — the instance is untouched; a throw that the strict
  profile says cannot happen (schema violation from inside the module) poisons
  the instance (FR-1.3).
- The kernel is **~one page of code**. That is the point: everything above it
  is verified, everything below it is Postgres.

### 5.4 Effect runner loop (per worker, per poll)

```
BEGIN;
  batch ← SELECT … FROM pr_outbox
          WHERE status='pending' AND next_attempt_at <= now()
          ORDER BY next_attempt_at
          FOR UPDATE SKIP LOCKED LIMIT $B;
  UPDATE batch SET status='inflight', claimed_until = now() + lease;
COMMIT;

for each intent in batch (concurrently, bounded):
  try:
    result ← handlers[intent.kind](intent.payload, intent.intent_id)      -- with timeoutMs
    mark done; dispatch(onSuccess.action, mapped(result), actionId = intent.intent_id + ':done')
  catch err:
    attempts++
    if attempts ≥ maxAttempts:
      mark dead; if onExhausted: dispatch(onExhausted.action, …)
    else:
      mark pending; next_attempt_at = now() + backoff(attempts) + jitter
```

A crashed worker's `inflight` rows revert to `pending` when `claimed_until`
expires — at-least-once by lease, exactly the recovery model of a Temporal
activity timeout, minus the heartbeat protocol (long-running handlers may
extend their lease via a callback; v0.1 keeps handlers short and idempotent).

The timer service is the same loop over `pr_timer` (`fire_at <= now()`),
whose "handler" is just `dispatch(action, data, actionId = timer_id)`.
Staleness needs no coordination: the machine rejects what no longer applies
(FR-4.2).

### 5.5 Failure-mode matrix

| failure | outcome |
|---|---|
| crash before dispatch txn commits | nothing happened; caller retries with same `actionId` → deduped |
| crash after commit, before caller sees reply | state + intents durable; caller retry deduped, gets cached result |
| crash between state update and outbox write | **impossible** — same transaction (FR-2.2) |
| effect handler crashes mid-call | lease expires → retried with same idempotency key; handler idempotency absorbs the duplicate |
| effect succeeds but completion dispatch lost | completion `actionId` is derived → redelivery deduped; runner retries completion until journaled |
| provider down for a day | backoff → DLQ → `onExhausted` action lets *verified logic* decide (cancel order, park for review) |
| timer fires after the state moved on | machine `reject(reason)` — journaled, harmless, verified |
| duplicate/racing external signals | row lock serializes; loser re-runs on fresh state; rejection is an observable result |
| bad deploy (shape or invariant regression) | blocked by the FR-6.2 gate before any instance sees it |
| Postgres down | polyrun is down — honest single-dependency failure mode; HA is the database's HA |

---

## 6. Verification story — what is checked, by what

Three concentric layers, from machine-checked to conventionally tested:

### 6.1 The machine (existing polygen guarantee)

Exhaustive exploration of the contract's action/data domains against
`invariants.mjs`; self-repair; determinism double-pass; independently
replayed synthesized corpus. Unchanged.

### 6.2 The machine ∘ effect mapper composition (new, and the headline)

Because the mapper is pure over `(pre, action, data, post)` edges the checker
already enumerates, `check.mjs` gains a `--effects` mode that accumulates
per-path effect emissions and evaluates **effect invariants**:

```js
// invariants.effects.mjs
export const atMostOneChargePerOrder = (path) =>
  path.emitted.filter(e => e.kind === 'chargeCard').length <= 1;

export const noChargeAfterCancel = (path) =>
  !path.emitted.some((e, i) => e.kind === 'chargeCard' && path.cancelledBefore(i));

export const everyChargeReachesResolution = (path) =>   -- liveness-ish, bounded
  path.terminal ? path.emitted.every(e => e.kind !== 'chargeCard' || path.resolved(e)) : true;
```

This closes the loop the README's case study opens: the production
double-charge class becomes an invariant over *emissions*, checked over every
reachable path **before deploy** — not just "state never says charged-twice"
but "the charge intent itself is never emitted twice". Temporal has no
counterpart to this layer at all.

Scope note: exploration covers the machine + mapper composition under the
declared domains. It does **not** model the outside world's latencies; the
world's responses enter as completion actions, which *are* in the explored
alphabet — so "CHARGE_SUCCEEDED arrives after CANCEL" is a path the checker
visits. This is exactly the interleaving class production bugs live in.

### 6.3 The kernel (conventional, once)

The kernel is logic-free and fixed, so it is tested conventionally and hard:
transactional property tests (crash injection between every pair of
operations via a fault-injecting store adapter), a Jepsen-style concurrent
dispatch soak, and the standard suite running against SQLite in CI with no
API key — same philosophy as the existing `npm test` tier. The kernel's own
correctness obligations (FR-2.2 atomicity, FR-2.3 dedupe, lease recovery) are
enumerable and small; they never grow with application count.

And in production, FR-7.1/7.2 keep auditing the deployed composition forever:
the journal is a trace corpus, `/polygraph:verify` is the drift detector.

---

## 7. API sketch (library)

```js
import { createRuntime } from '@polygraph/polyrun';

const rt = await createRuntime({
  store: { postgres: process.env.DATABASE_URL },
  machines: [{
    machineId: 'order',
    module:   './out/next.cjs',
    contract: './out/contract.json',
    effects:  { mapper: './out/effects.cjs', manifest: './out/effects.manifest.json' },
    migrate:  './out/migrate.cjs',      // optional, gated (FR-6.2)
  }],
  handlers: {
    chargeCard:       async (p, idemKey) => stripe.charges.create({ ...p, idempotency_key: idemKey }),
    dispatchShipment: async (p, idemKey) => shippingApi.dispatch(p, idemKey),
  },
});

const { instanceId } = await rt.create('order', undefined, { items, customerId });
await rt.dispatch(instanceId, 'SUBMIT', {}, `submit:${cartId}`);
const state = await rt.getState(instanceId);

rt.startWorkers({ effectConcurrency: 16, timerPollMs: 500 });  // or run polyrun-worker separately
```

CLI: `polyrun deploy` (runs the FR-6.2 gate), `polyrun export-traces`,
`polyrun audit` (FR-7.2), `polyrun dlq ls|retry|discard`.

---

## 8. Non-functional requirements

- **NFR-1 Throughput:** ≥ 500 accepted steps/s sustained on a single
  db.r6g.large-class Postgres; ≥ 100k active instances with p99 dispatch
  < 50 ms (excluding caller network). Bottleneck is Postgres commit rate by
  design.
- **NFR-2 Durability:** no accepted step or emitted intent lost under any
  single-process crash; RPO = last committed transaction.
- **NFR-3 Kernel size:** dispatch kernel ≤ ~500 LoC excluding adapters;
  reviewable in one sitting. This is a hard requirement, not an aspiration —
  it is the trust argument.
- **NFR-4 Timer precision:** fire within 5 s of `fire_at` at nominal load.
- **NFR-5 Ops footprint:** Postgres is the only stateful dependency; workers
  are stateless and horizontally scalable.
- **NFR-6 No API key at runtime:** like every checking tier in Polygraph,
  polyrun's runtime and deploy gate are pure local execution.

---

## 9. Honest comparison with Temporal (post-polyrun)

| dimension | Temporal | polygen + polyrun |
|---|---|---|
| logic correctness | none — durably executes bugs | model-checked pre-deploy; effect-emission invariants (§6.2) |
| state durability | event-sourced history + replay | snapshot per step, ACID |
| code constraints | deterministic, sandboxed workflow code | strict-profile SAM (pure, sealed, declared domains) |
| versioning in-flight work | `patch()`/worker-versioning; replay compatibility forever | snapshot-compatible deploys; mechanical gate incl. model check over live states |
| effects | activities, at-least-once, retries, heartbeats | outbox intents, at-least-once, retries, leases (no heartbeat protocol in v0.1) |
| timers | durable, arbitrary horizon | durable, arbitrary horizon; staleness handled by verified rejects |
| signals/queries | dedicated APIs, per-query handlers | ordinary actions / snapshot reads — no extra machinery |
| history/audit | full event history (its killer feature) | full step journal, which is *also* a verification corpus |
| scale ceiling | very high (multi-region, millions of instances) | one Postgres (NFR-1); sharding is future work |
| languages | Go/Java/TS/Python/.NET/PHP | JS/TS only |
| ops footprint | Temporal cluster (or Cloud) + DB | your existing Postgres |
| ecosystem maturity | battle-tested, large community | does not exist yet (this document) |

Where Temporal remains the right call: polyglot shops, extreme scale,
long-running heartbeating activities, and organizations buying the mature
ecosystem. Where polyrun supersedes it: JS/TS systems at ordinary scale whose
teams want the *logic* guaranteed, the deploy story sane, and the ops
footprint to be "the database we already have".

---

## 10. Milestones

- **M0 — kernel proof (target: 2–3 weeks of focused work)**
  Library kernel (dispatch, journal, dedupe) + SQLite adapter + in-process
  effect runner + timers. Fault-injection test suite. **Demo: the Temporal
  OMS order flow** — polygen-author the Order/Charge/Shipment machines with
  effect mappers, run the amend-with-timeout scenario, kill -9 the process
  mid-charge, watch it recover. This demo is the whole argument in one script.
- **M1 — production shape**
  Postgres adapter, standalone `polyrun-worker`, leases + DLQ + `onExhausted`,
  HTTP facade, metrics, `polyrun deploy` gate (FR-6.2), trace export.
- **M2 — the verification flywheel + composition**
  `check.mjs --effects` with effect invariants in polygen's self-repair loop;
  manifest/contract/mapper domain cross-checks; continuous audit command;
  minimal read-only UI; **first-class child machines (FR-8)**; journal
  fan-out via `LISTEN/NOTIFY` (FR-7.5).
- **M3 — hardening**
  Concurrency soak, archival/retention, migration tooling over large
  snapshot sets, lease-extension for long handlers, benchmark publication
  against NFR-1.

---

## 11. Decision log (resolved 2026-07-16)

1. **Effect mapper authorship** — **polygen drafts, human reviews**, same
   rule as contract/invariants. Folded into §4.3.
2. **Child machines** — **first-class, in M2**, with completion actions as
   the parent/child protocol. Specified as FR-8; until M2, decompose as
   fields of the parent state.
3. **Long-running handlers** — **request/callback is the recommended
   pattern** (the machine models the wait, keeping the interleavings inside
   the verified boundary); lease extension is the second-class escape hatch.
   Folded into FR-3.6.
4. **Read-model fan-out** — **yes, M2**: `LISTEN/NOTIFY` built-in, CDC-stable
   schema. Folded into FR-7.5.
5. **Name** — **`polyrun`**, confirmed.

---

*Related: README §"How it works"; `skills/polygen/SKILL.md` Step 4 (the
integration handoff this spec closes); `examples/case-study-subscription.md`
(the bug class §6.2 targets);
`examples/case-study-polygen-domain-gap.md` (the domain cross-check §4.2
extends); Temporal OMS reference app
<https://github.com/temporalio/reference-app-orders-go> (the M0 demo target).*
