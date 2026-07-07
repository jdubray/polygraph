---
name: polygraph
description: A polygraph for your state machine. Audit a stateful piece of code end-to-end: YOU (the agent) instrument a copy, build any test doubles needed to run it, and capture real execution traces, then derive a bare next(state, action, data) transition function from its source with an LLM, replay the traces against it, and surface every disagreement as a spec-error, a code-finding, or a contract-error. Use when the user wants to verify a state machine, workflow, reducer, or protocol implementation against its own behavior; check whether code does what it is believed to do; or reproduce/triage suspected state-handling defects. Trigger phrases: "polygraph", "verify this state machine", "check my reducer/workflow", "does this code do what I think", "audit the payment/order/session flow", "bare next / trace validation".
---

# Polygraph — a polygraph for your state machine

Guide the user through a five-step, trace-driven consistency check. You (the
in-session assistant) do the intelligent parts — designing the contract,
instrumenting the code, capturing traces, and triaging findings. The bundled
scripts do the mechanical parts — building the prompt, generating specs,
replaying, and classifying.

> **Tell the user this up front, once.** Disclosure: Polygraph is experimental,
> not peer-reviewed, unproven technology — newly published and highly
> speculative. It is a *consistency check, not a proof*:
> a clean run means the code's observable behavior matches an independent
> reading of its source, nothing more. Every finding is a lead to investigate by
> hand, not an established result. Do not present it as a guarantee, and do not
> let it be the only safeguard for correctness- or safety-critical code.

All scripts live under `${CLAUDE_PLUGIN_ROOT}/scripts/`. Node ≥ 20 is required.
Generation needs `ANTHROPIC_API_KEY` and an explicit model (recommend
`sonnet-4.8` or `fable-5`; there is no default). Replay and controls need no key.

## Step 1 — Define the contract (do this WITH the user)

Produce a `contract.json` (schema and example under
`${CLAUDE_PLUGIN_ROOT}/templates/`). Decide, by reading the code:

- **stateKeys** — the minimal observable-state fields the behavior depends on.
  Exclude display strings, timestamps, and IDs that do not drive transitions.
  The FIRST key is the primary control state.
- **actions** — the discrete events that step the machine, each with its data
  shape. Use the step boundary the code already has (a dispatch, a reducer
  action, one handled message).
- **initState**, **terminalStates**, and **specialRules** (guards / rewrites /
  special cases that live outside the main state table — these are the rules
  models most often miss, so flag them for extra trace coverage).

State the **no-op rule** explicitly: an action arriving where the code ignores
it yields `post == pre`. This makes the replay total.

## Step 2 — Capture traces from the code (YOU run this, autonomously)

This is the heavy step, and it is yours to carry — not the user's. If the code
does not run in isolation, **build the test doubles or emulators needed to run
it** (the finixpos study's agent built a payment-terminal emulator and a
fault-injection proxy to do exactly this), instrument a copy, drive the
scenarios, and produce the corpus. Only escalate to the user for judgment calls:
whether the contract's observable state is right, and whether a double you built
faithfully matches the real dependency (the correlated-oracle risk — validate at
least one assumption against a real service/sandbox when one exists).

Instrument a **copy** of the code (keep the change as a diff/patch) to emit one
NDJSON record per step: `{"pre":{...},"action":"NAME","data":{...},"post":{...}}`.
Capture `pre` before any internal rewriting of the action, `post` after it
settles.

- For JS/TS, offer the helpers in `${CLAUDE_PLUGIN_ROOT}/scripts/instrument/`:
  `withTracing` (wrap a `dispatch(action, data)`), `tapReducer` (a Redux-style
  reducer), `traceStep` (you already have pre/post), and `withSamTracing`
  (`scripts/instrument/sam-emitter.mjs`) for code built on the SAM pattern
  (`@cognitive-fab/sam-pattern`, optionally with `sam-fsm`) — it wraps the
  `component` config so every dispatch emits a window, no-ops included. For other
  languages, write a small emitter by hand following the same shape.
- Drive scenarios, one trace file per scenario: the normal path, each failure
  class, races, and deliberate glitches (an action into a terminal state → a
  no-op window). Use existing test doubles or emulators.
- Then validate the corpus:
  `node ${CLAUDE_PLUGIN_ROOT}/scripts/validate_corpus.mjs contract.json traces/`
  Fix any chaining or terminal-state problem before continuing (traces are
  ground truth). Give any special rule ≥3 windows or the validator warns.

## Step 3 — Controls FIRST (never skip)

Before involving the model, establish that the replay discriminates:

- **Positive control**: write a reference `next()` yourself by reading the code;
  it must score 100%.
- **Negative control**: break one rule in the reference; confirm it fails
  exactly the expected windows.

Replay a spec directly with:
`node ${CLAUDE_PLUGIN_ROOT}/scripts/verify.mjs --contract contract.json --traces traces/ --specs <dir-of-your-reference-specs>`

## Step 4 — Generate and replay

Run the full loop:

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/verify.mjs \
  --contract contract.json --source path/to/source --traces traces/ \
  --model sonnet-4.8 --n 5 --out out/
```

This builds a derivation-mode prompt (it never describes per-state semantics),
generates N independent specs, replays each, and writes `out/findings.md` and
`out/findings.json`. Use `--n 3` or more; a single generation may omit a rule.

## Step 5 — Triage each disagreement (do this WITH the user)

`findings.md` classifies every non-consistent window:

- **code-finding / contract-error** (all specs disagree with the trace): either
  the code does something unexpected (a defect — open the source at that
  pre-state and action) or the observable-state contract omits a field that
  drives the transition (widen it and return to Step 2).
- **spec-error** (some specs pass, some fail): usually one generation missed a
  rule; check the majority. Note *which* rule — it is typically a special case
  outside the main state table, and worth a code comment for the next reader.
- **unscoreable in all specs**: the generated modules did not load or export
  `next()`. Fix generation, not the code.

When every window is consistent across all specs, report it as exactly what it
is: the code's observable behavior matches an independent reading of its source.
To go further, propose invariants over the traces, or a hand-written model
checked against an explicit environment.

## Notes to carry into the work

- Traces are ground truth. Spec-vs-trace disagreement with a correct-looking
  spec is a code finding, not a bad window.
- If the source uses a framework, a generated spec may copy the framework's
  wiring instead of the module contract — the bare `next()` contract minimizes
  this; watch for `unscoreable-all`.
- If traces come from a mock/emulator written alongside the code, both may share
  a misunderstanding of a real dependency. Validate at least one assumption
  against the real service (e.g. a sandbox).
- The spec must be deterministic. Model timeouts and other time-driven behavior
  as explicit actions issued by the environment, never as a clock read.

Reference implementation and origin: the SysMoBench "finixpos" study at
<https://github.com/jdubray/SysMoBench-1>.
