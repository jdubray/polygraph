// Tier 3 · Pair A · version N+1 — intent for Medusa's payment collection at v2.5.0.
//
// These are the v2.4.0 invariants with the SAME RULES APPLIED MECHANICALLY to
// the new source. Nothing here was chosen after seeing what `polyvers` would
// say about it.
//
// That mechanical application is the point of the freeze. The FORM of the
// central rule — "status is the derivation, or canceled" — was fixed in the
// v2.4.0 file and committed at 0f34c26 before v2.5.0's source was read. All
// that changes below is that `derive()` now transcribes v2.5.0's function
// instead of v2.4.0's. If a fleet state violates the result, that is a
// consequence of Medusa's change, not of an invariant picked to produce one.
'use strict';

const STATUS = ['not_paid', 'awaiting', 'authorized', 'partially_authorized', 'canceled', 'failed', 'completed'];

// `maybeUpdatePaymentCollection_` at v2.5.0 — see next.cjs. The third clause
// is new and overrides the two above it.
function derive(s) {
  let status = s.hasSessions ? 'awaiting' : 'not_paid';
  if (s.authorized !== 'none') {
    status = s.authorized === 'full' ? 'authorized' : 'partially_authorized';
  }
  if (s.captured === 'full') {
    status = 'completed';
  }
  return status;
}

export const stateInvariants = [
  {
    // The widened CHECK constraint and union. Seven members at v2.5.0.
    name: 'status-in-declared-domain',
    pred: (s) => STATUS.includes(s.status),
  },
  {
    // Same form as v2.4.0's rule, with v2.5.0's derivation substituted.
    name: 'status-is-derived-or-canceled',
    pred: (s) => s.status === 'canceled' || s.status === derive(s),
  },
  {
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
  {
    // NEW, and it is the direct corollary of v2.5.0's new clause — the same
    // kind of corollary the v2.4.0 file already stated for the authorization
    // branches. Written so a violation names the specific rule rather than
    // pointing at the whole derivation.
    name: 'fully-captured-is-completed',
    pred: (s) => s.captured !== 'full' || ['completed', 'canceled'].includes(s.status),
  },
];

// Still deliberately empty, for the same reason as v2.4.0: the derivation path
// reads the current status nowhere, and `canceled` is still not sealed. The
// one status guard that does exist upstream (throwUnlessPaymentCollectionNotPaid,
// on entry to markPaymentCollectionAsPaid) is byte-identical in both versions
// and is not modelled in either — see v2.4.0/VALIDATION.md §5's correction.
export const transitionInvariants = [];

// OMISSIONS, carried forward from v2.4.0 and re-examined against v2.5.0:
//
//  • `canceled-is-terminal` — still NOT enforced. cancelOrderWorkflow remains
//    an unconditional stamp, so at v2.5.0 even a `completed` collection can be
//    moved to `canceled`. Omitted.
//  • `captured <= authorized` — still not enforced at the collection level.
//    Omitted; the model stays a strict superset.
//  • anything producing `failed` — the member is declared in the union and in
//    the widened CHECK constraint, but NO code path assigns it at v2.5.0
//    (verified repo-wide). It is therefore in the domain and unreachable. No
//    invariant is written for it, because there is no behaviour to transcribe.
