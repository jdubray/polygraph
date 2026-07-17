# Changelog

Notable changes to Polygraph and polygen. Versions before 2.0.0 are
summarized from the git history; see `git log` for the full record.

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
