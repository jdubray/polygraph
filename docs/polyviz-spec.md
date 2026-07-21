# polyviz — Functional & Technical Spec

*A Polygraph plugin that renders verification artifacts as diagrams. Handoff document for Claude Code.*

---

## 0. Summary

`polyviz` turns the artifacts Polygraph already produces — the state machine, the invariants,
the counterexamples, the compat/fleet-seeded verdicts, the run stats — into a fixed catalog of
clean, brand-consistent diagrams. It is a **deterministic, artifact-derived renderer**: same
inputs → byte-identical SVG, no model call at render time. The four diagrams in
`polyviz/reference/` (from the DAAO demo) are the visual acceptance target.

## 1. Why it belongs in Polygraph

The value is not "make diagrams." It's that the picture is **generated from the same source of
truth the gate checked**, so it cannot lie about the system. A hand-drawn or LLM-drawn diagram
drifts; `polyviz` output is a pure function of the verified model. That gives three things the
brand cares about:

- **Trustworthy visuals** — the counterexample drawn is *the* counterexample the gate produced, step for step; the "must-nevers" panel is the invariant set that was actually checked.
- **Deterministic, diffable, hashable output** — a diagram in a report or PR can be regenerated and byte-compared. (If the renderer were non-deterministic, it would reproduce exactly the D1 defect Polygraph flags in others. It must not.)
- **Zero specialist effort** — the reports and posts that sell Polygraph get their figures for free, from the run.

## 2. Design principles (non-negotiable)

1. **Artifact-derived.** Every mark traces to a field in a Polygraph artifact. No invented content.
2. **No model at render time.** Rendering is a pure function `artifacts → SVG`. (An LLM may *invoke* polyviz, but never draws.)
3. **Deterministic & canonical.** Same inputs, on any machine, produce byte-identical output. No `Date.now()`, no `Math.random()`, sorted keys, fixed number/format rules, pinned font metrics.
4. **Auto-layout, never hand-positioned.** Text is measured; boxes size to content; graphs are laid out by an engine. No overflow for any bounded input. (The reference PNGs were hand-tuned — polyviz must reproduce them *without* magic coordinates.)
5. **Themeable via tokens.** One dark theme (default, matches brand) + one light theme, driven by a tokens file. No hard-coded colors in renderers.
6. **Fail loud, not pretty.** Missing/invalid artifact → explicit error, never a silently wrong picture.

## 3. Functional spec

### 3.1 Users & jobs
- **Polygraph itself / report generation** (primary): after `polygraph`/`polyvers` run, emit the figure set into the report directory and reference them in `POLYGRAPH-REPORT.md`.
- **A developer**: "diagram this machine", "render the counterexample", "show the fleet-seed verdict" — one command, into a folder.
- **JJ / marketing**: regenerate the demo figures for posts/decks with a consistent look.

### 3.2 Diagram catalog (v1)

Each type consumes one section of the viz-model (§4.2) and maps to a reference figure.

| # | id | Purpose | Source section | Reference |
|---|----|---------|----------------|-----------|
| D1 | `state-machine` | Lifecycle graph: states, transitions, guards, effects, highlighted states | `machine` | fig2 (top) |
| D2 | `invariants` | The "must-nevers": S/L list with pass/fail status | `invariants` | fig2 (bottom) |
| D3 | `counterexample` | Ordered violating trace + violated-invariant banner + "gate-generated" callout | `trace` | fig3 |
| D4 | `compat-gate` | Version delta + live fleet + blocked/clear verdict with named offenders | `compat` | fig4 |
| D5 | `scorecard` | Thesis (review vs verify) + KPI strip (cost, claims, coverage) | `scorecard`,`choice` | fig1 |
| — | `model-card` | Composition of D1+D2 in one frame (as in fig2) | `machine`+`invariants` | fig2 |

Each renderer supports: node/step highlighting driven by data (e.g., `emphasis:"violation"`),
optional annotations on transitions/steps, and graceful wrapping of long labels.

### 3.3 Inputs
- Preferred: a **viz-model manifest** (`polyviz.json`, §4.2) — the stable contract.
- Or a **Polygraph artifacts directory** — adapters (§4.3) map native artifacts → viz-model.
- Theme name + optional tokens override file.

### 3.4 Outputs
- **SVG** (primary; crisp, scalable, diffable) per diagram.
- **PNG** export (default 2×) via a deterministic rasterizer (no browser).
- **Report integration**: write figures to `<report>/img/` and inject `![]()` references at markers in `POLYGRAPH-REPORT.md` (or emit a manifest the report step consumes).
- **`--hash`**: print sha256 of each SVG (determinism/CI check).

### 3.5 Plugin / CLI surface
Ships as a Claude Code plugin `polyviz` (SKILL.md triggers: "visualize/diagram the verification / state machine / counterexample / fleet check"). Underlying CLI:

```
polyviz render --in <dir|polyviz.json> --diagram <all|state-machine|invariants|counterexample|compat|scorecard|model-card> --out <dir> --format svg[,png] --theme <dark|light> [--tokens tokens.json] [--scale 2]
polyviz hash  --in <dir|polyviz.json> --diagram <...>        # prints sha256, no files
polyviz schema                                               # prints the viz-model JSON schema
```

### 3.6 Configuration & theming
`tokens.json`: `bg, panel, panel2, border, ink, muted, ok(green), fail(red), accentA(blue), accentB(violet), warn(amber), fontSans, fontMono, radius, gap`. Two presets shipped (`dark`, `light`). Renderers reference tokens only.

### 3.7 Non-goals (v1)
- No interactive/animated diagrams (SVG/PNG stills only; interactivity is a later milestone).
- No free-form "draw anything" — only the catalog.
- No editing UI. No live watch mode (nice-to-have later).
- Does not run verification — it only visualizes artifacts produced by other engines.

## 4. Technical spec

### 4.1 Architecture (pipeline)
```
Polygraph artifacts ──adapter──▶ viz-model (validated) ──layout──▶ scene ──render──▶ SVG ──raster──▶ PNG
                                     ▲                                           │
                                 JSON Schema                                  tokens/theme
```
Five stages, each pure and independently testable:
1. **Adapter** (only Polygraph-coupled stage) → viz-model.
2. **Validate** against JSON Schema (fail loud).
3. **Layout** → assigns geometry (graph layout for D1; deterministic flow/stack for the rest).
4. **Render** → SVG string from a small component library.
5. **Raster** → PNG.

### 4.2 The viz-model (canonical intermediate) — sketch
```jsonc
{
  "meta": { "title": "", "subtitle": "", "kicker": "", "theme": "dark", "brand": "COGNITIVE FAB · POLYGRAPH", "footer": "verify, don't review" },
  "machine": {
    "states": [{ "id": "APPROVED", "label": "APPROVED", "kind": "normal|terminal|highlight", "role": "" }],
    "transitions": [{ "from": "APPROVED", "event": "release", "guard": "now∈window", "to": "RELEASED", "effect": "transmit ×1", "emphasis": "none|accent|violation", "note": "" }]
  },
  "invariants": [{ "id": "S1", "kind": "safety|liveness", "text": "Never execute without two distinct approvers", "status": "pass|fail|unchecked" }],
  "trace": {
    "title": "", "subtitle": "",
    "steps": [{ "label": "approve(Bob)", "kind": "normal|redelivered|approved|violation", "annotation": "distinct approvers = 1" }],
    "violation": { "invariantId": "S1", "title": "S1 VIOLATED — two-person integrity", "detail": "One human, counted twice, reached execute()." },
    "callout": { "title": "This path was generated by the gate — not by a human.", "body": "…", "cleanPasses": true }
  },
  "compat": {
    "from": { "label": "RULE v1", "detail": "2 approvers" },
    "to":   { "label": "RULE v2 (deploy)", "detail": "3 approvers" },
    "fleet": [{ "id": "o2", "state": "APPROVED", "note": "2 approvals, under v1", "flagged": true }],
    "verdict": { "status": "blocked|clear", "title": "DEPLOY BLOCKED", "detail": "…", "offenders": ["o2"] }
  },
  "scorecard": [{ "value": "$0.48", "label": "total API cost", "accent": "accentA" }],
  "choice": {
    "left":  { "head": "REVIEW — today", "tone": "fail", "bullets": ["…"], "verdict": "Trust by hope" },
    "right": { "head": "VERIFY — the gate", "tone": "ok", "bullets": ["…"], "verdict": "Trust by construction" }
  }
}
```
Publish this as a JSON Schema; `polyviz schema` prints it; validation runs before layout.

### 4.3 Adapters (Polygraph artifacts → viz-model)
The **only** stage coupled to Polygraph's native formats, so it absorbs format churn.
- `machine`  ← the SAM v2 / model file (states, transitions, guards, effects).
- `invariants` ← the invariant/contract file + verification result status per id.
- `trace` ← the counterexample emitted by `polygraph` on a failing check (ordered steps + violated invariant id). Mark `redelivered/approved/violation` from step metadata.
- `compat` ← `polyvers` output (version delta, seeded live states, verdict, offenders).
- `scorecard` ← run manifest (cost, invariants passed/total, coverage/states explored).
> Action: collect one real sample of each artifact from the DAAO run to pin adapter field maps. Until then, the viz-model IS the contract and adapters are stubbed from the DAAO fixtures.

### 4.4 Layout
- **D1 state-machine**: use a layered graph layout — **`elkjs`** (preferred; deterministic layered algorithm) or `dagre`. Feed nodes/edges, get coordinates, then render. Terminal states (ABORTED/EXPIRED) as a separate rank. Transition guards/effects become edge labels; long labels wrap or truncate-with-title.
- **D2/D3/D4/D5**: deterministic hand-written layout (rows, stacks, flex-like distribution) with a **text-measurement utility** so panels size to content. No fixed coordinates that assume label lengths.

### 4.5 Renderer (SVG)
Small component library over an SVG string builder: `panel`, `pill`, `nodeBox`, `arrow`,
`bulletList`, `statTile`, `banner`, `chip`, `annotation`, `frame(title,kicker,footer)`. All take
tokens. A `measureText(str, size, font)` util backed by **pinned font metrics** (ship a metrics
table or embed the woff2 and read metrics) so wrapping is deterministic and matches the raster.

### 4.6 Theming
`dark` (default) mirrors `polyviz/reference/tokens.dark.json` (the palette used in the reference
figures). `light` for print/docs. `--tokens` overrides. Renderers must reference tokens only —
CI greps for hex literals in renderer files and fails if found.

### 4.7 Determinism (hard requirement + test)
- No wall-clock/random. Stable map iteration (sort keys). Fixed decimal formatting/locale.
- Pinned fonts + metrics; embed fonts in SVG (or reference a bundled family) so raster matches.
- Layout engine seeded/deterministic (elkjs layered is; verify no randomized tie-breaks).
- **Test**: render every fixture twice on CI (and ideally two OSes); assert byte-identical SVG and identical PNG sha256. This is the flagship test — it's the property the brand sells.

### 4.8 PNG export
Rasterize SVG with **`@resvg/resvg-js`** (Rust/WASM, deterministic, no headless browser). Default
`--scale 2`. Background from theme `bg`. (Browser screenshotting is banned — non-deterministic.)

### 4.9 Tech stack
- **TypeScript / Node** (matches the JS/SAM world; best SVG + layout ecosystem).
- Deps: `elkjs` (layout), `@resvg/resvg-js` (PNG), `ajv` (schema validation). Keep the dep list short; hand-roll SVG emission (no heavy chart lib).
- Node ≥ 20. No network access at runtime.

### 4.10 Packaging as a Claude Code plugin
- `SKILL.md` with triggers ("visualize/diagram the verification, the state machine, the counterexample, the fleet check, the scorecard") and usage.
- Bin entry `polyviz` (the CLI above). Callable by other Polygraph plugins: after `polygraph`/`polyvers`, invoke `polyviz render --in <artifacts> --out <report>/img --format svg,png`.
- Report step injects figure references at `<!-- polyviz:state-machine -->`-style markers.

### 4.11 Testing
- **Golden/snapshot** per diagram type against the DAAO fixtures → compare to `reference/*.svg` (visual parity with the four PNGs is the acceptance bar).
- **Determinism** test (§4.7).
- **Schema** tests (valid/invalid viz-models).
- **Overflow** test: long labels, many states, long invariant text → no clipping, no overlap.
- **Adapter** tests against captured Polygraph artifact samples.

### 4.12 Performance & limits
- Target < 300 ms/diagram, < 1 s for the full set, cold.
- Bound machine size gracefully (e.g., > N states → paginate or scale font, and `log()` the choice — never silently truncate).

## 5. MVP scope & milestones
- **M1** — viz-model + JSON Schema + SVG renderer + `scorecard` (D5) + `invariants` (D2). Static layouts; fastest visible parity (fig1, fig2-bottom).
- **M2** — `counterexample` (D3). Flow layout + banner + callout (fig3).
- **M3** — `state-machine` (D1) with elkjs auto-layout; compose `model-card` (fig2).
- **M4** — `compat-gate` (D4) (fig4).
- **M5** — adapters from real DAAO artifacts, PNG export, report integration, determinism CI.

Ship M1–M2 first; they already cover most report/post needs and prove the pipeline.

## 6. Open questions for JJ
1. **Artifact formats** — can you drop one real sample of each Polygraph artifact (machine model, invariants+results, a counterexample, a polyvers verdict, the run manifest)? That pins the adapters; until then the viz-model is the contract.
2. **Interactive HTML** later (hover a state/step to see guard/repro), or SVG/PNG stills forever?
3. **Light theme** needed for print/PDF reports in v1, or dark-only to start?
4. **Report coupling** — should polyviz auto-inject figures into `POLYGRAPH-REPORT.md`, or just emit files + a manifest the report step consumes? (Recommend the latter — looser coupling.)

## 7. Acceptance criteria
- Given the DAAO artifacts, `polyviz render --diagram all` reproduces the four reference figures at visual parity **with no hand-set coordinates**.
- Output is **byte-identical across repeated runs and machines** (determinism test green).
- **No network or model calls** at render time (enforced in test).
- Arbitrary bounded inputs (long labels, extra states/invariants) render **without clipping or overlap**.
- Golden snapshots exist for every diagram type; `polyviz schema` emits the published viz-model schema.

---

### Handoff assets
Put these in the repo for Claude Code to work against:
- `polyviz/reference/fig1..fig4.svg` and `.png` — the visual acceptance target.
- `polyviz/reference/tokens.dark.json` — the palette used above.
- `polyviz/fixtures/daao.polyviz.json` — a hand-authored viz-model reproducing the DAAO figures (write this first; it doubles as the M1–M4 golden input before adapters exist).
