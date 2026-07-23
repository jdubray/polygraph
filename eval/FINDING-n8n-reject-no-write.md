# FINDING — reject-with-no-write recurs 5/5 even with the v6.1.0 prompt fix (n8n field study, July 2026)

Fifth field target: n8n-io/n8n's execution-status classification
(`WorkflowExecute.processSuccessExecution`,
`packages/core/src/execution-engine/workflow-execute.ts:2624-2647`) — the
function deciding whether a finished workflow execution is reported
`canceled`, `error`, `waiting`, or `success`. Working tree:
`C:\Users\jjdub\code\osssm\polygraph-n8n` (full `REPORT.md`).

**No defect in n8n.** Confirmed by clean controls (7/7 positive, 5/7
negative with the expected all-specs invariant violation) and by directly
driving the real method on a live `WorkflowExecute` instance. One
doc-comment-worthy observation, not a live bug: n8n's real cancellation
error classes (`ManualExecutionCancelledError` et al.) spell `.message` with
double-L "cancelled," which the code's `.includes('canceled')` (single-L)
check can never match — real cancellation detection works entirely off the
`.name`-based check. Confirmed against the running code, not just read.

## This is NOT a new trap — it's the hatchet trap, reproduced after the fix

`FINDING-hatchet-reject-annotation.md` already names this exact failure mode
("pure-reject variants (no writes — nothing for #36 to catch)") as a known
residual case the sam-lib #36 write-then-reject hard-fail can't reach, and
ships the report-level fallback (`rejectedActedWindows`) plus a prompt
change (item 1: "REJECT MEANS DECLINED, FULL STOP... special-rule names are
reasons for REJECTIONS only") as the mitigation. This run is a third
independent data point, run *after* that prompt fix shipped, and it still
landed **5/5 unanimous** — worth feeding back precisely because of what did
and didn't change.

## What v6.1.0 got right

`findings.md`'s diagnosis fired immediately and unprompted:

> windows where a spec REJECTED while the code ACTED (trace post ≠ pre): 5
> — if this is uniform across specs and windows, suspect the
> reject-as-annotation trap... Look for a trailing reject(...) after next.*
> assignments in the specs before reading these as code findings.

On hatchet this took manually reading five generated files to notice. Here
the report said it outright, in the first pass. Real, working improvement.

## What still reproduces, and the precise trigger

All 5 generations (opus-4.8, fresh contract, `lang: javascript` — after I
caught and fixed my own repeat of the xstate `lang: typescript` mistake)
independently wrote:

```js
if (nameMatch) {
  return reject('cancellation-detected-by-name-not-message');   // no next.* write anywhere above this
}
...
return reject('wait-till-only-checked-when-no-error');           // covers BOTH 'waiting' and 'success'
```

Byte-checked all 5 spec files: **zero of them write to `next` before
rejecting** in these branches — there is nothing for a write-then-reject
hard-fail to catch, exactly as the hatchet finding anticipated.

The trigger isolates cleanly by comparing which branches got the reject
treatment against which didn't, across all 5 generations:

| branch | matches a named `specialRules` entry? | outcome (5/5 generations) |
|---|---|---|
| cancellation via name match | yes — `cancellation-detected-by-name-not-message` | `reject(name)`, no write |
| cancellation via message match | yes — `message-check-only-fires-on-external-single-l-spelling` | `reject(name)`, no write |
| waiting **or** success (both outcomes) | yes — `wait-till-only-checked-when-no-error` | `reject(name)`, no write, for BOTH outcomes |
| plain error (no cancel signal) | no matching rule | `next.status = 'error'` — correct, every time |

Every branch that maps to a *named* `specialRules` entry got rejected,
unconditionally, in all 5 generations — including
`wait-till-only-checked-when-no-error`, which does not describe a no-op at
all (it gates between two genuine, different, successful transitions:
`waiting` and `success`). The one branch with no matching rule name was
computed correctly every time. This sharpens the mechanism past "models
treat reject() as an annotation": **the specific trigger is the presence of
a named specialRules entry on the branch, independent of whether that rule
actually describes a rejection.** The shipped prompt wording ("special-rule
names are reasons for REJECTIONS only") did not prevent this — plausibly
because a model reading a contract where 3 of 4 branches carry an
explanatory named rule doesn't distinguish "this note explains a decline"
from "this note explains why a real transition looks the way it does";
both read as "here is the reason string for this branch."

**Isolated the same way as the hatchet case**: patched only the three
erroneous `reject()` calls in one generated spec into the `next.status`
writes the surrounding logic already computed correctly in comments —
**7/7, 0 invariant violations**, nothing else changed. Comprehension was
right in all 5 generations; only the reject/write mechanics were wrong.

## Suggested follow-up

Two candidate angles, complementary rather than either/or:

1. **Prompt**: separate "why" from "what to call" more explicitly — e.g.
   instruct that a specialRules `note` is documentation only, and the
   decision of whether to call `reject()` must be made independently by
   asking "does the real code's observable state change here?" (checkable
   against the trace corpus / dataDomain, not against whether a rule has a
   name).
2. **Structural**: since the existing `rejectedActedWindows` report signal
   already detects this reliably post-hoc, consider promoting it from a
   findings.md warning to a **regeneration trigger** — when replay shows
   ≥N windows uniformly rejected-while-code-acted across all live specs,
   automatically re-prompt with an explicit note naming the offending
   branches before presenting results, rather than requiring the operator
   to notice and re-run manually.

Field-study report: `C:\Users\jjdub\code\osssm\polygraph-n8n\REPORT.md`
(includes the pre-fix run, the still-mistaken 6.1.0 run with my own
`lang: typescript` contamination, and the clean 6.1.0 run this finding is
drawn from, so the progression is auditable start to finish).

## Resolution (polygraph 6.2.0 — both angles shipped)

1. **Root cause fixed, not just re-worded.** The trigger was the tool's own
   directive: the v2 template section was headed "Special rules (REQUIRED
   reject(reason) cases)" and `renderSpecialRulesAsRejections` emitted "the
   acceptor MUST call `reject('name')`" for EVERY named rule — including
   behavioral ones. The renderer now classifies each rule against the
   captured corpus: matching windows all no-op → `[REJECTION — must
   reject]`; matching windows change state → `[BEHAVIORAL — must perform
   the transition via next.* writes and MUST NOT reject; the name is only
   the why]`; unexercised → decide from the source. The template states a
   named rule is NOT an instruction to reject and gives the
   observable-change decision test. polygen's no-corpus authoring path
   keeps the old reading (there, specialRules are authored no-op
   declarations by construction).
2. **Detection promoted to auto-regeneration.** In generation mode, when
   the signature is UNIFORM (every live spec rejected ≥2 windows the code
   acted on), verify regenerates once with the offending (pre-state,
   action) windows called out, reports the second pass, and preserves both
   spec sets (`specs/`, `specs_regen/`). One extra API round at most;
   `--no-auto-regen` opts out; the findings.md header names both passes.
