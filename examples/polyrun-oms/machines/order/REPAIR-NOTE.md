# Hand-repair record — read before trusting polygen-report.md

`polygen-report.md` in this directory honestly records **NOT converged**
(1 state explored). Per the polygen skill's triage guidance ("fix the code by
hand at the counterexample"), one repair was applied by hand and the result
re-verified. This note is that record — the repo's no-silent-clean doctrine
applies to repairs too.

## The defect

The generated module declared the SAM component with `name: 'order'`. In
sam-lib, a **named** component binds its acceptors to a LOCAL component state
tree, not the shared instance state — so every guard read
`model.orderState === undefined` and rejected, including SUBMIT from the
initial state. That is why the checker explored exactly 1 state, and why the
self-repair loop could not converge: it spent its iterations on the
domain-gap warnings instead (see below).

**Repair:** remove `name: 'order',` from the component declaration
(one line; marked with a REPAIR comment in `next.cjs`). No transition logic
was touched.

## Post-repair verification

```
node scripts/check.mjs --spec examples/polyrun-oms/machines/order/next.cjs \
  --contract examples/polyrun-oms/machines/order-contract.json \
  --invariants examples/polyrun-oms/machines/order/invariants.mjs
states explored: 33
no invariant violations reachable ✓
```

Plus the composition check (`effect-invariants.mjs`, incl. spawn counting)
and the runtime suite in `../../test/oms.test.mjs` — see the folder README.

## Known pipeline noise, not defects

The report's recurring "domain-ref gap" for
`SHIPMENT_COMPLETED.childState = {...}` is the gap heuristic not recognizing
**object-valued** `dataDomain` entries as referenced (the code reads
`childState.shipState`, which the textual reference check misses). The
post-repair model check above explores those domain entries and exercises
both rollup branches. Two pipeline improvements fall out of this episode:
teach the gap heuristic about object-valued domain entries, and either
forbid `name:` on generated components or make polygen's own load gate catch
the local-state binding (a strict-clean `validate()` does not).
