# polyviz example — an order machine, drawn from its artifacts

A self-contained walkthrough of **polyviz**: render the whole diagram catalog
straight from a Polygraph/polyvers artifact set — no hand-drawing, no model call.
Every mark traces to a field in these files, so the picture can't drift from what
was checked.

## What's here

A tiny order-lifecycle machine and the artifacts the suite produces around it:

| file | what it is | diagram it feeds |
|------|------------|------------------|
| `contract.json` | states, actions, data domain, terminals | `state-machine`, `model-card` |
| `next.cjs` | the machine, as a bare `next(state, action, data)` module (no deps) | `state-machine` (edges derived by BFS) |
| `invariants.mjs` | the must-nevers (named predicates) | `invariants`, `model-card` |
| `bug.ndjson` + `findings.json` | a failing trace and the finding that flags it | `counterexample` |
| `compat-report.json` | a polyvers version-gate verdict (blocked) | `compat-gate` |
| `polyviz.annotations.json` | the narrative the raw artifacts don't carry (titles, invariant text, version labels) | all |
| `img/*.svg` | the rendered figures, committed | — |

## Render it

```
node ../../polyviz/bin/polyviz.mjs render --in . --diagram all --out img --format svg
```

That one command produces all five figures in `img/`:

- **`state-machine.svg`** — the lifecycle graph. The contract has no edge list,
  so polyviz derives the transitions by **executing `next.cjs`** over the
  declared `(action, data)` domain (bounded reachability) and reads the
  `charged` / `shipped` effect labels from the one-shot flag flips.
- **`invariants.svg`** — the must-nevers. The two safety predicates render green;
  L1 (cancellability) is a *reachability* property a state predicate cannot
  express, so it is declared with an honest `unchecked` status and renders muted
  — the figure claims exactly what was checked, nothing more.
- **`counterexample.svg`** — the bug: `submit → ship → deliver()` reaching
  **S1 VIOLATED — delivered without payment**, with the "the gate generated this"
  callout. The trace was captured from a guard-deleted variant of `next.cjs`
  (the committed machine rejects `ship` before `charge` — that variant is
  illustrative, not committed). Remove `bug.ndjson` + `findings.json` and this
  diagram simply isn't produced — there's no bug to show.
- **`compat-gate.svg`** — the versioning bug: a live `SHIPPED` order (`#o3`) that
  v2's new risk-hold rule would have blocked → **DEPLOY BLOCKED**.
- **`model-card.svg`** — the state-machine and the invariants in one frame.

Add `--format svg,png` for 2× PNGs (needs the optional `@resvg/resvg-js`); the
`state-machine`/`model-card` graph needs the optional `elkjs`. The pure
viz-model → SVG path (invariants, counterexample, compat-gate) needs neither.

## The annotations file

The raw artifacts carry structure, not prose. `polyviz.annotations.json` supplies
the human-readable narrative — nicer invariant text, the version-card labels,
the violation title — merged over what the adapters extract. Delete it and the
figures still render, just with derived defaults (e.g. the invariant `text`
prettified from its `name`).

## Determinism

Rendering is a pure function `artifacts → SVG`: re-run and the bytes are
identical.

```
node ../../polyviz/bin/polyviz.mjs hash --in . --diagram all
```

prints a stable sha256 per figure — the property a report or PR can regenerate
and byte-compare.
