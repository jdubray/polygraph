# polynv — the invariants engine

**Every other engine checks your code against `invariants.mjs`. This one
attacks where that file comes from.**

polynv turns invariant-writing from a blank-page exercise into a series of
concrete yes/no judgments about your own machine — then measures how strong
the resulting rule set actually is.

The fifth of five engines: Polygraph **audits**, polygen **authors**,
polyrun **executes**, polyvers **evolves**, polynv **elicits**.

## The problem: the rules are the one thing no tool can derive

Everything else in this toolset is mechanical. The model checker explores
every reachable state. The versioning gates replay real fleet snapshots.
The durable runtime journals every step. All of it produces the same
verdict: *your code does what your rules say*, or here's a counterexample.

Which means every one of those guarantees is only as good as the rules you
wrote. Code with a bug is a faithful description of the wrong behavior — no
amount of exploring it tells you the behavior is wrong. Someone has to say
what the system is *supposed* to do.

That's a hard thing to do from a blank page. Writing `(state) => …`
predicates that capture real intent is a rare skill, it's tedious, and the
rules you most need are exactly the ones nobody thinks to write down —
they're assumptions, not requirements. So `invariants.mjs` ends up thin,
and every gate downstream inherits that thinness while reporting green.

## How it works: judge stories, don't write predicates

polynv converts the scarce skill (authoring predicates) into a common one
(**judging concrete stories about your machine**).

It harvests candidate rules from the artifacts you already have — property
templates over the contract, plus mining over real traces and fleet
snapshots — and then **pre-checks every candidate against the machine's
reachable state graph** before showing it to you. That pre-check is what
makes the question answerable, because each candidate arrives in one of two
shapes:

- **"This holds everywhere I looked — is it a rule, or a coincidence?"**
  The property is true across the whole reachable graph. You decide whether
  it's load-bearing intent or an accident of the current implementation.
- **"The machine can do this today — is that acceptable?"** The property
  fails, and the question comes with the *shortest action path* that breaks
  it. Rejecting that story confirms an invariant **with its repro already
  attached**.

The design rule the whole engine is built on: **harvested candidates are
behavior, not intent.** Nothing reaches `invariants.mjs` without an
explicit, attributed human disposition. polynv proposes; you dispose.

## Then: how good is the rule set you ended up with?

An invariant file that passes every gate might still be nearly empty. So
polynv measures it, by mutation testing:

```bash
# grade the rules confirmed in the ledger
node polynv/bin/polynv.mjs grade --artifacts <dir>

# already have a hand-written invariants.mjs? grade THAT (the adoption path)
node polynv/bin/polynv.mjs grade --artifacts <dir> --include-invariants --max-mutants 500
```

Without `--include-invariants` the grade covers only ledger-confirmed rules,
so an existing hand-written file scores 0 — that flag is how you point it at
what you already have. `--max-mutants` defaults low for speed and the report
discloses when it graded a subset of the operator space.

`grade` mutates the machine in four operator families (guard-negation drop,
transition retarget, acceptor widening, field freeze), then asks how many
of those broken machines your invariants actually **kill**. Crucially, it
discards equivalent mutants by BFS graph comparison — finite declared
domains make mutation testing's classically undecidable subproblem
mechanical here — so the denominator is behaviorally distinct mutants only,
not an inflated score.

Calibrated on this repo's OMS order machine, the hand-written invariants
kill **101/113** distinct mutants. All 12 survivors are behavior-*removing*
mutants (dropped timers and completions) — the stated blind spot of any
safety-invariant set, since "nothing bad happens" is trivially satisfied by
a machine that does nothing. Surviving mutants become ranked questions:
candidates that would close a survivor rank first.

The grade also travels: polyvers' compat-report carries it as an
invariant-adequacy trust tier (measured / STALE / UNREADABLE / NOT
MEASURED), so a versioning verdict discloses how much intent it was
actually checked against.

## Usage

```bash
# harvest candidates and pre-check them → intent-ledger.json
node polynv/bin/polynv.mjs harvest --artifacts <dir> [--traces <path>] [--snapshots <path>]

# the highest-information open question
node polynv/bin/polynv.mjs questions --artifacts <dir> --next

# record the designer's call (this is the step that creates intent)
node polynv/bin/polynv.mjs record --artifacts <dir> --id <id> \
    --disposition confirm|reject|abandon|defer|modify --author <name>

# measure the rule set (add --include-invariants for a hand-written file);
# re-interview after a version bump
node polynv/bin/polynv.mjs grade  --artifacts <dir> [--include-invariants]
node polynv/bin/polynv.mjs drift  --artifacts <dir> [--reopen --author <name>]

# CONVERGED / PARTIAL (exit 1)
node polynv/bin/polynv.mjs report --artifacts <dir> --log
```

The CLI is the mechanical arm; **the interview itself lives in the polynv
skill** (`/polygraph:polynv`), which runs the dialog with you in session.
The agent handles only the autonomous half — harvest, pre-check, grade,
question prep. Dispositions are never delegated: they're the designer's
judgment, and the ledger records who made each one.

`intent-ledger.json` is the system of record — append-only at the event
level, committed to git, holding every candidate ever considered including
the rejected and abandoned ones, so a re-harvest never re-proposes them.
`INTENT-LOG.md` is a rendered view. The generated `invariants.mjs` carries
per-rule provenance and is guarded: a hand-written file is never
overwritten without `--force`.

Elicitation is **ongoing and multi-person**: `defer --assign <name>` parks
a question for whoever actually knows the answer, `questions --for <name>`
picks it up in a later session, and every record keeps its full
predicate-version history.

## Worked example — a real session

[`examples/polynv-oms/`](../examples/polynv-oms/) is a genuine, committed
elicitation session on the OMS order machine with its hand-written
invariants removed: harvest → domain priors → ten designer dispositions →
grade **68/113** → one survivor-closing rule → **88/113**. The ledger is
deliberately left mid-flight, with 45 open survivor questions, because
that's what ongoing elicitation actually looks like. The README there tells
the story with the real numbers.

## What the templates do and don't reach

Harvesting the OMS order machine yields ~20 candidates. Measured against
that machine's mature hand-written invariant set:

| hand-written rule | template reach |
|---|---|
| `terminal-states-frozen` | **fully recovered** — `terminal-absorbing:*` (×5), pre-check HOLDS |
| `never-charged-twice` | **half** — `set-once:txId` covers immutability; "only set by CHARGE_SUCCEEDED in 'charging'" is dialog territory |
| `cancel-rules` | **half** — the reject-in-state rules come from the contract's own specialRules; the positive cancel path is not templated |
| `rollup-counters-bounded` | **partial** — the 0..2 bounds yes, the `sum ≤ fulfillments` relation no |
| `stale-completions-are-noops` | **flagged, not templated** — harvest emits a NOTE telling the interviewer to ask it by hand |
| cross-field implications (`fulfilling-implies-txid`, …) | **not reached** — domain priors and the dialog carry these |

The honest summary: templates mechanically recover roughly a third of a
mature invariant set, flag another portion for the interview, and the
remainder is exactly what the domain-prior and dialog steps exist for.

They also surface questions the hand-written set never answered —
`monotone:totalCents` fails because AMEND lowers the total (intended? the
counterexample asks), and `emission-at-most-once:chargeCard` gets put to
the designer explicitly instead of living as an unstated assumption.

## Honest scope

- polynv **proposes; it never decides**. A converged ledger against wrong
  intent proves nothing — it just makes the judgment cheap to exercise and
  records who exercised it.
- Pre-checks and grading are exhaustive over the **declared finite domains**
  only, same bound as every other engine here.
- Mutation adequacy has a named blind spot: behavior-*removing* mutants
  largely evade safety invariants. The grade reports it rather than
  smoothing it over.
- Response/liveness properties are deliberately **not mined** — the safety
  checker cannot decide them.
- Deterministic and local with **no API key**, except the optional `--llm`
  harvest path (domain priors + code reading). `npm run test:polynv`.

Design decisions and implementation history:
[`docs/polynv-plan.md`](../docs/polynv-plan.md). Where this sits among the
five engines: [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) (Engine 5)
and [`docs/SDLC.md`](../docs/SDLC.md) (human gate #2).
