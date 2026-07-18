---
description: Run polyvers — classify a state-machine version change into compatibility lanes, run the gates those lanes require against fleet snapshots (shape round-trip, vocabulary, in-flight stimuli, migration validation, seeded model check), scaffold migrations, and check parent×child version matrices. No API key.
argument-hint: <classify|check|migrate scaffold|matrix> --old <dir> --new <dir> [--snapshots <path> | --synthesize] [--out out/compat] [--allow-bounded]
allowed-tools: Bash, Read, Write
---

Run polyvers over the arguments in `$ARGUMENTS`. This is the VERSIONING side
of the method (Polygraph audits, polygen authors, polyrun executes, polyvers
EVOLVES): given two versions of a machine's artifact family, classify the
change, run exactly the gates its lanes require, and gate the deploy on the
compat-report. Everything is deterministic and needs **no API key**.

This drives `${CLAUDE_PLUGIN_ROOT}/polyvers/bin/polyvers.mjs`:

```
node ${CLAUDE_PLUGIN_ROOT}/polyvers/bin/polyvers.mjs classify --old <dir> --new <dir> [--json]
node ${CLAUDE_PLUGIN_ROOT}/polyvers/bin/polyvers.mjs check    --old <dir> --new <dir> \
    (--snapshots <path> | --synthesize) [--max-states N] [--allow-bounded] [--out out/compat] [--json]
node ${CLAUDE_PLUGIN_ROOT}/polyvers/bin/polyvers.mjs migrate scaffold --old <dir> --new <dir> [--force]
node ${CLAUDE_PLUGIN_ROOT}/polyvers/bin/polyvers.mjs matrix \
    --parent-old <dir> --parent-new <dir> --child-old <dir> --child-new <dir> --child-id <machineId>
```

An artifact dir holds `contract.json` + the SAM v2 module + optional
`invariants.mjs`, `effects.manifest.json`, `effects.cjs`, `migrate.cjs` —
exactly what polygen emits.

Workflow:

1. **`classify` first** — it names the lanes (shape / vocabulary / intent /
   semantic / migration / composition) and the gates they demand, without
   running anything.
2. **Pick the snapshot corpus honestly** — live fleet state > `polyrun
   archive` output (`--snapshots`) > `--synthesize` (BFS-reachable states of
   the OLD machine — the weakest tier: it contains only states the old MODEL
   says are reachable, which is exactly the assumption a landmine violates).
   Always tell the user which tier was used; the report records it.
3. **`check`** — exit 0 is the gate. Read the report's failures BY LANE, and
   triage with this vocabulary: **migration-defect** (migrate.cjs is wrong —
   fix it), **rule-regression** (the new rules can hurt live state — the
   seeded model check's counterexample is the repro), **meaning-gap** (a live
   state has no honest image in the new version — escalate to the human with
   the named snapshots; NEVER auto-repair this one).
4. **Shape change?** `migrate scaffold`, have the human fill/confirm the TODO
   holes and the MIGRATION-NOTE, re-run `check` (the migrate gate validates
   purity, acceptance, projection equality, state+transition invariants, then
   every downstream gate runs over the MIGRATED corpus). `polyrun migrate`
   (dry run, then `--apply`) remains the apply-time gate over live snapshots.
5. **Parent/child machines?** `matrix` checks the 2×2 rollout-window pairings
   of the spawn/completion protocol and its delivery.

A BOUNDED exploration is a failing gate unless the operator explicitly
accepts it with `--allow-bounded`. An empty corpus, a missing invariants
file, or an unreadable stimulus set are refusals, never vacuous passes. The
gates are exactly as good as the invariants the artifacts state — say so.
