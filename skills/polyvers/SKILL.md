---
name: polyvers
description: Check whether a state-machine version change is safe to ship against the live fleet, and produce the migration when the shape changed. Classifies the change into compatibility lanes (shape, vocabulary, intent, semantic, migration, composition), runs the mechanical gates those lanes require against fleet snapshots — setState round-trip, cross-version stimuli replay, migration validation, and the seeded model check ("can any live state be driven to an invariant violation under the new rules") — and scaffolds migrate.cjs from the shape diff. Use when the user asks "can I ship this change?", "is this backward compatible?", "write me a migration", "will old in-flight timers break?", or changes a contract/machine/invariants file that has a deployed predecessor. Trigger phrases: "polyvers", "version this machine", "compatibility check", "migrate the fleet", "safe to deploy this state machine change".
---

# polyvers — version a state machine with mechanical gates

The fourth engine: Polygraph audits, polygen authors, polyrun executes,
polyvers EVOLVES. The premise (from
`${CLAUDE_PLUGIN_ROOT}/docs/VERSIONING.md`): state outlives code, so every
deploy is a compatibility event against the live fleet — and "compatible"
is not one question but several, each with its own mechanical check.
Everything here is deterministic, local, and needs **no API key**.

The CLI is `${CLAUDE_PLUGIN_ROOT}/polyvers/bin/polyvers.mjs`; an artifact
dir holds `contract.json` + the SAM v2 module + optional `invariants.mjs`,
`effects.manifest.json`, `effects.cjs`, `migrate.cjs` — what polygen emits.

> **Disclosure (same as the whole plugin).** This is experimental, unproven
> technology, and these gates are consistency checks, not proofs. They are
> exactly as good as the invariants the artifacts state — semantic drift the
> invariants do not mention is invisible to every gate. Versioning maturity
> is invariant-writing maturity.

## Step 1 — Classify before running anything

```
node ${CLAUDE_PLUGIN_ROOT}/polyvers/bin/polyvers.mjs classify --old <dir> --new <dir>
```

The lanes and what fires them: **shape** (contract stateKeys), **vocabulary**
(actions, reject reasons, effect kinds, terminal states), **intent**
(invariants — state or transition), **semantic** (the module changed),
**migration** (migrate.cjs added/edited), **composition** (effects.cjs
changed — gated by `polyrun check-effects`, the report says so as a NOT RUN
row). "No lane fired" on differing artifacts means a cosmetic edit; say so
rather than inventing risk.

## Step 2 — Choose the snapshot corpus honestly

The gates run against fleet states, and provenance is part of the verdict:

1. **fleet exports** (`--snapshots <dir|file>`; `polyrun archive` output,
   bare ndjson, or a `.json` array) — the honest tier. "Live" means a FRESH
   `polyrun archive`/export of the fleet fed to this flag; polyvers never
   connects to a database.
2. **`--synthesize`** — BFS-reachable states of the OLD machine: the weakest
   tier, because it contains only states the old MODEL says are reachable,
   which is exactly the assumption a landmine violates.

Always tell the user which tier was used. Never work around a refusal (empty
corpus, missing invariants, unreadable stimulus set) — each one means "the
gate would certify vacuous truth"; fix the input instead.

## Step 3 — Run the gates and triage by failure class

```
node ${CLAUDE_PLUGIN_ROOT}/polyvers/bin/polyvers.mjs check --old <dir> --new <dir> \
    --snapshots archive/ --out out/compat
```

Exit 0 is the gate; the compat-report (deterministic, byte-identical across
machines) is the PR artifact. Triage failures with this vocabulary:

- **migration-defect** — migrate.cjs is impure, rejected, projection-unequal,
  or violates invariants (including the migration TRANSITION itself against
  transition invariants). Fix the migration; re-run.
- **rule-regression** — the seeded model check found a live state that the
  new rules can DRIVE to a violation (the landmine). The failure names one
  witness snapshot and the shortest action(data) path — that is the repro.
  Remember it is a compatibility verdict, not an affected-instance list.
- **meaning-gap** — a live state has no honest image under the new version
  (the round-trip or migration fails on it and no pure function can fix it).
  **Escalate to the human with the named snapshots — never auto-repair.**
  The tool's contribution is that this decision arrives BEFORE the deploy.

A BOUNDED exploration is a failure unless the operator explicitly accepts
`--allow-bounded`. A stimuli failure means something the old version can
still deliver (timer, completion, old-vocabulary caller) becomes undefined
behavior — deprecate-don't-delete is the standard move.

## Step 4 — Shape change: scaffold, fill, re-check, then polyrun applies

```
node ${CLAUDE_PLUGIN_ROOT}/polyvers/bin/polyvers.mjs migrate scaffold --old <dir> --new <dir>
```

Contracts-only (works before the new module exists). The scaffold is complete
for pure additions; retyped keys get throwing TODO holes a human must fill —
walk the user through each hole and the MIGRATION-NOTE. Then re-run `check`:
a validated migration swaps the corpus, so every downstream gate runs over
the states the fleet will hold AFTER the migration. Apply stays with
`polyrun migrate` (dry run over live snapshots, then `--apply`).

## Step 5 — Parent/child machines: the version matrix

```
node ${CLAUDE_PLUGIN_ROOT}/polyvers/bin/polyvers.mjs matrix \
    --parent-old <dir> --parent-new <dir> --child-old <dir> --child-new <dir> --child-id <machineId>
```

Checks all four rollout-window pairings of the spawn/completion protocol and
its delivery (child terminal outcomes into the parent with the discovered
childKeys, parent-terminal cancels into the child). `--parent-snapshots` /
`--child-snapshots` seed fleet states into discovery and delivery — same
tier doctrine as `check`. Scope note to relay honestly: this is the
protocol/delivery matrix; the full product-space model check over joint
interleavings remains open.

## What the agent must not do alone

Approve a weakened invariant, dismiss a rule-regression, or decide what a
meaning-gap instance means — those are the human's calls (SDLC gates). The
job here is to make each one arrive pre-deploy, attached to named snapshots
and a repro, instead of post-deploy attached to a pager.
