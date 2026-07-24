# polygen — the authoring engine

**Everything else here checks code that already exists. polygen writes code
that arrives already checked.**

Give it a sentence describing a feature. It drafts a contract, authors a
state machine against it, proposes the invariants, model-checks its own
output, repairs the violations it finds, and hands you a module with a
passing exhaustive check plus a synthesized regression trace corpus.

The second of five engines: Polygraph **audits**, polygen **authors**,
polyrun **executes**, polyvers **evolves**, polynv **elicits**.

## The problem: verification arrives too late

The normal way to get verified code is to write it, then verify it. That
ordering is why most code is never verified at all — by the time the
machine exists, the contract is implicit, the invariants were never written
down, and reconstructing both to check something already shipped is work
nobody scheduled.

It also produces the wrong argument. When you audit existing code, a clean
result means "the code matches an independent reading of itself." When the
code is *generated against a contract and checked before it ships*, the
result means something stronger: the state space was explored and the rules
held, before anyone integrated it.

polygen inverts the order. The verification is not a review step at the
end — it's part of the authoring loop, and code that can't pass it doesn't
get presented as finished.

## How it works

```bash
node scripts/polygen.mjs --intent "<feature description>" --model opus-5 --out out/
```

Six stages, each gated:

1. **Draft the contract** — the observable state fields, the action
   alphabet, the data each action carries, which states are terminal.
2. **Author the module** — a SAM v2 strict-profile machine against that
   contract. Every authored (and every repaired) module must pass the
   library's own strict `validate()` at the stage boundary; schema and
   shape errors block the stage rather than becoming report lines, and an
   unloadable or truncated rewrite gets exactly one retry with the load
   error appended.
3. **Propose invariants** — the rules the machine should never break,
   written as plain JS predicates.
4. **Model-check** — exhaustive exploration from `init()` over the declared
   domains, exactly the same checker the audit path uses.
5. **Self-repair** — every reachable violation goes back to the model with
   its counterexample path, capped at `--repair-max` rounds.
6. **Synthesize a corpus** — drive the *final* code to produce
   `traces/*.ndjson`, then replay them in a separate process as an
   independent check.

The output is the same artifact family every other engine consumes:
`contract.json`, `next.cjs`, `invariants.mjs`, `traces/*.ndjson`, and
`polygen-report.md`.

## Two things that keep it honest

**It reuses the audit core, not a friendlier copy of it.** The
model-checking (`check.mjs`), corpus hygiene (`validate_corpus.mjs`), and
independent replay (`replay.mjs`) are literally the same modules the audit
path runs. polygen cannot grade its own homework with a softer ruler, and a
fix to that core improves both directions at once.

**A non-converging run is reported as NOT converged.** If self-repair burns
its rounds and violations remain, the report says so. It is never
presented as clean — which matters, because the entire value of generated
code is the claim attached to it.

There's a subtler failure this engine had to learn about. The contract and
the code come from **independent model calls**, so they can disagree — most
insidiously on an enum's spelling. A machine whose contract says
`"cancelled"` while the code emits `"canceled"` still model-checks
"successfully": the checker explores the tiny reachable fragment that
spelling allows and reports no violations over almost nothing. polygen now
cross-checks that contract and code agree on their action/data vocabulary.
[`examples/case-study-polygen-domain-gap.md`](../examples/case-study-polygen-domain-gap.md)
narrates the real run where this collapsed the explorable state space —
including a false positive the fix itself introduced.

## The handoff is deliberately manual

polygen hands you artifacts, not a merge. Three steps stay with you, in
order:

1. **Review the contract and the invariants.** They are the model's reading
   of your intent, not ground truth. Everything the check proved is
   relative to them, so this is where your judgment actually lands. (If you
   want help making that set strong rather than merely present, that's
   [polynv](../polynv/README.md)'s job — it grades an invariant set by
   mutation testing.)
2. **Wire the module into your real handler — call it, don't reimplement
   it.** A verified module that gets paraphrased into your codebase is no
   longer the thing that was verified.
3. **Re-verify the integrated code** with `/polygraph:verify` against
   traces captured from the *integrated* system. That last step catches
   drift between the pure model and the glue around it — the seam polygen
   cannot see.

From there the artifact family flows onward: [polyrun](../polyrun/README.md)
can execute it durably, [polyvers](../polyvers/README.md) gates its next
version against the live fleet.

## Worked examples

- **OTP flow** ([`examples/polygen-otp/`](../examples/polygen-otp/)) —
  authored from one sentence: 8 states, 0 violations, a 134-window
  synthesized corpus, 0 independent-replay failures.
- **Cart checkout, and the bug polygen found in itself**
  ([`examples/polygen-cart-checkout/`](../examples/polygen-cart-checkout/),
  narrated in
  [`case-study-polygen-domain-gap.md`](../examples/case-study-polygen-domain-gap.md))
  — the contract/code vocabulary mismatch that motivated the domain
  cross-check.

## Honest scope

- **JS/TS only.** The generated module is directly usable in a JS/TS
  codebase. Porting a verified machine to another language is a separate
  problem — the port itself would need a differential check against the
  original — and is out of scope.
- **Needs `ANTHROPIC_API_KEY`.** Authoring is the LLM half; everything that
  checks, replays, and explores runs locally.
- "Exhaustive" means exhaustive **over the finite (action, data) domains
  the contract declares** — the same bound, and the same unmeasured
  domain-representativeness gap, as everywhere else in this toolset.
- A passing polygen run means *the generated machine satisfies the
  generated invariants over the declared domain*. Whether those invariants
  capture what you actually meant is the one judgment no engine here makes
  for you.

Entry points: `/polygraph:polygen` (skill and command) for a guided run,
the `polygen` subagent to hand off the whole loop. Where this sits among
the five engines: [`ARCHITECTURE.md`](ARCHITECTURE.md).
