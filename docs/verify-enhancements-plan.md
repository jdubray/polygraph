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

M3–M5 open.

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
