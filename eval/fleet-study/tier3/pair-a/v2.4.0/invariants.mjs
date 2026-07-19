// Tier 3 · Pair A · version N — intent for Medusa's payment collection at v2.4.0.
//
// EVERY RULE HERE IS TAKEN FROM v2.4.0's OWN CODE. None is a rule a payments
// engineer might *wish* were true. That distinction is the whole discipline of
// this tier: an invariant the artifact does not enforce would make the model
// stricter than the thing being studied, and a "finding" against it would
// measure my modelling rather than Medusa's change.
//
// The consequence is an unusually thin file, and that thinness IS the result.
// At v2.4.0 the payment collection status is a derived projection with no
// guarded transitions, so almost the only thing assertable is that the
// derivation holds.
'use strict';

const STATUS = ['not_paid', 'awaiting', 'authorized', 'partially_authorized', 'canceled'];

// `maybeUpdatePaymentCollection_`, transcribed — see next.cjs.
function derive(s) {
  let status = s.hasSessions ? 'awaiting' : 'not_paid';
  if (s.authorized !== 'none') {
    status = s.authorized === 'full' ? 'authorized' : 'partially_authorized';
  }
  return status;
}

export const stateInvariants = [
  {
    // The DB CHECK constraint, and the TypeScript union. This is the rule the
    // v2.5.0 migration widens, so it is the one that matters most for Pair A.
    name: 'status-in-declared-domain',
    pred: (s) => STATUS.includes(s.status),
  },
  {
    // The actual behaviour of the artifact: status is whatever the last writer
    // set, and there are exactly two writers — the recompute, and the
    // unconditional cancel stamp. Stated as a disjunction because that is
    // literally what the code does, not because the disjunction is elegant.
    name: 'status-is-derived-or-canceled',
    pred: (s) => s.status === 'canceled' || s.status === derive(s),
  },
  {
    // Corollaries of the derivation, stated separately so that a violation
    // names something specific rather than pointing at the whole formula.
    name: 'authorized-implies-fully-authorized',
    pred: (s) => s.status !== 'authorized' || s.authorized === 'full',
  },
  {
    name: 'partially-authorized-implies-partial',
    pred: (s) => s.status !== 'partially_authorized' || s.authorized === 'partial',
  },
  {
    name: 'not-paid-implies-no-sessions',
    pred: (s) => s.status !== 'not_paid' || s.hasSessions === false,
  },
];

// DELIBERATELY EMPTY, and this is a finding rather than an oversight.
//
// A transition invariant asserts something about (before, action, after). At
// v2.4.0 NO transition on the payment collection is guarded by the
// collection's own status: `maybeUpdatePaymentCollection_` selects `status`
// and never reads it, and cancelOrderWorkflow stamps `canceled` with no check
// at all. There is therefore nothing to assert that the artifact enforces.
//
// Writing the obvious candidate — "canceled is terminal" — would be asserting
// a rule Medusa does not implement. The code permits a later recompute to move
// a canceled collection back to authorized, and the study's job is to model
// that, not to correct it.
export const transitionInvariants = [];

// OMISSIONS, recorded so a reader can see what was considered and rejected:
//
//  • `canceled-is-terminal` — NOT enforced at v2.4.0 (see above). Omitted.
//  • `captured <= authorized` — not enforced at the collection level. The
//    guards that exist live on the Payment entity (capturePayment_ throws when
//    payment.canceled_at is set, short-circuits when captured_at is set), not
//    on the collection. Omitted, which leaves the model a strict SUPERSET of
//    reachable real states. That over-approximation is the conservative
//    direction: it can only make a compatibility check fire more readily, and
//    per tier3-protocol §2a the adversarial choice is the correct one for a
//    precision study.
//  • anything about `completed_at` — set unconditionally by
//    `completePaymentCollections`, which carries the maintainers' own inline
//    TODO asking what checks belong there. No invariant exists to transcribe.
