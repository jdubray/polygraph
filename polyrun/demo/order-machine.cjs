// Order lifecycle machine — SAM v2 strict-profile module, modeled on the
// Temporal OMS reference app's Order workflow (submit → fraud check →
// charge → ship → complete, with the amend-on-unavailable + timeout branch).
//
// Hand-authored for the polyrun M0 demo in the exact artifact shape polygen
// emits (see examples/turnstile-v2/specs/reference.js); the M0 follow-up is
// to re-author it with polygen and diff. Every not-applicable action is an
// observable reject(reason) — that is what makes stale timers, duplicate
// webhooks, and at-least-once completions safe in the polyrun kernel.
'use strict';

const { createInstance } = require('@cognitive-fab/sam-pattern');

const instance = createInstance({ strict: true, hasAsyncActions: false, instanceName: 'order' });

const INITIAL_STATE = { orderState: 'pending', totalCents: 0, txId: '', cancelReason: '' };

// NOTE: each action needs its OWN function — the library stamps __actionName
// onto the function object, so a shared reference would alias every intent to
// the last-declared name.
const control = instance({
  initialState: JSON.parse(JSON.stringify(INITIAL_STATE)),
  component: {
    modelShape: {
      orderState: { type: 'string' },
      totalCents: { type: 'number' },
      txId: { type: 'string' },
      cancelReason: { type: 'string' },
    },
    actions: {
      SUBMIT: { action: (data = {}) => ({ ...data }), schema: {}, domain: [{ totalCents: 2500 }] },
      FRAUD_PASSED: { action: (data = {}) => ({ ...data }), schema: {}, domain: [{ itemsAvailable: true }, { itemsAvailable: false }] },
      FRAUD_FAILED: { action: (data = {}) => ({ ...data }), schema: {}, domain: [{ reason: 'suspicious' }] },
      AMEND: { action: (data = {}) => ({ ...data }), schema: {}, domain: [{ totalCents: 1900 }] },
      AMEND_WINDOW_EXPIRED: { action: (data = {}) => ({ ...data }), schema: {}, domain: [{}] },
      CHARGE_SUCCEEDED: { action: (data = {}) => ({ ...data }), schema: {}, domain: [{ txId: 'tx-1' }] },
      CHARGE_FAILED: { action: (data = {}) => ({ ...data }), schema: {}, domain: [{ reason: 'declined' }] },
      CHARGE_TIMED_OUT: { action: (data = {}) => ({ ...data }), schema: {}, domain: [{}] },
      CANCEL: { action: (data = {}) => ({ ...data }), schema: {}, domain: [{ reason: 'customer-request' }] },
      SHIPMENT_DELIVERED: { action: (data = {}) => ({ ...data }), schema: {}, domain: [{}] },
    },
    acceptors: {
      SUBMIT: (model) => (proposal, { reject, next, unchanged }) => {
        if (model.orderState !== 'pending') return reject('already-submitted');
        if (!(Number.isInteger(proposal.totalCents) && proposal.totalCents > 0)) return reject('invalid-total');
        next.orderState = 'fraudCheck';
        next.totalCents = proposal.totalCents;
        unchanged('txId', 'cancelReason');
      },
      FRAUD_PASSED: (model) => (proposal, { reject, next, unchanged }) => {
        if (model.orderState !== 'fraudCheck') return reject('stale-fraud-result');
        next.orderState = proposal.itemsAvailable === false ? 'awaitingAmend' : 'charging';
        unchanged('totalCents', 'txId', 'cancelReason');
      },
      FRAUD_FAILED: (model) => (proposal, { reject, next, unchanged }) => {
        if (model.orderState !== 'fraudCheck') return reject('stale-fraud-result');
        next.orderState = 'rejected';
        next.cancelReason = String(proposal.reason || 'fraud');
        unchanged('totalCents', 'txId');
      },
      AMEND: (model) => (proposal, { reject, next, unchanged }) => {
        if (model.orderState !== 'awaitingAmend') return reject('nothing-to-amend');
        if (!(Number.isInteger(proposal.totalCents) && proposal.totalCents > 0)) return reject('invalid-total');
        next.orderState = 'charging';
        next.totalCents = proposal.totalCents;
        unchanged('txId', 'cancelReason');
      },
      AMEND_WINDOW_EXPIRED: (model) => (proposal, { reject, next, unchanged }) => {
        if (model.orderState !== 'awaitingAmend') return reject('stale-timer');
        next.orderState = 'cancelled';
        next.cancelReason = 'amend-window-expired';
        unchanged('totalCents', 'txId');
      },
      CHARGE_SUCCEEDED: (model) => (proposal, { reject, next, unchanged }) => {
        if (model.orderState !== 'charging') return reject('stale-completion');
        next.orderState = 'shipping';
        next.txId = String(proposal.txId || '');
        unchanged('totalCents', 'cancelReason');
      },
      CHARGE_FAILED: (model) => (proposal, { reject, next, unchanged }) => {
        if (model.orderState !== 'charging') return reject('stale-completion');
        next.orderState = 'paymentFailed';
        next.cancelReason = String(proposal.reason || 'charge-failed');
        unchanged('totalCents', 'txId');
      },
      CHARGE_TIMED_OUT: (model) => (proposal, { reject, next, unchanged }) => {
        if (model.orderState !== 'charging') return reject('stale-timer');
        next.orderState = 'paymentFailed';
        next.cancelReason = 'charge-timed-out';
        unchanged('totalCents', 'txId');
      },
      CANCEL: (model) => (proposal, { reject, next, unchanged }) => {
        // Contract-anchored reason: the specialRule's name, per the polygraph
        // convention (cf. turnstile's 'push-while-locked-is-noop').
        if (model.orderState === 'charging') return reject('cancel-blocked-while-charging');
        if (!['pending', 'fraudCheck', 'awaitingAmend'].includes(model.orderState)) return reject('not-cancellable');
        next.orderState = 'cancelled';
        next.cancelReason = String(proposal.reason || 'cancelled');
        unchanged('totalCents', 'txId');
      },
      SHIPMENT_DELIVERED: (model) => (proposal, { reject, next, unchanged }) => {
        if (model.orderState !== 'shipping') return reject('not-shipping');
        next.orderState = 'completed';
        unchanged('totalCents', 'txId', 'cancelReason');
      },
    },
    reactors: [],
  },
});

const { intents } = control;

const getState = () => instance({}).getState();
const setState = (snapshot) => { instance({}).setState(snapshot); };

const init = () => {
  try {
    const model = instance({}).state();
    if (model && typeof model.clearError === 'function') model.clearError();
  } catch { /* best-effort; strict-profile errors throw at the caller anyway */ }
  setState(INITIAL_STATE);
};

const actions = Object.fromEntries(
  Object.keys(intents).map((name) => [name, (data = {}) => intents[name](data)])
);

module.exports = { instance, init, actions, getState, setState };
