# Turnstile example

A tiny worked example of the bare-next() method: a classic turnstile FSM
(`turnstile.js`) with states `LOCKED`/`UNLOCKED`, actions `COIN`/`PUSH`, and a
coin counter. It exercises the whole path — controls, replay, and finding
classification — **without needing an API key**.

## Files

- `turnstile.js` — the "production code" under audit.
- `contract.json` — observable state (`state`, `coins`), actions, and the one
  special rule (`PUSH` while `LOCKED` is a no-op).
- `traces/*.ndjson` — 12 windows across 3 scenarios (normal cycle, no-op pushes,
  extra coin while unlocked). Includes 3 `PUSH`-while-`LOCKED` no-op windows.
- `specs/reference.js` — hand-written reference (the positive control).
- `specs-mutant/mutant.js` — reference with the no-op rule broken (the negative
  control); it should fail exactly the 3 `PUSH`-while-`LOCKED` windows.

## Commands

From the plugin root:

```bash
# 1. Validate the corpus (chaining, terminals, coverage table).
node scripts/validate_corpus.mjs examples/turnstile/contract.json examples/turnstile/traces

# 2. Positive control — reference must be fully consistent (12/12).
node scripts/verify.mjs --contract examples/turnstile/contract.json \
  --traces examples/turnstile/traces --specs examples/turnstile/specs --out /tmp/ts-ref

# 3. Negative control — mutant produces 3 code-findings (the broken no-op).
node scripts/verify.mjs --contract examples/turnstile/contract.json \
  --traces examples/turnstile/traces --specs examples/turnstile/specs-mutant --out /tmp/ts-mut

# 4. (Optional) Real generation — needs ANTHROPIC_API_KEY.
node scripts/verify.mjs --contract examples/turnstile/contract.json \
  --source examples/turnstile/turnstile.js --traces examples/turnstile/traces \
  --model opus-5 --n 5 --out /tmp/ts-gen
```

The self-test (`npm test`) runs steps 1–3 and asserts the expected outcomes.

## Model checking (Half 2)

This turnstile is a *replay* example. For the bug-finding half — iterating a
spec against invariants — see `npm run eval:check`, which model-checks the eval
machines in `eval/machines/` and finds seeded bugs the replay misses, with
counterexamples. Note: model checking needs a bounded state space; a machine
with an unbounded counter (like this turnstile's coin count) is explored only up
to `--max-states`.
