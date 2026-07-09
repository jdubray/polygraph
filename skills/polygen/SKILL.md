---
name: polygen
description: Write NEW stateful code that is verifiable from the moment it's written, instead of auditing code that already exists (that's the "polygraph" skill). Draft a contract from a feature description, author init()/next(state, action, data) against it, self-repair against reachable invariant violations before anything ships, and synthesize a demo/regression trace corpus. Use when the user wants to write a new state machine, workflow, or reducer and have it come out pre-verified; when they say "build a verifiable X"; or as the first half of a lifecycle that ends with wiring the result into a real app and auditing the integration with polygraph. Trigger phrases: "polygen", "write a verifiable state machine", "author verifiable code", "build me a X flow that's already checked", "generate a reducer/workflow and verify it".
---

# polygen — author verifiable code, out of the box

Companion to the `polygraph` skill. That one AUDITS code that already exists.
This one AUTHORS new code so it's verifiable from the start — closing the loop
at creation time instead of retrofitting it later. v1 is **JS/TS only**: the
generated `next()` is directly usable only in a JS/TS codebase (porting a
verified model to another language is a real, separate problem — the port
itself would need its own differential check against the JS original — and is
out of scope here).

> **Same disclosure as `polygraph`.** This is experimental, unproven
> technology and a *consistency check, not a proof*. A converged run means the
> authored code satisfies its OWN stated invariants over a bounded, explored
> state space — nothing more. The contract and the invariants are the model's
> reading of your intent; they need your review before either is trusted.

All scripts live under `${CLAUDE_PLUGIN_ROOT}/scripts/`. `polygen.mjs` needs
`ANTHROPIC_API_KEY` and an explicit `--model` (no default; recommend
`sonnet-5` or `opus-4.8`).

## Step 1 — Get the feature intent and the contract (do this WITH the user)

Ask for (or draft from) a plain-language description of the feature: the
states it moves through, the events that step it, and anything the user
already knows should never happen (a payment recorded twice, a lock releasing
without an explicit unlock).

You have two paths:
- **Model drafts the contract** (the default): pass `--intent "<description>"`
  with no `--contract`. `polygen.mjs` drafts `contract.json` from the intent —
  observable state, action alphabet, `dataDomain` (concrete values for every
  parameterized action field — **this is not optional**: an action field
  missing from `dataDomain` is silently excluded from model-checking below),
  terminal states, and special rules. **Review this before continuing** — it
  is now the design spec everything else is built against; a wrong contract
  produces correctly-verified code against the wrong intent.
- **You supply the contract** (`--contract <c.json>`): use when the user
  already knows the exact shape (e.g. this is one leg of a larger system with
  an established observable-state convention).

## Step 2 — Run polygen

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/polygen.mjs \
  --intent "<feature description>" --model sonnet-5 --out out/
```

This authors `init()`/`next()`, proposes `invariants.mjs`, then self-repairs:
model-checks the code against its own invariants and, on a reachable
violation, patches the code and re-checks — up to `--repair-max` (default 3)
rounds. It then synthesizes a demo/regression trace corpus by driving the
final code through model-proposed scenarios, validates it
(`validate_corpus.mjs`), and independently replays it in a **separate
process** as a sanity check (catches nondeterminism the in-process generation
wouldn't expose).

Everything lands in `<out>/`: `contract.json`, `next.cjs`, `invariants.mjs`,
`traces/*.ndjson`, and `polygen-report.md`.

## Step 3 — Read the report and triage (do this WITH the user)

- **Converged, no domain-coverage gaps**: the code satisfies its own
  invariants over the explored space. Still review the contract and
  invariants by hand — a converged run against a wrong or incomplete contract
  proves nothing about the actual feature.
- **Did not converge within the repair budget**: the report says so plainly
  and lists the residual violation(s) with a counterexample. Do not treat this
  as shippable — either fix the code by hand at the counterexample, or re-run
  with a higher `--repair-max`.
- **Domain coverage gaps** (flagged at the top of the report): an action field
  had no `dataDomain` entry, so that action was invisible to the checker. Add
  the missing domain to `contract.json` and re-run — the "converged" verdict
  above did not actually examine that action.
- **Corpus problems that survived the one feedback retry**: read them; usually
  a scenario that doesn't drive to a declared terminal state.

## Step 4 — Hand off to integration + audit

Wiring the generated `next()` into the real app is deliberately NOT scripted —
it needs a human or an integrating agent making real judgment calls about the
handler/route/reducer it plugs into. Instruct whoever does this:

- **Call `next()`; do not reimplement the transition logic inline.** The whole
  point of authoring it this way is that the transition logic lives in exactly
  one place.
- Once wired up, **capture REAL traces from the running integration** and run
  `/polygraph:verify` (the `polygraph` skill) against them. This is the step
  that catches drift — e.g. someone "helpfully" tweaking the wiring later and
  reintroducing logic outside `next()`, or the pure model disagreeing with how
  the real handler actually calls it.

## Notes to carry into the work

- The repair loop fixes CODE, never invariants — an invariant encodes intent
  by definition; if a "violation" is actually a misunderstanding of intent,
  that's a signal to fix the contract/invariants and re-run, not to weaken the
  rule until it stops firing.
- A reachable violation on iteration 0 (before any repair) usually means the
  model's first draft missed a special rule named in the contract — worth
  noting which one, the same way `polygraph`'s Step 5 does for spec-errors.
- LLM output can have a genuine syntax slip (a stray `;` where a `,` belongs).
  `polygen.mjs` retries once with the load error fed back before giving up —
  if you see a hard failure citing "still fails to load," that's a real defect
  worth a closer look, not a transient issue.

Reference implementation and origin: the SysMoBench "finixpos" study at
<https://github.com/jdubray/SysMoBench-1>, and the `polygraph` skill this one
complements.
