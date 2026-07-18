# polynv worked example — eliciting the OMS order machine's invariants

A REAL elicitation session, committed artifacts and all: the OMS order
machine (`examples/polyvers-oms/order-v1`) copied here **without** its
hand-written `invariants.mjs`, and the rules elicited from scratch through
the polynv interview — harvested candidates, frontier-model domain priors,
ten designer dispositions, and two mutation grades. Every answer in
[`order/intent-ledger.json`](order/intent-ledger.json) is a genuine
disposition by the machine's author (recorded 2026-07-18); the generated
[`order/invariants.mjs`](order/invariants.mjs) carries per-rule provenance,
and [`order/INTENT-LOG.md`](order/INTENT-LOG.md) is the rendered
transcript.

> Same disclosure as the engine: pre-checks are consistency checks over the
> declared finite domains; the grade bounds unconstrained behavior, it does
> not certify intent.

## How it went (reproduce with the commands in each step)

**1. Harvest** (`polynv harvest --artifacts order`) — 19 candidates from
the contract's own vocabulary, each pre-checked: 17 HOLDS, 2 arriving with
shortest counterexamples. The emission candidates got REAL verdicts
through the machine ∘ mapper composition (polyrun check-effects). One note:
the contract's `stale-completions-reject` rule is prose, not mechanically
templatable — "ask about it by hand" (it returns in step 5).

**2. Domain priors** (`polynv add … --source domain-prior`) — the
interviewing model contributed two payments norms as candidates:
authorization-before-capture ("a charge is only recorded from `charging`")
and terminal-failure-states-carry-a-reason. Both pre-checked HOLDS; both
later confirmed by the designer. Generation proposed; only the designer
accepted.

**3. The interview** — counterexample questions first. The top question
showed the concrete story *SUBMIT(2, $25.00) → items unavailable →
AMEND(1, $19.00)* and asked "the machine can lower the total today — is
that acceptable?" The designer said **yes**: both `monotone` candidates
were **rejected** with the reason recorded ("AMEND legitimately lowers the
total") — a deliberate answer the ledger keeps so it is never re-asked.
Then eight confirms: the five terminal states are frozen, `txId` is
set-once, blocked cancels mutate nothing, the type-bound templates, both
at-most-once emissions.

**4. First grade** (`polynv grade --max-mutants 200`) — the round-one set
kills **68/113** behaviorally distinct mutants. Compare the hand-written
battle-tested set: 101/113. The 45 survivors became ledger questions, and
they said precisely what was missing: a **widen band** (completions
accepted in states that shouldn't accept them) and a **freeze band** (the
rollup counters' cross-field arithmetic).

**5. One rule closes a band** — the widen band is exactly the
stale-completions rule harvest had flagged for by-hand asking. The model
drafted the predicate, the designer confirmed it, and the regrade jumped
to **88/113**. That is the engine's core loop working: the grade measures,
the survivors become questions, one answer moves the measurement.

**6. Honestly PARTIAL** — the committed ledger is deliberately mid-flight:
20 confirmed, 2 rejected, 45 open (the survivor backlog for the next
session). The remaining gap to 101 is the freeze/rollup band, which needs
the cross-field rollup rules (`shipmentsDelivered + shipmentsFailed ≤
fulfillments` and friends) — next session's interview. The drop-family
survivors illustrate the grade's stated blind spot: behavior *removal* is
invisible to safety invariants. Note also that ~20 of the open survivor
questions were answered *implicitly* by step 5 (their mutants are now
killed) — re-running `grade` never re-proposes them, and a future session
would abandon them with that note.

## What the numbers say

| invariant set | kills (of 113 distinct mutants) |
|---|---|
| round-one interview (17 compiled rules) | 68 |
| + the stale-completions rule (18 rules) | **88** |
| the hand-written set (9 rules, years of thought) | 101 |
| the remaining gap | the cross-field rollup rules — still open questions |

Fewer, sharper rules beat many shallow ones: the redundancy cluster in the
grade output shows five of the elicited type-bound rules share one kill
profile — the mutation set cannot tell them apart. The hand-written set's
edge is entirely in cross-field implications, which is exactly what the
plan says templates cannot reach and the dialog exists for.

## Try it yourself

```bash
node polynv/bin/polynv.mjs questions --artifacts examples/polynv-oms/order --next   # the top open survivor question
node polynv/bin/polynv.mjs grade     --artifacts examples/polynv-oms/order --max-mutants 200
node polynv/bin/polynv.mjs report    --artifacts examples/polynv-oms/order
node polynv/bin/polynv.mjs drift     --artifacts examples/polynv-oms/order          # nothing moved: exit 0
```

Answer a survivor (supply the rule and its shape, then confirm):

```bash
node polynv/bin/polynv.mjs record --artifacts examples/polynv-oms/order \
  --id 'mutation-survivor:freeze:shipmentsDelivered' --disposition modify --author you \
  --target transition --js "(pre, a, d, post) => a !== 'SHIPMENT_COMPLETED' || pre.orderState !== 'fulfilling' || post.shipmentsDelivered + post.shipmentsFailed === pre.shipmentsDelivered + pre.shipmentsFailed + 1"
```
