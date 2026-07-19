# Tier 3 · Medusa — candidate selection, and what the record actually contains

> ## ⚠ CORRECTION — this document's central prediction was WRONG
>
> Written before either pair ran. It concluded that both usable pairs were pure
> widenings, and therefore that **"this tier CANNOT measure recall"** and that
> **"no TP and no MISS is possible here."**
>
> Both halves are false. **Pair A was not a widening** — `v2.5.0` changed the
> status *derivation*, stranding 6 of 32 fleet states — and the study did find a
> real miss (zero-amount collections, out-of-projection). See
> [`README.md`](README.md) for the corrected result.
>
> The text below is left exactly as committed, per tier3-protocol §2's amendment
> rule. A failed pre-run prediction is a result, not an embarrassment to tidy
> away: it is precisely the mistake a practitioner makes when classifying a
> release from its notes, made here by the person who then had to check.
>
> What survives verified and unchanged: Medusa's `OrderStatus` and
> `FulfillmentStatus` never changed across the v1 line or across v2.0.0 → HEAD,
> and no released pair narrows a state domain.

FS-M4, selection phase. Per [`tier3-protocol.md`](../../../docs/tier3-protocol.md)
§4, candidate pairs are chosen on the **maintainer record alone**, before any
pair is run, and a negative Tier 3 is published either way. This file is that
record. It is written before any translation exists.

## The headline, before any pair is run

**Medusa's released version history contains no narrowing of an order,
fulfillment, or payment state domain.** Every state-machine change that can be
verified in the v2 line is a *widening* — a status gains members, nothing is
removed or renamed.

That fact was not anticipated by plan §6, and it changes what this tier can
measure. It is reported first because it is the most consequential thing the
selection phase found, and because discovering it *after* building three
translations would have been an expensive way to learn it.

## What was verified

### Order and fulfillment status: unchanged

- **v1 line** — `OrderStatus`, `FulfillmentStatus`, `PaymentStatus` are defined
  together in `packages/medusa/src/models/order.ts` and are byte-identical from
  `v1.18.0` through `v1.20.11` (the last v1 tag).
- **v2 line** — `OrderStatus`, `PaymentStatus`, `FulfillmentStatus` in
  `packages/modules/order/src/schema/index.ts` are byte-identical from `v2.0.0`
  to HEAD.

The state machines plan §6 named as the target **never changed in a released
version pair**. All verified churn is in the payment-collection and
payment-session status space.

### Pair A — v2.4.0 → v2.5.0 · `PaymentCollectionStatus` gains `failed`, `completed`

Verified directly, both sides:

- `packages/core/types/src/payment/common.ts` at `refs/tags/v2.4.0` declares
  exactly `not_paid | awaiting | authorized | partially_authorized | canceled`
  — five members, no `failed`, no `completed`.
- The migration `packages/modules/payment/src/migrations/Migration20250207132723.ts`
  is a CHECK-constraint widening and nothing else:

  ```sql
  up():   check("status" in ('not_paid','awaiting','authorized','partially_authorized','canceled','failed','completed'))
  down(): check("status" in ('not_paid','awaiting','authorized','partially_authorized','canceled'))
  ```

- Maintainer's own account, PR #11356 (`702d338`): *the payment collection is
  marked completed once the captured amount is the full amount, and failures
  are handled by setting the session status to failed.*

**No row is touched.** The migration widens what the database will accept; every
state a live fleet holds remains legal. This is an addition, not a break.

### Pair B — v2.17.1 → v2.17.2 · `PaymentSessionStatus` gains `pending_authorization`

- `PaymentSessionStatus` at `v2.4.0` is
  `authorized | captured | pending | requires_more | error | canceled` — no
  `pending_authorization`.
- PR #15085 (`b50a9db`, merged 2026-06-29) introduces it for deferred payment
  methods (bank transfers, vouchers), and states explicitly: *providers that do
  not implement the new status keep the previous synchronous behaviour.* That
  is a maintainer asserting backward compatibility in the same breath as the
  change.
- Cited in the `v2.17.2` release notes under "Async Payment Methods Support".

Also a pure addition.

### Pair C — `partially_captured` · REJECTED as ground truth

A migration exists (`Migration20250625084134.ts`) but the release pair could not
be pinned: bisection places the type change somewhere after `v2.6.0` and at or
before `v2.8.1`, while the migration's filename timestamp (2025-06-25) is
*later* than `v2.8.1`'s release (2025-05-15). MikroORM migration filenames are
stamped at authoring time on a branch, so the two need not agree — but an
unresolved discrepancy is not ground truth. **Not used.** Re-bisecting
`payment/common.ts` across `v2.6.0 → v2.6.1 → v2.7.0 → v2.7.1 → v2.8.0 →
v2.8.1` would settle it.

### Upgrade-breakage issues: none found

Plan §6 lists two independent ground-truth sources — a shipped migration, or an
issue reporting upgrade breakage matching a finding. **The second source is
empty.** Searches for constraint-violation and enum-migration failures tied to
these fields returned nothing that names them as a cause. The nearest report,
issue #13301 (duplicate Stripe `/capture` calls around payment-collection
completion, v2.9.0), does not attribute itself to the status change and is
**not** counted as corroboration.

This matters: it removes the corroborating source, leaving the migration record
alone as ground truth for this tier.

## What this tier can and cannot measure

**Cannot: recall.** Scoring a TP requires an incompatibility for the tool to
catch. Both usable pairs are widenings, so there is no incompatibility to
detect, and consequently no TP and no MISS is *possible* here. A recall number
cannot come from Medusa's released history. Anyone wanting one must find a
project that shipped a narrowing, or accept that recall evidence stays
synthetic (Tier 1).

**Can: precision on real-world changes.** The expected result on both pairs is
that `polyvers` reports them compatible. That yields a false-positive rate over
changes that real maintainers actually shipped — which is the practitioner's
question ("will this cry wolf on my normal releases?") and is one half of the
reviewer's "hit/false-positive numbers" ask. It is a real number and it is
externally grounded, but it must be labelled as precision, never as recall.

**Can: an observation about practice.** Across two major versions of a mature
commerce backend, the dangerous change class — narrowing a state domain under a
live fleet — **does not appear in a single release**. The state machines are
either stable or grown. That is consistent with narrowings being known-expensive
and avoided rather than being safe, and it is worth stating carefully: it is
evidence about what maintainers *do*, not proof of what is *safe*. Drawing
"therefore the problem is rare" from it would be exactly the overclaim this
study is trying not to make.

## Honest limits of this selection

- **N = 2** verified pairs, one project, one subsystem (payments).
- **Zero TPs by construction**, so the tier demonstrates that the tool does not
  cry wolf — not that it barks. A reviewer is entitled to say so.
- **One ground-truth source**, the migration record, with no issue corroboration.
- The `v1 → v2` boundary is a full rewrite (`v1.20.11` → `v2.0.0`) and is not a
  usable pair; it is excluded, not scored.
