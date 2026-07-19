# Tier 3 · Pair A — Medusa v2.4.0 → v2.5.0

Run under [`tier3-protocol.md`](../../../../docs/tier3-protocol.md).
Version-N translation frozen at `0f34c26` before v2.5.0's source was read.

**Verdict: FAIL.** 6 of 32 fleet states violate v2.5.0's rules.

## What the change actually is

The selection phase recorded this pair as *"`PaymentCollectionStatus` gains
`failed` and `completed`"*, which reads like a pure widening. It is not.
`maybeUpdatePaymentCollection_` gained a new **final** clause that overrides
everything above it:

```ts
  if (MathBN.gt(authorizedAmount, 0)) {
    status = MathBN.gte(authorizedAmount, amount) ? AUTHORIZED : PARTIALLY_AUTHORIZED
  }
+ if (MathBN.eq(paymentCollection.amount, capturedAmount)) {
+   status = PaymentCollectionStatus.COMPLETED
+   completedAt = new Date()
+ }
```

**The derivation function changed, not just the domain.** A fully captured
collection is `completed` at v2.5.0 where v2.4.0 left it `authorized` — because
at v2.4.0 capture did not move the status at all.

The migration Medusa shipped (`Migration20250207132723.ts`) widens the CHECK
constraint and **touches no row**. There is no backfill anywhere in the repo at
v2.5.0. Existing rows keep the status they had.

## The finding

| snapshot | status | authorized | captured | refunded |
|---|---|---|---|---|
| `#7`  | `partially_authorized` | partial | **full** | none |
| `#10` | `authorized`           | full    | **full** | none |
| `#15` | `partially_authorized` | partial | **full** | partial |
| `#16` | `partially_authorized` | partial | **full** | full |
| `#21` | `authorized`           | full    | **full** | partial |
| `#22` | `authorized`           | full    | **full** | full |

Each violates `status-is-derived-or-canceled` and `fully-captured-is-completed`.
All six are fully captured, none is canceled, and under v2.5.0's own derivation
every one of them should read `completed`.

In plain terms: **an order settled before the upgrade and an identical order
settled after it end up with different statuses, permanently.** Nothing
recomputes the old row — `maybeUpdatePaymentCollection_` only runs on authorize,
capture, and refund, and a fully settled collection receives none of those
again. Any query for completed collections silently misses the pre-upgrade
population.

### The maintainers named this, in the commit that created it

PR #11356's own description, listing work still to do:

> *"We should convert the payment collection status and the different amounts to
> calculated fields from the payment session, captures, and refunds, **as they
> can easily be a source of inconsistencies.**"*

The inconsistency class the tool found from the fleet is the one the author
flagged in the same commit — and did not fix. That is independent corroboration
of the finding's reality, from the maintainers rather than from us.

## Classification — and why this is TI, not TP

Under §6's rule a **TP** requires that *"they shipped a migration for this
change"* and the finding names it. Medusa shipped a migration, but it is a
constraint widening that addresses nothing this finding is about. Scoring TP
would be stretching the pre-registered rule to flatter the result.

**Classified TI — true, and knowingly accepted.** The finding is correct; the
maintainers were aware of the inconsistency class and deferred it. That is
precisely what the TI bucket is for.

### The honest caveat this finding needs

`status-is-derived-or-canceled` asserts that the stored status equals what the
derivation would compute. **Medusa never checks this.** The code computes status
on write and never validates it at rest, so an un-rewritten old row is not
violating anything Medusa itself enforces — it is violating a consistency
property the system aspires to and never asserts.

So the defect is a **silent divergence**, not a crash, a rejected stimulus, or
undefined behaviour. Whether it bites depends on whether anything reads `status`
expecting derivation-consistency. The admin UI listing order payment status is
exactly such a reader, which is why we think it does bite — but that is an
argument, not something these gates measured.

What makes the finding non-circular is the freeze: the *form* of this invariant
("status is the derivation, or canceled") was written into the v2.4.0 file and
committed at `0f34c26` **before v2.5.0's source was read**. Only `derive()`
changed, mechanically, to transcribe the new function. The rule was not chosen
after seeing what it would catch.

## A false positive — self-inflicted, and reported anyway

The first run reported **four** retyped keys: `status`, `authorized`, `captured`,
`refunded`. Two of those were noise **I created**: I had reworded the prose in
the `type` descriptions of `authorized` and `refunded` without changing their
semantics, and polyvers diffs the whole type string.

Fixed by restoring byte-identical strings where the meaning was unchanged; the
run above reports `status, captured`.

Two lessons, and the first is about method rather than tooling:

- **A contract's `type` prose is part of its identity and must not be edited
  casually.** Documentation churn in a type field manufactures a shape diff and
  a spurious migration demand. This was my error, not the tool's, and it is
  recorded rather than quietly corrected because a study that only reports the
  tool's mistakes is not measuring honestly.
- `captured` is still flagged as *retyped* though its **domain is unchanged** —
  what changed is its role (it now drives the status). That is a real semantic
  change surfaced by the shape lane rather than the semantic lane: a **taxonomy
  imprecision, not a false alarm.** The user-visible cost is that it demands a
  migration for a change no data migration can address.

## Cost

| | |
|---|---|
| corpus | 32 states, `provenance: upstream-model` (see manifest) |
| gates run | load, invariant-diff, migrate, shape-roundtrip, invariants-pointwise, semantic-model-check |
| passed | load, invariant-diff, shape-roundtrip |
| failed | migrate, invariants-pointwise, semantic-model-check |
| distinct violating snapshots | 6 of 32 |
| wall clock | seconds, local, deterministic |
| API cost | none |
| human cost | authoring two translations + one identity `migrate.cjs` |

The `migrate.cjs` is the identity, because that is what Medusa shipped. Writing
anything else would have modelled a migration that does not exist and answered
a question nobody asked.

## Secondary finding — `failed` is dead vocabulary

`failed` is added to the union **and** to the widened CHECK constraint at
v2.5.0, but **no code path assigns it** (verified repo-wide at the tag; the PR
lists failure handling as future work, and `PaymentSessionStatus` did not gain a
`failed` member either).

polyvers did not flag this, and **that is not a miss** — a declared-but-unwritten
enum member is not a compatibility defect, and no gate claims to detect one. It
is recorded because it is true of the artifact and because it shows the shipped
domain widening was, in part, speculative.
