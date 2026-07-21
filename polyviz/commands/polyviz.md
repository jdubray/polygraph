---
description: Render Polygraph verification artifacts as deterministic diagrams (SVG, optional PNG). Renders a fixed catalog — state-machine, invariants, counterexample, compat-gate, model-card — from a viz-model JSON or straight from a Polygraph/polyvers artifacts directory. Byte-identical output; no model call at render time.
argument-hint: render --in <dir|polyviz.json> --diagram <all|state-machine|invariants|counterexample|compat-gate|model-card> --out <dir> [--format svg,png] [--theme dark|light] [--tokens f.json] [--scale 2] — or — hash --in <...> --diagram <...> — or — schema
allowed-tools: Bash, Read, Write
---

Run polyviz over the arguments in `$ARGUMENTS`. polyviz is the VISUALIZATION side
of the method: it turns the artifacts Polygraph/polyvers already produced into a
fixed catalog of clean, brand-consistent diagrams. Rendering is a pure function
`artifacts → SVG` — deterministic (byte-identical on repeat), no model call, no
network. It does **not** run verification; it only visualizes.

This drives `${CLAUDE_PLUGIN_ROOT}/bin/polyviz.mjs`:

```
node ${CLAUDE_PLUGIN_ROOT}/bin/polyviz.mjs render --in <dir|polyviz.json> \
    --diagram <all|state-machine|invariants|counterexample|compat-gate|model-card> \
    --out <dir> [--format svg,png] [--theme dark|light] [--tokens f.json] [--scale 2]
node ${CLAUDE_PLUGIN_ROOT}/bin/polyviz.mjs hash --in <...> --diagram <...>
node ${CLAUDE_PLUGIN_ROOT}/bin/polyviz.mjs schema
```

Inputs:

- **A viz-model JSON** (`*.polyviz.json`, the stable contract — `polyviz schema`
  prints it): pure `viz-model → SVG`, executes no user code, no optional deps for
  SVG.
- **A Polygraph/polyvers artifacts directory**: adapters derive the machine graph
  (bounded BFS that **executes** the SAM/`next` module), read `invariants.mjs`,
  resolve a failing `findings.json` to its counterexample trace, and map
  `compat-report.json`. A `polyviz.annotations.json` in the dir supplies the
  narrative the raw artifacts don't carry.

Optional runtime components (mention when relevant): `state-machine`/`model-card`
need `elkjs`; `--format png` needs `@resvg/resvg-js` (native/WASM). The SVG path
for `invariants`/`counterexample`/`compat-gate` needs neither. Missing optional
deps fail loud with the exact `npm i` to run.

Workflow:

1. Default to `--format svg` (deterministic, diffable). Add `png` only for a
   raster deliverable.
2. When `--in` is a run directory, warn that the machine graph is derived by
   executing the module, and offer a `polyviz.annotations.json` for nicer copy.
3. Use `hash` to prove determinism in CI. The reference figures under
   `${CLAUDE_PLUGIN_ROOT}/reference/` are the visual acceptance bar.
