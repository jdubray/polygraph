# Polygraph — verification findings

> Consistency check, not a proof. Every finding is a lead to investigate by hand.

## Part 1 — trace conformance (replay)

- specs replayed: **1** (live: **1**)
- windows: **27**
- consistent (pass in all live specs): **23**
- likely spec-error (some specs miss it): **0**
- likely code-finding / contract-error (all specs disagree): **4**
- unscoreable in all specs (specs didn't load): **0**
- ⚠️ windows where a spec neither acted nor REJECTED (`unhandled`): **4** — unexplained silence; a faithful spec should either transition or reject(reason).

## Windows to review

| scenario | # | action | verdict | per-spec | step classification (per live spec) |
|---|---|---|---|---|---|
| s5_charge_declined_single.ndjson | 1 | CHARGE_RESULT | code-finding-or-contract | fail | unhandled |
| s6_charge_error_single.ndjson | 1 | CHARGE_RESULT | code-finding-or-contract | fail | unhandled |
| s9_both_charges_fail_order_failed.ndjson | 1 | CHARGE_RESULT | code-finding-or-contract | fail | unhandled |
| s9_both_charges_fail_order_failed.ndjson | 2 | CHARGE_RESULT | code-finding-or-contract | fail | unhandled |

**Reading the verdicts**
- *code-finding / contract-error*: every spec disagrees with the trace here. Either the code does something you did not expect (a defect) or your observable-state contract omits a field that drives this transition. Investigate the source at this (pre-state, action).
- *spec-error*: some generations pass, some fail. Usually one generation missed a rule; check the majority. The missed rules are typically special cases living outside the main state table.
- *unscoreable in all specs*: the generated modules did not load or export next(). Fix generation, not the code.

**Reading the step classifications** (v2 SAM artifact only)
- *rejected(reason)* and *identity-by-mutation* are the two GOOD no-op classes: the spec explicitly declined or explicitly re-committed the same state.
- *unhandled* on a failing window is itself a finding: the spec neither acted nor rejected — usually a missing acceptor case (spec-error) or a rule the code has that the contract does not.

## Part 2 — invariant violations (model checking)

- states explored: **26** · specs checked: **1/1**

**2 invariant violation(s) reachable — these are bugs, with counterexamples:**

| invariant | kind | strength | counterexample (init → …) |
|---|---|---|---|
| completed-implies-some-fulfillment-completed | state | all-specs | init → RESERVED({"available":[false]}) → CUSTOMER_ACTION({"action":"amend"}) |
| completed-implies-no-failed-fulfillment | state | all-specs | init → RESERVED({"available":[true,true]}) → SHIPMENT_RESULT({"index":0,"ok":true}) → SHIPMENT_RESULT({"index":1,"ok":false}) |

An *all-specs* violation means every independently derived model reaches the bad
state — a strong signal. Follow the counterexample path in the source.