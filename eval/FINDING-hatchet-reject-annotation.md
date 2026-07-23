# FINDING — reject(reason) read as a success annotation, 5 of 5 (hatchet field study, July 2026)

Fourth field target: hatchet-dev/hatchet's `DeriveWorkflowRunStatus`
(`internal/statusutils/status.go`) — the pure rollup of N task statuses into
one workflow-run status. Working tree: `C:\Users\jjdub\code\osssm\polygraph-hatchet`
(full `REPORT.md`). **No defect in hatchet** — fail-dominance,
in-flight-beats-cancelled, EVICTED-as-in-flight, and the uniform-EVICTED
pass-through all held, confirmed by an EXHAUSTIVE 216-state model check
(the full 6³ space, no cap) and clean controls. One doc-comment-worthy
observation for hatchet: the raw return has a 6th value (`EVICTED`) that
today is laundered to `RUNNING` only because the single caller routes
through `.ToProto()`.

## The trap — the sharpest polygraph data point of the four targets

Step 4 came back **0/19 consistent**: every one of the 5 independently
generated specs computed the **exact correct** `next.taskStatuses` /
`next.derived` values — matching the hand reference rule for rule — and then
all 5 appended one extra line:

```js
next.taskStatuses = taskStatuses;
next.derived = derived;
reject(reason);        // <- in all 5 generations
```

`reject(reason)` is a terminal DECLINE that discards the entire `next`
draft. Every generation read the contract's `specialRules` (each carrying an
explanatory `note` naming why a branch fires) and inferred that
`reject(reason)` was the idiom for tagging a *successful* transition with
its reason — the profile has no accept-with-a-reason primitive, so the
nearest-looking call was borrowed. Removing that ONE line from one spec:
**19/19, 0 violations**, nothing else changed.

Not a partial split (xstate was 4-of-5 on a different trap) — a clean
5-of-5 **structural** misreading, triggered by a contract whose specialRules
name every branch of a total function rather than only its no-op cases.

## Fixes shipped (plan M7)

1. **Prompt**: `prompt_template_v2.txt` now states REJECT MEANS DECLINED,
   FULL STOP — terminal statement of a no-op branch, never preceded by
   `next.*` writes, no accept-with-a-reason primitive exists, and the
   special-rule names are reasons for REJECTIONS only.
2. **Report detection**: `verify.mjs` flags the signature — a failing window
   where a spec classified `rejected(...)` while the trace shows the code
   ACTED (post ≠ pre) — per finding (`rejectedButCodeActed`) and as a
   summary counter with a triage hint ("look for a trailing reject after
   `next.*` writes before reading these as code findings").
3. **Upstream draft** (`docs/draft-upstream-issue-reject-after-write.md`):
   the v2 strict profile should hard-fail a step that wrote to `next` and
   then rejected, instead of silently discarding real work — the silent
   discard is what let a wrong idiom replay as a plausible-looking spec.

## Pattern across the four targets

raft (commitment): 4/5 collapsed two independent gates. xstate: 5/5 trapped
by a union-typed key the prompt itself mistyped. hatchet: 5/5 borrowed
reject() as an annotation. In every case the N-way vote caught the problem
(consistency collapsed loudly instead of verifying a wrong model) — and in
every case the root cause was a single structural gap in what the tool told
the generations, not model comprehension. The fix layer is the prompt and
the report's triage vocabulary, and each trap now has a named signature in
`findings.md`.
