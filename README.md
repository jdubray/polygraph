<p align="center">
  <img src="assets/polygraph-verify.jpg" alt="Polygraph — /verify" width="640">
</p>

# Polygraph

**A polygraph for your state machine.**

A Claude Code plugin for **trace-driven consistency checking of stateful code**.
You point it at a state machine (a workflow, reducer, protocol, or session
handler); it has an LLM derive a bare `next(state, action, data)` transition
function from the source, replays real execution traces against it, and reports
every place the code's observed behavior disagrees with an independent reading
of its own source — as a **spec-error**, a **code-finding**, or a
**contract-error**.

> **Disclosure — read this first.** Polygraph is **experimental, not
> peer-reviewed, unproven technology.** The method is newly published and highly
> speculative. It is a **consistency check, not a proof**: a clean run means the
> code's observable behavior matches an independent transition function derived
> from its source, and nothing more. Every finding is a *lead to investigate by
> hand*, not an established result. Do not rely on it as your only safeguard for
> correctness- or safety-critical code. Approach the output with skepticism.

## How it works (two halves)

An LLM derives a bare `next(state, action, data)` function from your code. Then
Polygraph does **two** things with it — and the second is where bugs are found.

**Half 1 — conformance (replay).** Check that the derived spec reproduces real
execution traces.

1. **Define a contract** — the minimal observable state, the action alphabet,
   terminal states, and the special rules that live outside the main state table.
2. **Capture traces** — instrument a copy of the code to emit one NDJSON
   `{pre, action, data, post}` window per step, across scenarios.
3. **Controls first** — a hand-written reference spec must score 100%; a mutated
   one must fail only its target windows. This proves the replay discriminates.
4. **Generate + replay** — generate N independent specs, replay each, triage the
   disagreements.

**Half 2 — model checking (the bug-finder).** Iterate the spec against
invariants.

5. **Write invariants** — rules encoding what the code *should* do ("a customer
   is never charged without a confirmed transaction"), as `invariants.mjs`.
6. **Check** — `scripts/check.mjs` explores every reachable state of `next()`
   from `init()` over a finite action/data domain and reports any state that
   breaks a rule, with a shortest **counterexample path**.

Why both halves are needed: **replay only catches a bug when the spec
*disagrees* with the code — and a faithful spec doesn't.** On small, legible
code a capable model reproduces the code exactly, bug included, so replay goes
silent. Model checking iterates that *same faithful spec* against your intent and
**reaches** the bad state anyway. This is measured, not asserted — see
[`eval/FINDING-faithful-reproduction.md`](eval/FINDING-faithful-reproduction.md)
(replay found 0/5 seeded bugs; model checking found 5/5, with counterexamples:
`npm run eval:check`).

Versions before 0.2.0 shipped only Half 1. The method and its failure modes are
documented in the `polygraph` skill.

## polygen — the other direction: author NEW verifiable code

`/polygraph:verify` **audits** code that already exists. `polygen` **authors**
new code so it's verifiable from the moment it's written — closing the loop at
creation time instead of retrofitting it later. Given a one-sentence feature
description, it:

1. **Drafts a contract** — observable state, action alphabet, `dataDomain`
   (concrete enumerable values for every parameterized action field — this is
   how the model checker knows what to explore), terminal states, special
   rules.
2. **Authors `init()`/`next(state, action, data)`** against that contract.
3. **Proposes `invariants.mjs`** — rules encoding intent, not just behavior.
4. **Self-repairs** — model-checks the code against its own invariants
   (exhaustive reachability, the same `check.mjs` engine `verify.mjs` uses)
   and, on a reachable violation, patches the code and re-checks. Capped
   (`--repair-max`, default 3); a run that doesn't converge is reported as NOT
   converged, never silently presented as clean. It also cross-checks that
   every `dataDomain` value the contract declares is actually referenced in
   the code — the contract and the code come from **two independent model
   calls**, so nothing else guarantees they agree on vocabulary, and a
   mismatch there silently collapses how much of the state space the checker
   can even reach. See
   [`examples/case-study-polygen-domain-gap.md`](examples/case-study-polygen-domain-gap.md)
   for a real run where this happened and how it was fixed — including an
   honest look at a false positive the fix introduces.
5. **Synthesizes a demo/regression trace corpus** by driving the final code
   through model-proposed scenarios, validates it, and independently replays
   it in a **separate process** as a sanity check (catches nondeterminism the
   in-process generation wouldn't expose).

Everything lands in `<out>/`: `contract.json`, `next.cjs`, `invariants.mjs`,
`traces/*.ndjson`, `polygen-report.md`.

```bash
node scripts/polygen.mjs --intent "<feature description>" --model sonnet-5 --out out/
```

**Then the handoff, deliberately not scripted**: review the contract and
invariants (both are the model's reading of your intent, not ground truth),
wire `next()` into the real handler/reducer (call it — don't reimplement the
transition logic inline), then run `/polygraph:verify` against REAL captured
traces from the integrated code. That last step is what catches drift between
the pure model and the glue code around it.

**v1 is JS/TS only.** The generated `next()` is directly usable only in a
JS/TS codebase; porting a verified model to another language is a real,
separate problem (the port itself would need its own differential check
against the JS original) and is out of scope here.

## What it needs from you (read before you start)

Polygraph replays **real execution traces** — it cannot verify code from source
alone. Its power comes from the traces being ground truth captured from the code
actually running. So the first question is: **can you run the isolated code?**

| your situation | what to do | can it find code bugs? |
|---|---|---|
| the module has a clean step boundary you can call (a dispatch, reducer, or handler) | instrument it and drive it (below) | yes |
| it only runs with its environment (DB, network, a device) | stand up test doubles / an emulator so it runs in isolation first | yes — once it runs |
| it can't be run at all (a fragment) | you can hand-write windows, but then you're testing against your *expectations*, not the code's behavior | no — only spec-errors vs your hand-written traces |

**Where the effort goes.** Building the contract and running generate/replay are
cheap (minutes). **Capturing traces is the bulk of the work** — it means
instrumenting a copy of the code and driving it through scenarios. If you
already have tests, wrap the step boundary once and every test emits windows for
free:

```js
import { withTracing } from '<plugin>/scripts/instrument/trace-emitter.mjs';

// project ONLY your contract's observable keys — exclude everything else:
const project = () => ({ txState: m.txState, orderId: m.orderId /* ...your keys */ });

// wrap a dispatch(action, data) so every call appends a {pre,action,data,post} window:
const dispatch = withTracing(rawDispatch, project, 'traces/s1_normal.ndjson');

// Redux-style reducer? use tapReducer(rawReducer, project, file,
//   { actionName: a => a.type, actionData: a => a.payload })
```

Code built on the **SAM pattern** (`@cognitive-fab/sam-pattern`, optionally with
`sam-fsm`)? Wrap the `component` config — every dispatch emits a window,
no-ops included:

```js
import { withSamTracing } from '<plugin>/scripts/instrument/sam-emitter.mjs';

const project = (m) => ({ txState: m.txState /* ...your observable keys */ });
const traced  = withSamTracing(component, project, 'traces/s1_normal.ndjson');
const { intents } = instance({ initialState, component: traced, render });
// then drive `intents` through your scenarios (sam-pattern intents are async — await them)
```

See `examples/turnstile-sam/` for a runnable SAM instance.

Then drive scenarios (normal path, each failure class, races, and deliberate
no-ops — an action sent into a terminal state), one `.ndjson` file per scenario,
and validate the corpus before generating.

### The point: in Claude Code, the agent does Step 2 for you

Trace capture is the heavy step — and inside Claude Code, the agent does it, not
you. Point it at the isolated code and it will instrument a copy, **build
whatever test doubles or emulators are needed to run it in isolation**, drive the
scenarios, and produce (and validate) the corpus.

Existence proof: in the study that introduced the method, a Claude agent built a
payment-terminal emulator and a fault-injection proxy, instrumented a production
SAM payment workflow, drove 17 scenarios, and produced a 75-window corpus — all
of Step 2 — autonomously. That is the differentiator: the step that historically
made this kind of verification expensive is the step the agent now carries.

What stays with you is judgment, not labor: confirming the contract captures the
right observable state, and validating that any doubles the agent built match
reality (the correlated-oracle check — e.g. probe one assumption against a real
sandbox). The manual snippets above are for using the scripts standalone; in a
Claude Code session you can just say *"verify this state machine"* and let the
agent run Step 2.

## Install (Claude Code plugin)

Install from the marketplace (this repo is its own marketplace):

```
/plugin marketplace add jdubray/polygraph
/plugin install polygraph@polygraph
```

Or clone directly into your Claude Code plugins directory:

```bash
git clone https://github.com/jdubray/polygraph \
  ~/.claude/plugins/polygraph
```

Update later with `/plugin marketplace update polygraph`.

Then in a session, six entry points — three for auditing existing code, three
for authoring new code:

| you type | what it is | when to use it |
|---|---|---|
| `/polygraph:polygraph` | audit **skill** (guided method) | full end-to-end audit walk-through — Claude designs the contract, captures traces, runs controls, generates, and triages with you |
| `/polygraph:verify` | audit **command** (script runner) | you already have a contract + traces and just want to run generate + replay (`--contract … --traces … --model …`) |
| `polygraph-verifier` | audit **subagent** | hand off the whole audit loop for an autonomous, unsupervised run |
| `/polygraph:polygen` | author **skill** (guided method) | write a NEW state machine from a feature description, self-repaired before it ships |
| `/polygraph:polygen` | author **command** (script runner) | you know exactly what you want and just want to run it (`--intent "…" --model …`) |
| `polygen` | author **subagent** | hand off the whole author loop for an autonomous, unsupervised run |

(The `verify` command's fully-qualified form is `/polygraph:verify`; the
`polygraph` skill's is `/polygraph:polygraph` — the plugin and the skill share
the name, hence the doubled form. `polygen`'s skill and command share the
`polygen` name directly.)

**Or just ask in plain language** — each skill triggers on phrases like:

- Audit: *"verify this state machine"* / *"polygraph this workflow"* /
  *"check my reducer / workflow"* / *"does this code do what I think it
  does?"* / *"audit the payment / order / session flow"* / *"bare next /
  trace validation"*
- Author: *"polygen"* / *"write a verifiable state machine"* / *"author
  verifiable code"* / *"build me a X flow that's already checked"* /
  *"generate a reducer/workflow and verify it"*

Requirements: **Node ≥ 20**. Generation calls the Anthropic API and needs
`ANTHROPIC_API_KEY` plus a model; replay and the controls need neither.

## Use it as a plain CLI (no Claude Code)

The scripts are standalone:

```bash
# replay saved specs (no API key)
node scripts/verify.mjs --contract contract.json --traces traces/ --specs specs/ --out out/

# generate + replay (needs ANTHROPIC_API_KEY)
node scripts/verify.mjs --contract contract.json --source src/machine.ts \
  --traces traces/ --model sonnet-5 --n 5 --out out/

# validate a corpus
node scripts/validate_corpus.mjs contract.json traces/

# author NEW verifiable code from a feature description (needs ANTHROPIC_API_KEY)
node scripts/polygen.mjs --intent "<feature description>" --model sonnet-5 --out out/
```

## Models

There is **no default model** — pass `--model`. Recommended:

| alias | resolves to | notes |
|---|---|---|
| `sonnet-5` | `claude-sonnet-5` | balanced choice (speed / intelligence) |
| `fable-5` | `claude-fable-5` | strongest in the origin study |

Any value not in the alias table (`scripts/models.mjs`) is passed to the API
**verbatim**, so you can always give the exact Anthropic model id. Verify ids
against the current Anthropic model list before relying on an alias.

**Reasoning models** (e.g. `claude-sonnet-5`) emit a thinking block that draws
from the same token budget *before* the answer. The default output ceiling
(32000) leaves room for both; if you lower it and see empty specs
(`stop_reason: max_tokens`, everything `unscoreable-all`), the budget was spent
on thinking — raise it with `--max-tokens`:

```bash
node scripts/verify.mjs --contract c.json --source src.ts --traces traces/ \
  --model claude-sonnet-5 --n 5 --max-tokens 32000 --out out/
```

## Examples

- **Quickstart — the turnstile.** Runs the full controls path with **no API
  key**: `npm test` validates the corpus and runs the positive/negative
  controls. Step through it manually via `examples/turnstile/README.md`, and see
  `examples/turnstile-sam/` for the same machine as a real SAM instance.
- **A full-loop run on a production system** — `examples/case-study-subscription.md`
  walks a real end-to-end run on a closed-source SaaS subscription-billing state
  machine: five independent LLM-derived specs, replayed against a real trace
  corpus, that independently corroborated a genuine double-charge bug — plus an
  honest look at the risks the method *can't* see (the ones at the external-
  service boundary).
- **polygen — OTP verification flow** (`examples/polygen-otp/`) — a state
  machine authored from a one-sentence description, self-repaired against a
  domain-ref gap in one round, converged clean: 8 states, 0 violations, a
  134-window synthesized corpus, 0 independent-replay failures.
- **polygen — cart checkout, and a bug polygen found in itself**
  (`examples/polygen-cart-checkout/`, narrated in
  `examples/case-study-polygen-domain-gap.md`) — the run that motivated the
  domain-ref cross-check: the drafted contract and the authored code
  disagreed on enum spelling, silently collapsing the reachable state space
  to 2 states behind a "converged: true." Includes an honest look at a false
  positive the fix itself introduces.

## Layout

```
.claude-plugin/plugin.json   plugin manifest
skills/polygraph/            the audit method, as instructions Claude follows
skills/polygen/              the author method, as instructions Claude follows
commands/verify.md           the /polygraph:verify slash command (audit)
commands/polygen.md          the /polygraph:polygen slash command (author)
agents/verifier.md           the polygraph-verifier subagent (audit)
agents/polygen.md            the polygen subagent (author)
scripts/                     tv.mjs (replayer), generate, verify, build_prompt,
                             polygen, polygen_prompts, contract_render,
                             validate_corpus, models, instrument/*
templates/                   contract.schema.json + contract.example.json
examples/turnstile/          a tiny worked example + its controls (audit)
examples/polygen-otp/        a from-scratch worked example (author)
examples/polygen-cart-checkout/  a from-scratch worked example with a real
                             self-repair round (author)
test/selftest.mjs            npm test — proves the audit pipeline without the API
assets/                      brand art
```

## Origin

The method is introduced in:

> Jean-Jacques Dubray. **Can Code Specify a System Precisely Enough to Formally
> Verify It?** arXiv:2607.05076, July 2026. <https://arxiv.org/abs/2607.05076>

Across seven models from two vendors, a bare `next()` contract was the most
reliable spec target, and the approach found real defects in a production
payment workflow. The `scripts/tv.mjs` replayer is that study's task-agnostic
transition-validation runner, bundled here. Reference implementation and the
full case study: <https://github.com/jdubray/SysMoBench-1>.

If you use Polygraph in your work, please cite the paper (see `CITATION.cff`).

## License

Apache-2.0 — see `LICENSE`.
