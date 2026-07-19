# Pair A · version N (v2.4.0) — translation validation record

Required by [`tier3-protocol.md`](../../../../../docs/tier3-protocol.md) §2 step 2.
**This translation is frozen by the commit that adds this file.** v2.5.0's
source had not been read when it was authored; see §2a for the declared
selection-phase contamination and why tight modelling is its countermeasure.

Upstream: `medusajs/medusa` @ `refs/tags/v2.4.0`, commit `956a50e934fb`.

## 1. Every declared status member is reachable

Exhaustive exploration from `init` over the full declared action domain:

```
reachable states:   32
statuses reached:   authorized, awaiting, canceled, not_paid, partially_authorized
UNREACHABLE:        (none)
```

All five members of v2.4.0's `PaymentCollectionStatus` are reachable. **No
omission to record** — the contract's state domain is exactly the upstream
union, with no member dropped and none invented.

## 2. The module model-checks clean from `init`

```
states explored: 32
no invariant violations reachable ✓
```

A translation that violates its own invariants is wrong before it is useful.
This one does not.

## 3. Per-transition mapping to upstream source

| model action | upstream trigger | source |
|---|---|---|
| `ADD_SESSION` | `createPaymentSession` | `payment-module.ts` |
| `AUTHORIZE_SESSION` | `authorizePaymentSession` → `maybeUpdatePaymentCollection_` | `payment-module.ts` |
| `CAPTURE_PAYMENT` | `capturePayment` → `maybeUpdatePaymentCollection_` | `payment-module.ts` |
| `REFUND_PAYMENT` | `refundPayment` → `maybeUpdatePaymentCollection_` | `payment-module.ts` |
| `CANCEL_ORDER` | `cancelOrderWorkflow` → `updatePaymentCollectionStep` | `core-flows/src/order/workflows/cancel-order.ts` |

The derivation in `derive()` is a transcription of `maybeUpdatePaymentCollection_`:

```ts
let status = sessions.length === 0 ? NOT_PAID : AWAITING
if (authorizedAmount > 0)
  status = authorizedAmount >= amount ? AUTHORIZED : PARTIALLY_AUTHORIZED
```

Initial status `not_paid` comes from the model column default
(`model.enum(PaymentCollectionStatus).default(NOT_PAID)`); no create path passes
an explicit status.

## 4. Behavioural checks against v2.4.0's semantics

| probe | result | upstream justification |
|---|---|---|
| `AUTHORIZE_SESSION` with no session | rejected, no-op | `authorizePaymentSession` takes a session id; nothing to authorize |
| `CAPTURE_PAYMENT` with nothing authorized | rejected, no-op | capture operates on a `Payment` from an authorized session |
| `REFUND_PAYMENT` with nothing captured | rejected, no-op | refund needs a capture to refund against |
| `CANCEL_ORDER` from any state | **accepted, always** | `updatePaymentCollectionStep` is an unconditional field write |
| `CANCEL_ORDER` twice | state unchanged | see the correction below |
| `CANCEL_ORDER` then `AUTHORIZE_SESSION` | **`canceled` → `authorized`** | the recompute never reads the current status |

**Correction to the fifth row.** The probe reports "unchanged" because it
compares state before and after, and writing `canceled` over `canceled` is an
**identity write, not a rejection**. `CANCEL_ORDER` has no reject path at all —
the contract says so explicitly — and the two must not be conflated: a
rejection is observable in `lastStep()` as a named refusal, an identity write
is not observable at all. Recorded here rather than left to read as a guard
that does not exist.

**The sixth row is the load-bearing one.** It reproduces the behaviour the
extraction found in the source: because `maybeUpdatePaymentCollection_` selects
`status` and never reads it, a canceled collection can be moved back to
`authorized` by any later recompute. The translation models this rather than
correcting it.

## 5. Sibling-entity guards vs collection-status guards

The three rejections above are preconditions on the **`Payment` / `PaymentSession`
entities**, not on `PaymentCollection.status`. v2.4.0 guards those siblings
(`capturePayment_` throws when `payment.canceled_at` is set, short-circuits when
`captured_at` is set) and guards the collection's own status **nowhere**. The
contract's `specialRules` say so per rule; `transitionInvariants` is empty for
the same reason.

## 6. Known over-approximation

`captured` may exceed `authorized` in this model (e.g. `authorized: 'partial'`
with `captured: 'full'`), because no such bound is enforced at the collection
level upstream. The model is therefore a strict **superset** of really
reachable states.

This direction is deliberate. An over-approximation can only make a downstream
compatibility check fire *more* readily, which per §2a is the adversarial choice
for a precision study — if `polyvers` passes Pair A against a model that admits
extra states, the pass is stronger, not weaker. The alternative (adding a bound
the artifact does not enforce) would tighten the model beyond the thing being
studied and could hide a real finding.
