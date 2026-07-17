# polyrun-oms — the Temporal OMS reference app, reimplemented on polyrun

A behavioral reimplementation of Temporal's
[order-management reference application](https://github.com/temporalio/reference-app-orders-go)
on the polyrun durable-execution harness — with the one property the original
cannot claim: **every machine in it is LLM-authored from a pinned contract and
model-checked before it ever ran.**

## What it models

- **Order** (`machines/order/`, polygen-authored): submit with a fulfillment
  count → fraud check → charge → **fulfilling**, where one shipment child is
  spawned per fulfillment; the amend-with-timeout branch when items are
  unavailable; cancellation rules (`cancel-blocked-while-charging`,
  `fulfillment-in-progress`); a completion **rollup** — the order completes
  only when every shipment delivered, or lands in `partiallyDelivered` when
  any child was cancelled. *Provenance note:* this machine's polygen run did
  NOT converge and received one recorded hand-repair — read
  [`machines/order/REPAIR-NOTE.md`](machines/order/REPAIR-NOTE.md) before
  trusting `polygen-report.md`; the post-repair model check is 33 states,
  0 violations, and both defects that caused the episode are now gated in
  the polygen pipeline itself.
- **Shipment** (`machines/shipment/`, polygen-authored): preparing →
  inTransit → delivered, courier-signalled, cancellable only while
  preparing; notifies the order on its terminal state and accepts the
  order's cancel-on-parent-terminal.
- **Billing**: fraud check + idempotency-keyed charge as effects (retries,
  DLQ, `onExhausted` letting verified logic decide what provider-down means).
- **Fulfillment splitting**: the storefront's cart maps items to warehouses;
  distinct warehouses = fulfillments (the OMS order-splitting behavior).

The composition is verified beyond the machines themselves:
`effect-invariants.mjs` proves over every reachable path that the order
never emits two charges, **spawns exactly its fulfillment count of shipment
children**, and never spawns before a successful charge
(`polyrun check-effects --config examples/polyrun-oms/polyrun.config.mjs`).

## Run it

All from the repo root; Node ≥ 20, no API key needed for any of it (polygen
authoring already happened — its artifacts are committed).

```bash
# tests (composition check incl. spawn-count negative control, rollup paths,
# amend, cancel rules, at-least-once safety, deploy gate + audit) — 8 tests,
# SQLite by default; set POLYRUN_PG_URL=postgres://... to run on Postgres
npm run test:oms

# the crash demo: kill -9 mid-charge, recover, charge dedupes at the
# provider, two shipment children spawn, courier delivers both, rollup
# completes — exactly one charge on the ledger
npm run demo:oms

# the storefront (User places/amends orders, Courier ships/delivers) +
# the polyrun ops console + the JSON facade, one process
npm run oms
#   → http://127.0.0.1:7080/shop   (storefront)
#   → http://127.0.0.1:7080/       (ops console: instances, journals, rejects)

# the verification tooling, straight from the CLI
node polyrun/bin/polyrun.mjs check-effects --config examples/polyrun-oms/polyrun.config.mjs
node polyrun/bin/polyrun.mjs deploy        --config examples/polyrun-oms/polyrun.config.mjs
node polyrun/bin/polyrun.mjs audit         --config examples/polyrun-oms/polyrun.config.mjs
```

Storefront walkthrough: as **User**, tick products (each maps to warehouse A
or B — distinct warehouses become separate shipments), place the order, and
watch it ride fraud check → charge → fulfilling. As **Courier**, Ship and
Deliver each shipment; when the last one lands, the rollup completes the
order. Try cancelling at different stages to see the verified rejection
reasons surface in the UI.

## Layout

```
machines/order-contract.json    pinned contract the order machine was authored against
machines/order/                 polygen output: next.cjs, invariants, report, trace corpus
machines/shipment/              polygen output (authored for the polyrun test fixtures,
                                vendored here; authoring-contract.json is the pinned input)
effects.cjs                     pure edge-triggered mapper (spawns children per fulfillment)
effects.manifest.json           effect vocabulary + completion wiring + retry policies
effect-invariants.mjs           path-level emission invariants + pointwise state invariants
polyrun.config.mjs              machines + handlers (idempotency-keyed provider ledger)
bin/oms-server.mjs              storefront + ops console + facade in one process
web/storefront.html             self-contained User/Courier page
demo/                           the kill -9 crash demo
test/oms.test.mjs               the suite (SQLite default; POLYRUN_PG_URL for Postgres)
```

## How this differs from Temporal's version — the part that matters

The Go reference app and this folder implement the same business process.
The difference is **where correctness comes from**:

| | Temporal reference app | this folder |
|---|---|---|
| workflow logic written by | engineers, in Go | **polygen** (an LLM), from a pinned contract |
| correctness argument | the tests someone wrote | **exhaustive model check** of every reachable state, before first run |
| "never charged twice" | convention: an idempotency key, hoped to be used right | a checked **emission invariant**: no reachable path emits `chargeCard` twice |
| "one shipment per fulfillment" | code review | a checked invariant: every path **spawns exactly `fulfillments` children**, never before a successful charge |
| stale signal / duplicate webhook | whatever the workflow code happens to do | a **verified `reject(reason)`** — an observable no-op by construction |
| deploying changed logic | replay determinism + `patch()` versioning, forever | snapshot compatibility, **mechanically gated** (`polyrun deploy`) over live state |
| production vs model drift | unknowable | the journal **is** a trace corpus; `polyrun audit` replays it on demand |
| regression corpus | hand-maintained tests | **synthesized** by the pipeline (`machines/*/traces/`, replayed independently) |

Put differently: Temporal's version demonstrates that a durable engine can
reliably execute order logic. This version demonstrates that the order logic
itself can be **generated, proven against its stated invariants, and then
executed durably** — the engine-hard guarantees are table stakes here (crash
recovery, idempotent payment, timers, signals: see the demo), and the
correctness guarantees on top have no counterpart in the original.

The provenance is deliberately warts-and-all: one of the two machines needed
a recorded one-line hand-repair (see the note above), and that episode
hardened the generator itself. That is the intended loop — defects surface
as gate failures and become pipeline fixes, not folklore.

## Honest deltas vs the reference app

Same as the harness's own scope notes, plus: the product catalog is a
4-item fixture (not a catalog service); billing is effects rather than a
separate service on its own task queue; and the storefront is a single page,
not the reference app's full React application. The workflow semantics —
lifecycle, splitting, child orchestration, signals, timers, human-in-the-loop,
idempotent payment, crash recovery — are all here, and all verified.
