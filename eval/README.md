# Polygraph eval — does the tool actually help?

The skill-eval literature (SkillsBench and the two SkillComposer papers, 2026)
is blunt: a skill can *hurt*, and you cannot know whether yours helps without a
with/without comparison, auto-scored, holding everything else constant. This
directory does that for Polygraph.

## What is measured (and what is not)

There are two layers, deliberately separated.

### 1. `npm run eval:mechanism` — is the eval itself valid? (deterministic, no API)

Bare-`next()` only detects a bug that is a **source-vs-behavior divergence**:
the code does something a *faithful reading of its own source* would not predict.
A bug that is "consistently wrong" (buggy code + traces from that same buggy
code) is invisible — a spec derived from the same source agrees with the traces.

So the seeded machines are constructed as class-1 divergences: a faithful reader
predicts transition T for some `(state, action, data)`, but the code does T′ ≠ T.
`mechanism-eval` regenerates each machine's trace corpus from `source.cjs`, then
replays the **apparent-intent** `reference.cjs` against it and asserts:

- **seeded** → the seeded window(s) FAIL, everything else passes (the divergence
  is detectable in principle);
- **clean** → all windows pass (no false alarm);
- **out-of-scope** → all windows pass (a self-consistent invariant violation is
  correctly invisible).

If any machine fails this, it is mis-constructed and the A/B built on it would be
meaningless. This is the free regression that keeps the suite honest.

### 2. `npm run eval:ab` — does the tool beat the model alone? (needs API)

Two arms per machine, N runs each, auto-scored against `ground-truth.json`:

- **baseline** ("without"): one model call on `source.cjs` alone, asked to locate
  any divergence and emit a flat JSON verdict `{buggy, action, state}`.
- **polygraph** ("with"): the real loop — derive N specs from the source, replay
  each against the machine's traces, classify per window, and derive the verdict
  mechanically (a **code-finding** window ⇒ buggy at that `action`/pre-state). No
  second judgment call; the tool's output *is* the verdict.

Scoring: a seeded machine is detected only if the arm flags it **at the right
action**; a clean/out-of-scope machine must **not** be flagged (false alarm).
The scorecard reports per-machine and aggregate detection rate, false-alarm rate,
the **with-minus-without delta**, and explicitly flags any machine where
Polygraph does *worse* than baseline.

**Interpretation rule:** accept the skill only if the delta is positive AND no
task regresses.

## The 8 machines

| id | domain | class | seeded technique |
|---|---|---|---|
| m01 | subscription billing | seeded | sibling-path asymmetry (5xx handled in dunning, missing in renewal) |
| m02 | session / auth | seeded | off-by-one lockout guard (`> 3` vs `>= 3`) |
| m03 | queue / worker | seeded | fall-through mutation under a no-op-looking action (HEARTBEAT requeues a failed job) |
| m04 | document workflow | seeded | action does more than its position implies (PUBLISH bypasses review from draft) |
| m05 | payments | seeded | wrong-comparison partial guard (`<= 0` vs `< amount`) |
| m06 | control | clean | — |
| m07 | e-commerce | clean | — |
| m08 | subscription billing | out-of-scope | self-consistent invariant violation (conflict→active; the real risk is at the service boundary) |

## Running

```bash
npm run eval:mechanism            # free, deterministic — validates the suite
node eval/skill-ab.mjs --dry-run  # free — validates the A/B scoring with mocked fetch
ANTHROPIC_API_KEY=... node eval/skill-ab.mjs --model <id> --n 3   # the real A/B
# artifact A/B (P8 ship gate): legacy bare-next vs v2 SAM strict, both arms:
ANTHROPIC_API_KEY=... node eval/ab-v2.mjs --model haiku-4.5 [--machines m01-m04]
node eval/ab-v2.mjs --reference   # degraded replay-only mode (no key)
```

The artifact A/B (`ab-v2.mjs`) records, per machine per arm: seeded-bug
detection split by mechanism (replay vs model-check), dead-spec count, and the
two v2-only assertions (a rejection-reason classification appears; the
determinism double-pass ran). Results merge into
`results/ab-v2-scorecard.json`; the analyzed run lives in
[`AB-V2-RESULTS.md`](AB-V2-RESULTS.md).

Cost note: the real A/B is `machines × N × (1 baseline call + N generation
calls)` — with 8 machines, N=3, that is 8×3 baseline + 8×3×3 generation ≈ 96
calls. Use `--max-tokens 32000` (the default here) so reasoning models don't
truncate. Traces and generated specs are regenerated on demand and gitignored.

## What this does NOT measure (honest limits)

- The A/B measures **the method/tool** (model + Polygraph's derive-replay loop)
  vs the model alone. The polygraph arm is deterministic given its specs; the
  baseline arm is a single free-form call. Both are auto-scored against a fixed
  ground truth.
- It does **not** measure the *skill in a live Claude Code session* — i.e. the
  agent reading `SKILL.md`, choosing to instrument, capturing traces itself, and
  triaging. That is the fully harness-faithful test; it is heavier and
  non-deterministic, and is left as future work. The suite here isolates the
  question the tool can answer cleanly: given the loop is run, does its output
  locate real divergences without crying wolf on clean code?
- The seeded suite is small (8 machines) and the divergences are hand-built to
  be the class the method targets. It shows the method *can* discriminate; it is
  not a claim about hit-rate on arbitrary real-world bugs.
