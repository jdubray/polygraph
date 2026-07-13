---
description: Run polygen — draft a contract from a feature description, author a verifiable SAM v2 strict-profile module against it (--legacy-bare-next for a bare next(state, action, data) implementation), self-repair against reachable invariant violations, and synthesize a demo/regression trace corpus.
argument-hint: --intent "<feature description>" --model <id> [--contract <c.json>] [--lang javascript] [--out out/] [--repair-max 3] [--max-tokens 32000] [--legacy-bare-next]
allowed-tools: Bash, Read, Write
---

Run polygen over the arguments in `$ARGUMENTS`. This is the AUTHOR side of the
method (companion to `/polygraph:verify`, which AUDITS existing code): instead
of deriving a spec from code that already exists, it writes new code that is
verifiable from the moment it's written.

This drives `${CLAUDE_PLUGIN_ROOT}/scripts/polygen.mjs`:

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/polygen.mjs \
  --intent "<feature description>" --model <id> \
  [--contract <c.json>] [--lang javascript] [--out out/] \
  [--repair-max 3] [--max-tokens 32000] [--legacy-bare-next]
```

Always needs `ANTHROPIC_API_KEY` and an explicit `--model` (no default — pass
the exact Anthropic model id if not using a known alias; recommend `sonnet-5`
or `opus-4.8`). v1 is JS/TS only.

What it does, in order:
1. Drafts a `contract.json` from the feature description (or uses one you
   supply with `--contract`) — the observable state, action alphabet,
   `dataDomain` (concrete enumerable values — required for model checking to
   see parameterized actions at all), terminal states, and special rules.
2. Authors the module against that contract — by default a SAM v2
   strict-profile module (named intents/schemas/domains, keyed acceptors,
   `reject(reason)`, sealed model; must load strict-clean through the
   `validate()` gate), or `init()`/`next(state, action, data)` with
   `--legacy-bare-next`.
3. Proposes `invariants.mjs` — rules encoding intent, not just behavior.
4. Self-repairs: model-checks the code against its own invariants (exhaustive
   reachability, same engine as `check.mjs`), and on a reachable violation,
   patches the code and re-checks — capped at `--repair-max` (default 3).
   A run that does not converge within budget is reported as NOT converged,
   never silently presented as clean.
5. Synthesizes a demo/regression trace corpus by driving the final code
   through model-proposed scenarios, validates it, and independently replays
   it in a separate process as a sanity check.

Steps to perform:
1. Run the command above with the parsed arguments.
2. Read `<out>/polygen-report.md` and walk the user through it: the contract
   (flag if model-drafted — review before use), the code, the invariants
   (flag as proposed, not authoritative), the repair-loop outcome (converged
   or not), and the corpus/replay results.
3. Tell the user the next steps explicitly: review the contract and
   invariants by hand, wire the module into the real handler/reducer (v2:
   dispatch `actions[name](data)` and read `getState()`; legacy: call
   `next()` — either way call it, don't reimplement the logic inline), then run
   `/polygraph:verify` against REAL captured traces after integration to
   catch drift between this pure model and the glue code around it.

Always state that this is a consistency check, not a proof — the code has
been model-checked against its OWN stated invariants and independently
replayed, which is not the same as being correct. The contract and invariants
are the model's reading of intent; they need human review.
