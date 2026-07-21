# polyviz

A deterministic, artifact-derived diagram renderer for Polygraph. It turns the
artifacts the suite already produces — the machine, the invariants, the
counterexample, the compat verdict — into a fixed catalog of clean,
brand-consistent SVGs. Same inputs → **byte-identical** output, no model call at
render time.

Full spec: [`docs/polyviz-spec.md`](../docs/polyviz-spec.md).

## Status

**M1–M4 — shipped.** The full v1 diagram catalog: `invariants` (D2),
`counterexample` (D3), `state-machine` (D1, elkjs), `model-card` (D1+D2, fig2),
and `compat-gate` (D4). Bug **and** fix faces for D3 and D4, dark & light themes,
golden + determinism tests. Remaining work is M5 plumbing.

| id | diagram | milestone |
|----|---------|-----------|
| D2 | `invariants` — the must-nevers, pass/fail | ✅ M1 |
| D3 | `counterexample` — the bug trace (+ clean-pass "fix" variant) | ✅ M2 |
| D1 | `state-machine` — lifecycle graph (elkjs auto-layout) | ✅ M3 |
| —  | `model-card` — D1 + D2 composed (fig2) | ✅ M3 |
| D4 | `compat-gate` — blocked / clear verdict (portrait, fig4) | ✅ M4 |
| —  | adapters (real artifacts), PNG export, report injection | M5 |

D3 (`trace.violation` present/absent) and D4 (`verdict.status` blocked/clear)
each render the bug and the fix from the same renderer — see the paired
fixtures (`daao.polyviz.json` vs `daao-fixed` / `daao-compat-clear`).

The `state-machine` graph is laid out by **elkjs** (`elk.algorithm: layered`,
deterministic). It scales down uniformly to fit the 1104px content width when a
machine is too wide (spec §4.12) and logs the scale factor. Transition
labels (note ⁄ effect) are placed above the row at each edge's midpoint.

**Bug and fix from one renderer:** `counterexample` renders the bug (red
violation banner) when `trace.violation` is present, and the fix (green
clean-pass banner) when it is absent — see `fixtures/daao.polyviz.json` vs
`fixtures/daao-fixed.polyviz.json`.

The scorecard (D5) from the original spec was cut: the focus is visualizing
**bugs and fixes**, and the "fix" is the passing variant of D3/D4, not a
separate diagram.

## CLI

```
polyviz render --in <dir|polyviz.json> --diagram <all|state-machine|invariants|counterexample|compat-gate|model-card> \
               --out <dir> [--format svg[,png]] [--theme dark|light] [--tokens f.json] [--scale 2]
polyviz hash   --in <dir|polyviz.json> --diagram <...>   # sha256 per SVG, no files
polyviz report --in <dir|polyviz.json> --diagram <...> --img <dir> [--report REPORT.md] [--format svg,png]
               # render into <img>, write manifest.json, and (with --report) inject image refs
               # at `<!-- polyviz:<id> -->` markers (idempotent open/close blocks)
polyviz schema                                            # print the viz-model JSON Schema
```

From the repo root: `npm run polyviz -- render --in polyviz/fixtures/daao.polyviz.json --diagram invariants --out out`.

## Installing (optional, separate from polygraph)

polyviz is a **separate plugin** in the marketplace (`source: ./polyviz`) — you
install it only if you want the visuals; polygraph does not pull it in. Its two
runtime components are **optional and lazy**:

- The pure **viz-model → SVG** path (invariants, counterexample, compat-gate)
  needs no optional dependency and **executes no user code**.
- `state-machine` / `model-card` need `elkjs` (pure-JS graph layout).
- `--format png` needs `@resvg/resvg-js` (a native/WASM rasterizer).
- Deriving the machine graph **from a real run** executes the target module
  (bounded reachability) — prefer the viz-model path if that's a concern.

Both are `optionalDependencies`, loaded on first use; if one is missing the CLI
fails loud with the exact `npm i` to run.

`--in` takes either a **viz-model** JSON (the stable contract, §4.2) **or a
Polygraph/polyvers artifacts directory** — adapters (§4.3) map the native
artifacts to a viz-model. Shipped:

- **machine** ← `contract.json` + its SAM/next module. The contract has no edge
  list, so transitions are derived by a bounded, deterministic **BFS over the
  module's declared (action, data) domain** (the reachability driver polyvers/
  polyrun use), projected onto the abstract `state` field. This executes the
  target module (JJ's ruling); effects (`transmit ×1`/`execute ×1`) are read
  from one-shot flag flips.
- **invariants** ← the invariants module (`invariants.mjs`): id/kind derived from
  the name, text prettified, status defaulting to pass.
- **counterexample** ← a `findings.json` failure resolved to its trace file
  (rich `{pre,action,data,post}` ndjson or simple `{op,actor}` ops): steps,
  redelivered no-op detection (`pre==post`), and the violating step marked from
  the finding index + reject reason.
- **compat** ← polyvers `compat-report.json` → D4.

An optional `polyviz.annotations.json` in the directory overrides the narrative
fields the raw artifacts don't carry (titles, invariant text, version labels,
state highlights).

PNG export (`--format png`, default `--scale 2`) rasterizes each SVG with
`@resvg/resvg-js` — no headless browser. Deterministic per-platform (byte-
identical across runs); cross-OS parity is best-effort (depends on system
fonts). Report injection and two-OS CI are the last M5 items.

## Architecture (pure, staged — spec §4.1)

```
viz-model ──validate──▶ layout ──render──▶ SVG   (M5: ──raster──▶ PNG)
   ▲ JSON Schema                    ▲ tokens/theme
```

- `src/model/` — the viz-model JSON Schema + a fail-loud validator (no deps).
- `src/layout/measure.mjs` — `measureText`/`wrapText` over a **pinned metrics
  table** (`assets/metrics.json`), so wrapping is a pure function of a checked-in
  file, identical on every machine. Regenerate with `assets/gen-metrics.mjs`.
- `src/render/` — a tiny SVG string builder (`svg.mjs`), token loader
  (`theme.mjs`), and component library (`components.mjs`). Renderers reference
  tokens only — a test greps them for hex literals.
- `src/adapters/` — Polygraph/polyvers artifacts → viz-model (the only
  Polygraph-coupled stage). `compat.mjs` (polyvers `compat-report.json`) ships;
  `index.mjs` dispatches over an artifacts directory.
- `src/layout/graph.mjs` — elkjs wrapper for the state-machine graph.
- `src/diagrams/` — one module per diagram; registered in `diagrams/index.mjs`.
  Renderers may be sync or async (elk-backed `state-machine`/`model-card` return
  a promise); the CLI and tests await them.

## Determinism

The flagship property (§4.7). Won at the text-measurement boundary: no
wall-clock, no random, sorted keys, fixed number formatting, and a pinned
metrics table instead of a system font. `npm run test:polyviz` renders each
fixture twice and asserts byte-identical SVG. PNG byte-parity across OSes is
best-effort until the M5 rasterizer/font bundle is proven.

## Tests

```
npm run test:polyviz
```

Covers determinism, golden snapshots (dark+light), schema valid/invalid,
overflow (long labels / many invariants wrap and grow, never clip), and the
no-hex-literals guard.
