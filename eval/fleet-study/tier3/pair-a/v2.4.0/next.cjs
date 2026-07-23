// Tier 3 · Pair A · version N — Medusa `PaymentCollectionStatus` at v2.4.0.
//
// Translated from medusajs/medusa at refs/tags/v2.4.0 (commit 956a50e934fb).
// FROZEN per docs/tier3-protocol.md §2 before v2.5.0's source was read.
// See VALIDATION.md for the per-transition mapping to upstream source.
//
// THE CENTRAL FACT ABOUT THIS ARTIFACT: status is not stored state, it is a
// DERIVED PROJECTION. `maybeUpdatePaymentCollection_` recomputes it from
// scratch on every write, from the payment sessions and amounts:
//
//   let status = sessions.length === 0 ? NOT_PAID : AWAITING
//   if (authorizedAmount > 0)
//     status = authorizedAmount >= amount ? AUTHORIZED : PARTIALLY_AUTHORIZED
//
// The current status IS fetched (`select: ["amount", "raw_amount", "status"]`)
// and then never read. No transition is guarded on it. `canceled` is written
// unconditionally by cancelOrderWorkflow and is NOT sealed — a later recompute
// would overwrite it. All of that is modelled faithfully below, including the
// parts that look like defects, because the point of this tier is to check the
// artifact as shipped rather than an idealised version of it.
//
// DECLARED ABSTRACTIONS (the model is finite; Medusa's amounts are not):
//   • Money is abstracted to 'none' | 'partial' | 'full' — the only
//     distinctions the derivation makes are `> 0` and `>= amount`.
//   • `sessions.length` is abstracted to a boolean, since the derivation only
//     tests `=== 0`.
// Both are recorded in contract.json. They lose nothing the status logic uses
// and they are the reason exploration terminates.
//
// OBSERVABLE PROJECTION — the bound on every claim made here. Five keys are
// declared. Everything else about a Medusa payment collection is unchecked:
// provider ids, session data blobs, currency, refund reasons, captures as
// individual records, `completed_at`, metadata, and the entire Order and Cart
// that own the collection.
'use strict';

const { createInstance } = require('@cognitive-fab/sam-pattern');

const instance = createInstance({ strict: true, hasAsyncActions: false, instanceName: 'medusa-payment-collection-v2.4.0' });

// The exact five members declared at v2.4.0 in
// packages/core/types/src/payment/common.ts. No wildcard, no catch-all: the
// protocol's §2a countermeasure is to model version N as tightly as its source
// allows, because a tight domain is the ADVERSARIAL setup for a precision
// study — it is what makes an added member able to conflict.
const STATUS = ['not_paid', 'awaiting', 'authorized', 'partially_authorized', 'canceled'];

const LEVELS = ['none', 'partial', 'full'];

// Model default: `model.enum(PaymentCollectionStatus).default(NOT_PAID)` in
// packages/modules/payment/src/models/payment-collection.ts. No create path
// passes an explicit status.
const INITIAL_STATE = {
  status: 'not_paid',
  hasSessions: false,
  authorized: 'none',
  captured: 'none',
  refunded: 'none',
};

/**
 * `maybeUpdatePaymentCollection_`, transcribed. Note what is absent: the
 * current status is not an input. Note also that `captured` and `refunded` are
 * persisted by the same call but play NO part in choosing the status — at
 * v2.4.0 a fully captured collection still reads `authorized`.
 */
function derive(model) {
  let status = model.hasSessions ? 'awaiting' : 'not_paid';
  if (model.authorized !== 'none') {
    status = model.authorized === 'full' ? 'authorized' : 'partially_authorized';
  }
  return status;
}

const control = instance({
  initialState: JSON.parse(JSON.stringify(INITIAL_STATE)),
  component: {
    modelShape: {
      status: { type: 'string' },
      hasSessions: { type: 'boolean' },
      authorized: { type: 'string' },
      captured: { type: 'string' },
      refunded: { type: 'string' },
    },
    actions: {
      ADD_SESSION: { action: (d = {}) => ({ ...d }), schema: {}, domain: [{}] },
      AUTHORIZE_SESSION: { action: (d = {}) => ({ ...d }), schema: {}, domain: [{ level: 'partial' }, { level: 'full' }] },
      CAPTURE_PAYMENT: { action: (d = {}) => ({ ...d }), schema: {}, domain: [{ level: 'partial' }, { level: 'full' }] },
      REFUND_PAYMENT: { action: (d = {}) => ({ ...d }), schema: {}, domain: [{ level: 'partial' }, { level: 'full' }] },
      // cancelOrderWorkflow → updatePaymentCollectionStep. Unconditional.
      CANCEL_ORDER: { action: (d = {}) => ({ ...d }), schema: {}, domain: [{}] },
    },
    acceptors: {
      // createPaymentSession. No check against the collection's own status —
      // nothing in createPaymentSession/authorizePaymentSession reads it.
      // (2.1 next-state: `derive` recomputes from the values being written
      // this step, so the post-write inputs are threaded explicitly.)
      ADD_SESSION: (model) => (p, { reject, next, unchanged }) => {
        if (model.hasSessions) return reject('session-already-present');
        next.hasSessions = true;
        next.status = derive({ hasSessions: true, authorized: model.authorized, captured: model.captured });
        unchanged('authorized', 'captured', 'refunded');
      },

      // authorizePaymentSession → maybeUpdatePaymentCollection_.
      // The precondition is on the SESSION (you cannot authorize one that does
      // not exist), NOT on PaymentCollection.status. That distinction is the
      // whole point: sibling entities carry guards, the collection does not.
      AUTHORIZE_SESSION: (model) => (p, { reject, next, unchanged }) => {
        if (!model.hasSessions) return reject('no-session-to-authorize');
        if (model.authorized !== 'none') return reject('session-already-authorized');
        next.authorized = p.level;
        next.status = derive({ hasSessions: model.hasSessions, authorized: p.level, captured: model.captured });
        unchanged('hasSessions', 'captured', 'refunded');
      },

      // capturePayment → maybeUpdatePaymentCollection_. `capturePayment_`
      // throws when payment.canceled_at is set and short-circuits when
      // captured_at already is — both are Payment-entity guards. Capture does
      // not move authorizedAmount, so the derived status is UNCHANGED by it.
      CAPTURE_PAYMENT: (model) => (p, { reject, next, unchanged }) => {
        if (model.authorized === 'none') return reject('nothing-authorized-to-capture');
        if (model.captured !== 'none') return reject('already-captured');
        next.captured = p.level;
        next.status = derive({ hasSessions: model.hasSessions, authorized: model.authorized, captured: p.level });
        unchanged('hasSessions', 'authorized', 'refunded');
      },

      // refundPayment → maybeUpdatePaymentCollection_. Also status-neutral.
      REFUND_PAYMENT: (model) => (p, { reject, next, unchanged }) => {
        if (model.captured === 'none') return reject('nothing-captured-to-refund');
        if (model.refunded !== 'none') return reject('already-refunded');
        next.refunded = p.level;
        next.status = derive({ hasSessions: model.hasSessions, authorized: model.authorized, captured: model.captured });
        unchanged('hasSessions', 'authorized', 'captured');
      },

      // cancelOrderWorkflow stamps every linked collection unconditionally.
      // There is NO guard, and no reject path: cancelling twice is not
      // refused by anything in the payment module at v2.4.0. Modelling a
      // guard here would be modelling a machine Medusa does not ship.
      CANCEL_ORDER: (model) => (p, { next, unchanged }) => {
        next.status = 'canceled';
        unchanged('hasSessions', 'authorized', 'captured', 'refunded');
      },
    },
    reactors: [],
  },
});

const { intents } = control;
const getState = () => instance({}).getState();
const setState = (snapshot) => { instance({}).setState(snapshot); };
const init = () => { setState(INITIAL_STATE); };
const actions = Object.fromEntries(Object.keys(intents).map((n) => [n, (d = {}) => intents[n](d)]));

module.exports = { instance, init, actions, getState, setState, STATUS, LEVELS, derive };
