# Polygraph — verification findings

> Consistency check, not a proof. Every finding is a lead to investigate by hand.

## Part 1 — trace conformance (replay)

- specs replayed: **1** (live: **1**)
- windows: **21**
- consistent (pass in all live specs): **21**
- likely spec-error (some specs miss it): **0**
- likely code-finding / contract-error (all specs disagree): **0**
- unscoreable in all specs (specs didn't load): **0**

All windows consistent across all specs — the derived spec reproduces the code.
_Note: a faithful spec reproduces bugs too, so a clean Part 1 is not a clean bill of
health. The bug-finding is Part 2._


## Part 2 — invariant violations (model checking)

- states explored: **6** · specs checked: **1/1**

**2 invariant violation(s) reachable — these are bugs, with counterexamples:**

| invariant | kind | strength | counterexample (init → …) |
|---|---|---|---|
| enums-valid | state | all-specs | init |
| no-completion-before-processing | state | all-specs | init |

An *all-specs* violation means every independently derived model reaches the bad
state — a strong signal. Follow the counterexample path in the source.