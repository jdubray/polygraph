---
description: Run polynv — elicit the invariants for a state machine. Harvest candidates from the contract's vocabulary, traces, and fleet snapshots; contribute frontier-model domain priors; pre-check every candidate (HOLDS or a concrete counterexample); drive a plugin-led interview into an append-only intent ledger; grade invariant-set strength by mutation. No API key (except --llm).
argument-hint: <harvest|questions|add|record|grade|report> --artifacts <dir> [subcommand flags] — start with: harvest --artifacts <dir> [--traces <path>] [--snapshots <path>]
allowed-tools: Bash, Read, Write
---

Run polynv over the arguments in `$ARGUMENTS`. This is the ELICITATION side
of the method (Polygraph audits, polygen authors, polyrun executes, polyvers
evolves, polynv ELICITS): every other gate is exactly as good as
`invariants.mjs`, and this engine is how that file gets good — the plugin
takes the lead, and the designer's job reduces to judging concrete stories.
Deterministic and **no API key** except the optional `--llm` harvest source.

Follow the `polynv` skill — it is the dialog protocol, and the dialog is the
product. The CLI is `${CLAUDE_PLUGIN_ROOT}/polynv/bin/polynv.mjs`:

```
node ${CLAUDE_PLUGIN_ROOT}/polynv/bin/polynv.mjs harvest   --artifacts <dir> [--traces <p>] [--snapshots <p>] [--min-obs N] [--llm --model <id>]
node ${CLAUDE_PLUGIN_ROOT}/polynv/bin/polynv.mjs questions --artifacts <dir> [--next] [--for <name>] [--json]
node ${CLAUDE_PLUGIN_ROOT}/polynv/bin/polynv.mjs add       --artifacts <dir> --id prior:<slug> --target state|transition --question "…" --js "…" --author <you> [--source domain-prior --domain <d> --norm "…" --model <id>]
node ${CLAUDE_PLUGIN_ROOT}/polynv/bin/polynv.mjs record    --artifacts <dir> --id <id> --disposition confirm|reject|abandon|defer|modify --author <designer>
                                                           [--js "…"] [--concern "…"] [--assign <name>] [--target state|transition] [--out <path>] [--force]
node ${CLAUDE_PLUGIN_ROOT}/polynv/bin/polynv.mjs grade     --artifacts <dir> [--include-invariants]
node ${CLAUDE_PLUGIN_ROOT}/polynv/bin/polynv.mjs drift     --artifacts <dir> [--reopen --author <name>]
node ${CLAUDE_PLUGIN_ROOT}/polynv/bin/polynv.mjs report    --artifacts <dir> [--log]
```

On a **version bump** (the machine changed since the interview), run
`drift` first: it re-checks every recorded answer against the machine as it
is now and names every verdict that moved — a confirmed rule now violated
is a finding; a rejected candidate whose behavior changed is re-asked
(`--reopen`, attributed). Emission candidates get real verdicts whenever
the dir carries the composition (`effects.cjs` + manifest, via polyrun
check-effects).

Disposition flags that trip the unprepared: a **temporal** (precedence)
record's revision is STRUCTURED — `--disposition modify
--js '{"kind":"precedence","first":"<ACTION>","then":"<ACTION>"}'` —
free-form js is refused (there is no checker for it). A **mutation-survivor**
record arrives with no predicate: your answering `modify` supplies both the
rule and its shape (`--target state|transition`), then a separate `confirm`.
And `--source domain-prior` is what routes `--domain/--norm/--model` into
the record's provenance — omit it and a model-drafted prior is silently
recorded as designer-sourced; never omit it when adding YOUR priors.

Workflow (the skill has the full protocol — these are the fixed points):

1. **Harvest first**, passing every substrate the user has (traces, a
   polyrun journal export, fleet snapshots) — then **contribute your own
   domain priors via `add` before the first question**: identify the domain
   from the contract and enumerate its canonical invariants; the designer of
   a payment system gets asked about authorization-before-capture whether or
   not any harvester surfaced it.
2. **Interview one question at a time** (`questions --next`),
   concrete-story-first. You propose and frame; **only the designer
   dispositions** — never answer an intent question on their behalf; offer
   `defer --assign` when they are unsure. Every `record` carries
   `--author <designer>`.
3. **Grade before closing** (`--include-invariants` when a hand-written
   `invariants.mjs` exists). Survivor questions rank first on the next pass.
4. **End with the verdict**: CONVERGED (all records terminal AND graded) or
   PARTIAL with what remains, per assignee. Commit `intent-ledger.json`
   (the system of record) and the generated `invariants.mjs`; `INTENT-LOG.md`
   is the rendered view for the PR.

Always state the disclosure the skill carries: pre-checks are consistency
checks over the declared finite domains; harvested candidates are behavior,
not intent; the grade bounds unconstrained behavior (behavior-REMOVING
mutations largely evade it) and never certifies that the questions asked
were sufficient.
