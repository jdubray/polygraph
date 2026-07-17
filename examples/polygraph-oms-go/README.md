# polygraph-oms-go — auditing Temporal's reference app with Polygraph

The full circle. Elsewhere in this repo the Temporal OMS reference
application is *reimplemented* on polyrun (`examples/polyrun-oms`). Here it
is **audited**: Polygraph's verification loop pointed at the reference
app's own Go source — the Order workflow of
[temporalio/reference-app-orders-go](https://github.com/temporalio/reference-app-orders-go)
(MIT, vendored unmodified under `source/`).

> Same disclosure as the repo README: this is a consistency check, not a
> proof, and every finding is a lead to investigate by hand. The "findings"
> below are **design observations about intent**, not defect reports — the
> code does exactly what it says; the question Polygraph raises is whether
> that is what an order system's owner would *want*.

## How the audit works

1. **Contract** (`contract.json`) — the observable state is the workflow's
   own `StatusQuery` projection: order status + the per-fulfillment status
   list. The action vocabulary is the workflow's real stimulus set:
   reservation results, customer signals, the customer-action timer, charge
   results, shipment child completions.
2. **Ground truth** (`harness/`, `traces/`) — a Go harness drives the REAL
   workflow code (imported from the upstream module, unmodified) through
   Temporal's own `testsuite`: stub activities gated on virtual-time
   releases, a timed stub Shipment child, and event-driven capture — every
   completion listener opens a Polygraph window `{pre, action, data, post}`
   whose `post` is the workflow's own query sampled a virtual millisecond
   later. 9 scenarios, 27 windows, corpus-validated
   (`go run ./harness ../traces` — regenerate any time; no Temporal server
   needed).
3. **Controls** — the hand-written reference spec (`specs/reference.js`)
   replays **27/27**; the mutated control (`controls/mutant.js`, charge
   failures silently absorbed) fails exactly its 4 corrupted windows. The
   harness can tell good from bad before any generated spec is trusted.
4. **Generation** — THREE independent LLM specs written from the GO SOURCE
   (`verify.mjs --source source/workflows.go --n 3`, fable-5): all three
   replay **27/27** against the real-execution traces
   (`results-generated/findings.md`).
5. **Model check** (`check.mjs` + `invariants.mjs`) — every spec is explored
   exhaustively against intent invariants. All FOUR specs (3 generated + the
   reference) explore the identical 26-state space and report the identical
   two violations below. The audit's conclusion does not depend on any
   single reading of the code — including the human one.

## Findings

The replay half confirms the specs are faithful; the model check then
surfaces two reachable states a reasonable owner would not expect — each
with a shortest counterexample, both also captured live in the traces:

**F1 — an order can complete with nothing fulfilled, nothing charged.**
```
init                              {status: pending,                 fulfillments: []}
RESERVED({available: [false]})  → {status: customerActionRequired,  fulfillments: [unavailable]}
CUSTOMER_ACTION({action: amend})→ {status: completed,               fulfillments: [cancelled]}
```
When every item is unavailable and the customer amends, all fulfillments
are cancelled, zero goods ship, zero payment is taken — and the order's
final status is `completed` (`allFulfillmentsFailed()` counts only
*failed*, and cancelled ≠ failed). Trace witness:
`traces/s8_all_unavailable_amend_completes_empty.ndjson`.

**F2 — partial failure is reported as plain success.**
```
… CHARGE_RESULT({index:0, success:false}) → [failed, processing]
  SHIPMENT_RESULT({index:1, ok:true})     → {status: completed, fulfillments: [failed, completed]}
```
One fulfillment's charge declines; the other delivers; the order status is
`completed` with no partial marker. Callers reading only the status (the
common case) cannot distinguish this from full success. Trace witness:
`traces/s7_partial_shipment_failure.ndjson`.

Two smaller observations, verified in traces rather than flagged as
violations: a customer **cancel** leaves fulfillment statuses untouched
(`s3`: `cancelled` with `[pending, unavailable]` — reservations are never
observably released on this path, unlike the timeout path which cancels
them), and a charge activity *error* is indistinguishable from a declined
charge in the observable state (`s6` ≡ `s5`).

None of this is hidden behavior — it is all right there in ~40 lines of
`run()`/`allFulfillmentsFailed()`. That is precisely the point: the code is
a faithful description of what it does; only stated intent, checked
mechanically, reveals whether that is what anyone *meant*. In the polyrun
reimplementation (`examples/polyrun-oms`) the equivalent states are
`partiallyDelivered` and a `cancelled`-fulfillment rollup — those choices
were forced by writing the invariants first.

## Reproduce

```bash
# regenerate ground truth from the real Go workflow (Go ≥ 1.23; no server)
cd examples/polygraph-oms-go/harness && go run . ../traces

# corpus hygiene
node scripts/validate_corpus.mjs examples/polygraph-oms-go/contract.json examples/polygraph-oms-go/traces

# positive + negative controls (no API key)
node scripts/verify.mjs --contract examples/polygraph-oms-go/contract.json --traces examples/polygraph-oms-go/traces --specs examples/polygraph-oms-go/specs   --out examples/polygraph-oms-go/results
node scripts/verify.mjs --contract examples/polygraph-oms-go/contract.json --traces examples/polygraph-oms-go/traces --specs examples/polygraph-oms-go/controls --out examples/polygraph-oms-go/results-mutant

# generate specs from the Go source (needs ANTHROPIC_API_KEY)
node scripts/verify.mjs --contract examples/polygraph-oms-go/contract.json --source examples/polygraph-oms-go/source/workflows.go --traces examples/polygraph-oms-go/traces --model fable-5 --n 3 --out examples/polygraph-oms-go/results-generated

# the model check that produces the findings (no API key)
node scripts/check.mjs --spec examples/polygraph-oms-go/specs/reference.js --contract examples/polygraph-oms-go/contract.json --invariants examples/polygraph-oms-go/invariants.mjs
```
