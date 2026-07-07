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

## How it works (five steps)

1. **Define a contract** — the minimal observable state, the action alphabet,
   terminal states, and the special rules that live outside the main state table.
2. **Capture traces** — instrument a copy of the code to emit one NDJSON
   `{pre, action, data, post}` window per step, across scenarios (normal,
   failures, races, deliberate no-ops).
3. **Controls first** — a hand-written reference spec must score 100%; a mutated
   one must fail only its target windows. This proves the replay discriminates.
4. **Generate + replay** — build a *derivation-mode* prompt (it never describes
   per-state semantics), generate N independent specs, replay each.
5. **Triage** — classify every disagreement; code-findings and contract-errors
   point back at the source, spec-errors point at a generation that missed a
   rule.

The method and its failure modes are documented in the `polygraph` skill.

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

Then drive scenarios (normal path, each failure class, races, and deliberate
no-ops — an action sent into a terminal state), one `.ndjson` file per scenario,
and validate the corpus before generating.

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

Then in a session:

- run `/polygraph:verify` (the slash command), or
- ask Claude to "verify this state machine" (the skill triggers), or
- delegate to the `polygraph-verifier` subagent for an autonomous run.

Requirements: **Node ≥ 20**. Generation calls the Anthropic API and needs
`ANTHROPIC_API_KEY` plus a model; replay and the controls need neither.

## Use it as a plain CLI (no Claude Code)

The scripts are standalone:

```bash
# replay saved specs (no API key)
node scripts/verify.mjs --contract contract.json --traces traces/ --specs specs/ --out out/

# generate + replay (needs ANTHROPIC_API_KEY)
node scripts/verify.mjs --contract contract.json --source src/machine.ts \
  --traces traces/ --model sonnet-4.8 --n 5 --out out/

# validate a corpus
node scripts/validate_corpus.mjs contract.json traces/
```

## Models

There is **no default model** — pass `--model`. Recommended:

| alias | resolves to | notes |
|---|---|---|
| `sonnet-4.8` | *(verbatim — supply exact id)* | balanced choice |
| `fable-5` | `claude-fable-5` | strongest in the origin study |

Any value not in the alias table (`scripts/models.mjs`) is passed to the API
**verbatim**, so you can always give the exact Anthropic model id. Verify ids
against the current Anthropic model list before relying on an alias.

## Quickstart: the turnstile example

Runs the full controls path with **no API key**:

```bash
npm test   # validates the corpus + runs positive/negative controls
```

or step through it manually — see `examples/turnstile/README.md`.

## Layout

```
.claude-plugin/plugin.json   plugin manifest
skills/polygraph/            the method, as instructions Claude follows
commands/verify.md           the /polygraph:verify slash command
agents/verifier.md           the polygraph-verifier subagent
scripts/                     tv.mjs (replayer), generate, verify, build_prompt,
                             validate_corpus, models, instrument/*
templates/                   contract.schema.json + contract.example.json
examples/turnstile/          a tiny worked example + its controls
test/selftest.mjs            npm test — proves the pipeline without the API
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
