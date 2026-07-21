---
name: polyviz
description: Turn Polygraph verification artifacts into clean, brand-consistent diagrams (SVG, optional PNG). polyviz is a DETERMINISTIC, artifact-derived renderer — same inputs produce byte-identical output and it makes no model call at render time. Use when the user wants to "visualize / diagram the verification", "draw the state machine / lifecycle", "render the counterexample / the bug the gate found", "show the fleet / compat / deploy-gate verdict", or "regenerate the figures for a report or post". It renders a fixed catalog (state-machine, invariants, counterexample, compat-gate, model-card) from either a hand-authored viz-model JSON or straight from a Polygraph/polyvers artifacts directory. NOT for drawing arbitrary diagrams outside that catalog, and it does not run verification — it only visualizes artifacts other engines produced. Trigger phrases: "polyviz", "diagram the machine", "render the counterexample", "visualize the compat gate", "make the figures".
---

# polyviz — visualize the verification, don't redraw it

polyviz is the VISUALIZATION side of the Polygraph method (Polygraph audits,
polygen authors, polyrun executes, polyvers evolves, polynv elicits — polyviz
**draws**). Every mark it emits traces to a field in a Polygraph artifact, so the
picture cannot drift from the model that was actually checked. Rendering is a
pure function `artifacts → SVG`: no `Date.now()`, no randomness, sorted keys —
byte-identical on every run. An LLM may *invoke* polyviz; it never draws.

The CLI is `${CLAUDE_PLUGIN_ROOT}/bin/polyviz.mjs`:

```
polyviz render --in <dir|polyviz.json> --diagram <all|state-machine|invariants|counterexample|compat-gate|model-card> \
               --out <dir> [--format svg[,png]] [--theme dark|light] [--tokens tokens.json] [--scale 2]
polyviz hash   --in <dir|polyviz.json> --diagram <...>     # sha256 per SVG, no files (determinism/CI check)
polyviz schema                                             # print the viz-model JSON Schema
```

## Two ways to feed it

1. **A viz-model JSON** (`*.polyviz.json`) — the stable contract (`polyviz schema`
   prints it). Pure `viz-model → SVG`: no user code executed, no optional deps
   needed for the SVG path. Best when you're authoring figures by hand or a tool
   already emitted a viz-model.

2. **A Polygraph/polyvers artifacts directory** (`--in <dir>`) — adapters map the
   native artifacts to a viz-model:
   - `contract.json` + its SAM/`next` module → the **machine** graph. The
     contract has no edge list, so transitions are derived by a bounded,
     deterministic **BFS that executes the module** over its declared
     `(action,data)` domain. This runs the target module — only do it on a run
     you trust.
   - the invariants module (`invariants.mjs`) → the **invariants** panel.
   - a `findings.json` reporting a failure, resolved to its trace → the
     **counterexample**.
   - polyvers `compat-report.json` → the **compat-gate**.
   Drop a `polyviz.annotations.json` in the dir to supply the narrative the raw
   artifacts don't carry (titles, nicer invariant text, version-card labels, a
   highlighted state).

## The catalog (v1)

| id | shows | source |
|----|-------|--------|
| `state-machine` | the lifecycle graph (states, transitions, guards/effects, a highlighted state) | `machine` |
| `invariants` | the must-nevers: safety/liveness list with pass/fail | `invariants` |
| `counterexample` | the bug: violating trace + violated-invariant banner + "the gate generated this" callout. Renders the **fix** (clean pass, green) when there is no violation. | `trace` |
| `compat-gate` | the versioning bug: version delta + live fleet + **blocked**/**clear** verdict with named offenders | `compat` |
| `model-card` | `state-machine` + `invariants` composed in one frame | `machine`+`invariants` |

## Optional runtime components (be upfront with the user)

- **SVG for invariants / counterexample / compat-gate** — needs nothing extra
  and runs no user code.
- **state-machine / model-card** — needs the optional `elkjs` (pure JS layout).
- **PNG export** (`--format png`) — needs the optional `@resvg/resvg-js` (a
  native/WASM rasterizer). SVG never needs it.
- **Deriving the machine from a real run** — executes the target module (bounded
  reachability). Prefer the viz-model path if the user is wary of that.

If an optional dep is missing, the CLI fails loud with the exact `npm i …` to run.

## How to drive it

1. If the user hands you a **viz-model JSON**, render straight away:
   `node ${CLAUDE_PLUGIN_ROOT}/bin/polyviz.mjs render --in <file> --diagram all --out <dir>`.
2. If they point at a **run/artifacts directory**, render with `--in <dir>`; tell
   them the machine graph is derived by executing the module, and offer to add a
   `polyviz.annotations.json` for nicer copy.
3. Default to `--format svg` (deterministic, diffable). Add `png` only when they
   want a raster (decks, docs).
4. Use `polyviz hash` in CI to assert determinism (same input → same sha256).
5. The reference figures in `${CLAUDE_PLUGIN_ROOT}/reference/` are the visual bar.

Keep the output to the fixed catalog. If the user wants a diagram outside it,
say so — polyviz is deliberately not a general drawing tool.
