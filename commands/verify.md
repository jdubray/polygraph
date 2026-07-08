---
description: Run the Polygraph verification loop — generate N transition-function specs from a source file and replay real traces against them, reporting spec-errors vs code-findings.
argument-hint: --contract <c.json> --source <file> --traces <dir> --model <id> [--n 5] [--max-tokens 32000] [--invariants <inv.mjs>] [--invariants <inv.mjs>]
allowed-tools: Bash, Read, Write
---

Run the Polygraph (bare-next) verification loop over the arguments in `$ARGUMENTS`.

This drives `${CLAUDE_PLUGIN_ROOT}/scripts/verify.mjs`. Two modes:

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

Recommended models: `sonnet-5`, `fable-5` (configurable; no default — pass the
exact Anthropic model id if you are not using a known alias).

Steps to perform:
1. If no `contract.json` exists yet, help the user build one from
   `${CLAUDE_PLUGIN_ROOT}/templates/contract.example.json` (see the
   polygraph skill for the full method).
2. Validate the corpus first:
   `node ${CLAUDE_PLUGIN_ROOT}/scripts/validate_corpus.mjs <c.json> <traces>`.
3. Run `verify.mjs` with the parsed arguments.
4. Read `out/findings.md` and walk the user through each finding, classifying it
   as a code-finding, contract-error, or spec-error per the skill's Step 5.

Always state that this is a consistency check, not a proof, and that findings
are leads to investigate by hand.
