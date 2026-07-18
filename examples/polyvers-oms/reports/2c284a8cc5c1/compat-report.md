# polyvers compat-report — change 2c284a8cc5c1

old version `ea94f8be5cf5` → new version `567141e63b32`

**Lanes:** shape, migration, intent, semantic
**Corpus:** 33 snapshot(s), source: synthesized (BFS-reachable states of the OLD machine — the weakest tier; prefer live or archived snapshots) — migrated through the new version's migrate.cjs before the downstream gates

| gate | verdict | summary |
|---|---|---|
| load | PASS | module surface, validate(), contract/manifest cross-checks |
| invariant-diff | PASS | strengthened: state:amend-count-nonnegative |
| migrate | PASS | migrate.cjs validated over 33 snapshot(s) (pure, accepted, projection-equal, state+transition invariants hold) — against this corpus tier; polyrun migrate's live dry run remains the apply-time gate |
| shape-roundtrip | PASS | setState round-trip over 33 snapshot(s) |
| invariants-pointwise | PASS | 4 state invariant(s) × 33 snapshot(s) = 132 checks (6 transition invariant(s) need transitions, not snapshots — checked by the M1 model-check gate) |
| semantic-model-check | PASS | exhaustive check from 33 fleet snapshot(s) + init, 7 state(s) discovered; one witness per violated rule — not an affected-instance list |

## Shape diff
- state keys added: amendCount

## Intent diff
- invariants added: state:amend-count-nonnegative

## Verdict: PASS
