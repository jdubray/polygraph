# A/B eval — legacy bare-next vs v2 SAM strict artifact (P8 ship gate)

Run date: 2026-07-13 · model `haiku-4.5` (`claude-haiku-4-5-20251001`) ·
N=3 specs/arm/machine · all 8 machines · harness `eval/ab-v2.mjs` ·
raw records `eval/results/ab-v2-scorecard.json` · generated specs kept under
`eval/results/ab-v2-specs/<machine>/<arm>/`.

(Provisioning note: the first key issued for this gate expired before any
generation — a replay-only degraded run against the reference specs was
recorded to `eval/results/ab-v2-scorecard-reference-mode.json`; legacy
pipeline baseline 5/5 replay-detection, 0 false alarms, 0 dead specs. A fresh
key then allowed the full generative A/B below, which supersedes it.)

## Per-machine table

Detection = seeded bug found by that mechanism (replay = a
code-finding-or-contract window at the ground-truth action; check = a
reachable invariant violation). "flag" = the arm raised a finding on a
machine whose ground truth says it must not be flagged.

| machine | class | arm | specs live/dead | seeded detected (replay) | seeded detected (model-check) | rejection-reason in results | determinism check ran |
|---|---|---|---|---|---|---|---|
| m01-subscription-renewal | seeded | legacy | 3/0 | – | ✅ | n/a | ✅ |
| m01-subscription-renewal | seeded | **v2** | 3/0 | ✅ (RENEW_CHARGE) | – | ✅ | ✅ |
| m02-auth-lockout | seeded | legacy | 3/0 | – | ✅ | n/a | ✅ |
| m02-auth-lockout | seeded | **v2** | 3/0 | – | ✅ | ✅ | ✅ |
| m03-job-queue | seeded | legacy | 3/0 | – | ✅ | n/a | ✅ |
| m03-job-queue | seeded | **v2** | 3/0 | – | ✅ | ✅ | ✅ |
| m04-doc-approval | seeded | legacy | 3/0 | – | ✅ | n/a | ✅ |
| m04-doc-approval | seeded | **v2** | 3/0 | – | ✅ | ✅ | ✅ |
| m05-payment-capture | seeded | legacy | 3/0 | – | ✅ | n/a | ✅ |
| m05-payment-capture | seeded | **v2** | 3/0 | ✅ (AUTHORIZE) | – | ✅ | ✅ |
| m06-traffic-light | clean | legacy | 3/0 | not flagged ✓ | not flagged ✓ | n/a | ✅ |
| m06-traffic-light | clean | **v2** | 3/0 | ⚠️ flag (see caveat 1) | not flagged ✓ | – | ✅ |
| m07-cart | clean | legacy | 3/0 | not flagged ✓ | not flagged ✓ | n/a | ✅ |
| m07-cart | clean | **v2** | 3/0 | not flagged ✓ | not flagged ✓ | ✅ | ✅ |
| m08-conflict-oos | out-of-scope | legacy | 3/0 | not flagged ✓ | not flagged ✓ | n/a | ✅ |
| m08-conflict-oos | out-of-scope | **v2** | 3/0 | ⚠️ flag (see caveat 2) | not flagged ✓ | ✅ | ✅ |

## Ship criteria (plan P8)

| criterion | legacy | v2 | verdict |
|---|---|---|---|
| seeded-bug detection (replay OR model-check) | 5/5 | 5/5 | **parity** ✅ |
| detection at the cheaper replay tier | 0/5 | 2/5 (m01, m05) | v2 better ✅ |
| dead-spec count (48 generations total, 24/arm) | 0 | 0 | **at baseline** ✅ |
| v2-only: a rejection-reason classification appears in results | n/a | 7/8 machines | ✅ |
| v2-only: determinism double-pass runs | ran (engine-generic) | ran on every cell, 0 nondeterministic specs | ✅ |

**Verdict: SHIP.** Detection parity or better (with v2 additionally surfacing
m01 and m05 at the replay tier, where legacy needed the model checker), dead
specs at baseline (zero in both arms), and both new v2 evidence classes
present. Two caveats, both understood and neither a detection/dead-spec
regression:

1. **m06 (clean) v2 replay flag — a real corpus/contract gap, not a spec
   miss.** The m06 trace corpus contains one `STOP` no-op window, but the
   contract declares only `NEXT`. A legacy bare-next spec silently no-ops on
   any unknown action, so this never surfaced; a v2 strict module has no
   `STOP` intent to invoke, so every spec fails that window and it classifies
   `code-finding-or-contract` — and it literally is a **contract-error**
   (undeclared action in the trace). Action: when moving a corpus to the v2
   arm, every action appearing in the traces must be declared in the contract
   (with a `reject()` rule if the code ignores it). `validate_corpus` prints
   the `red|STOP` coverage row but does not currently error on undeclared
   actions — worth tightening.
2. **m08 (out-of-scope) v2 replay flag — ambiguity made observable.** All
   three v2 specs implemented the contract's `conflict-handling` special rule
   as `reject('conflict-handling')`, while the code activates on an
   idempotency conflict; the window classifies code-finding with a uniform
   `rejected(conflict-handling)` explanation. Ground truth scores this
   machine "correctly not flagged" (the divergence is settled only at the
   external-service boundary), so per the scoring it is a false alarm — but
   the finding points exactly at the documented hazard (activate without
   confirmed payment). Root cause: the v2 prompt renders specialRules as
   named rejection requirements, which converts silent ambiguity into an
   observable, reasoned disagreement. Acceptable behavior; noted for triage
   guidance (a uniform rejection-reason on a code-finding window usually
   means the CONTRACT took a side the code did not).

## Repro

```
ANTHROPIC_API_KEY=… node eval/ab-v2.mjs --model haiku-4.5 --machines m01-m04
ANTHROPIC_API_KEY=… node eval/ab-v2.mjs --model haiku-4.5 --machines m05-m08
# results merge into eval/results/ab-v2-scorecard.json
# degraded replay-only mode (no key): node eval/ab-v2.mjs --reference
```

---

## Release-model rerun: Fable 5 (claude-fable-5), N=3, all 8 machines, both arms

Run 2026-07-13, after the m06 contract fix (STOP declared with the
`stop-is-noop` reject rule) and the validate_corpus undeclared-action error.
Raw: `results/ab-v2-scorecard.json` (merged), `results/ab-v2-fable5-log.txt`.

| criterion | legacy | v2 | verdict |
|---|---|---|---|
| seeded detection (m01-m05) | 4/4 generable (m03 n/a, see below) | **5/5** | v2 meets, legacy blocked on one |
| detected at the cheap replay tier | 0 | 2 (m01, m03) | v2 better |
| clean machines (m06, m07) | clean | clean | ✅ — m06 false positive GONE post-contract-fix |
| m08 (out-of-scope boundary) | clean | boundary flag only (documented) | as designed |
| dead specs | 0 | 0 | ✅ |
| rejection classification present | n/a | 8/8 machines | ✅ |
| determinism pass | ran, 0 flagged | ran, 0 flagged | ✅ |

**Fable-specific finding: the legacy m03 (job-queue) cell is unrunnable.**
All generations return empty with `stop_reason=refusal` — 6/6 across the
sweep and a confirmation retry — while the v2 prompt over the SAME source
generates 3/3 clean specs that catch the seeded bug at the replay tier.
Model-specific (haiku-4.5 ran the same cell fine) and prompt-form-specific
(v2 fine, legacy refused). Consequence worth noting: under the release
model, the v2 arm is strictly MORE available than the legacy arm. We do not
patch the legacy prompt (it is frozen for comparability); recorded as a
known Fable/legacy interaction.

**Verdict: SHIP confirmed at the release model.** v2 is 5/5 on detection
with two replay-tier catches, zero dead specs, zero false positives on
clean machines after the m06 contract fix, and full rejection/determinism
evidence. The haiku-4.5 and fable-5 scorecards agree on every ship
criterion.

---

## New-model rerun: Opus 5 (claude-opus-5), N=3, all 8 machines, both arms

Run 2026-07-24, the day Opus 5 became available — a smoke test of the new
model against the existing gate, not a re-litigation of the artifact
decision. Post-m06-contract-fix, so comparable to the fable-5 rerun above
rather than to the original haiku-4.5 gate. Raw:
`results/ab-v2-scorecard.json` (overwritten by this run).

| criterion | legacy | v2 | verdict |
|---|---|---|---|
| seeded detection (m01-m05) | 4/4 generable (m05 refused, see below) | **5/5** | v2 meets, legacy blocked on one |
| detected at the cheap replay tier | 0 | **0** | see "where detection landed" |
| clean machines (m06, m07) | clean | clean | ✅ |
| m08 (out-of-scope boundary) | not generable (refused) | clean | ✅ — the fable/haiku boundary flag did NOT recur |
| dead specs | 0 | 0 | ✅ |
| rejection classification present | n/a | 8/8 machines | ✅ |
| determinism pass | ran, 0 flagged | ran, 0 flagged | ✅ |

**Zero false alarms across the whole v2 arm** — the first model here to
score that. Haiku raised two spurious replay flags (m06, m08); fable-5
cleared m06 after the contract fix but still raised the m08 boundary flag.
Opus 5 raises neither.

**Where detection landed: all model-check, no replay.** Every one of the five
v2 catches came from the model checker; none from the replay tier, against
2/5 for both haiku-4.5 and fable-5. Read carefully, this is not a
regression. The replay tier only fires when the derived spec DISAGREES with
what the code actually did. Opus 5's specs reproduce the code's observable
behavior faithfully enough that replay finds nothing to report; the seeded
divergence — a gap between the code and its contract, not within the code —
survives to the exhaustive pass, which catches all five. The practical
consequence is a cost shift, not a coverage loss: a more faithful deriver
makes the cheap tier quieter and moves the work to the expensive one. Worth
weighing before tiering the loop in CI. (v2 wall-clock ran 17–133s per cell
vs 13–18s for legacy.)

**Legacy-arm refusals — the third instance, and now a pattern.** m05
(payment-capture) and m08 (conflict-oos) returned 0/3 specs, every
generation `stop_reason: refusal`, `category: cyber`. Same shape as the
fable-5 m03 finding above: **legacy prompt only** (the v2 prompt over the
identical source generated 3/3 clean specs in both cells) and
**model-specific** (`claude-opus-4-8` and `claude-sonnet-5` do not refuse
the same input). Three independent instances now — fable-5/m03,
opus-5/m05, opus-5/m08 — each a different model/machine pair, all on the
legacy arm.

Bisected here to the **source files' own comments**, not the prompt
scaffolding: sending m05's comment block alone under nothing more than
"summarize what this module does in one sentence" also refuses. Those
comments describe a guard bypass in payment logic ("the guard that is
supposed to reject partials only checks `approved <= 0`, so a genuine
partial sails through to `captured`"), which reads as vulnerability
research.

That generalizes past this suite, and it is worth stating plainly: **every
prompt Polygraph sends is vulnerability-shaped by construction** — "here is
code, here is how it might be wrong." Any user machine whose comments
honestly document a suspected bug can lose a generation this way. As with
fable-5/m03 we do NOT patch the legacy prompt (frozen for comparability),
and the standing consequence holds: under current models the v2 arm is
strictly MORE available than the legacy arm. 6.2.1 makes the failure legible
rather than silent — `generate.mjs` now reports the category and the API's
own explanation, tags the result `refusal: true`, and says a retry will not
help.

**Verdict: no change to the artifact decision; Opus 5 clears the gate.** v2
is 5/5 on detection with zero dead specs, zero nondeterministic specs, zero
false alarms, and full rejection/determinism evidence. Recommended model
moved `opus-4.8` → `opus-5` in 6.2.1 on the strength of this run.

```
ANTHROPIC_API_KEY=… node eval/ab-v2.mjs --model claude-opus-5 --n 3
# (the opus-5 alias also works as of 6.2.1)
```
