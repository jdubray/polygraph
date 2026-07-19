// Tier 3 · Pair A · version N+1 — Medusa `PaymentCollectionStatus` at v2.5.0.
//
// Translated from medusajs/medusa PR #11356, commit 702d338284a8, released in
// v2.5.0. Authored AFTER the v2.4.0 translation was frozen (commit 0f34c26),
// by mechanically applying the same translation rules to the new source.
//
// WHAT ACTUALLY CHANGED. The selection phase recorded this pair as "the enum
// gains failed and completed", which reads like a pure widening. Reading the
// source shows it is not: `maybeUpdatePaymentCollection_` gained a new FINAL
// clause that overrides everything above it —
//
//     if (MathBN.eq(paymentCollection.amount, capturedAmount)) {
//       status = PaymentCollectionStatus.COMPLETED
//       completedAt = new Date()
//     }
//
// so the DERIVATION FUNCTION changed, not just the domain. A collection whose
// captured amount equals its total is now `completed` where v2.4.0 left it
// `authorized`. The migration shipped with this change widens the CHECK
// constraint and touches no row.
//
// WHAT DID NOT CHANGE:
//   • the status is still recomputed from scratch and the current status is
//     still selected-then-ignored — transitions remain unguarded;
//   • `canceled` is still not sealed;
//   • the authorized / partially_authorized branch is byte-identical.
//
// `failed`: added to the union and to the CHECK constraint, but NOT produced
// by the derivation. The PR's own description lists failure handling ("setting
// the payment session status to failed when such a webhook comes in") as work
// still to do. It is declared here because the contract must mirror the
// upstream domain, and recorded in VALIDATION.md as apparently unreachable.
//
// DECLARED ABSTRACTIONS: unchanged from v2.4.0 — money is none/partial/full,
// session count is a boolean. See contract.json.
'use strict';

const { createInstance } = require('@cognitive-fab/sam-pattern');

const instance = createInstance({ strict: true, hasAsyncActions: false, instanceName: 'medusa-payment-collection-v2.5.0' });

// Seven members: the five from v2.4.0 plus `failed` and `completed`, matching
// the union in packages/core/types/src/payment/common.ts and the CHECK
// constraint in Migration20250207132723.ts.
const STATUS = ['not_paid', 'awaiting', 'authorized', 'partially_authorized', 'canceled', 'failed', 'completed'];

const LEVELS = ['none', 'partial', 'full'];

const INITIAL_STATE = {
  status: 'not_paid',
  hasSessions: false,
  authorized: 'none',
  captured: 'none',
  refunded: 'none',
};

/**
 * `maybeUpdatePaymentCollection_` at v2.5.0, transcribed. The first two
 * clauses are byte-identical to v2.4.0; the third is new and overrides them.
 */
function derive(model) {
  let status = model.hasSessions ? 'awaiting' : 'not_paid';
  if (model.authorized !== 'none') {
    status = model.authorized === 'full' ? 'authorized' : 'partially_authorized';
  }
  // NEW in v2.5.0. Note it is unconditional on what came before: a fully
  // captured collection is `completed` regardless of the authorization branch.
  if (model.captured === 'full') {
    status = 'completed';
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
      CANCEL_ORDER: { action: (d = {}) => ({ ...d }), schema: {}, domain: [{}] },
    },
    acceptors: {
      ADD_SESSION: (model) => (p, { reject }) => {
        if (model.hasSessions) return reject('session-already-present');
        model.hasSessions = true;
        model.status = derive(model);
      },
      AUTHORIZE_SESSION: (model) => (p, { reject }) => {
        if (!model.hasSessions) return reject('no-session-to-authorize');
        if (model.authorized !== 'none') return reject('session-already-authorized');
        model.authorized = p.level;
        model.status = derive(model);
      },
      // Unchanged guards (capturePayment_ still throws on canceled_at and
      // short-circuits on captured_at), but the RESULT now differs: a full
      // capture moves the collection to `completed`.
      CAPTURE_PAYMENT: (model) => (p, { reject }) => {
        if (model.authorized === 'none') return reject('nothing-authorized-to-capture');
        if (model.captured !== 'none') return reject('already-captured');
        model.captured = p.level;
        model.status = derive(model);
      },
      REFUND_PAYMENT: (model) => (p, { reject }) => {
        if (model.captured === 'none') return reject('nothing-captured-to-refund');
        if (model.refunded !== 'none') return reject('already-refunded');
        model.refunded = p.level;
        model.status = derive(model);
      },
      CANCEL_ORDER: (model) => () => {
        model.status = 'canceled';
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
