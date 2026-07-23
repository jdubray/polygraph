# FINDING — union-typed state keys trap every generation (xstate field study, July 2026)

Third field target: statelyai/xstate's transition-resolution engine
(`transition()`/`initialTransition()`, published `xstate@5.32.5`), driven
through a hand-authored hierarchical statechart. Working tree:
`C:\Users\jjdub\code\osssm\polygraph-xstate` (full `REPORT.md` with the
isolation runs). **No defect in xstate** — hierarchical entry (always fresh,
no implicit history), guard evaluation, and root-level handlers all matched
the independent model on 33/33 real windows once the harness bugs below were
isolated.

The real finding is a **100%-reproducible bug class in polygraph itself**:

## The trap

A state key whose runtime type is a union — `string | {red: string}`, the
literal shape of xstate's `state.value` for any machine with nested states —
made **all 5 independent generations** declare `value: { type: 'string' }`
in `modelShape`. The v2 strict profile's shape checker validates single
runtime types only (`checkShapeWrite`, vendored sam-pattern 2.1.2), so every
spec threw at runtime the moment a transition assigned the object arm:
20/33 windows failed identically across all 5 specs. Patching ONLY that one
declaration to `{}` (the undocumented no-`type` escape) took the same spec
to 33/33 with zero other changes — the acceptor logic in every generation
was right; the schema line trapped them all.

**Root cause is in the tool, not the models**: `renderModelShape()` rendered
`value: { type: 'string' }` INTO the prompt (inferred from the initState
value `'green'`) and the template says "declare EXACTLY the observable
keys". The generations obeyed a wrong instruction; nothing anywhere told
them — or the renderer — how a union-typed key must be declared.

## Fix shipped (plan M6)

- `renderModelShape(contract, windows)` now detects union keys from THREE
  sources — real captured windows (a key observed as more than one runtime
  type across pre/post), the initState value, and a top-level-`|` parse of
  the stateKey type note that classifies each arm's runtime type
  (`'LOCKED' | 'UNLOCKED'` is one runtime type, string; `string | {…}` is
  two) — and renders `value: {},  // union — takes object | string at
  runtime; MUST stay untyped …` with the reason shipped into the prompt.
- `verify.mjs` threads the trace corpus into `buildPrompt`, so the strongest
  signal (what the machine actually does) wins even with no type note.
- `prompt_template_v2.txt` forbids tightening `{}` back to a single type,
  even when the initial state suggests one.

## Secondary lesson (operator error, worth the doc line)

`"lang": "typescript"` in the contract — set because the *target* is TS —
pushed 2 of 5 generations to emit real TS annotations into a file loaded as
plain CommonJS (instant syntax error). The spec artifact is ALWAYS JS/CJS
regardless of the target's language; `lang` describes the source being read,
and the fence choice follows it. Recorded here; the skill's contract step
should make that explicit if it recurs.

## Upstream

Real union support (`type: ['string', 'object']`) belongs in sam-pattern
itself — drafted in `docs/draft-upstream-issue-union-types.md`. Until then
the untyped-`{}` rendering is the correct contract-level behavior (it is
what the hand-written reference needed too), at the cost of no shape
checking at all on union keys.
