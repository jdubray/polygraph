# verify enhancements — plan from the raft field study

**Status: PLAN v1.0 — M1 implemented** (frozen-field scan in `check.mjs`
reported as `frozenKeys`, aggregated per-spec in `verify.mjs` with
all-specs/some-specs strength and distinct-value tracking, rendered in both
reports; `--initial-states` plumbed through `verify.mjs` so the prescribed
remedy works in the tool that prints the warning; capHit scopes the claim to
EXPLORED states. Adversarially reviewed; all four confirmed findings fixed
— non-object-state crash, first-spec-wins value aggregation, unactionable
remedy flag, unqualified capHit claim. Deliberately NOT folded into
`domainNotes`: polynv/polygen read those as "alphabet pruned".)

**M2 implemented** (drift detector + heartbeat in `check.mjs` explore():
per-key distinct-value tracking over init + BFS-discovered states, sampled
every 256 discoveries; `driftWarnings` in the result, rendered in both
reports; `POLYGRAPH_HEARTBEAT_MS`-tunable heartbeat, EPIPE-safe stderr.
Review findings fixed: seeds excluded from the detector on both sides (a
polyvers fleet corpus with per-instance ids would false-positive), drift
verdicts reported only for TRUNCATED runs with a loud retraction line when
a completed exploration disproves a mid-run warning, env parsing validated,
consistent result shape on error paths. Recorded limits: the detector is
single-key — a product-of-keys blowup is invisible to it (comment in code;
absence of a warning is not evidence of boundedness); polynv/polyvers do
not yet surface `driftWarnings` in their own verdict surfaces — follow-up.)

**M3 implemented** (spec-vs-spec agreement over live specs in `verify.mjs`:
pairwise %, strict-majority deviations, named outliers, per-finding split
column, consensus line. Review findings fixed: the quiet consensus line is
gated on FULL agreement — an even split (1-vs-1/2-vs-2) has no nameable
outlier and previously rendered 0% as consensus; unscoreable-everywhere
windows are excluded from the agreement denominator; deviation counts are
reported against majority-bearing windows; report prose no longer claims
"identical mistake" — the status matrix cannot compare outputs, only
verdicts. Recorded limit: shared failures count as agreement without output
comparison.)

**M4 implemented** (`scripts/mutate.mjs` — scripted negative control reusing
polynv's four operators via `generateMutants`/`enumerateGraph`/`graphDigest`
(now exported, not copied); in-process replay with the pipeline replayers'
projection + unscoreable + data-default rules; equivalent-mutant discard,
downgraded to `equivalent-bounded` (never "no corpus can distinguish it")
when either graph is cap-truncated; the positive control must be 100% or the
run is refused — which also surfaces scoring-parity bugs instead of
laundering them into blind-spot verdicts; exit 1 on any distinguishable
zero-flip mutation; NaN flags exit 2; default `--max-states 5000` (a graph
per mutant, double-pass each); drift stderr suppressed via
`enumerateGraph`'s new `driftThreshold` passthrough. DEVIATION from plan:
acceptance re-based on the turnstile example — the raft assets live outside
the repo. Recorded follow-up: no way to acknowledge a known-uncapturable
blind spot, so such a corpus exits 1 forever — alarm-fatigue risk.)

**M5 implemented** (skill: real-traces disqualifier up front;
subscription-not-polling capture guidance with the raft example; corpus
coverage sanity check; frozen/drift warning reading in Step 4b; agreement
line + split column reading in Step 5; scripted negative control in Step 3.
`commands/verify.md`: prerequisite line, `--initial-states` flag.)

## M6 — union-typed state keys (xstate field study)

**Implemented** with `eval/FINDING-xstate-union-schema.md` (third field
target; no defect in xstate; 5/5 generations trapped identically by
`value: { type: 'string' }` rendered INTO the prompt for a
`string | {red: string}` key). Fix: `renderModelShape(contract, windows)`
detects union keys from captured windows, initState, and a top-level-`|`
type-note parse, rendering `{}` with a do-not-tighten comment;
`verify.mjs` threads the corpus into `buildPrompt`; the v2 template forbids
tightening `{}`. Real union support (`type: ['string','object']`) drafted
upstream: `docs/draft-upstream-issue-union-types.md`.

Review findings fixed: a union must be established WITHIN one source —
evidence (windows+init) or a note whose arms are PURE type tokens — never
by merging across sources (the "array of enum: 'a' | 'b'" note shape had
fabricated an array|string union and stripped checking from
polygraph-oms-go's contract); union and observed nulls render
`{ nullable: true }` (the checker tests null BEFORE type — plain `{}` on a
nullable union was the same trap class again); window evidence now wins for
single types too; prose arms are skipped, not guessed. Recorded limits:
`to-tla.mjs` types state from init values and cannot represent a union —
the transpiler tier may refuse or mistype a union-keyed spec (refusal is
loud; noted, not fixed); prompts are now corpus-dependent (same
contract+source, different traces → possibly different modelShape
rendering) — deliberate, the corpus is ground truth. Accepted residuals: a
union note with one pure arm and one prose arm confidently picks the arm
that parsed (under-detection direction, only bites with no init/window
evidence); the reject-as-annotation summary line gives no per-spec
uniformity breakdown (findings.json and the split column carry it).

## M7 — reject-as-annotation trap (hatchet field study)

**Implemented** with `eval/FINDING-hatchet-reject-annotation.md` (fourth
field target; no defect in hatchet; 5/5 generations computed the correct
`next.*` writes and appended `reject(reason)` as a success label — 0/19
consistent until that ONE line was removed: 19/19). Fix:
`prompt_template_v2.txt` states REJECT MEANS DECLINED, FULL STOP (terminal,
no preceding `next.*` writes, no accept-with-a-reason primitive; special
rule names are rejection reasons only); `verify.mjs` detects the signature
(a spec `rejected(...)` on a window whose trace post ≠ pre —
`rejectedButCodeActed` per finding, `rejectedActedWindows` in the summary,
triage hint in findings.md and the skill's Step 5). Load-time hard-fail of
write-then-reject belongs in the library — drafted upstream:
`docs/draft-upstream-issue-reject-after-write.md`.

All milestones done.

## M8 — named-rule ≠ rejection (n8n field study)

**Implemented** with `eval/FINDING-n8n-reject-no-write.md` (fifth target; no
defect in n8n; the pure-reject trap reproduced 5/5 AFTER the 6.1.0 prompt
wording fix — trigger isolated to "branch maps to a named specialRules
entry", independent of whether the rule describes a no-op). Root cause was
the tool's own directive: the template headed specialRules "REQUIRED
reject(reason) cases" and the renderer commanded `reject('name')` for every
rule. Fix (both suggested angles): (1)
`renderSpecialRulesAsRejections(contract, windows)` classifies each rule
against the corpus — [REJECTION] when its matching windows all no-op,
[BEHAVIORAL — must NOT reject] when they change state, decide-from-source
when unexercised; polygen's no-corpus path keeps the authored must-reject
reading; the template teaches the observable-change decision test. (2) The
`rejectedActedWindows` signal is promoted to an **auto-regeneration
trigger**: uniform signature on ≥2 windows in generation mode → one
regeneration with the offending windows called out, second pass reported,
both spec sets kept, `--no-auto-regen` opts out. Review findings fixed:
MIXED rules (some windows no-op, some change) render two-armed
instructions split by pre-state — or the per-branch observable-change test
when the arms overlap — never one absolute (an absolute manufactured the
inverse act-instead-of-reject trap, reproduced on the repo's own
m04-doc-approval corpus); whenState idioms ("key == 'value'", 'any')
normalize before matching; name-only rules render as documentation, never
a blanket command; `changed` uses `stable()` (the replayer's canonical
equality); the regen addendum declares precedence over the base prompt's
Special-rules lines; findings.md's regen banner and the skill's Step-5
triage both flag the contract-question tension (if the contract
deliberately declared those windows no-ops, the FIRST pass was the
signal — `--no-auto-regen`); `--no-auto-regen` with `--specs` errors
loudly. The regen path is tested end-to-end through the
`opts._generateSpecs` seam (trigger, addendum, both-passes report,
opt-out) — no live API in tests.

**Upstream closure (2026-07-23):** both drafts filed and shipped —
sam-lib **#35** (union types) and **#36** (reject-after-write hard-fail,
per-acceptor: a different acceptor's veto after another wrote stays legal)
landed in **sam-pattern 2.2.0**. Polygraph **6.1.0** vendors 2.2.0:
`renderModelShape` emits real union arrays (the `{}` escape is retired,
shape checking recovered on union keys; to-tla union limit unchanged);
the reject-as-annotation library throw is the primary detection with
verify's trace signature kept as the fallback; findings.md surfaces
per-window spec runtime errors so library diagnoses reach the report.

**Thesis:** the first external field study
([eval/FINDING-raft-field-study.md](../eval/FINDING-raft-field-study.md),
hashicorp/raft, two machines, July 2026) validated the method — controls
discriminated, the N-way vote caught a repeatable 4-of-5 misreading, no false
code-findings — but exposed four places where the tooling stays silent about
its own blind spots and one place where the skill under-teaches. Every item
below is something that actually bit us in that study; nothing is
speculative. Each milestone follows the repo convention: implement → test →
adversarial review → fix confirmed findings → commit.

---

## M1 — frozen-field warning (the checker's structural blind spot)

**Problem.** A state key that no action ever changes (`startIndex` in
`commitment.go`) fixes the checker to its `init()` value: every behavior
gated on a non-default value is structurally unreachable from init, and the
check passes vacuously. Proven by mutation: with the safety gate deleted,
Part 2 still reported 0 violations; only replay caught it.

**Deliverable.** After exploration in `check.mjs`, compare every state key's
value across the full reachable graph. For each key whose value is identical
in every reachable state, emit a domain-note-style warning:

> state key `startIndex` never changes across any explored action — if it
> gates behavior, Part 2 cannot verify that behavior from init; supply
> `--initial-states` seeds (or trace windows) with non-default values.

The remedy already exists (`--initial-states` seeding, built for polyvers);
the gap is purely that nothing tells the user to reach for it.

**Touch points.** `scripts/check.mjs` (post-exploration scan; fold into
`domainNotes` so `render()` and `verify.mjs`'s findings.md pick it up for
free), `test/` coverage with a machine that has a frozen gate field.

**Acceptance.** The commitment-machine shape (frozen `startIndex`, deleted
gate) now produces a loud warning in `findings.md`; a machine where every
key varies produces no new noise; seeded runs that unfreeze the key clear
the warning.

## M2 — runaway-exploration guardrails

**Problem.** An action that mints a fresh state forever (unbounded
monotonic counter: raft's `ElectionTimeout` term bump) turns the default
`--max-states 100000` into a 15+ minute silent grind, killed by hand.

**Deliverable.**
1. **Drift detection:** during BFS, track distinct values per state key.
   When a key's distinct-value count crosses a threshold (e.g. ≥1000 and
   still growing ~linearly with states explored), warn immediately on
   stderr and in the result: "state key `term` has N distinct values and
   growing — the state space is likely unbounded in this key; consider
   abstracting it in the contract or a much smaller `--max-states`."
2. **Progress heartbeat:** a stderr line every ~10s of exploration
   (states discovered, frontier size, elapsed) so a long run is visibly
   alive and visibly runaway, instead of silent.

Keep the default cap; the fix is *telling the user early*, not guessing a
universal bound.

**Touch points.** `scripts/check.mjs` (explore loop), threading the drift
warning into `domainNotes`.

**Acceptance.** A term-bump-style machine warns within seconds; a bounded
machine (the 64-state commitment control) produces neither warning nor
heartbeat noise; determinism double-pass digests are unaffected (heartbeat
and drift stats stay out of the digest).

## M3 — spec-vs-spec agreement report

**Problem.** `verify.mjs` already classifies spec-vs-trace per window, but
the spec-vs-*spec* structure of a disagreement is invisible. The raft
commitment run's key signal — 4 of 5 specs making the *identical* mistake,
1 dissenter agreeing with the hand control — was only found by reading the
generated code.

**Deliverable.** From the existing `matrix[spec][window]`, compute pairwise
agreement between live specs and per-spec deviation from the majority
verdict. Add to `summary` and `findings.md`:

- a consensus line: "5 live specs; pairwise agreement 78%; spec_2 deviates
  from the majority on 11/25 windows — review the outlier before trusting
  the majority";
- per-finding, which specs form the majority vs. the minority (the
  `statuses` column already lists pass/fail; name the split explicitly when
  it is lopsided, e.g. "4-vs-1 — the minority may be the one that read the
  source correctly; check it against the source, not the vote count".

The framing matters: a lopsided split is *evidence of a trap in the source's
legibility*, not automatically evidence the majority is right — the raft
case had the majority wrong.

**Touch points.** `scripts/verify.mjs` (`summary`, `renderMarkdown`),
`eval/skill-ab.mjs` if it consumes `summary` shape.

**Acceptance.** Replaying the saved raft commitment specs (`--specs`)
surfaces the 4-vs-1 split in the summary without hand-diffing; an all-agree
run adds a single quiet consensus line.

## M4 — scripted negative control (`mutate`)

**Problem.** The skill mandates a negative control, but it is hand work:
copy the control spec, break one rule, guess which windows should now fail,
eyeball the delta. Under time pressure this step gets skipped — and it is
the only step that proves the harness can fail.

**Deliverable.** A small `scripts/mutate.mjs`:

```
node mutate.mjs --spec control.js --contract c.json --traces traces/ \
  [--list | --apply <mutation-id> --out mutated.js]
```

- `--list`: enumerate applicable targeted mutations (drop a guard / reject
  rule, negate a condition, skip one effect) with stable ids. Reuse the
  mutation machinery polynv's mutation grade already drives through
  `check()`'s `steps` override rather than forking a new mutator.
- `--apply`: write the mutated spec, replay it against the corpus alongside
  the original, and report the delta: "mutation dropped-guard-3: 22/25
  (original 25/25); windows 7, 11, 19 flipped — the corpus discriminates
  this rule ✓". A mutation with **zero** flipped windows is the headline
  result: that rule is not exercised by any trace (exactly the M1 class of
  blind spot, seen from the corpus side).

**Touch points.** new `scripts/mutate.mjs`, reuse from `polynv`'s mutation
grade, `skills/polygraph/SKILL.md` step-3 rewrite to call it.

**Acceptance.** On the raft commitment control, one listed mutation
reproduces the hand-made negative control (22/25, same 3 windows); a
mutation of the `startIndex` gate with the original corpus reports the
zero-flip warning.

## M5 — skill guidance: traces are the verification

**Problem (doc-only).** Two field lessons the skill does not yet teach:

1. **No real traces → wrong tool.** Part 1 is empty without captured
   behavior; hand-modeling both sides is grading your own homework. The
   skill should say this up front as a disqualifier, not a caveat.
2. **Capture by event subscription, not polling.** Polling at ~2 ms missed
   *every* sub-millisecond Candidate occupancy in raft; the library's own
   Observer mechanism caught them all. Guidance: prefer the target's native
   event/observer/hook surface; treat "sleep and poll" as a red flag for
   any transition that can resolve faster than the poll interval; sanity-
   check the corpus for states the contract declares but the corpus never
   visits (that absence is itself a capture bug until proven otherwise).

**Touch points.** `skills/polygraph/SKILL.md` (prerequisites + corpus-
capture section), `commands/verify.md` if it repeats the prerequisites.

**Acceptance.** Review-only milestone: the skill states the disqualifier
before the workflow steps, and the capture section names the
polling-vs-subscription failure mode with the raft example.

---

## Sequencing and non-goals

M1 → M2 (both live in `check.mjs`'s explore loop; M1 is smaller and its
warning plumbing is reused by M2) → M3 (independent, `verify.mjs` only) →
M4 (depends on nothing above but benefits from M1's vocabulary for the
zero-flip case) → M5 (doc pass last, so it can cite the new tooling).

**Non-goals:** no change to the verdict vocabulary (`classify()` stays
canonical); no automatic model selection or cross-model orchestration
(lesson 6 of the field study is a documented tactic, not tooling); no
attempt to make the checker explore beyond its domain — M1 makes the
boundary *visible*, seeding remains the remedy.
