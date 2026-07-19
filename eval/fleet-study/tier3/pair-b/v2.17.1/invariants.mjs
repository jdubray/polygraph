// Tier 3 · Pair B · version N — intent for Medusa's payment session at v2.17.1.
//
// As in Pair A, every rule here is taken from v2.17.1's own code, and the file
// is thin because the artifact enforces little. But the thinness has a
// DIFFERENT cause, and the difference is the interesting part of Pair B.
//
// Pair A's collection status was computed internally, so its rules were
// derivation identities. Pair B's session status is REPORTED BY A THIRD PARTY
// and written verbatim. There is no derivation to assert. What can be asserted
// is only what the storage layer constrains and what the code demonstrably
// never undoes.
'use strict';

const STATUS = ['authorized', 'captured', 'pending', 'requires_more', 'error', 'canceled'];

export const stateInvariants = [
  {
    // Enforced by the DATABASE, not by the application. `payment-module.ts`
    // writes whatever the provider reported with no membership check; the
    // `model.enum(PaymentSessionStatus)` column is what actually refuses an
    // unknown value. Asserted here because it IS enforced — just one layer
    // down from where a reader might expect.
    name: 'status-in-declared-domain',
    pred: (s) => STATUS.includes(s.status),
  },
];

export const transitionInvariants = [
  {
    // `authorized_at` is written in exactly one place — authorizePaymentSession_,
    // and only when it was previously null:
    //     ...(session.authorized_at === null ? { authorized_at: new Date() } : {})
    // No code path anywhere clears it. Monotonicity is therefore a real
    // property of the artifact rather than an aspiration, which is why Pair B
    // has a transition invariant where Pair A had none.
    name: 'authorized-at-is-monotone',
    pred: (before, action, data, after) => !before.authorizedAt || after.authorizedAt,
  },
];

// OMISSIONS, each considered and rejected with a reason:
//
//  • `authorized-implies-authorized-at` — TEMPTING AND FALSE. Only the
//    authorize path sets `authorized_at`. `createPaymentSession` and
//    `updatePaymentSession` write a provider-reported `authorized` straight
//    through WITHOUT touching `authorized_at`, so a session can be
//    `status: 'authorized'` with `authorized_at: null`. Asserting this would
//    invent a guarantee the artifact does not make.
//
//  • `authorized-at-implies-status-authorized` — also false, and in the other
//    direction: `updatePaymentSession` can move the status away from
//    `authorized` while `authorized_at` remains set.
//
//  • anything sealing `error` or `canceled` — nothing treats them as terminal.
//    `updatePaymentSession` will write over either without a check.
//
//  • `captured is unreachable` — NOT asserted, because it is not true. The
//    authorize path collapses CAPTURED into AUTHORIZED and never persists it,
//    but create/update write provider values through untouched, so a provider
//    reporting `captured` at initiate or update stores it verbatim.
