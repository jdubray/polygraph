---
description: Run the Polygraph verification loop — generate N transition-function specs from a source file and replay real traces against them, reporting spec-errors vs code-findings.
argument-hint: --contract <c.json> --source <file> --traces <dir> --model <id> [--n 5] [--max-tokens 32000] [--invariants <inv.mjs>] [--legacy-bare-next] [--tla]
allowed-tools: Bash, Read, Write
---

Run the Polygraph verification loop over the arguments in `$ARGUMENTS`.

This drives `${CLAUDE_PLUGIN_ROOT}/scripts/verify.mjs`. The generated artifact
is, by default, a **v2 SAM strict-profile module** (named intents with schemas
and finite domains, keyed acceptors, observable `reject(reason)`, sealed
model); `--legacy-bare-next` selects the original bare
`next(state, action, data)` artifact end-to-end for one release. Two modes:

- **Generate + replay** (needs `ANTHROPIC_API_KEY` and `--model`):
  ```
  node ${CLAUDE_PLUGIN_ROOT}/scripts/verify.mjs \
    --contract <c.json> --source <file> --traces <dir> \
    --model <id> --n 5 --out out/
  ```
- **Replay saved specs** (no key):
  ```
  node ${CLAUDE_PLUGIN_ROOT}/scripts/verify.mjs \
    --contract <c.json> --traces <dir> --specs <dir> --out out/
  ```

Useful flags:

- `--legacy-bare-next` — bare-next artifact (legacy prompt, `tv.mjs` replayer,
  `buildDomain()` checker domains) instead of the v2 default.
- `--tla` — TLC escalation tier: after the verdict, the winning live spec
  (most windows passed; tie → first) is mechanically transpiled to TLA+
  (`out/tla/*.tla` + `.cfg`) and model-checked with TLC; the outcome (states,
  per-invariant verdicts, counterexample steps, skipped invariants with
  reasons) lands in a "TLC escalation" subsection of `findings.md` Part 2.
  Toolchain discovery: `POLYGRAPH_JAVA` (or `java` on PATH) and
  `POLYGRAPH_TLA_JAR` (path to `tla2tools.jar`; no PATH fallback). A missing
  toolchain is reported as a note — the `.tla`/`.cfg` artifacts are still
  written. Optional: `--tla-bound N`, `--tla-timeout <seconds>`.
- `--invariants <inv.mjs>` / `--max-states N` — the model-checking half
  (Part 2); runs automatically when `invariants.mjs` sits beside the contract.
- `--initial-states <states.json>` — a JSON array of state objects seeded into
  every per-spec model check alongside `init()`. This is the remedy for a
  `FROZEN STATE KEY` warning in `findings.md` (a key no action changes leaves
  Part 2 structurally blind to behavior it gates — seed non-default values to
  unfreeze it).

Recommended models: `opus-4.8`, `fable-5` (configurable; no default — pass the
exact Anthropic model id if you are not using a known alias).

Prerequisite: a REAL captured trace corpus. The corpus is the verification —
if the code cannot be run and instrumented to capture traces, this tool does
not apply (recommend hand-written modeling instead); never substitute
synthetic traces derived from reading the source.

Steps to perform:
1. If no `contract.json` exists yet, help the user build one from
   `${CLAUDE_PLUGIN_ROOT}/templates/contract.example.json` (see the
   polygraph skill for the full method). In the v2 default pipeline every
   action with data fields MUST have a `dataDomain` entry — it is also the
   exploration and transpilation domain, and a gap blocks generation loudly.
2. Validate the corpus first:
   `node ${CLAUDE_PLUGIN_ROOT}/scripts/validate_corpus.mjs <c.json> <traces>`.
   Every action appearing in the traces must be declared in the contract —
   the v2 strict artifact has no silent-unknown-action fallback.
3. Run `verify.mjs` with the parsed arguments.
4. Read `out/findings.md` and walk the user through each finding, classifying it
   as a code-finding, contract-error, or spec-error per the skill's Step 5. In
   the v2 default, each finding window also carries a step classification —
   `rejected(reason)` and `identity-by-mutation` are the two GOOD no-op
   classes; `unhandled` (the spec neither acted nor rejected) is itself a
   finding.

Always state that this is a consistency check, not a proof — exhaustive only
over the declared finite (action, data) domains, not unbounded real data —
and that findings are leads to investigate by hand.
