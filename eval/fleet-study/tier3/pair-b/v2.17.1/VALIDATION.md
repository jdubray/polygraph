# Pair B · version N (v2.17.1) — translation validation record

Required by [`tier3-protocol.md`](../../../../../docs/tier3-protocol.md) §2 step 2.
**This translation is frozen by the commit that adds this file.** v2.17.2's
source and PR #15085 had not been read when it was authored; see §2a for the
declared selection-phase contamination.

Upstream: `medusajs/medusa` @ `refs/tags/v2.17.1`, commit `9aadd07b63d0`.

## 1. Every declared status member is reachable

```
states:        12
statuses:      authorized, canceled, captured, error, pending, requires_more
UNREACHABLE:   (none)
```

All six members of v2.17.1's `PaymentSessionStatus` are reachable. **No
omission to record.**

Worth noting how `captured` gets there: the authorize path never persists it
(`authorizePaymentSession_` collapses `CAPTURED` into `AUTHORIZED`), but
`createPaymentSession` and `updatePaymentSession` write provider values through
untouched, so a provider reporting `captured` at initiate or update stores it
verbatim. A translation that modelled only the authorize path would have made
`captured` unreachable and been wrong.

## 2. The module model-checks clean from `init`

```
states explored: 12
no invariant violations reachable ✓
```

## 3. Per-transition mapping to upstream source

| model action | upstream | write |
|---|---|---|
| `PROVIDER_INITIATE` | `createPaymentSession` | `status = providerPaymentSession.status ?? PENDING` |
| `PROVIDER_UPDATE` | `updatePaymentSession` | `status = data.status ?? providerData.status ?? session.status` |
| `PROVIDER_AUTHORIZE` | `authorizePaymentSession` (+ `authorizePaymentSession_`) | see below |

`PROVIDER_AUTHORIZE` has three outcomes, all transcribed:

1. **Idempotent short-circuit** — `if (session.payment && session.authorized_at)`
   returns the existing payment before any provider call. Modelled as
   `reject('already-authorized')`.
2. **Provider reported `authorized` or `captured`** — `authorizePaymentSession_`
   writes `status = AUTHORIZED` (collapsing `captured`), sets `authorized_at`
   if it was null, and creates a `Payment`.
3. **Anything else** — the provider's status is **written** and a `MedusaError`
   is then raised.

## 4. The mutate-then-throw path, and why it is not a rejection

Outcome 3 is the subtle one. Upstream:

```ts
if (status !== PaymentSessionStatus.AUTHORIZED && status !== PaymentSessionStatus.CAPTURED) {
  // ...update the session with the provider's status...
  throw new MedusaError(MedusaError.Types.NOT_ALLOWED, ...)
}
```

The row **is persisted**; the throw is control flow for the caller. This model
treats the write as the outcome and records the throw here instead of modelling
it as `reject()`, because a rejection asserts that the state did **not** change
— which would be false, and would hide from the corpus exactly the states a
fleet ends up holding after a declined or pending authorization.

## 5. The only guard, and what it keys on

There is one guard in this machine: the idempotency check above. **It keys on
`authorized_at` and the presence of a linked `Payment` — not on the status
value.** No code path anywhere checks "the current status must be X before
writing Y".

So writes to `PaymentSession.status` are unguarded with respect to the session's
own status, the same conclusion Pair A reached for the payment collection. The
two machines are otherwise quite different, and this was checked rather than
assumed.

## 6. Provider trust is the defining property

The session status is not computed. It is reported by a third-party payment
provider and written verbatim, with no enum-membership check, no validation,
and no mapping table in `payment-module.ts`. The sole transformation anywhere
is `CAPTURED → AUTHORIZED` in the authorize path.

Domain membership is therefore enforced by the **database** (`model.enum`
column), not by the application: a provider reporting an unrecognised status
fails at write time as a constraint violation rather than being refused in code.
`status-in-declared-domain` is asserted on that basis — it is enforced, just one
layer below where a reader might look.

This matters for Pair B specifically. A version that adds a status member is
adding something **providers can emit**, into a system that trusts what
providers emit. That is a different compatibility question from Pair A's, where
the new member could only ever be produced by Medusa's own code.

## 7. Invariants deliberately NOT asserted

Recorded in full in `invariants.mjs`; the load-bearing one:

`authorized-implies-authorized-at` is **tempting and false.** Only the authorize
path sets `authorized_at`. Create and update write a provider-reported
`authorized` straight through without touching it, so a session can be
`status: 'authorized'` with `authorized_at: null`. Asserting it would have
invented a guarantee the artifact does not make — and, because Pair B's
question is about a new status member, would likely have manufactured a finding.

What *is* asserted as a transition invariant is `authorized-at-is-monotone`:
`authorized_at` is written in exactly one place, only when previously null, and
cleared nowhere. That is a real property of the artifact, which is why Pair B
has a transition invariant where Pair A had none.
