# polynv — plan for the fifth engine (invariants)

**Status: PLAN v0.3 — COMPLETE (M0–M3 + follow-ups), design revised by literature review** under
[`polynv/`](../polynv/README.md): the contract-structure template
generator, per-candidate pre-check through `scripts/check.mjs` (HOLDS /
FAILS-with-counterexample / BOUNDED / ERROR / NOT-RUN), the append-only
`intent-ledger.json` with the full disposition lifecycle
(confirm/reject/abandon/defer/modify, attributed, multi-person), generated
`invariants.mjs` with provenance and a hand-written-file overwrite guard,
the `harvest`/`questions`/`add`/`record`/`report` CLI, and the plugin-led
dialog skill with the domain-prior obligation
(`skills/polynv/SKILL.md`). `npm run test:polynv`. The pre-M0 open
questions were resolved with the author on 2026-07-18 (§10). A
literature-informed design review (2026-07-18, recorded in §11) revised
the mining, dialog, and grading designs and added the
adequacy-into-compat-report integration. **M1 is implemented** per the
revised design: both retrofits (consequence machinery via the reachable
graph; the SAM-tuned grammar), both miners with confidence thresholds,
the graph-BFS precedence pre-check, normal-form pruning + vacuity
filtering, and headless `--llm`. **M2 is implemented**: the four mutation
operators, equivalent-mutant discard by graph comparison, kill-profile
clustering + open-candidate profiling (hypothesis-splitting rank),
survivor questions, convergence-requires-grade, `--include-invariants`
(grade a pre-existing hand-written intent artifact), and the adequacy
line in polyvers' compat-report. **Calibration on the OMS worked example
(decision §10.4, 2026-07-18):** the known-good hand-written set kills
**101/113** behaviorally distinct mutants (5 equivalents discarded); all
12 survivors are drop/retarget mutants in the timer/completion band —
confirming that behavior-REMOVING mutants are largely invisible to
safety invariants (a machine that does *less* violates no state rule).
That blind spot is stated in the skill and report; liveness/response
monitoring is the recorded gap. The operator set stands as chosen.
**Adversarial review of M0–M2 (house convention) ran 2026-07-18** — 8
finder angles, 24 deduped candidates, 5 verifier agents; all 17 confirmed
findings fixed (regressions: `polynv/test/review-fixes.test.mjs`). The
load-bearing fixes: the reachable graph now surfaces throwing steps and
nondeterminism (crashing mutants are harness-killed, never "survivors";
machine faults pre-check as ERROR, never as the candidate's FAILS); the
grade explores mutants over the interview's own manifest alphabet
(`check.mjs` gained an explicit `steps` override) and refuses 0-distinct
runs; grades carry an oracle hash so polyvers discloses STALE instead of
presenting an outdated score; temporal rules are revised structurally and
confirmable only after the graph check; a reopen-to-zero removes the
generated invariants.mjs instead of leaving retracted rules enforcing;
vacuity covers every guarded kind and is skipped over unsound graphs;
miners tolerate old-shape snapshots. Recorded non-fixes: the widen
operator's chimera fragility on stricter acceptors (now harness-killed,
not misclassified — full fix would need acceptor-aware donors) and the
per-candidate BFS cost in harvest (efficiency backlog).
**M3 is implemented**: `commands/polynv.md` (`/polygraph:polynv`),
`agents/polynv.md` (the autonomous half only — harvest/pre-check/grade/
question prep; the interview is never delegated), quintet integration
(ARCHITECTURE five engines + Engine 5 section + intent-ledger artifact
row + invariant-strength trust-boundary row; SDLC human gate #2 gains
the elicit path; README names the grade as the partial adequacy
measure; plugin/marketplace manifests updated), and polyvers' intent
lane consumes ledger provenance — the compat-report's intent diff
annotates each added invariant as elicited-and-confirmed-by, ledger:
<status>, or the bare fact "(no ledger record)" (never a verdict — a
hand-written rule may be well-reviewed outside polynv). M3's own
adversarial review fixed a lookup-key mismatch (diff names are
'state:'/'transition:'-prefixed; ledger ids are bare), the
partial-provenance-on-parse-failure inconsistency, and the
polynv-unavailable misdiagnosis (RECORDED BUT UNVERIFIED, not
UNREADABLE). **Completion (follow-ups closed):** the shared-graph
pre-check fast path (verdict parity test-asserted; harvest ~6× faster on
the OMS example), the emission pre-check through polyrun check-effects,
`polynv drift` (the §10.6 re-interview diff: moved verdicts named,
judged answers re-asked under `--reopen`, confirmed-now-violated rules
kept confirmed as findings), and the review's efficiency backlog.
**Still recorded:** acceptor-aware widen donors, runtime monitoring of
confirmed temporal rules, composition drift for emission records, the
five-engine diagram refresh.

**Thesis:** every gate in the other four engines is exactly as good as
`invariants.mjs`, and the repo says so itself — *"unstated intent is
invisible to every gate"* (VERSIONING.md), *"a converged run against wrong
intent proves nothing"* (ARCHITECTURE.md trust boundaries). The ceiling of
the whole edifice is invariant-writing maturity, which is a scarce skill:
the tooling makes good invariants cheap to *check*, not cheap to *have*.
polynv attacks the *have* side in two steps: **harvest** candidate
invariants from observed behavior, contract structure, and the frontier
model's inherent domain knowledge (someone building a payment system
should inherit the domain's canonical rules, not rediscover them), then
a **plugin-led dialog** that converges the candidates into a confirmed
`invariants.mjs` — with the plugin, not the designer, driving the
conversation, because asking a human to produce well-crafted invariants
from a blank page is exactly the scarce skill we are routing around.

The engine verb set becomes: Polygraph **audits**, polygen **authors**,
polyrun **executes**, polyvers **evolves**, polynv **elicits**. The
composition in one line: **Daikon mines, L\* asks, van Lamsweerde
generalizes, SpecFuzzer gates** — each piece decades-old or
well-benchmarked, the composition aimed at a versioning pipeline
apparently unclaimed (§11).

---

## 1. The one design rule everything follows from

**Harvested invariants are behavior, not intent.** Anything inferred from
traces, the journal, or the BFS describes what the code *does* — a machine
with a double-charge bug will happily yield "charges ≤ 2" as an observed
property. If harvested candidates flowed into the gates unconfirmed, the
edifice would collapse into replay determinism ("the new version behaves
like the old one"), which is precisely the industrial default
VERSIONING.md argues against. So:

- **No candidate ever enters `invariants.mjs` without an explicit human
  disposition.** The human gate is irreducible; polynv's job is to
  maximize intent captured *per unit of human judgment*.
- The skill polynv demands from the designer is *judging concrete
  stories* (common), not *writing quantified predicates from scratch*
  (scarce). Every question the dialog asks is anchored to something
  concrete: an observed property with its witness windows, a template
  over a name the contract declares, or a shortest counterexample path.
- Every confirmed rule carries **provenance** — how it was elicited and
  what the human answered — so downstream consumers (polyvers' intent
  lane, reports) can distinguish confirmed intent from proposal forever.
- **The generation role never holds the acceptance role** (the
  structural anti-sycophancy rule; cf. IDEA2, §11). The agent that
  drafts a predicate — template generator, miner, or the interviewing
  model itself — is never the authority that accepts it: acceptance
  belongs to the mechanical checks (pre-check, corpus, model check) plus
  the designer's attributed disposition, and to nothing else. Model
  agreement, however confident, is not a disposition.
- **Lead with consequences, not predicates.** Every question and every
  acceptance is anchored to executable evidence: a proposed rule is
  shown by what it *forbids* (concrete states/paths), and an accepted
  rule immediately reports what it does to reality — "this rule already
  fails on 3 live fleet states; here they are." Predicates get nodded
  through; concrete newly-forbidden states get scrutinized. The
  conversation anchors to evidence, not rapport.

## 2. Step 1 — harvest (deterministic, no API key)

Six candidate sources, each producing entries in `candidates.json` with
evidence attached. Candidates are *questions*, never rules.

Mining is **two different problems with different substrates and
algorithms** — the artifact family already separates the targets
(`stateInvariants` / `transitionInvariants`), and the miner must too:

1. **State-property mining (Daikon-style, over snapshots).** Daikon's
   real lesson is not "mine from traces" but *how*: a **fixed grammar of
   property templates** instantiated against observations, with
   **statistical confidence thresholds** so coincidences on small corpora
   never become proposals (a field constant across 6 windows is noise;
   across 4,000 it is a question). polynv's grammar is tuned to SAM
   machines rather than generic programs — generic templates produce
   noise, and triage fatigue is this engine's failure mode: flag
   implications (`refunded → !shipping`), key-presence-per-control-state,
   domain-value constraints, ranges/constancy/orderings over the declared
   state keys. Substrate: fleet snapshots and window pre/post states.
   Evidence: the observation count, the confidence, three witnesses.
2. **Temporal-property mining (Perracotta/Synoptic-style, over the
   journal).** `amount >= 0` is a state property; *"charged implies
   authorize happened earlier"* is a **temporal** one, minable only from
   event *sequences* — response, precedence, alternation patterns over
   the journal's action stream. The polyrun journal is a
   production-grade temporal corpus for free. Mined temporal candidates
   land as transition invariants where expressible, and as emission/
   check-effects candidates where they constrain the composition.
3. **Contract-structure templates.** The contract already declares
   actions, effect kinds, terminal states, spawn wiring. That vocabulary
   generates a finite checklist of invariant templates: *at-most-once*
   per effect kind, *absorbing* per terminal state, *precedence*
   (X never before Y) per effect pair, *balance* (charge/refund pairing),
   *ceiling* per counter-shaped field, *spawn-count* per child machine.
   This is exhaustive over the vocabulary in a way a human staring at a
   blank file never is — and it is the harvest source that can propose
   rules the code currently *violates* (which mining, by construction,
   cannot).
4. **Reachability surprises.** The BFS already enumerates every reachable
   state over the declared domains. Cluster them by control state and
   flag combinations likely to be unintended (terminal state with pending
   obligations, flags in contradictory positions). Each surprise is
   either a bug or a missing invariant — the dialog decides which.
5. **Frontier-model domain priors.** Someone building a payment system
   should not have to rediscover "never capture without an
   authorization", "refunds never exceed the captured amount",
   "idempotency keys imply at-most-once side effects" — decades of
   domain lore (payments, auth/session, inventory, approval workflows)
   are in the model's training, and this source asks for them
   *independent of the code*: given the contract's vocabulary and the
   feature description, what invariants are canonical in this domain?
   That independence is the point — domain priors can propose rules the
   code violates AND rules no trace ever exercised, the two blind spots
   of mining. In-session, the interviewing model supplies these directly
   (no API key — the skill demands them, see §7); headless, `--llm`
   generates them. Still candidates like everything else: a domain norm
   the designer rejects ("we allow multiple partial captures") is a
   recorded, load-bearing answer.
6. **LLM reading of source + intent prose** (optional, API key). What
   polygen's proposal step does today, generalized to existing code:
   candidates from names, comments, and the feature description. Lowest
   trust tier, labeled as such.

Every candidate is then **pre-checked** with the existing engine: run
`check.mjs` with the candidate as the sole invariant. HOLDS → the
question is "is this a rule or a coincidence?". FAILS → the shortest
counterexample path becomes the question itself (see step 2). Vacuous or
implied-by-another candidates are pruned before any human sees them —
wasted questions are the failure mode of this whole engine.

## 3. Step 2 — dialog (the plugin takes the lead)

The dialog is an interview the plugin drives, not a form the designer
fills. Designer attention is the scarce resource, so **query efficiency
is the whole game** — and the active-learning literature (Angluin's L\*,
van Lamsweerde's scenario inference; §11) is the principled version of
what a heuristic ranking only approximates:

- **Select questions that split the hypothesis space.** polynv maintains
  *competing* candidate invariants; the highest-value question is a
  concrete state or path on which candidate A says *legal* and candidate
  B says *illegal* — one designer judgment kills half the hypothesis
  space, where an oddball state kills at most one candidate. The M0
  ranking (counterexamples first, then priors, templates, emission) is
  the bootstrap heuristic; from M2 the discriminating signal is the
  **killed-mutant profile** (§4) — candidates with different kill
  profiles are behaviorally distinct, and a state distinguishing them is
  computable from the mutant graphs, so the grade and the dialog share
  machinery.
- **The equivalence-query move: show consequences, never (only) the
  predicate.** When a label generalizes into a predicate — or a designer
  offers a revision — do not present the formula for approval; present
  what it *additionally forbids*: "this rule newly excludes these 4
  reachable states; here they are." Predicates get nodded through;
  concrete newly-forbidden states get scrutinized. (Mechanically: diff
  the BFS-reachable set filtered by the old vs the new predicate.) The
  loop is van Lamsweerde's: judgments as positive/negative examples,
  inductive generalization, human confirmation *of the generalization's
  consequences*.

Ordering, then: hypothesis-splitting questions first once the machinery
exists; until then counterexamples first, then templates over
vocabulary, then mined properties, then surprises. Question forms, all
closed-ended:

- **Counterexample question** (candidate FAILED pre-check): "Here is a
  concrete sequence: *created → charged → cancel → retry lands → charged
  again*. The final state is X. **Is this acceptable?**" Reject → a
  confirmed intent invariant is born *with its repro attached*, and it is
  a known-reachable violation — a finding, surfaced immediately. Accept
  → the candidate dies, and the acceptance is recorded (polyvers' intent
  lane can later detect when a newly proposed rule contradicts it).
- **Template question** (from vocabulary): "The contract declares effect
  `chargeCard`. **Can it ever be emitted twice for one instance?**" No →
  emit the at-most-once emission invariant. Yes → ask for the bound or
  the condition; "it depends" escalates to a free-form rule the plugin
  drafts and reads back for confirmation.
- **Coincidence question** (mined, HOLDS): "In all 4,182 observed
  windows, `refundTotal` never exceeded `chargeTotal`. **Is that a rule
  or an artifact of the scenarios run so far?**" Rule → confirm. Artifact
  → record the rejection so it is never asked again.
- **Domain question** (from priors): "Payment systems conventionally
  guarantee *no capture without a prior authorization*. Your contract
  has both `authorize` and `capture`. **Does this rule apply here?**"
  Confirmed domain priors are the highest-value confirmations — they
  encode intent the designer would likely never have articulated
  unprompted — and a *rejected* prior is documentation gold: the log
  records exactly where this system deviates from its domain's norms.

Designer answers are: **confirm** / **reject** / **weaken-or-modify** /
**defer** (park the question with an optional concern note, to be
answered by someone else or at a later time). The plugin redrafts and
re-checks every modification before accepting it — a modified rule that
is unreachable-vacuous or already violated is pushed back, never
silently recorded. And every **confirm** answers back with consequences
(§1): the rule's immediate effect on reality — reachable states it
forbids, live fleet snapshots it already fails on (when a corpus is
wired), the finding it opens if its pre-check FAILED — so acceptance is
anchored to executable evidence at the moment it happens. Every question, answer, concern, and predicate
revision appends to the **intent ledger** (§8) — the record of *why*
behind every rule, attachable to the PR that lands `invariants.mjs`.

**Elicitation is an ongoing activity, not a sitting.** This is a design
decision, not an accident: real invariant sets converge over days or
weeks, with more than one person involved in separate sessions. So the
unit of state is the per-invariant **record**, not the session: each
record carries its predicate *versions* (an invariant may be weakened,
strengthened, and reworded several times before reaching its final
shape), its open questions and concerns (each with author and date,
answerable later by someone else), and its lifecycle status —
`candidate → open → confirmed | rejected | abandoned | superseded`.
A session is just an episode that advances some records; the dialog
resumes from the ledger, never re-asks a settled question, and can
route a deferred question to the person named on it.

**Convergence is a named verdict over the ledger, not an exit.** The
elicitation is CONVERGED when (a) every record is in a terminal status,
(b) every vocabulary template is answered, and (c) the adequacy grade
(below) meets the target or its surviving mutants are explicitly
accepted as out-of-intent. Anything less is reported PARTIAL with the
open-record list, per person where questions are assigned — the
no-silent-clean doctrine, applied to elicitation.

## 4. The adequacy grade — measuring what no gate measures

The disclosures currently admit that nothing measures invariant-set
strength. polynv adds the first partial measure, mutation-based:
systematically perturb the *machine* (swap a guard, drop a `reject`,
reorder a transition, widen an acceptor) and model-check each mutant
against the current invariant set. A mutant no invariant kills is a
behavior change the rules do not constrain — and its diff plus a
distinguishing trace becomes the next dialog question. The grade
("your invariants kill 14/20 mutants; the 6 survivors are these
behaviors") is reported the way corpus tiers are today: provenance as
part of the honesty story. It never proves the invariants match intent —
it bounds how much behavior they leave unconstrained. (This reuses the
mutated-spec negative-control machinery Polygraph already has, pointed
at the machine instead of the spec. Closest assembled pipeline in the
literature: SpecFuzzer, §11.)

Three refinements the literature review earned (2026-07-18):

- **The equivalent-mutant problem is decidable here.** Mutation
  testing's classic pain — a mutant with unchanged observable behavior
  cannot be killed, and detecting equivalence is undecidable in general
  — dissolves in this setting: a SAM v2 mutant has a **finite state
  graph over the declared domains**, so running the same BFS on original
  and mutant and comparing graphs (states + transition edges, by
  `stable()`) mechanically discards behaviorally equivalent mutants. The
  finite-domain restriction the repo discloses as its main limitation
  *pays back* here: it makes the field's hardest subproblem decidable,
  and the grade's denominator honest.
- **Cluster invariants by killed-mutant profile.** Invariants that kill
  the same mutants are redundant with respect to the mutation set —
  cluster them, present one representative per cluster, and the triage
  list compresses for free (SpecFuzzer's ranking move). The profiles
  are stored on the ledger records.
- **Kill profiles are the dialog's discrimination signal.** The same
  profiles feed §3's hypothesis-splitting question selection — the gate
  and the interview are one machine seen from two sides, not two
  features.

**The grade is a disclosed input to polyvers' verdict, not an upstream
nicety.** polyvers already discloses corpus provenance as a trust tier
(archive vs synthesized); invariant-set strength is the same kind of
fact. A semantic-lane PASS against invariants that kill 9 of 40 mutants
means much less than one against 36 of 40 — so the **compat-report
carries the mutation score** (or `adequacy: NOT MEASURED` when polynv
has not run), and the reader knows which PASS they are holding. This
closes the vacuous-green hole at the reporting layer, where the
no-silent-clean doctrine says it belongs.

## 5. What already exists (polynv wraps, not duplicates)

| capability | where it lives today | polynv role |
|---|---|---|
| candidate checking + shortest counterexamples | `scripts/check.mjs` + `sam-adapter.cjs` | pre-check every candidate; counterexample paths become dialog questions |
| snapshot/window corpus | fleet snapshots, `*.ndjson` traces | substrate for source 1 (state-property mining) |
| temporal event stream | the polyrun journal | substrate for source 2 (temporal mining — response/precedence) |
| contract vocabulary | `contract.json`, `effects.manifest.json` | the template generator for harvest source 3 |
| reachable-state enumeration | the BFS in `check.mjs` | source 4 (surprises), the equivalence-query consequence diff (§3), and mutant-graph comparison (§4) |
| frontier-model domain knowledge | the model's training (in-session assistant, or `--llm` headless) | harvest source 5 — canonical domain invariants, asked for independent of the code |
| LLM invariant proposal | polygen step 3 | harvest source 6, generalized to existing code |
| mutated-artifact negative controls | Polygraph's controls stage | the mutation engine behind the adequacy grade |
| emission invariants | `polyrun check-effects` | template targets for effect-kind questions |
| corpus/adequacy trust-tier disclosure | polyvers compat-report | grows an invariant-adequacy line sourced from `polynv grade` (§4) |

The genuinely new machinery: **the miners** (window-property inference),
**the template generator** (vocabulary → question checklist), **the
question ranker/pruner** (implication + vacuity filtering so no human
minute is wasted), **the dialog protocol** (a skill, primarily — this is
what Claude Code is for), and **the mutation grader**.

## 6. Tools (CLI, no API key except where noted)

New directory `polynv/` mirroring `polyvers/` (`src/`, `bin/`, `test/`),
CLI `polynv/bin/polynv.mjs`:

- **`polynv harvest --artifacts <dir> --traces <src>`** — run all
  applicable miners + the template generator + the pre-check; emit
  `candidates.json` (each: predicate draft, source, evidence, pre-check
  verdict with counterexample if FAILED, pruned-implications list).
  `--llm` adds source 4 (API key).
- **`polynv questions [--for <author>]`** — render the ranked open
  question list from the ledger; `--next` emits one question in a
  stable machine-readable form (what the skill consumes to drive the
  dialog); `--for` filters to questions deferred to a named person.
- **`polynv record --id <recordId> --disposition
  confirm|reject|modify|defer --author <name>`** — append the
  disposition (+ optional revised predicate, re-checked before
  acceptance; + optional `--concern <text>` / `--assign <name>` on
  defer) as a new event on the record, and regenerate `invariants.mjs`
  from all confirmed records with provenance headers. The ledger is
  append-only at the event level; nothing is ever deleted, including
  abandoned records.
- **`polynv grade --artifacts <dir>`** — the mutation adequacy grade:
  mutant kill ratio + surviving-mutant diffs and distinguishing traces,
  which feed back into `questions`.
- **`polynv report`** — convergence status: dispositioned / open /
  template coverage / grade; `--ci` prints the one-screen verdict.

## 7. Plugin surfaces

- **`commands/polynv.md`** → `/polygraph:polynv` — "help me find the
  invariants for this machine": harvest, then run an interview episode
  in the session (resuming from the ledger), then grade, then hand over
  `invariants.mjs` + the ledger and its rendered `INTENT-LOG.md`.
- **`skills/polynv/SKILL.md`** — the dialog protocol itself: the plugin
  leads, questions come from `polynv questions --next`, one at a time,
  concrete-story-first; never accept a designer's free-form invariant
  without re-checking it; never let the session end without stating
  CONVERGED or PARTIAL and what remains. The skill also **obligates the
  interviewing model to contribute its own domain knowledge**: before
  the first question, identify the domain from the contract vocabulary
  and feature prose, enumerate the invariants canonical to that domain,
  and merge them into the question queue as domain-prior candidates —
  the designer of a payment system gets asked about
  authorization-before-capture whether or not any harvest source
  surfaced it. Domain priors the model raises in-session are recorded
  through `polynv record` like every other candidate, so headless and
  in-session runs produce the same artifact shapes. Trigger phrases: "what
  invariants should this have", "help me write invariants", "is my
  invariant set any good".
- **`agents/polynv.md`** — the autonomous half only: harvest + pre-check
  + grade + question-list preparation. **The dialog is not delegated** —
  an agent answering intent questions on the designer's behalf would be
  the trap of §1 with extra steps. The agent prepares the interview; the
  human takes it in-session.
- **Docs integration (at M3)** — SDLC's human gate #2 ("review the
  invariants") gains a "or elicit them: `/polygraph:polynv`" path; the
  README/ARCHITECTURE disclosure line "no gate measures the
  declared-domain gap / invariant adequacy" gets amended to name the
  grade as a partial measure, with its limits stated.

## 8. Artifacts polynv adds to the family

- **`candidates.json`** — harvest output: candidates with evidence and
  pre-check verdicts; regenerable, diffable. `polynv questions` merges
  it into the ledger as new records (dedup against settled ones).
- **`intent-ledger.json`** — **the canonical artifact and the system of
  record.** A plain structured file in git — deliberately no database —
  holding one record per invariant *ever considered*, including the
  abandoned and rejected ones (a rejected domain norm is documentation;
  an abandoned candidate must not be re-proposed next harvest). Each
  record: stable id; source + evidence; the ordered list of predicate
  versions (normal form + compiled JS); the event stream of questions,
  concerns, dispositions — each with author and date; current status
  (`candidate | open | confirmed | rejected | abandoned | superseded`);
  for domain priors, the structured provenance of the claim (domain,
  norm as stated, model, date). Append-only at the event level; the
  format is versioned like every other artifact so polyvers can diff it.
- **`INTENT-LOG.md`** — a rendered, human-readable view of the ledger
  (`polynv report --log`), for PR reading; never edited by hand, never
  the source of truth.
- **`invariants.mjs` with provenance** — unchanged format (plain JS
  predicates — every existing consumer keeps working), generated from
  the ledger's confirmed records, plus a header comment per rule:
  elicited-by (mined / template / counterexample / domain-prior /
  mutation-survivor / designer), record id into the ledger.
- **`intent-report.{json,md}`** — convergence verdict, template
  coverage, adequacy grade, open questions. The natural attachment for
  the PR that lands or amends `invariants.mjs`, and the thing polyvers'
  intent lane can cite.

## 9. Milestones

- **M0 — templates + domain priors + dialog protocol (the value slice
  with no new checker code).** Template generator over `contract.json` /
  `effects.manifest.json`, candidate pre-check via existing `check.mjs`,
  `harvest`/`questions`/`record`/`report`, the skill running the
  interview end-to-end — including the domain-prior obligation, which
  costs nothing at M0 because in-session the interviewer *is* a frontier
  model; only the headless `--llm` path is deferred. Worked example: elicit the OMS order machine's
  invariants from scratch via dialog and compare against the
  hand-written `effect-invariants.mjs` — how many of the real rules does
  the interview reach, and what did it surface that the hand-written set
  missed?
  **M0 retrofits from the design review (small, do first in M1):** the
  equivalence-query presentation — `record --disposition modify` and
  confirm answers report the consequence diff (reachable states newly
  forbidden vs the prior predicate) computed from the BFS, not just the
  re-check verdict; and the SAM-tuned property grammar replaces the M0
  ad-hoc template kinds as the shared normal-form vocabulary miners and
  templates both emit.
- **M1 — the miners + `harvest --llm`.** Two miners, per the state/
  temporal split (§2): the SAM-tuned property grammar over snapshots and
  window states (flag implications, key-presence-per-control-state,
  domain-value constraints, ranges/constancy) **with statistical
  confidence thresholds** — below-threshold observations never become
  questions; and response/precedence mining over the polyrun journal.
  Normal-form implication/vacuity pruning (the question-economy work);
  coincidence questions wired into the dialog; the headless LLM path
  (domain priors + code-reading, sources 5–6) in the CLI.
- **M2 — the adequacy grade + the principled dialog.** Machine mutation
  operators; **equivalent-mutant discard by BFS graph comparison** (the
  denominator is behaviorally distinct mutants only); kill-ratio
  grading; **killed-mutant-profile clustering** (one representative
  question per redundancy cluster); surviving-mutant questions fed back
  into the dialog; **hypothesis-splitting question selection** over the
  kill profiles (§3 — the gate and the interview share machinery);
  convergence redefined to include the grade. **polyvers integration:**
  the compat-report gains the invariant-adequacy line (mutation score or
  NOT MEASURED). This is the milestone that partially answers "no gate
  measures it."
- **M3 — plugin surfaces complete + quartet integration.** Command,
  agent, docs integration; polyvers' intent lane consumes provenance
  (a strengthened rule that was `confirmed` reads differently from one
  that was `proposed`); `polynv harvest` re-run on a version bump diffs
  old dialog answers against new behavior. Adversarial multi-agent
  review per milestone, same as polyrun/polyvers.

## 10. Resolved design decisions (design review with the author, 2026-07-18)

The pre-M0 open questions were put to the author and are now decisions:

1. **Elicitation is an ongoing, multi-person activity** — not an
   hour-long sitting. The plugin captures versions of invariants,
   questions, and concerns that may be answered at a later time, by a
   different person, until each invariant reaches its final shape.
   Consequence: the unit of state is the per-invariant record with an
   event stream and lifecycle status (§3, §8); sessions are episodes
   that resume from the ledger; question budgeting is a skill concern
   (the ranker stays information-greedy: counterexamples first, dedupe
   by implication).
2. **Normal form for predicates** — miners and templates emit an
   internal normal form (comparisons/implications over state keys) that
   compiles to plain JS at `record` time. Implication pruning, the
   question-economy linchpin, operates on the normal form.
3. **Invariant records are kept forever, in a structured JSON file, no
   database** — `intent-ledger.json` (§8) holds every record ever
   considered, including the abandoned ones that never made the list;
   append-only at the event level, versioned, in git.
4. **Mutation operators (chosen on the author's delegation):** start
   with the classic state-machine four — guard negation, transition
   retarget, reject removal, acceptor widening — and calibrate the set
   at M2 on the OMS example against its known-good invariants (too few
   operators flatter the grade; too many flood the question queue).
   Revisit only with that calibration data in hand.
5. **LLM code-reading (source 6) is in scope** — wired into the CLI as
   `harvest --llm` (API key), lowest trust tier as labeled; its
   marginal value over sources 1–5 is still measured on the M0 worked
   example, but inclusion is not conditional on the measurement.
6. **Domain-prior provenance is structured** — each domain-prior record
   carries the domain, the norm as the model stated it, the model id,
   and the date (§8), so a future re-interview by a sharper model diffs
   its priors against recorded answers instead of re-asking.

## 11. Where this sits in the literature (design review, 2026-07-18)

An LLM-assisted literature pass (read it as a map, not a peer review —
the same caveat VERSIONING.md carries) places each piece of this engine
in an established neighborhood, and revised the design accordingly:

- **Daikon — dynamic invariant detection** is the mining design: not
  "mine from traces" but a *fixed grammar of property templates*
  instantiated against observations with statistical confidence
  thresholds ("likely invariants" — the same epistemics as this plan's
  behavior-not-intent rule). polynv's grammar is SAM-tuned (§2.1)
  because generic templates produce triage fatigue.
- **Perracotta / Synoptic — temporal specification mining** is the
  second miner: response/precedence/alternation patterns from event
  sequences, which is a different problem from state-property mining
  and needs the journal, not snapshots (§2.2).
- **Angluin's L\* and active learning** is the dialog's query-selection
  theory: with the designer as the oracle, membership queries should
  *distinguish competing hypotheses* (one judgment halves the space),
  and equivalence queries are approximated by showing a generalization's
  *consequences* — newly-forbidden concrete states — rather than its
  formula (§3).
- **Van Lamsweerde — inferring declarative specifications from
  scenarios** is the template for the whole elicitation loop: human
  judgments as positive/negative examples, inductive generalization,
  human confirmation of the generalization. Read before designing the
  dialog's generalization step.
- **Mutation analysis / SpecFuzzer — oracle strength by mutation** is
  the adequacy gate: kill ratios as invariant-set strength, redundancy
  clustering by kill profile. The classic equivalent-mutant
  undecidability *dissolves* in this setting — finite declared domains
  make mutant equivalence a BFS graph comparison (§4), the one place the
  repo's main disclosed limitation pays the toolset back.
- **The 2024–25 LLM-invariant wave (SpecGen, neurosymbolic
  loop-invariant work, InvBench; IDEA2 for human dialogs)** converges on
  the architecture this plan already had — LLM proposes, mechanical
  checker disposes, failures loop back — and adds the structural rule
  §1 now carries: the generation role never holds the acceptance role.
  Nobody serious lets model agreement stand.

The composition — mine (Daikon), ask (L\*), generalize (van
Lamsweerde), gate (SpecFuzzer), disclosed into a *versioning* pipeline's
verdict (§4 → polyvers compat-report) — appears unclaimed as an
assembled whole; every ingredient has decades of precedent. Same
posture as VERSIONING.md's survey: novel in framing, not in
ingredients.
