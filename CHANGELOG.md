# Changelog

Notable changes to Polygraph and polygen. Versions before 2.0.0 are
summarized from the git history; see `git log` for the full record.

## 6.2.0 — 2026-07-23

**A named rule is not an instruction to reject (n8n field study, M8).**
The fifth field target (`eval/FINDING-n8n-reject-no-write.md`, no defect in
n8n) reproduced the pure-reject trap 5/5 even after 6.1.0's prompt wording
fix, and isolated the real trigger: generations reject every branch that
maps to a **named** `specialRules` entry — because the template and
renderer literally commanded it ("REQUIRED reject(reason) cases" / "the
acceptor MUST call reject('name')") for every rule, including rules naming
behavioral branches.

- `renderSpecialRulesAsRejections(contract, windows)` now **classifies each
  rule against the captured corpus**: matching windows all no-op →
  `[REJECTION — must reject]`; matching windows change state →
  `[BEHAVIORAL — must perform the transition, MUST NOT reject; the name is
  only the why]`; unexercised → decide from the source. The template
  teaches the observable-change decision test; polygen's no-corpus
  authoring path keeps the must-reject reading.
- **Auto-regeneration**: when the first generation pass hits the
  reject-as-annotation signature uniformly (every live spec rejected ≥2
  windows the code acted on), verify regenerates once with the offending
  (pre-state, action) windows called out and reports the second pass —
  both spec sets kept (`specs/`, `specs_regen/`), `--no-auto-regen` opts
  out, findings.md names both passes.

## 6.1.0 — 2026-07-23

**sam-pattern 2.2.0 — both field-study traps fixed at the library layer.**
The two upstream issues drafted from the July 2026 field studies
(`eval/FINDING-xstate-union-schema.md`,
`eval/FINDING-hatchet-reject-annotation.md`) landed as sam-lib #35 and #36
and shipped in 2.2.0; the vendored engine and npm dep move up together.

- **Union types (#35):** `type` accepts an array
  (`{ type: ['string', 'object'] }`) in modelShape and payload schemas.
  `renderModelShape` now emits the real arm list for detected union keys —
  shape checking stays live on every arm — replacing the interim untyped
  `{}` escape; the v2 and polygen prompts forbid collapsing the array.
- **Reject-after-write hard-fail (#36):** a same-acceptor `next.*` write
  followed by `reject()` throws `SamFrameError` naming the discarded keys
  (a different acceptor's veto stays legal). The reject-as-annotation trap
  now fails loudly at step time; verify's trace-signature detection
  (`rejectedActedWindows`) remains as the fallback for pure-reject variants
  and specs run against older libraries. Breaking only for modules that
  were already silently losing writes.
- findings.md gains a **"Spec runtime errors on failing windows"** section:
  distinct per-window spec errors (e.g. the #36 SamFrameError) surface in
  the report instead of dying in replay detail as anonymous fails.

Also in this release (the verify-enhancements plan, M1–M7, all
adversarially reviewed): frozen-state-key warnings with `--initial-states`
plumbed through verify; runaway-exploration drift detection + progress
heartbeat; spec-vs-spec agreement reporting (pairwise %, outliers, split
column); the scripted negative control `scripts/mutate.mjs`; the skill's
real-traces prerequisite and capture guidance; union-key rendering from
trace evidence; and the reject-as-annotation detection above. Field-study
reports: `eval/FINDING-raft-field-study.md` and the two above — no defects
found in hashicorp/raft, xstate, or hatchet.

## 6.0.0 — 2026-07-22

**The strict-profile artifact moves to sam-pattern 2.1.2 — explicit
next-state (prime) semantics.** sam-lib 2.1 ("#25" — the design's working
name, used in the library's own error messages; tracked as sam-lib issue
#34) makes strict acceptors
TLA+-style next-state relations: `model` is the frozen pre-state, writes go
to the `next` draft, and every declared variable is assigned or named
`unchanged(...)` per accepted step — statement order can no longer change a
transition's meaning, and `manifest().acceptors.frames` exposes each
acceptor's prime/frame sets. This is **breaking for strict-profile modules
that declare a `modelShape`** (the toolset's flagship artifact class):
2.0-form acceptors that write `model.x` now throw `SamShapeError`.

Coordinated upgrade across the toolset:

- **Vendored engine** (`scripts/vendor/sam-pattern.cjs`) bumped 2.0.0 →
  2.1.2; npm deps to `sam-pattern ^2.1.2` / `sam-fsm ^2.1.0`. Every engine
  loads target modules through `scripts/load-spec.mjs`, which pins to the
  vendored bundle — engine semantics and a user's installed library now
  agree again.
- **All tracked strict+shape machines migrated** to the `next`/`unchanged`
  form (~40 modules: polyvers/polyrun fixtures and demos, the OMS example
  family, fleet-study-stripe, oms-go references *and* their deliberately
  broken control mutants — defects preserved bit-for-bit — etcd-raft-v2,
  tier-3 pairs, embedded test mocks). LLM-generated archival outputs
  (results-generated specs, sysmobench gens) are historical run records and
  were left in 2.0 form.
- **Prompts** (verify's spec template, polygen's author/repair prompts) now
  teach the next-state form: writes to `next`, pre-state reads, the frame
  rule, and the exact `instance({ initialState, component })` wiring idiom.
- **SAM→TLA transpiler** (`--tla`) accepts the 2.1 acceptor signature,
  treats `next.x =` as the primed assignment, and fails loud on 2.0-form
  writes.
- Validated end-to-end with real generation runs (opus-4.8): spec
  derivation replays 12/12 windows clean over 2.1-form specs; polygen
  authors, self-checks, and converges a 2.1-form module.

Known nuance: under 2.1 an intent no acceptor constrains **throws**
(`SamFrameError`, `unhandledIntent`) instead of warning, and async acceptors
on a non-synchronized instance throw (2.1.2) instead of silently losing
post-`await` writes. On that last class: the pre-2.1 form of the hazard (an
async acceptor's late write landing in the live model) also existed in
2.0.0, but no Polygraph artifact, prompt, or fixture has ever used an async
acceptor (`hasAsyncActions: false` + synchronous acceptors are doctrine), so
results produced under the 2.0.0 engine are unaffected.

## 5.0.0 — 2026-07-19

No new engine: **polyvers gains an evidence base**. The compatibility
mechanism was previously argued for; it is now measured, in a
pre-registered three-tier fleet study (`docs/fleet-study-plan.md`,
`eval/fleet-study`, `examples/fleet-study-stripe`), and replicated against
an external benchmark (`docs/tier3-protocol.md`, `eval/sysmobench`). The
headline result is that **corpus provenance is decisive**: four incompatible
changes run against corpora differing only in where the states came from
give 4/4 caught from archived (real-provenance) states and 3/4 from
synthesized BFS-reachable ones, no false positives on either tier. The
escapee is the landmine the design exists for — a state the old version
could reach, that production therefore holds, and that the new version
forbids — and a synthesized corpus cannot contain it by construction, since
it holds only states the old *model* says are reachable. Same tool, same
change, same gates; the verdict turns on provenance alone. A dunning-budget
narrowing separately explores 19 states clean from `init()` and fails when
seeded from the fleet: a machine can be internally consistent and still
unsafe to deploy. Affected population is stated per finding (one snapshot),
because class of defect and blast radius are different claims.

The external replication finds that **conformance and exploration fail in
different directions**, and neither subsumes the other. On SysMoBench's etcd
Raft task, over real traces from a real 3-node cluster via the tracing hook
upstream in `etcd-io/raft`: replay catches 2/8 injected defects and 4/5
one-shot generated specs; the explorer with invariants catches 1/8
definitive (6/8 inconclusive) and 0/5. Replay misses defensive code a
correct system never drives, including the heartbeat clamp this project's
own prior work singles out; the explorer misses anything the stated
invariants omit. A specification graded by either alone gets a clean bill it
has not earned. Two Medusa version pairs replayed under a freeze protocol
(the old-version model committed before the new version's diff is read)
make the same point about release notes: `v2.4.0 → v2.5.0` and
`v2.17.1 → v2.17.2` summarize interchangeably as "enum gains members" and
behave oppositely — 6 of 32 states stranded versus 0 — because the first
changed a status *derivation* and the second changed nothing but a domain.

Reported against itself: a **projection-bound miss** (a zero-amount payment
collection reads unpaid under one version and completed under the next; the
declared money abstraction collapses at zero, so the case is inexpressible —
out-of-projection, with the bound declared before the analysis); a
**self-inflicted false positive** (reworded type-description prose
manufactured a shape diff — operator error, reported rather than quietly
fixed); two measurement bugs caught by control rows deliberately scored on
identical terms; and a corrected claim in the paper — finite action domains
do not imply a finite state space, since exhaustiveness requires a finite
*reachable* state space, which a contract is not currently required to
declare. Commit `f6743a7`'s title reports "the explorer catches 8/8"; that
figure is **wrong** — a regex matching the word "violations" inside `no
invariant violations reachable` — and was corrected in `59345b6`. The
figures above are authoritative.

Also in this release: two polyvers defects the study found and fixed (the
migrate gate conflating structural with invariant failures, the semantic
gate understating its own coverage); `polyrun simulate`
(`polyrun/src/simulate.mjs`); the joint product check
(`polyvers/src/product.mjs`, `polyrun/src/check-product.mjs`, with a
narrowed cancel window that passes the pairwise matrix and fails the joint
product); engine READMEs rewritten as introductions; and the SDLC and
five-engine diagrams. Bounded results are not passes — enforced in code
throughout, not assumed.

## 4.0.0 — 2026-07-18

New engine: **polynv**, invariant elicitation — the fifth engine (Polygraph
audits, polygen authors, polyrun executes, polyvers evolves, polynv
**elicits**). Every other engine's guarantee is exactly as good as
`invariants.mjs`; polynv attacks where that file comes from, converting the
scarce skill (writing predicates from a blank page) into a common one
(judging concrete stories). `polynv harvest` generates pre-checked
candidates from the contract's own vocabulary (terminal-absorbing, ranges,
set-once, reject-in-state, at-most-once emissions — the last verdicted
through the machine ∘ mapper composition via check-effects), Daikon-style
state-property miners over traces/snapshots and precedence miners over
ordered event streams (statistical confidence thresholds; below-threshold
observations become notes, never questions), and frontier-model domain
priors (key-free in-session; `--llm` headless). Every candidate arrives at
the interview as "holds everywhere — rule or coincidence?" or as a shortest
counterexample: "the machine can do this today — acceptable?". Dispositions
(confirm / reject / modify / defer, always attributed) live in an
append-only `intent-ledger.json` — the multi-person system of record that
keeps every answer, including rejections, forever. `polynv grade` measures
invariant-set strength by mutation: four operator families, behaviorally
equivalent mutants discarded by graph comparison (the finite-domain
restriction making the field's classic undecidable subproblem mechanical),
kill-profile redundancy clustering, and survivors becoming the next
questions. `polynv drift` re-checks every recorded answer when the machine
changes. polyvers consumes the ledger both ways: the compat-report's
invariant-adequacy trust tier (measured / STALE / UNREADABLE / NOT
MEASURED) and intent-diff provenance annotations. Convergence requires the
grade; a grade that measured nothing is refused. Plugin surfaces:
`/polygraph:polynv` command, skill, and subagent (which prepares the
interview but never answers intent questions). Design plan with literature
anchors (Daikon mines, L* asks, van Lamsweerde generalizes, SpecFuzzer
gates): `docs/polynv-plan.md`. Worked example with a genuine designer
session — 68/113 mutants killed by round one, 88/113 after one
survivor-closing rule, vs 101/113 for the years-old hand-written set:
`examples/polynv-oms/`. Three adversarial multi-agent reviews (M0–M2, M3,
completion), all confirmed findings fixed; `npm run test:polynv` (47
tests).

Also in this release: a repo-wide precision pass on the scope claims —
"exhaustive" always means exhaustive over the finite (action, data) domains
the contract declares, stated in every disclosure, with the
declared-domain-vs-real-data abstraction gap named as unmeasured;
`check.mjs` gained an explicit `steps` domain override; and the composition
checker landed CP-M0..M2 (product semantics, the parent×child joint-state
checker, contract-derived child abstraction walks — `polyrun
check-product`).

## 3.0.0 — 2026-07-17

New engine: **polyvers**, versioning for state machines with mechanical
compatibility gates — the fourth engine (Polygraph audits, polygen authors,
polyrun executes, polyvers **evolves**). It makes `docs/VERSIONING.md`
executable: given two versions of a machine's artifact family and fleet
snapshots, `polyvers classify` fires the compatibility lanes the change
touches (shape / vocabulary / intent / semantic / migration / composition)
and `polyvers check` runs exactly the gates those lanes demand — setState
round-trip, cross-version stimuli replay (everything the old version can
still deliver must land as accepted or a NAMED observable reject,
kernel-parity classification), migration validation (`polyvers migrate
scaffold` generates migrate.cjs from the shape diff; the gate checks purity,
acceptance, projection equality, and state+transition invariants, then
swaps the corpus so every downstream gate runs over post-migration states),
and the headline: an exhaustive model check **seeded from live fleet
snapshots** (`check.mjs --initial-states`) asking whether any state the
fleet actually holds can be DRIVEN to an invariant violation under the new
rules — the v1-reachable/v3-unreachable landmine hunt, mechanized, with a
fixture proving only the seeded check catches it. `polyvers matrix` checks
parent×child rollout-window pairings over the spawn/completion protocol and
its delivery. Deterministic byte-identical compat-reports, refusals instead
of vacuous passes (empty corpus, missing invariants, BOUNDED exploration
without --allow-bounded), no API key anywhere. Plugin surfaces:
`/polygraph:polyvers` command, skill, and subagent. Worked example:
`examples/polyvers-oms` versions the OMS order machine (shape+rules+intent
change, scaffolded migration, committed compat-report and matrix report).
Docs: the four-engine architecture (two verification gates between
authoring and execution — correctness and compatibility — with execution
feeding both back), an updated diagram set (reworked fig 1, new fig 5), the
SDLC's Phase 7 mechanized, and a literature-context section in the
versioning essay. Every milestone (M0–M3) shipped with an adversarial
multi-agent review; all confirmed findings fixed. 62 polyvers tests; the
shared checker gained `initialStates` with seed-exempt exploration caps.

Major-version note: `scripts/check.mjs`'s result shape changed
(`statesExplored` now counts discovered states only, with `seededStates`
reported separately), and the polyvers artifact-dir convention reserves
`migrate.cjs`/`effects.cjs` as sibling artifacts a machine module may not
be named after.

## 2.1.0 — 2026-07-17

New component: **polyrun**, a durable execution harness for polygen-verified
SAM v2 strict-profile machines — spec in `docs/polyrun-spec.md`, code under
`polyrun/`. Snapshot-based durability (no event-sourced replay, no
determinism constraints), transactional outbox with idempotency keys and
leases, durable timers whose staleness is resolved by verified
`reject(reason)`, SQLite and Postgres adapters, standalone worker, HTTP
facade + read-only UI, and a CLI (deploy gate, effect-emission checker over
the machine ∘ mapper composition, journal-replay audit, migrate, archive,
DLQ). First-class parent/child machines and post-commit journal fan-out.
The production journal doubles as a Polygraph trace corpus. Every milestone
(M0–M3) shipped with an adversarial multi-agent review; all confirmed
findings fixed. 60 tests green on both stores; the kill -9 mid-charge demo
(`npm run demo:polyrun`) recovers with exactly one charge — on both the
hand-written and the polygen-authored order machine.

Two capstone examples: `examples/polyrun-oms` reimplements Temporal's OMS
reference app on polyrun (multi-fulfillment orders, shipment children,
rollup, storefront — every machine polygen-authored), and
`examples/polygraph-oms-go` AUDITS the reference app's actual Go source:
real-execution traces via Temporal's own testsuite, positive/negative
controls, three independent LLM specs replaying 27/27, and a unanimous
model-check verdict — two intent findings with shortest counterexamples
(an all-unavailable amended order completes with nothing fulfilled or
charged; partial failure reports as plain success).

## 2.0.1 — 2026-07-15

Hardening release: a full code review of the 2.0.0 pipeline (four review
passes over the engines, audit pipeline, polygen, and the TLA tier, followed
by an adversarial review of the fixes themselves) surfaced and closed every
finding. The unifying theme: **no silent-clean paths** — a run that verified
nothing, or less than it appears to, must never present as a pass.

### Fixed — audit pipeline (`verify`)

- A trace directory with zero windows now fails loudly instead of reporting
  "All windows consistent" (the specs side already had this guard; the traces
  side did not). `validate_corpus` likewise treats a zero-window corpus as a
  hard problem.
- `classify()`'s strongest verdict (`code-finding-or-contract`, "every spec
  disagrees with the trace") now requires every live spec to have actually
  failed; fail+unscoreable mixes classify as the weaker `spec-error`.
- `--specs` is now mutually exclusive with `--model`/`--source` — stale saved
  specs can no longer silently masquerade as a fresh generation.
- CLI arg parsing hardened across `verify`, `polygen`, and `generate`: a value
  flag followed by another flag is a usage error instead of silently becoming
  `1` (`--n --tla` used to gut the N-way vote down to a single spec); numeric
  flags are validated.
- The TLC section no longer prints a "PASS" banner when zero invariants were
  translated — it says explicitly that the run explored only and checked
  nothing.

### Fixed — core engines

- `sam-adapter`'s `next()` resets the instance via `init()` before merging the
  snapshot. The library's `setState` is merge-only, so hidden state leaked
  between transitions and BFS node identity depended on traversal order —
  states could be wrongly merged or missed, and a reachable violation could go
  unreported. Replay (`sam-tv`) and exploration now share one reset semantics.
- A rejection that **observably mutates** the model first is now a recorded
  violation instead of being explored as a legal no-op (the checker and
  replayer used to contradict each other on such specs). Internal-key
  mutations before a reject (reason logging) remain legal.
- `check()` fails loudly on an empty exploration domain (an empty intent
  registry used to explore one state and exit 0 clean), calls the module's own
  `validate()`, and notes any contract action missing from the manifest.
- `stable()` — the pipeline-wide state-equality definition — no longer
  conflates `undefined` and `NaN` with `null`: a spec that drops a field or
  computes `NaN` no longer passes against a trace `null`. (This can flip
  stored verdicts for legacy specs that relied on `undefined ≡ null`.)
- Both replayers refuse empty or non-object `postState` windows as
  unscoreable (the projection rule passed them vacuously), and
  `validate_corpus` validates window shape: malformed windows are reported
  problems, the control-state key must be present in every window, and a
  declared key that never appears anywhere in the corpus is flagged.
- Replayer child processes get a corpus-size-scaled timeout
  (`POLYGRAPH_REPLAY_TIMEOUT_MS` overrides the base) mapped to unscoreable —
  a spec with a stray `setInterval` can no longer hang the pipeline — and the
  stdout protocol line is shape-checked so stray spec output can't masquerade
  as a verdict.
- `generate` fails a `stop_reason: max_tokens` response even when partial text
  came back (a truncated spec can be loadable but incomplete), and the CLI
  exits non-zero when zero specs were written.

### Fixed — polygen

- The strict `validate()` gate had an escape hatch: in non-strict mode the
  library *returns* problems instead of throwing, and the return value was
  discarded — a module that disobeyed `strict: true` passed the gate with no
  intents, schemas, or domains. The returned problems array now fails the
  gate (and `check()` applies the same rule).
- A conformance repair (the post-replay rewrite) is now **re-model-checked**
  and re-cross-checked before the report renders: a repair that reintroduces a
  violation flips the run to NOT converged instead of shipping under the
  pre-rewrite verdict.
- Exploration-coverage notes (an intent with no usable manifest domain, a
  contract action absent from the manifest) now spend repair budget through
  the domain-gap repair prompt and block convergence — a partially-explored
  machine no longer presents as checked, and no longer burns the whole run
  without a repair attempt either.
- An invariants module with no recognized exports is refused (the model check
  would have passed vacuously); `default` exports are unwrapped.
- The domain-ref cross-check token-matches numeric/boolean values instead of
  substring matching (`3` no longer "found" inside `13`; booleans documented
  as a weak signal).
- Corpus hygiene: `tracesDir` is cleaned before each synthesis (stale windows
  from a previous round or run no longer pollute validation/replay),
  model-chosen scenario names are sanitized for file paths, and name
  collisions can no longer overwrite another scenario's trace file.
- The CLI exit code reflects **every** unclean signal — replay failures,
  replayer protocol errors, corpus drive/validation problems — not just
  non-convergence.

### Fixed — TLA tier (`--tla`)

- Creation-shaped commits (`{ ...sv, [k]: rec }` where `k` may be a new key)
  now emit a `DOMAIN`-membership-guarded update. TLA+ `EXCEPT` on a missing
  key is a silent stutter, so reachable JS states vanished from the model —
  a false TLC pass. Provably in-domain commits keep the plain `EXCEPT`.
- `typeof x === …` / `x !== undefined` folds on conditionally-initialized
  `let`s now consult the definedness condition instead of folding to a
  constant (the old fold could make an acceptor an unconditional early return
  or fire guarded writes on paths where JS wrote nothing).
- Refused loudly instead of mistranslated: string literals with embedded
  quotes, compound string arithmetic (`+=` on a string field), node aliases
  bound after a mutation/commit (pre-state reads in TLA+, post-state in JS),
  and alias bindings leaking out of their branch scope.
- TLC output parsing: comma-grouped state counts parse in full, and a
  violation printed before a timeout reports as the violation, not buried as
  `timeout`.

### Fixed — instrumentation

- `withSamTracing` / `withTracing` / `tapReducer` deep-snapshot the projection
  at capture time: in-place mutation (the norm in SAM v1 acceptors) rewrote
  the captured `pre` before serialization, making every window read
  `pre == post` for object/array-valued observable keys — a corrupted corpus
  that validated clean.
- The v2 emitter advances its pre/post chain before emitting and warns on a
  dropped window, so a failed emit can no longer silently record a two-step
  transition as one.

### Tests

- Self-test coverage grew from 149 to 202 checks across five suites, adding
  `test/selftest-polygen.mjs` (full polygen orchestration against a scripted
  model stub, including the conformance-repair re-check) and
  `test/selftest-tla.mjs` (transpiler output-shape regression tests). The
  seeded-bug eval still detects 5/5 by model checking with the 0/5 replay
  baseline.

### Docs

- README rewritten for developers new to formal verification: why/effort
  first, a per-command API-key table, the 1.x bare-next material folded into a
  footnote, and a reference to Emilie Ma's Berlin Buzzwords talk
  (SysMoBench / Specula) as convergent evidence for the approach.

## 2.0.0 — 2026-07

- The default derived artifact moves from the bare `next()` contract to the
  **SAM v2 strict profile** (`@cognitive-fab/sam-pattern` 2.0.0): named
  intents with per-intent schemas and finite payload domains, acceptors keyed
  by intent name, observable `reject(reason)`, sealed model.
- Replay windows carry step classifications (`rejected` /
  `identity-by-mutation` / `unhandled`); model checking reads exploration
  domains from the module's own `manifest()` and runs a determinism
  double-pass on every check.
- Optional `--tla` tier: mechanical transpilation of the winning spec to TLA+,
  checked by TLC when a Java toolchain is available.
- `--legacy-bare-next` preserves the 1.x pipeline end-to-end for one release.

## Earlier (0.x highlights)

- **0.5.x** — polygen: author NEW verifiable code from a feature description,
  self-repaired against reachable invariant violations; domain-mismatch
  cross-check.
- **0.2.x** — the explicit-state model checker (the bug-finding half),
  seeded-divergence eval suite, and the first no-silent-clean-paths hardening
  pass.
- **0.1.x** — trace-driven replay of LLM-derived bare-next specs (the
  conformance half), turnstile worked example, controls methodology.
