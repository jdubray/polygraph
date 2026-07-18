<p align="center">
  <img src="assets/polygraph-verify.jpg" alt="Polygraph — /verify" width="640">
</p>

# Polygraph

**Your tests check the paths you thought of. Polygraph checks the ones you didn't.**

Polygraph is a Claude Code plugin (and standalone CLI) that finds bugs in
**stateful code** — workflows, reducers, protocol handlers, checkout flows,
session managers — by exhaustively exploring every state the code can reach
and flagging the ones that break rules you care about, like *"a customer is
never charged twice."*

You don't need to know anything about formal verification to use it. You
write the rules as plain JavaScript predicates. The heavy lifting — deriving a
formal model of your code, exploring the state space, producing a shortest
path to each violation — is done for you.

> **Disclosure — read this first.** Polygraph is **experimental, not
> peer-reviewed, unproven technology.** It is a **consistency check, not a
> proof**: a clean run means the code's observable behavior matches an
> independent reading of its own source, and nothing more. Every finding is a
> *lead to investigate by hand*, not an established result. Do not rely on it
> as your only safeguard for correctness- or safety-critical code.

## Why Polygraph

Unit tests execute the scenarios you wrote. A state machine of even modest
size has orders of magnitude more reachable states than any test suite
visits — and the bugs that hurt in production live in the combinations nobody
wrote a test for: a retry landing after a cancel, a timeout racing a
confirmation, an event arriving in a state where nobody expected it.

Polygraph attacks that gap in two ways:

- **Audit existing code** (`/polygraph:verify`). An LLM reads your source and
  writes an independent, executable specification of it — a second opinion on
  what the code does. Polygraph then (1) replays real execution traces
  against that spec to confirm it's faithful, and (2) **model-checks** it:
  starting from the initial state, it tries every action with every relevant
  payload, visits every reachable state, and reports any state that violates
  one of your rules — with the shortest sequence of actions that gets there.
  That counterexample path is a ready-made repro for the bug.

- **Author new code** (`polygen`). Give it a one-sentence feature description
  and it writes the state machine *and* its rules, model-checks its own
  output, repairs violations, and hands you code with a passing exhaustive
  check plus a generated regression trace corpus — verified from the moment
  it's written.

Real result: on a production SaaS subscription-billing machine, this method
independently corroborated a genuine double-charge bug
([`examples/case-study-subscription.md`](examples/case-study-subscription.md)).
In the controlled eval, replay alone found 0/5 seeded bugs — model checking
found 5/5, with counterexamples
([`eval/FINDING-faithful-reproduction.md`](eval/FINDING-faithful-reproduction.md)).

### Why not use TLA+ / Alloy / a model checker directly?

Those tools work — but you have to hand-translate your code into their
language and keep the translation current, which is why almost nobody does
it. Specifying even a small-to-midsize system is a multi-month effort, and
every code change invalidates the spec. Polygraph's bet is that an LLM can
produce that formal model *from your source* cheaply enough to rerun on every
change, and that replaying real traces against the model tells you whether to
trust it. You stay in JavaScript the whole time. (If you *do* want the real
thing, an optional `--tla` flag mechanically transpiles the winning spec to
TLA+ and runs TLC over it.)

This bet is no longer a fringe position. Emilie Ma's Berlin Buzzwords talk
[*Scaling formal methods with LLMs*](https://www.youtube.com/watch?v=M2wb2ug2gYg)
presents the same thesis from the TLA+ side: SysMoBench, a benchmark showing
frontier LLMs can't yet write conformant specs unaided, and Specula, an
agentic pipeline (spec generation + model checking + trace validation — the
same three legs Polygraph stands on) that found 160+ bugs in production
systems like MongoDB and etcd-raft, over 130 previously unknown, at roughly
$40 per repository. The convergent finding: the LLM alone is not trustworthy,
but an LLM *held accountable by a model checker and trace validation* is a
practical bug-finder.

> **Deep dives:** [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — how the
> three engines (Polygraph audits, polygen authors, polyrun executes) share
> one artifact family; [`docs/SDLC.md`](docs/SDLC.md) — a team lifecycle for
> integrating them into agentic workflows, with the human gates spelled out;
> [`docs/polyrun-spec.md`](docs/polyrun-spec.md) — the durable-execution
> harness specification; [`docs/VERSIONING.md`](docs/VERSIONING.md) — an
> essay on why versioning state machines is hard and how the gates here
> make compatibility a checked property instead of a review vibe. Each doc
> has interactive diagrams inline; browse them all at
> [`docs/diagrams/index.dc.html`](docs/diagrams/index.dc.html).

## How it works

Everything revolves around three artifacts you can read and diff:

1. **A contract** (`contract.json`) — what's observable: the state fields
   that matter, the actions the machine accepts, the data each action can
   carry, which states are terminal. This is the scope of the audit.

2. **A spec** — an executable model of your code, written by an LLM from your
   source. By default it's a strict, self-describing state-machine module
   (the [SAM pattern](https://sam.js.org) v2 strict profile): every action it
   ignores must say *why* (`reject(reason)`), it can't hide bookkeeping
   state, and it declares its own action/data domains — so the model checker
   knows exactly what to explore with zero configuration. Several specs are
   generated independently and vote, so one bad generation doesn't decide the
   outcome.

3. **Invariants** (`invariants.mjs`) — your rules, as plain JS functions over
   a state: *"never charged without a confirmed transaction"*, *"an expired
   session can't accept input."* These encode your **intent**, which is the
   one thing no tool can derive from the code — code with a bug is a faithful
   description of the wrong behavior.

Then two checks run:

**Check 1 — replay (is the spec faithful?).** Real execution traces —
captured by wrapping your dispatch/reducer once, so every step logs a
`{pre, action, data, post}` window — are replayed against each spec. Before
any generated spec is trusted, controls run: a hand-written reference spec
must score 100% and a deliberately mutated one must fail, proving the harness
can actually tell good from bad. Disagreements are triaged into
**spec-errors** (the LLM misread the code), **code-findings** (the code
disagrees with an independent reading of itself — investigate), and
**contract-errors** (the contract mis-scoped the problem).

**Check 2 — model check (where the bugs are).** The faithful spec is iterated
exhaustively from its initial state against your invariants. This is the step
that finds what tests miss: replay can only flag a bug when spec and code
*disagree*, and a faithful spec reproduces the bug right along with the code.
Model checking reaches the bad state anyway and prints the shortest path to
it. Every check also runs a determinism double-pass for free.

**polygen** runs the same machinery in reverse: draft contract → author
module → propose invariants → model-check → self-repair on violations (capped
at `--repair-max` rounds; a non-converging run is reported as NOT converged,
never silently presented as clean) → synthesize and independently replay a
trace corpus. It also cross-checks that contract and code agree on their
action/data vocabulary, because the two come from independent model calls —
[`examples/case-study-polygen-domain-gap.md`](examples/case-study-polygen-domain-gap.md)
shows a real run where a silent enum-spelling mismatch collapsed the
explorable state space, and how the check caught it.

polygen output is JS/TS only: the generated module is directly usable in a
JS/TS codebase; porting a verified model to another language would need its
own differential check and is out of scope.

## Effort and prerequisites

| step | who does it | how long |
|---|---|---|
| Define the contract (observable fields, actions, terminals) | you, or Claude drafts it for your review | minutes |
| Capture traces (instrument a copy, drive scenarios) | **the agent, in Claude Code** — it builds test doubles/emulators if needed; standalone, you wrap your dispatch once (snippet below) | the bulk of the work standalone; delegated in Claude Code |
| Write invariants (your rules as JS predicates) | you — this is your intent; the tool can propose, only you can confirm | minutes per rule |
| Generate specs, replay, model-check | automatic | minutes |
| Triage findings | you — every finding is a lead, not a verdict | depends on what it finds |

Trace capture is historically what made this kind of verification expensive,
and it's the step the agent now carries: in the origin study, a Claude agent
built a payment-terminal emulator and a fault-injection proxy, instrumented a
production payment workflow, drove 17 scenarios, and produced a 75-window
corpus autonomously. What stays with you is judgment: confirming the contract
covers the right state, and sanity-checking any doubles the agent built
against reality.

One hard prerequisite: **the code must be runnable in isolation**, because
traces are ground truth captured from the code actually executing. If it has
a clean step boundary (a dispatch, reducer, or handler), you're set. If it
only runs against a DB/network/device, stand up doubles first (or let the
agent do it). If it can't run at all, replay degenerates to checking specs
against your *expectations*, which can't find code bugs.

Wrapping the boundary standalone is one line per scenario:

```js
import { withTracing } from '<plugin>/scripts/instrument/trace-emitter.mjs';

// project ONLY the contract's observable keys:
const project = () => ({ txState: m.txState, orderId: m.orderId });
const dispatch = withTracing(rawDispatch, project, 'traces/s1_normal.ndjson');
// Redux-style reducer: tapReducer(...)  ·  SAM component: withSamTracing(...) — see scripts/instrument/
```

## When an API key is required

Only spec **generation** and code **authoring** call the Anthropic API.
Everything that checks, replays, or explores runs locally on Node ≥ 20.

| task | command | API key? | why |
|---|---|---|---|
| Try the quickstart / run the test suite | `npm test` | **no** | replays bundled specs against bundled traces |
| Validate a trace corpus | `validate_corpus.mjs` | **no** | local schema/shape checks |
| Replay saved specs against traces | `verify.mjs --specs …` | **no** | pure local execution |
| Model-check a spec against invariants | `check.mjs` | **no** | exhaustive local exploration |
| Escalate to TLA+/TLC | `verify.mjs --tla` | **no** | mechanical transpile + local TLC (needs Java + `tla2tools.jar` via `POLYGRAPH_JAVA` / `POLYGRAPH_TLA_JAR`) |
| **Generate specs from source** | `verify.mjs --source … --model …` | **yes** (`ANTHROPIC_API_KEY`) | the LLM writes the specs |
| **Author new code (polygen)** | `polygen.mjs --intent … --model …` | **yes** (`ANTHROPIC_API_KEY`) | the LLM drafts contract, code, and invariants |

This applies inside Claude Code too: the skills and subagents shell out to
these same scripts, so the generate and polygen steps need
`ANTHROPIC_API_KEY` set in your environment — your Claude Code session
credentials are not used for them.

## Install

As a Claude Code plugin (this repo is its own marketplace):

```
/plugin marketplace add jdubray/polygraph
/plugin install polygraph@polygraph
```

Or clone directly: `git clone https://github.com/jdubray/polygraph ~/.claude/plugins/polygraph`.
Update later with `/plugin marketplace update polygraph`. Requires **Node ≥ 20**.

Then just ask in plain language — *"verify this state machine"*, *"does this
code do what I think it does?"*, *"write a verifiable checkout flow"* — or use
the entry points directly:

| you type | what it is | when to use it |
|---|---|---|
| `/polygraph:polygraph` | audit **skill** | guided end-to-end audit — Claude designs the contract, captures traces, runs controls, triages with you |
| `/polygraph:verify` | audit **command** | you already have contract + traces; just run generate + replay |
| `polygraph-verifier` | audit **subagent** | hand off the whole audit for an autonomous run |
| `/polygraph:polygen` | author **skill / command** | write a NEW verified state machine from a feature description |
| `polygen` | author **subagent** | hand off the whole authoring loop |
| `/polygraph:polyvers` | version **skill / command** | gate a machine version change against the fleet: lanes, migrations, stimuli, seeded model check (no API key) |
| `polyvers` | version **subagent** | hand off the whole compatibility check + migration scaffold |

## Use it as a plain CLI (no Claude Code)

```bash
# replay saved specs (no API key)
node scripts/verify.mjs --contract contract.json --traces traces/ --specs specs/ --out out/

# generate + replay (needs ANTHROPIC_API_KEY)
node scripts/verify.mjs --contract contract.json --source src/machine.ts \
  --traces traces/ --model sonnet-5 --n 5 --out out/

# validate a corpus (no API key)
node scripts/validate_corpus.mjs contract.json traces/

# escalate the winning spec to TLC (no API key; needs Java toolchain)
POLYGRAPH_JAVA=/path/to/java POLYGRAPH_TLA_JAR=/path/to/tla2tools.jar \
  node scripts/verify.mjs --contract contract.json --traces traces/ --specs specs/ --tla --out out/

# author NEW verifiable code (needs ANTHROPIC_API_KEY)
node scripts/polygen.mjs --intent "<feature description>" --model sonnet-5 --out out/
```

polygen writes everything to `<out>/`: `contract.json`, `next.cjs` (the
module), `invariants.mjs`, `traces/*.ndjson`, and `polygen-report.md`. The
handoff after a polygen run is deliberately manual: review the contract and
invariants (they're the model's reading of your intent, not ground truth),
wire the module into your real handler — call it, don't reimplement it — then
run `/polygraph:verify` against traces captured from the *integrated* code.
That last step catches drift between the pure model and the glue around it.

## Models

There is **no default model** — pass `--model`. Recommended:

| alias | resolves to | notes |
|---|---|---|
| `sonnet-5` | `claude-sonnet-5` | balanced choice (speed / intelligence) |
| `fable-5` | `claude-fable-5` | strongest in the origin study |

Anything not in the alias table (`scripts/models.mjs`) is passed to the API
verbatim, so an exact Anthropic model id always works. Reasoning models spend
output tokens on thinking before the answer; if you lower `--max-tokens` from
the default 32000 and see empty specs (`stop_reason: max_tokens`), raise it
back.

## Examples

- **Quickstart — the turnstile** (`examples/turnstile-v2/`, no API key):
  `npm test` validates the corpus and runs the positive/negative controls;
  `npm run verify:turnstile-v2` replays the bundled specs.
- **Production case study** (`examples/case-study-subscription.md`): a real
  end-to-end run on a closed-source SaaS billing machine that corroborated a
  genuine double-charge bug — plus an honest look at the risks the method
  *can't* see (external-service boundaries).
- **polygen — OTP flow** (`examples/polygen-otp/`): authored from one
  sentence; 8 states, 0 violations, a 134-window synthesized corpus, 0
  independent-replay failures.
- **polygen — cart checkout, and a bug polygen found in itself**
  (`examples/polygen-cart-checkout/`, narrated in
  `examples/case-study-polygen-domain-gap.md`): the contract/code vocabulary
  mismatch that motivated the domain cross-check, including a false positive
  the fix introduces.
- **TLC tier reference** (`examples/etcd-raft-v2/`): a v2 spec + invariants
  exercising the TLA+ escalation.

## Layout

```
.claude-plugin/plugin.json   plugin manifest
skills/polygraph/            the audit method, as instructions Claude follows
skills/polygen/              the author method, as instructions Claude follows
commands/                    /polygraph:verify, /polygraph:polygen, /polygraph:polyvers
agents/                      polygraph-verifier and polygen subagents
scripts/                     sam-tv.mjs (replayer), check.mjs (model checker),
                             to-tla.mjs + tla-check.mjs (TLC tier), verify,
                             generate, polygen, validate_corpus, models,
                             vendor/sam-pattern.cjs, instrument/*
templates/                   contract.schema.json + contract.example.json
examples/                    worked examples and case studies (see above)
eval/                        the seeded-bug A/B eval and findings
test/                        npm test — no API key needed
```

## Origin

The method is introduced in:

> Jean-Jacques Dubray. **Can Code Specify a System Precisely Enough to Formally
> Verify It?** arXiv:2607.05076, July 2026. <https://arxiv.org/abs/2607.05076>

The 2.0 release gate: a seeded-bug A/B eval passing at parity or better at two
model tiers, with two bugs newly caught at the cheap replay tier and zero dead
specs. Reference implementation and full case study:
<https://github.com/jdubray/SysMoBench-1>.

Related work: Emilie Ma,
[*Scaling formal methods with LLMs*](https://www.youtube.com/watch?v=M2wb2ug2gYg)
(Berlin Buzzwords) — SysMoBench (benchmarking LLM spec generation on
production systems) and Specula (an agentic TLA+ spec-generation and
bug-discovery pipeline), reaching the same conclusion from the formal-methods
side: model checking plus trace validation is what makes LLM-generated specs
trustworthy.

If you use Polygraph in your work, please cite the paper (see `CITATION.cff`).

<details>
<summary>Legacy 1.x artifact (<code>--legacy-bare-next</code>)</summary>

Polygraph 1.x derived a bare `next(state, action, data)` function instead of
the strict SAM v2 module. That pipeline remains available end-to-end behind
`--legacy-bare-next` for one release (`npm run test:legacy`,
`npm run verify:turnstile`). The v2 strict profile replaced it because it
closes whole failure classes by construction — silent no-op specs, hidden
bookkeeping state, vacuous exploration — while the N-spec voting layer absorbs
what v2 gives up. The one discipline sentence the study showed carried
bare-next's replay robustness is kept verbatim in the v2 prompts. (The repo's
historical disk name, `bare-next-verify`, records this lineage.)

</details>

## License

Apache-2.0 — see `LICENSE`.
