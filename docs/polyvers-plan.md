# polyvers — plan for the fourth engine (version)

**Status: PLAN v1.0 — M0–M3 implemented** under
[`polyvers/`](../polyvers/README.md): classifier, shape/vocabulary/intent
gates, archive + synthesized corpora, CLI, fixtures (M0); the semantic
model-check gate via `check.mjs --initial-states` with the landmine fixture
(M1); the migration lane (`migrate scaffold` + the migrate gate, with the
validated migration swapping the corpus every downstream gate sees) and the
stimuli gate (old-version stimuli × fleet states, kernel-mirrored
classification) (M2); the plugin surfaces (`/polygraph:polyvers` command,
skill, agent), the migration and composition lanes, and the cross-machine
matrix (M3). Each milestone hardened by an adversarial multi-agent review
with all confirmed findings fixed. `npm run test:polyvers`.

**Recorded deviations and follow-ups:** `--draft` (LLM-filled scaffold
holes, self-repaired against the migrate gate) is follow-up work; the
stimuli gate reads the old module's manifest-declared domain rather than
harvesting a live journal (the deterministic superset); the M3 matrix is
the spawn/completion **protocol/delivery** check — the full product-space
model check (joint interleavings against cross-machine invariants) remains
open, per the essay's scope note, as does `versions.json` (open question
#2, version-identity reconciliation with polyrun's declared versions) and
extracting a shared `classifyStep()` the polyrun kernel itself consumes.
**Thesis:** `docs/VERSIONING.md` argues that "compatible" decomposes into five
mechanically checkable questions. Today those checks are scattered — some live
in `polyrun deploy`/`migrate`, some exist only as prose in the essay, and the
classification step (which lane is this change in?) is entirely manual.
polyvers makes the essay executable: **given two versions of the artifact
family and a source of live state, classify the change, run exactly the gates
that lane requires, and emit a compatibility report a deploy can be gated on.**

The engine verb set becomes: Polygraph **audits**, polygen **authors**,
polyrun **executes**, polyvers **evolves**.

---

## 1. Scope and non-goals

**In scope**
- Diffing two versions of the artifact family (`contract.json`, machine
  module, `invariants.mjs`, `effects.manifest.json`) and classifying the
  change into the essay's lanes (shape / semantic / behavioral / vocabulary /
  intent).
- Running the per-lane gates against a snapshot corpus (live DB, archived
  export, or synthesized states) and emitting a `compat-report`.
- Scaffolding and verifying `migrate.cjs` (optionally LLM-drafting it,
  polygen-style, then self-repairing against the migration gates).
- Plugin surfaces (skill, command, agent) so the classify → gate → report
  loop runs autonomously inside agentic workflows.

**Non-goals (recorded, like polyrun's)**
- Not a deploy orchestrator: polyvers decides *whether* a version is safe,
  polyrun remains the thing that ships and runs it. `polyrun deploy` will
  call into polyvers gates rather than the reverse.
- No schema-registry service; versions stay files in git, identified by
  content hash + declared `machineVersion`.
- Cross-machine version *products* (parent v2 × child v1 model check) are M3,
  explicitly — this is the open item VERSIONING.md records.

## 2. What already exists (polyvers wraps, not duplicates)

| capability | where it lives today | polyvers role |
|---|---|---|
| load gates + `setState` round-trip over live snapshots + pointwise invariants | `polyrun deploy` (FR-6.2) | reuse as the **shape gate**; polyvers adds corpus sources beyond the live DB |
| pure/fenced/journaled migration | `polyrun migrate` | reuse as the **apply** step; polyvers adds scaffold + LLM draft + pre-apply verification |
| exhaustive model check from `init()` | `scripts/check.mjs` + `sam-adapter.cjs` | extend with `--initial-states <corpus>` → the **semantic gate** (live states as initial states — the landmine hunt, currently prose-only) |
| version-aware journal replay | `polyrun audit` | reuse as the post-deploy **drift check**; report links to it |
| domain/manifest/protocol cross-checks at registration | polyrun runtime constructor | extract into a callable **vocabulary gate** so it can run pre-deploy without booting a runtime |

The genuinely new machinery: **the classifier** (artifact-family diff →
lane), **the semantic gate** (model check seeded from real snapshots), **the
behavioral gate** (replay v(n)'s in-flight timers/outbox completions against
v(n+1) and assert every one lands as `accepted` or an *explained* reject),
and **the intent gate** (invariant diff: strengthened / weakened / renamed,
with the fleet consequences of each strengthening named per instance).

## 3. Tools (CLI, no API key except where noted)

New directory `polyvers/` mirroring `polyrun/`'s layout (`src/`, `bin/`,
`test/`), CLI `polyvers/bin/polyvers.mjs`:

- **`polyvers classify --old <dir> --new <dir>`** — structural diff of the
  four artifacts; output: the lane(s) touched, the gate list that lane
  requires (from the decision table, now encoded as data), and a stable
  changeId. Multiple lanes may fire at once (a shape change usually drags a
  vocabulary change); the gate set is the union.
- **`polyvers check --old <dir> --new <dir> --snapshots <src>`** — run the
  required gates. `--snapshots` accepts a polyrun config (live DB), an
  archive dir (`polyrun archive` output), or `--synthesize` (BFS-reachable
  states of the *old* machine — weakest tier, clearly labeled). Exit code is
  the gate. Per-gate results, counterexamples with shortest paths, and named
  offending instances go into `out/compat/<changeId>/compat-report.{json,md}`.
- **`polyvers migrate scaffold --old <dir> --new <dir>`** — from the shape
  diff, emit a `migrate.cjs` skeleton (identity for unchanged keys, TODO
  holes for added/removed/retyped keys) plus a verification harness. With
  `--draft` (API key), LLM-fill the holes and self-repair against the
  migration gates: module accepts every migrated snapshot, projection
  equality, invariants hold on migrated states. Apply remains
  `polyrun migrate --apply` — unchanged.
- **`polyvers stimuli --old <dir> --new <dir> --journal <src>`** — the
  behavioral gate standalone: harvest in-flight timers and pending/inflight
  outbox completions from a v(n) journal/DB, fire each into the v(n+1)
  machine at its migrated state, and assert nothing lands as `unhandled` or a
  reject with an unnamed reason. Cross-version delivery, checked instead of
  asserted-by-doctrine.
- **`polyvers report`** — render the latest compat-report; `--ci` prints the
  one-screen verdict table.

## 4. Plugin surfaces

Consistent with the existing polygraph plugin (`commands/`, `skills/`,
`agents/` at repo root):

- **`commands/polyvers.md`** → `/polygraph:polyvers` — "check whether this
  machine change is safe against the fleet": runs classify → check →
  report, walks the user through failures lane by lane.
- **`skills/polyvers/SKILL.md`** — when to invoke (user changed a
  contract/machine/invariants file that has a deployed predecessor; user
  asks "can I ship this change?", "is this backward compatible?", "write me
  a migration"), how to pick a snapshot source honestly (live > archive >
  synthesized, and *say which one was used*), and the triage vocabulary for
  gate failures (mirroring spec-error/code-finding/contract-error:
  **migration-defect / rule-regression / meaning-gap** — the last being
  VERSIONING.md's "no honest image" case, which is escalated to the human,
  never auto-repaired).
- **`agents/polyvers.md`** — autonomous version auditor: given old + new
  artifact dirs and a snapshot source, run the full loop, draft the
  migration if the lane needs one, self-repair it, and return the
  compat-report — flagging anything in the meaning-gap bucket for human
  decision. Tools: Read, Write, Bash, Glob, Grep (same as polygen's agent).
- **Docs integration** — SDLC "Versioning best practices" items 1–3 become
  "run `/polygraph:polyvers`"; the VERSIONING essay's decision table gains a
  "the command" column.

## 5. Artifacts polyvers adds to the family

- **`compat-report.json` / `.md`** — the deliverable: lanes, gates run,
  snapshot source + count (provenance is part of the honesty story),
  verdicts, counterexamples, named instances. Diffable, CI-gateable, and the
  natural attachment for a version-bump PR.
- **`MIGRATION-NOTE.md`** — scaffolded next to `migrate.cjs` (mirrors
  `REPAIR-NOTE.md`): why the shape changed, what each hole maps, which
  instances (if any) were meaning-gap and what the human decided.
- **`versions.json`** (per machine dir; RECORDED FOLLOW-UP — not implemented,
  see open question #2) — append-only version manifest:
  `machineVersion`, content hashes of the four artifacts, changeId, link to
  the compat-report that admitted it. polyrun's per-step `machine_version`
  stamping gets its values from here.

## 6. Milestones

- **M0 — classify + shape/vocabulary gates.** Artifact diff, lane
  classification, decision table as data; shape gate reusing the deploy-gate
  round-trip against archive/synthesized corpora; vocabulary gate extracted
  from the runtime constructor. Deterministic, no API key. Worked example:
  a benign OMS order-machine rule tweak (plain-deploy lane) and a renamed
  action (vocabulary lane) with fixture snapshots.
- **M1 — the semantic gate.** `check.mjs --initial-states`: BFS seeded from
  every corpus snapshot under the *new* machine's rules. This is the
  headline (the v1-reachable/v3-unreachable landmine hunt, mechanized) and
  the essay's precise compatibility definition made executable. Fixture: a
  deliberately planted landmine version pair that only this gate catches.
- **M2 — migration lane + behavioral gate.** `migrate scaffold` (+ `--draft`
  with self-repair), `stimuli`. Worked example: the OMS order machine gains
  a shape change (e.g. split `charge` into `authorize`/`capture`) with
  in-flight timers crossing the boundary — the full five-gate run, ending in
  `polyrun migrate --apply` and a version-aware `polyrun audit` that stays
  quiet.
- **M3 — plugin surfaces + the open item.** Command/skill/agent shipped;
  cross-machine product check (parent × child version matrix over the
  spawn/completion protocol) attempted, or honestly re-scoped with what was
  learned. Adversarial multi-agent review per milestone, same as polyrun.

## 7. Open questions (to resolve before M0)

1. **Where does the semantic gate's state-space bound come from?** Seeding
   BFS from thousands of snapshots multiplies the explored space; likely
   need dedupe-by-`stable()` across seeds plus the existing depth/path caps,
   with BOUNDED reported exactly as `check-effects` does.
2. **Version identity: declared, derived, or both?** Content-hash identity is
   tamper-proof but human-hostile; declared `machineVersion` is readable but
   forgeable. Leaning both: declared for display, hash for gating drift
   between the manifest and reality.
3. **Does `classify` need the *old* machine to be loadable, or are the four
   artifact files enough?** Files-only would let polyvers run against a
   version that predates the strict profile — probably worth it for the
   audit-of-legacy story, at the cost of a weaker vocabulary diff.
