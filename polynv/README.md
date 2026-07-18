# polynv — the invariants engine (complete: M0–M3 + follow-ups)

The fifth engine: Polygraph **audits**, polygen **authors**, polyrun
**executes**, polyvers **evolves**, polynv **elicits**. Every other engine's
guarantee is relative to `invariants.mjs`; polynv attacks where that file
comes from. Plan and design decisions: [`docs/polynv-plan.md`](../docs/polynv-plan.md).

**Status: M2** — M0/M1 plus the adequacy grade (`polynv grade`): four
mutation operator families over the adapted machine (guard-negation drop,
transition retarget, acceptor widening, field freeze), **equivalent-mutant
discard by BFS graph comparison** (finite declared domains make the
field's undecidable subproblem mechanical — the denominator is
behaviorally distinct mutants only), kill-profile clustering, open-
candidate profiling (candidates that kill surviving mutants rank first;
profile-duplicates of confirmed rules are deprioritized), survivor
questions in the ledger, convergence-requires-grade, and the adequacy
trust-tier line in polyvers' compat-report. Calibration on this repo's OMS
order machine: the hand-written invariants kill **101/113** distinct
mutants; all 12 survivors are behavior-*removing* mutants (dropped
timers/completions) — the stated blind spot of any safety-invariant set.
`--include-invariants` grades a pre-existing hand-written `invariants.mjs`
(the adoption path). Below, the M1 story:

**M1** — M0 (templates, pre-check, ledger, CLI, dialog skill) plus
the design review's retrofits and miners (plan §11): the **reachable-graph
consequence machinery** (`record` confirm/modify answers with what the rule
forbids / a newly-forbidden vs newly-allowed diff — the equivalence-query
move), the **SAM-tuned property grammar** as the shared normal form
(implication-on-control-key, in-domain, ordering added), **state-property
mining** over `--traces`/`--snapshots` with statistical confidence
thresholds (below-threshold observations become notes, never questions),
**temporal precedence mining** over per-scenario sequences (rejects are
identity edges, not occurrences; response/liveness deliberately not mined —
the safety checker cannot decide it), a graph-BFS **precedence pre-check**
(a corpus-biased precedence FAILS with a shortest path), normal-form
**pruning + vacuity** filtering, and the headless `--llm` path (domain
priors + code-reading via the pipeline's existing Anthropic call; strict
parser, drops-with-notes). Deterministic except `--llm`; no API key
otherwise. `npm run test:polynv`.

**M3** ships the surfaces and the quintet integration: the
`/polygraph:polynv` command, the `polynv` agent (autonomous half only —
harvest, pre-check, grade, question prep; **the interview is never
delegated**: intent dispositions belong to the designer, in-session), the
five-engine docs (ARCHITECTURE Engine 5, SDLC human gate #2's elicit
path), and polyvers consuming the ledger both ways — the compat-report's
adequacy trust tier (measured / STALE / UNREADABLE / NOT MEASURED) and
intent-diff provenance annotations (elicited-and-confirmed-by vs
no-ledger-record).

**Completion** closes the recorded follow-ups: the **shared-graph
pre-check fast path** (one BFS per harvest instead of two per candidate —
verdict parity with the full checker is test-asserted; harvest on the OMS
example dropped ~6×), the **emission pre-check** (at-most-once candidates
run through polyrun check-effects whenever the dir carries the
composition — real HOLDS/BOUNDED/FAILS verdicts instead of NOT-RUN), the
**`drift` command** (the version-bump re-interview diff, plan §10.6:
re-check every recorded answer against the machine as it is now; report
moved verdicts, exit 1; `--reopen` re-asks judged answers whose ground
truth drifted while confirmed-now-violated rules stay confirmed as
findings), and the review's efficiency backlog (incremental prune
indexes, first-occurrence temporal indexing, hoisted witness maps,
clone-free mutant wrappers). Still recorded for the future:
acceptor-aware widen donors, runtime monitoring of confirmed temporal
rules, composition drift for emission records, and the five-engine
diagram refresh.

The one design rule (plan §1): **harvested candidates are behavior, not
intent** — nothing enters `invariants.mjs` without an explicit, attributed
human disposition. The skill converts the scarce skill (writing predicates
from a blank page) into a common one (judging concrete stories): every
candidate is pre-checked, so a question arrives either as *"this holds
everywhere — rule or coincidence?"* or as a shortest counterexample —
*"the machine can do this today; is it acceptable?"* Rejecting that story
confirms an invariant with its repro attached.

## Usage

```
node polynv/bin/polynv.mjs harvest   --artifacts <dir>            # templates + pre-check → intent-ledger.json
node polynv/bin/polynv.mjs questions --artifacts <dir> --next     # highest-information open question
node polynv/bin/polynv.mjs add      --artifacts <dir> --id prior:x --target transition \
    --question "…" --js "(pre,a,d,post)=>…" --author <name> --source domain-prior \
    --domain payments --norm "…" --model <id>                     # in-session domain priors
node polynv/bin/polynv.mjs record   --artifacts <dir> --id <id> \
    --disposition confirm|reject|abandon|defer|modify --author <name>
node polynv/bin/polynv.mjs report   --artifacts <dir> --log       # CONVERGED / PARTIAL (exit 1)
```

The artifact dir is polygen's output family (`contract.json` + SAM v2
module + optional `effects.manifest.json`). `intent-ledger.json` is the
system of record — append-only at the event level, in git, holding every
record ever considered (rejected and abandoned ones included; a re-harvest
never re-proposes them). `INTENT-LOG.md` is a rendered view. The generated
`invariants.mjs` carries per-rule provenance and is guarded: a hand-written
file is never overwritten without `--force`.

Elicitation is **ongoing and multi-person** (plan §10.1): `defer --assign
<name>` parks a question for someone else; `questions --for <name>` picks
it up in a later session; each record keeps its full predicate-version
history until it reaches final shape.

## Worked example — a real elicitation session

[`examples/polynv-oms/`](../examples/polynv-oms/) is a committed, genuine
session on the OMS order machine (its hand-written invariants removed):
harvest → domain priors → ten designer dispositions → grade 68/113 →
one survivor-closing rule → **88/113**, with the ledger deliberately left
mid-flight (45 open survivor questions) as the ongoing-elicitation design
intends. The README there tells the story with the real numbers.

## M0 worked example — templates vs the hand-written OMS invariants

Harvesting `examples/polyvers-oms/order-v1` (the test fixture) yields ~20
candidates. Against that machine's hand-written `invariants.mjs`:

| hand-written rule | template reach |
|---|---|
| `terminal-states-frozen` | **fully recovered** — `terminal-absorbing:*` (×5), pre-check HOLDS |
| `never-charged-twice` | **half recovered** — `set-once:txId` covers immutability; "only set by CHARGE_SUCCEEDED in 'charging'" is domain-prior/dialog territory |
| `cancel-rules` | **half recovered** — `reject-in-state:cancel-blocked-while-charging` + `:fulfillment-in-progress` (from the contract's own specialRules); the positive cancel path is not templated |
| `rollup-counters-bounded` | **partially** — `range:shipmentsDelivered/,shipmentsFailed` catch the 0..2 bounds; the `sum ≤ fulfillments` relation is not templated |
| `stale-completions-are-noops` | **flagged, not templated** — the rule's `whenState` is prose; harvest emits a NOTE telling the interviewer to ask it by hand |
| `fulfilling-implies-txid`, `terminal-rollup-consistency`, `submit-amend-resets-rollup`, `shipment-rollup-correct` | **not reached** — cross-field implications; domain priors and the dialog carry these |

And the templates surface questions the hand-written set never answered:
`monotone:totalCents` FAILS (AMEND lowers the total — intended? the
counterexample asks), and `emission-at-most-once:chargeCard` is put to the
designer explicitly instead of living as an unstated assumption. The honest
summary: M0 templates mechanically recover roughly a third of a mature
invariant set, flag another portion for the interview, and the remainder is
exactly what the domain-prior and dialog steps exist for.
