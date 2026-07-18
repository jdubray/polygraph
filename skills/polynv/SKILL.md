---
name: polynv
description: Elicit the invariants for a state machine — the plugin takes the lead. Harvest candidate invariants from the contract's own vocabulary (terminal states, typed fields, reject rules, effect kinds), contribute the frontier model's domain knowledge as candidates, pre-check every candidate against the machine so each question arrives with a HOLDS verdict or a concrete counterexample story, then drive a plugin-led interview that converges an append-only intent ledger into a confirmed invariants.mjs. Use when the user asks "what invariants should this machine have", "help me write invariants", "is my invariant set any good", or when polygen/polygraph need an invariants.mjs that does not exist yet. Elicitation is an ongoing, multi-person activity — sessions resume from intent-ledger.json and never re-ask settled questions.
---

# polynv — elicit the invariants (the plugin leads)

Every Polygraph gate is exactly as good as `invariants.mjs`, and writing
good invariants from a blank page is a scarce skill. This skill routes
around it: **you (the in-session assistant) drive the interview**; the
designer's job is reduced to judging concrete stories — confirm / reject /
modify / defer — which is a common skill. Never wait for the designer to
propose invariants unprompted; propose, ask, and record.

> **Disclosure (same as the whole plugin).** This is experimental, unproven
> technology. A pre-check verdict is a consistency check over the declared
> finite (action, data) domains, not a proof. Harvested candidates describe
> BEHAVIOR, not intent — a machine with a bug yields candidates that bless
> the bug — which is why nothing enters `invariants.mjs` without the
> designer's explicit disposition, and why you must never answer an intent
> question on the designer's behalf. A CONVERGED verdict means every question
> was answered AND the mutation adequacy grade ran — it still does not prove
> the questions were sufficient: the grade bounds unconstrained behavior, it
> does not certify intent, and behavior-removing mutations largely evade it.

The CLI is `${CLAUDE_PLUGIN_ROOT}/polynv/bin/polynv.mjs`; an artifact dir
holds `contract.json` + the SAM v2 module + optional `effects.manifest.json`
(what polygen emits). The system of record is `intent-ledger.json` in that
dir — append-only, in git, holding every record ever considered including
rejected and abandoned ones. Deterministic, no API key.

## Step 1 — Harvest (mechanical)

```
node ${CLAUDE_PLUGIN_ROOT}/polynv/bin/polynv.mjs harvest --artifacts <dir> \
  [--traces <dir-or-file.ndjson>] [--snapshots <corpus>] [--min-obs N]
```

Generates template candidates from the contract's own vocabulary (one
absorbing question per terminal state, range/sign/set-once/monotone per
typed field, one no-op question per reject-describing special rule, one
at-most-once question per manifest effect kind) and pre-checks each against
the machine. **Always offer to mine**: if traces, a polyrun journal export,
or fleet snapshots exist, pass them — the miners add observed-behavior
candidates (in-domain, ranges, orderings, control-key implications,
temporal precedence) with observation counts as evidence; mined candidates
are *behavior*, so their question is always "rule, or artifact of the
corpus?". Below-threshold observations become notes, not questions. Read
the output notes: a special rule that mentions rejection but was not
mechanically templatable is YOUR question to ask by hand; pruned and
vacuous candidates are listed with reasons.
Re-running harvest is always safe — settled records are never re-proposed.

## Step 2 — Contribute domain priors (your obligation, before the first question)

Identify the domain from the contract vocabulary and any feature prose
(payments, auth/session, inventory, approval flow, …). Enumerate the
invariants canonical to that domain from your own knowledge — the designer
of a payment system gets asked about authorization-before-capture whether
or not any harvester surfaced it. Add each as a candidate with provenance:

```
node ${CLAUDE_PLUGIN_ROOT}/polynv/bin/polynv.mjs add --artifacts <dir> \
  --id "prior:<slug>" --target state|transition \
  --question "<the domain norm, as a question about THIS machine>" \
  --js "<the predicate>" --author <your-name> --source domain-prior \
  --domain <domain> --norm "<the norm as you state it>" --model <your model id>
```

The pre-check runs immediately: a prior that FAILS arrives at the interview
with its counterexample attached. A prior the designer rejects is
documentation gold — record their reason as `--concern`.

## Step 3 — The interview (you lead, one question at a time)

```
node ${CLAUDE_PLUGIN_ROOT}/polynv/bin/polynv.mjs questions --artifacts <dir> --next --json
```

Present exactly one question, concrete-story-first. The ranking is
information-greedy: counterexample questions come first — show the shortest
path verbatim and ask *"the machine can do this today; is this
acceptable?"* Acceptable → record `reject` (the behavior is intended; note
why). Not acceptable → record `confirm` — the rule becomes intent AND the
counterexample is the repro of a live finding; say so plainly. For HOLDS
questions ask *"rule, or coincidence of the current code?"* For emission
questions (pre-check NOT-RUN at M0) still ask; a confirmed one is recorded
for check-effects wiring.

Record every answer with attribution:

```
node ${CLAUDE_PLUGIN_ROOT}/polynv/bin/polynv.mjs record --artifacts <dir> \
  --id <recordId> --disposition confirm|reject|abandon|defer|modify \
  --author <designer-name> [--js "<revised predicate>"] [--concern "…"] [--assign <name>]
```

House rules:
- **Never accept a free-form invariant without re-checking it** — a
  designer's revision goes through `--disposition modify`, which re-runs
  the pre-check; a revision the machine reachably violates stays open with
  its counterexample and must earn its own confirmation.
- **Know the two special revision shapes.** A temporal (precedence) record
  is revised STRUCTURALLY — `--js
  '{"kind":"precedence","first":"<ACTION>","then":"<ACTION>"}'` — and is
  confirmable only after its graph check ran; free-form js is refused. A
  mutation-survivor record has no predicate yet: the answering `modify`
  supplies the rule AND its shape via `--target state|transition`, then a
  separate `confirm` (which reports the rule's consequences).
- **Never answer an intent question yourself.** You propose and frame; the
  designer dispositions. If they are unsure, offer `defer` with `--assign`
  and `--concern` — elicitation is multi-person and ongoing by design; a
  later session (`questions --for <name>`) picks the question up.
- **Respect the budget.** A designer answers 20–40 questions in a sitting.
  When attention flags, stop, report, and leave the rest open in the ledger.

## Step 4 — Grade, then close the session honestly

```
node ${CLAUDE_PLUGIN_ROOT}/polynv/bin/polynv.mjs grade --artifacts <dir> [--include-invariants]
node ${CLAUDE_PLUGIN_ROOT}/polynv/bin/polynv.mjs report --artifacts <dir> --log
```

The grade measures invariant-set strength by mutation (equivalent mutants
are discarded mechanically by graph comparison — the denominator is
behaviorally distinct mutants only) and **convergence requires it**. Each
surviving mutant becomes a top-ranked question: "no rule constrains this
behavior change — supply one, or accept it as out-of-intent." Pass
`--include-invariants` when the dir has a hand-written `invariants.mjs`
worth grading alongside the ledger's confirmed rules — that is also the
adoption path for machines that predate polynv. Know the grade's blind
spot and say it: behavior-REMOVING mutants (a timer that silently stops
firing) largely survive any safety-invariant set — those survivors are
telling you about the limits of state invariants, not necessarily about
missing rules. polyvers discloses the grade in its compat-report, so
grading here strengthens every future version verdict.

Never end without stating the verdict: **CONVERGED** (every record
terminal AND graded) or **PARTIAL** (name what remains, per assignee). Walk the user
through: the FINDINGS list (confirmed rules the machine reachably violates
— each carries its repro; fixing the machine is the follow-up, via polygen
repair or by hand, then `polynv` re-checks on the next pass), the confirmed
emission rules awaiting check-effects wiring, and where the generated
`invariants.mjs` was written. The overwrite guard never clobbers a
hand-written `invariants.mjs` — reconcile by hand or pass `--out`, and say
which you did. `INTENT-LOG.md` is the rendered view for the PR; the ledger
is the artifact to commit.
