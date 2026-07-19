# Tier 3 — archaeology against Medusa

FS-M4 of [`docs/fleet-study-plan.md`](../../../docs/fleet-study-plan.md), run
under [`docs/tier3-protocol.md`](../../../docs/tier3-protocol.md).

Two released version pairs of `medusajs/medusa`, replayed against a fleet, and
scored against the maintainers' own record.

## The version-pair matrix

| pair | change | selection note | what it actually was | verdict | fleet impact |
|---|---|---|---|---|---|
| **A** — `v2.4.0 → v2.5.0` | `PaymentCollectionStatus` gains `failed`, `completed` | "pure widening" | **derivation changed** — a new final clause maps fully-captured to `completed` | **FAIL** | **6 of 32** states stranded |
| **B** — `v2.17.1 → v2.17.2` | `PaymentSessionStatus` gains `pending_authorization` | "pure widening" | pure widening — `payment-module.ts` untouched | **PASS** | 0 of 12 |

**This table is the Tier 3 result.** The two selection notes are near-identical.
The outcomes are opposite. Nothing short of reading both diffs distinguished
them, and a study that classified either pair from its release notes or its
changelog would have been wrong in both directions — Pair A a false negative,
Pair B a false positive.

That is the case for mechanical checking stated as evidence rather than as
argument: the human-legible summary of a change is not a reliable predictor of
whether it strands a fleet.

## Ground-truth mapping

Required by plan §6: every finding linked to an upstream artifact.

| finding | pair | bucket | upstream artifact |
|---|---|---|---|
| 6 fully-captured collections keep `authorized`/`partially_authorized` where v2.5.0's derivation says `completed` | A | **TI** | [PR #11356](https://github.com/medusajs/medusa/pull/11356) (`702d338`) — the author's own description lists converting these to calculated fields as future work, *"as they can easily be a source of inconsistencies"* |
| — (no finding) | B | **TN** | [PR #15085](https://github.com/medusajs/medusa/pull/15085) (`b50a9db`); constraint widened ahead of the feature by `Migration20260411223700.ts` |

**No TP.** §6 reserves TP for a finding that names a shipped migration. Both
pairs shipped migrations, and both are CHECK-constraint widenings that address
nothing either finding is about. Scoring Pair A's result as a TP would stretch a
pre-registered rule to flatter the study, so it is TI: correct, and knowingly
accepted by the maintainers.

## MISS analysis

§3 requires misses be hunted as deliberately as hits, split by whether the
projection could see them.

| miss | class | detail |
|---|---|---|
| zero-amount collections change status | **out-of-projection** | see below |
| `failed` is dead vocabulary at v2.5.0 | **not a miss** | declared in the union and the CHECK constraint, assigned by no code path. Not a compatibility defect, and no gate claims to detect one |

### The out-of-projection miss, in full

v2.5.0's new clause is an **equality**, not a `>=`:

```ts
if (MathBN.eq(paymentCollection.amount, capturedAmount)) { status = COMPLETED }
```

So a collection with `amount === 0` satisfies it with nothing captured and no
sessions at all:

```
a free order (amount = 0), brand new, no sessions, nothing captured:
  v2.4.0 → not_paid
  v2.5.0 → completed
```

Zero-amount collections are not exotic in commerce — a 100% discount, a gift
card covering the full total, a free item. This is a real behavioural change and
**`polyvers` did not report it.**

It is classed **out-of-projection** rather than a tool limitation, and the reason
is written into the contract itself: the money abstraction is
`none | partial | full`, which **collapses when `amount === 0`** — `none` and
`full` become the same value, so the case is inexpressible. That bound was
declared in `v2.5.0/contract.json` (`abstractionBound`) *before* this analysis,
not retrofitted after the miss was found.

This is the most useful single number the tier produced, because it is the
projection bound **costing something measurable** rather than being conceded in
the abstract. The guarantee really is relative to `stateKeys` and to the
abstractions chosen, and here that relativity hid a live defect. A paper
claiming otherwise would be overclaiming; this is what the honest version looks
like.

## Corrections to the selection phase

[`FINDINGS.md`](FINDINGS.md) was written before either pair ran and got its
central prediction wrong. It stated that both usable pairs were widenings, that
therefore *"this tier CANNOT measure recall"*, and that *"no TP and no MISS is
possible here."*

Pair A was not a widening. It produced a real finding, and the zero-amount case
above is a real miss. **Both halves of that claim were false**, and they are left
standing in `FINDINGS.md` with a correction notice rather than edited away,
because the failure of a pre-run prediction is itself a result: it is the same
mistake a practitioner makes when they classify a release from its notes.

What survives from the selection phase, verified and unchanged: Medusa's
`OrderStatus` and `FulfillmentStatus` never changed across the whole v1 line or
across v2.0.0 → HEAD, and no released pair narrows a state domain.

## Honest limits

- **N = 2** pairs, one project, one subsystem (payments).
- **Corpora are `upstream-model`** — generated by the frozen version-N
  translations, not captured from a running Medusa. §5 permits this as the
  fallback; it is sound for the compatibility question (are version-N-legal
  states accepted by version N+1?) and is not evidence about translation
  fidelity, which is `VALIDATION.md`'s job.
- **The translations are ours.** Ground truth is external, the model is not.
  §2's freeze — version-N authored and committed before the N+1 diff is read —
  is what keeps the findings non-circular, and both freeze commits are cited in
  the per-pair reports (`0f34c26`, `a305507`).
- **One ground-truth source.** No upgrade-breakage issue could be found for
  either pair, so §6's second source is empty throughout.
- **Zero TPs**, so the tier shows the tool does not cry wolf and, in Pair A,
  that it finds a real inconsistency the maintainers deferred. It does not show
  the tool catching something the maintainers had to fix, because Medusa shipped
  no such change in the window studied.

## Two defects this tier found in `polyvers`

Both fixed, both with regression tests.

1. **The migrate gate conflated structural and invariant failures** (found in
   FS-M3, confirmed here) — a well-formed migration whose output violates a rule
   suppressed every downstream corpus gate.
2. **The semantic gate understated its own coverage** — it reported states
   discovered *beyond* the seeds, so Pair B's 12-snapshot run read
   `3 state(s) discovered` and looked vacuous. Now reads
   `14 state(s) checked = 11 seeded from the fleet + 3 discovered from them`.

## And one the study nearly committed

Pair B's write-up records it in full: from the change commit alone, the evidence
that Medusa had widened an enum without its DB constraint was compelling, and the
ORM schema snapshot appeared to corroborate it. Reading the migration DDL rather
than the ORM metadata showed the constraint had been widened correctly, two
months early.

Trusting the secondary source would have published a critical false finding
against a real project. It is recorded because a study's credibility rests on
what it does with a story that is too good.
