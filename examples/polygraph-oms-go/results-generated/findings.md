# Polygraph — verification findings

> Consistency check, not a proof. Every finding is a lead to investigate by hand.

## Part 1 — trace conformance (replay)

- specs replayed: **3** (live: **3**)
- windows: **27**
- consistent (pass in all live specs): **27**
- likely spec-error (some specs miss it): **0**
- likely code-finding / contract-error (all specs disagree): **0**
- unscoreable in all specs (specs didn't load): **0**

All windows consistent across all specs — the derived spec reproduces the code.
_Note: a faithful spec reproduces bugs too, so a clean Part 1 is not a clean bill of
health. The bug-finding is Part 2._


## Part 2 — invariant violations (model checking)

- states explored: **26** · specs checked: **3/3**

**2 invariant violation(s) reachable — these are bugs, with counterexamples:**

| invariant | kind | strength | counterexample (init → …) |
|---|---|---|---|
| completed-implies-some-fulfillment-completed | state | all-specs | init → RESERVED({"available":[false]}) → CUSTOMER_ACTION({"action":"amend"}) |
| completed-implies-no-failed-fulfillment | state | all-specs | init → RESERVED({"available":[true,true]}) → CHARGE_RESULT({"index":0,"success":false}) → SHIPMENT_RESULT({"index":1,"ok":true}) |

An *all-specs* violation means every independently derived model reaches the bad
state — a strong signal. Follow the counterexample path in the source.