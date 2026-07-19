# Tier 3 · Pair B — Medusa v2.17.1 → v2.17.2

Run under [`tier3-protocol.md`](../../../../docs/tier3-protocol.md).
Version-N translation frozen at `a305507` before v2.17.2's source was read.

**Verdict: PASS.** All eight gates green over a 12-state fleet corpus.

## What the change is

PR #15085 adds `pending_authorization` to `PaymentSessionStatus`, for deferred
payment methods — bank transfers, payment links, vouchers — where an order
should be creatable before authorization completes.

**Unlike Pair A, this really is a pure widening**, and the decisive evidence is
what the commit does *not* touch:
`packages/modules/payment/src/services/payment-module.ts` **is not in the change
commit's file list at all.** Every status write path is byte-identical to
v2.17.1. The new member is one more value providers may report, into paths that
already wrote provider values verbatim.

The new behaviour lives *above* the module, in core-flows:
`authorizePaymentSessionStep` gained an early `return new StepResponse(null)` on
the new status, `validateCartPaymentsStep` added it to the statuses it
processes, and a new `authorizePaymentSessionForOrderWorkflow` guards
`status !== PENDING_AUTHORIZATION` with a throw. Those are consumers of the
session machine, outside the scope version N was frozen at, and are noted rather
than modelled — changing scope mid-pair would make the comparison meaningless.

## The migration shipped *ahead* of the feature

`Migration20260411223700.ts` widens `payment_session_status_check` to exactly
the seven members. It shipped **2026-04**; the feature commit landed
**2026-06**. The database was taught to accept the value roughly two months
before any code could emit it.

For a widening that is the correct order, and it closes the window Pair B would
otherwise have had: no deployment exists in which a provider could report
`pending_authorization` into a database that would reject it.

## A serious finding I nearly reported, and why it was wrong

Working from the change commit alone, the evidence looked damning. The enum
gained a member; `payment-module.ts` was untouched, so provider values are
written verbatim with no validation; **no migration appeared in the commit**;
and the ORM schema snapshot at v2.17.2 confirmed it:

```
payment_collection.status  enum items: [... 8 members, current ...]
payment_session.status     enum items: ["authorized","captured","pending",
                                        "requires_more","error","canceled"]
```

Six members. No `pending_authorization`. That reads as an enum widened without
its constraint — a provider emitting the new status would hit a CHECK violation
on write.

**It is not true.** Reading the actual migration DDL rather than the ORM's
metadata settled it: `Migration20260411223700.ts` widens the constraint
correctly, and it predates the feature. What is stale is
`.snapshot-medusa-payment.json`, which does not reflect its own applied
migration — a minor upstream inconsistency (the next `migration:create` would
try to re-add the change), and **not** the data-integrity bug the narrative was
pointing at.

Recorded because it is the exact failure mode this study is built to avoid: a
compelling story, apparently confirmed by a secondary source, killed by one more
verification step against the primary artifact. Had the snapshot been trusted,
Pair B would have reported a critical false finding against a real project.

## Cost

| | |
|---|---|
| corpus | 12 states, `provenance: upstream-model` |
| gates run | load, vocabulary, invariant-diff, migrate, shape-roundtrip, stimuli, invariants-pointwise, semantic-model-check |
| passed | all 8 |
| stimuli deliveries | 18 old-version stimuli × 12 snapshots = 216, every outcome accepted or a named reject |
| model check | 14 states = 11 seeded + 3 discovered |
| wall clock | seconds, local, deterministic |
| API cost | none |
| human cost | one mechanical edit to the frozen translation + one identity `migrate.cjs` |

The v2.17.2 module was derived from v2.17.1 by adding a single member to the
status domain — a `sed` with matching line counts, recorded in the commit. That
is the whole diff, because that is the whole change.

## Classification

**No finding to adjudicate.** The change is compatible, `polyvers` reports it
compatible, and the fleet's twelve states all remain legal. This is a
**true negative**: the contribution to the study is a data point on
*precision* — the tool did not cry wolf on a real, shipped, non-trivial release.

Pair A and Pair B together give the pattern worth reporting: identical-looking
selection notes ("the enum gains a member") that behaved oppositely once the
source was read. Pair A changed a derivation and stranded 6 of 32 states; Pair B
changed nothing but a domain and stranded none. **A study that had classified
either pair from its release notes would have got it wrong.**

## A tool defect this pair found

The semantic gate's summary understated its own coverage. It reported
`statesExplored`, which counts states discovered *beyond* the seeds, so this
pair's run read:

> `exhaustive check from 12 fleet snapshot(s) + init, 3 state(s) discovered`

Three states, from twelve seeds — which reads as a vacuous check, on the gate
whose entire purpose is exploring *from the fleet*. The seeded states **are** the
fleet, and therefore are the coverage. `check.mjs`'s own renderer had always
printed both numbers (`3 (+ 11 seeded)`); the polyvers summary dropped one.

Fixed in `polyvers/src/gates.mjs`; the same run now reads:

> `14 state(s) checked = 11 seeded from the fleet + 3 discovered from them`

Regression test in `polyvers/test/m0.test.mjs`. It deliberately does not assert
`seeded === corpus.length` — a snapshot equal to `init()` dedupes to the init
root, so seeded may be one less. My first version of the test asserted equality
and failed; the assertion was wrong, not the fix.

This was a reporting defect, not a coverage one: the check really did explore
all 14 states, and the PASS above was always sound. But a PASS an operator
cannot trust is worth little, and "3 states discovered" invited exactly the
wrong conclusion.
