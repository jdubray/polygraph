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
  any child was cancelled.
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

```bash
# tests (composition check incl. spawn-count negative control, rollup paths,
# amend, cancel rules, at-least-once safety, deploy gate + audit)
node --test examples/polyrun-oms/test/oms.test.mjs

# the crash demo: kill -9 mid-charge, recover, courier delivers both
# shipments, rollup completes — exactly one charge on the provider ledger
node --no-warnings examples/polyrun-oms/demo/run-demo.mjs

# the storefront (User places/amends orders, Courier ships/delivers) +
# the polyrun ops console + the JSON facade
node --no-warnings examples/polyrun-oms/bin/oms-server.mjs
#   → http://127.0.0.1:7080/shop
```

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

## Honest deltas vs the reference app

Same as the harness's own scope notes, plus: the product catalog is a
4-item fixture (not a catalog service); billing is effects rather than a
separate service on its own task queue; and the storefront is a single page,
not the reference app's full React application. The workflow semantics —
lifecycle, splitting, child orchestration, signals, timers, human-in-the-loop,
idempotent payment, crash recovery — are all here, and all verified.
