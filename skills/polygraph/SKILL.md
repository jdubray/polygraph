---
name: polygraph
description: A polygraph for your state machine. Audit a stateful piece of code end-to-end: YOU (the agent) instrument a copy, build any test doubles needed to run it, and capture real execution traces, then derive a transition-function spec from its source with an LLM (default artifact: a SAM v2 strict-profile module — named intents/schemas/domains, keyed acceptors, observable reject(reason), sealed model; --legacy-bare-next keeps the original bare next(state, action, data) contract), replay the traces against it, model-check it against invariants, and surface every disagreement as a spec-error, a code-finding, or a contract-error. Optional --tla tier escalates the winning spec to TLC. Use when the user wants to verify a state machine, workflow, reducer, or protocol implementation against its own behavior; check whether code does what it is believed to do; or reproduce/triage suspected state-handling defects. Trigger phrases: "polygraph", "verify this state machine", "check my reducer/workflow", "does this code do what I think", "audit the payment/order/session flow", "bare next / trace validation", "SAM spec verification".
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
> reading of its source, nothing more. "Exhaustive" means exhaustive over the
> finite (action, data) domains the contract/module declares — data-dependent
> behavior beyond those representative values is unchecked, and that
> abstraction gap is not measured by any gate. Every finding is a lead to investigate by
> hand, not an established result. Do not present it as a guarantee, and do not
> let it be the only safeguard for correctness- or safety-critical code.

All scripts live under `${CLAUDE_PLUGIN_ROOT}/scripts/`. Node ≥ 20 is required.
Generation needs `ANTHROPIC_API_KEY` and an explicit model (recommend
`opus-4.8` or `fable-5`; there is no default). Replay and controls need no key.

**The artifact (v0.6):** by default the derived spec is a **SAM v2
strict-profile module** (`@cognitive-fab/sam-pattern` 2.0.0-alpha, vendored at
`scripts/vendor/sam-pattern.cjs`): named intents with per-intent schemas and
finite payload **domains** declared in a manifest, acceptors keyed by intent
name, every ignored action an observable `reject(reason)`, and a sealed model
(no hidden state). This buys evidence bare-next could not produce: a failing
no-op window now says *why* the spec did nothing (`rejected(reason)` /
`identity-by-mutation` / `unhandled`), dead wiring is a load-time error
instead of a silent zero, the checker's exploration domains come from the
module's own manifest, every check runs a determinism double-pass, and the
spec is mechanically transpilable to TLA+ (`--tla`). The original bare
`next(state, action, data)` artifact remains available end-to-end behind
`--legacy-bare-next` for one release.

House rule (from sam-lib #29, fixed structurally in 2.0.0-alpha.2): never
rely on `instance({}).state()` — on machines whose primary control key is
`state` it returns data, not the method. The pipeline and the prompts use
`getState()`/`setState()` exclusively.

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
  models most often miss, so flag them for extra trace coverage). In the v2
  pipeline specialRules render as named rejection requirements, so the
  replayer's rejection-reason column has something contract-anchored to check.
- **dataDomain** — REQUIRED in the v2 default for every action with data
  fields: a finite list of representative payload values per field. It is the
  generation domain, the model-checking exploration domain, and the TLC
  transpilation domain; a gap blocks generation loudly (no silent exclusion).

State the **no-op rule** explicitly: an action arriving where the code ignores
it yields `post == pre`. This makes the replay total. In the v2 artifact the
spec makes that no-op *observable* — it must `reject(reason)`, never throw.
Every action that appears in the traces must be declared in the contract: the
strict module has no silent-unknown-action fallback (an undeclared action
classifies as a contract-error, which is what it is).

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
  --model opus-4.8 --n 5 --out out/
```

This builds a derivation-mode prompt (it never describes per-state semantics),
generates N independent specs, replays each, and writes `out/findings.md` and
`out/findings.json`. Use `--n 3` or more; a single generation may omit a rule.
Add `--legacy-bare-next` to run the whole loop on the legacy bare-next
artifact instead (prompt, replayer, and checker domains all follow the flag).

If every window comes back `unscoreable-all`, the generations were empty — with
a reasoning model (e.g. `claude-opus-4-8`) the thinking block spent the token
budget before any answer. Add `--max-tokens 32000` (the default is already 32000;
only lower it deliberately).

## Step 4b — Model-check the spec against invariants (THE BUG-FINDER)

Replay (Step 4) only catches a bug when the derived spec DISAGREES with the code.
A faithful spec — which capable models produce on legible code — does not
disagree, so replay alone misses real bugs (measured: `eval/FINDING-faithful-reproduction.md`).
The half that actually finds bugs is iterating the spec against invariants.

- Write `invariants.mjs` WITH the user — rules encoding what the code *should*
  do (intent), not what it does. Export
  `{ stateInvariants: [{name, pred:(state)=>bool}], transitionInvariants: [{name, pred:(pre,action,data,post)=>bool}] }`.
  A predicate returns true when the rule holds. Aim these at the special rules
  and at the safety properties the code exists to enforce ("never publish without
  approval", "never charge without confirmation", "lock by N attempts").
- Provide a finite `dataDomain` in the contract for actions with data (or rely on
  the values observed in the traces).
- Run it (verify.mjs runs it automatically when an `invariants.mjs` sits beside
  the contract, or pass `--invariants`):
  `node ${CLAUDE_PLUGIN_ROOT}/scripts/check.mjs --spec <mod.js> --contract contract.json --invariants invariants.mjs --traces traces/`
- A reachable violation is a **bug**, reported with the shortest counterexample
  path from init. A violation reached by ALL generated specs is a strong signal
  (every independent reading reaches the bad state). Walk the counterexample in
  the source.
- In the v2 default, exploration domains come from the module's own
  `manifest()` (no `buildDomain()` inference, so nothing is silently excluded)
  and every check runs a determinism double-pass — a `nondeterminism` finding
  means two identical explorations diverged (a clock/random read in the spec).
- Honest limits: exploration is bounded (report cap hits); and a hazard that
  depends on an EXTERNAL service (not in the observable state) is invisible to
  reachability — it needs a real sandbox probe, not a bigger search.

## Step 4c — TLC escalation (optional, `--tla`)

Add `--tla` to `verify.mjs` to escalate the winning live spec (most windows
passed; tie → first) from "bounded exploration says" to "TLC says": the spec
is mechanically transpiled to TLA+ (`out/tla/*.tla` + `.cfg`), state
invariants whose predicates stay inside the translatable subset are carried
along as TLA+ INVARIANTs, and TLC runs when a toolchain is available
(`POLYGRAPH_JAVA` or `java` on PATH, plus `POLYGRAPH_TLA_JAR` pointing at
`tla2tools.jar`). The findings report gains a "TLC escalation" subsection:
states generated/distinct, a per-invariant verdict table, counterexample
steps on violation, and every skipped invariant named with its reason
(transition invariants are skipped by kind; check.mjs still checks them in
JS). A missing toolchain is a note, not an error — the `.tla`/`.cfg` are
still written for running elsewhere. A transpiler refusal names the offending
construct: transpilability is a checkable property of the spec.

## Step 5 — Triage each disagreement (do this WITH the user)

`findings.md` classifies every non-consistent window:

- **code-finding / contract-error** (all specs disagree with the trace): either
  the code does something unexpected (a defect — open the source at that
  pre-state and action) or the observable-state contract omits a field that
  drives the transition (widen it and return to Step 2).
- **spec-error** (some specs pass, some fail): usually one generation missed a
  rule; check the majority. Note *which* rule — it is typically a special case
  outside the main state table, and worth a code comment for the next reader.
- **unscoreable in all specs**: the generated modules did not load or lack the
  expected surface. Fix generation, not the code.

In the v2 default each finding row also carries a **step classification** per
live spec. `rejected(reason)` and `identity-by-mutation` are the two GOOD
no-op classes (the spec explicitly declined, or explicitly re-committed the
same state); `unhandled` — the spec neither acted nor rejected — is itself a
finding (usually a missing acceptor case, or a rule the code has that the
contract does not). A *uniform* rejection-reason on a code-finding window
usually means the contract took a side (a specialRule rendered as a rejection
requirement) that the code did not — triage it as a contract question first.

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

## Provenance — why these two artifacts, and why v2 is the default

The design follows the SysMoBench paper's findings (and its v2 postscript).
The paper's data splits Polygraph's two roles: as a **replay oracle**, the
bare-next artifact plus one discipline sentence was the best performer for
pure trace conformance — and the control showed it was the sentence, not the
structure, that carried the robustness. That sentence is kept **verbatim** in
the v2 prompts: "Acceptors must guard against invalid proposals (an action
that the implementation does not act on in the current state must be a no-op
via `reject(reason)`, NOT a throw)". As a **checkable substrate**, the v2
strict module is strictly stronger: schema-enforced wiring (no silent dead
specs), sealed model (no hidden state), observable rejection, manifest-
declared domains (closing the silent-exclusion gap), determinism checking,
and a mechanical path to TLC. Polygraph ships one artifact for both roles —
v2 — because the N-spec voting layer absorbs exactly the failure mode v2
gives up (occasional individual conformance misses) while v2 eliminates the
failure modes voting cannot absorb (dead specs, hidden state, vacuous
exploration).

Reference implementation and origin: the SysMoBench "finixpos" study at
<https://github.com/jdubray/SysMoBench-1>. (Lineage note: this repo's disk
name, `bare-next-verify`, records the original bare-next artifact; the repo
is not being renamed.)
