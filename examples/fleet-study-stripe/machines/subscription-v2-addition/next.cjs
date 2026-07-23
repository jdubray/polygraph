// v2-addition — PURE ADDITION: refunds. Nothing removed, no existing
// transition altered, no invariant changed. Expected verdict: COMPATIBLE.
//
// Fleet study Tier 2 — the Stripe subscription lifecycle as a SAM v2
// strict-profile machine (docs/fleet-study-plan.md §5).
//
// The states are Stripe's own subscription statuses, and the transitions are
// the ones Stripe's billing engine actually performs:
//
//   incomplete ──pay ok──▶ active            (first invoice settles)
//   incomplete ──23h────▶ incompleteExpired  (terminal)
//   trialing   ──pay ok──▶ active            (trial converts)
//   trialing   ──pay fail▶ pastDue           (trial ends, card declines)
//   active     ──pay fail▶ pastDue           (renewal declines → dunning)
//   pastDue    ──pay ok──▶ active            (a retry lands)
//   pastDue    ──retries─▶ unpaid            (dunning budget exhausted)
//   unpaid     ──pay ok──▶ active            (customer fixes the card)
//   any live   ──cancel──▶ canceled          (terminal)
//
// `dunningAttempts` is bounded by the declared domain (0..3), which is what
// makes the state space finite and the exploration exhaustive — the standard
// model-bounding move, stated rather than hidden.
//
// OBSERVABLE PROJECTION — the bound on every claim made against this machine.
// The contract declares four keys, and NOTHING else about a Stripe
// subscription is checked by any gate: not proration, not tax, not invoice
// line items, not payment-method fingerprints, not customer metadata, not
// currency, not coupon/discount state. A defect living purely in an
// unprojected field is invisible here by construction. See the README.
'use strict';

const { createInstance } = require('@cognitive-fab/sam-pattern');

const instance = createInstance({ strict: true, hasAsyncActions: false, instanceName: 'subscription-v2-addition' });

const MAX_DUNNING = 3;
const INITIAL_STATE = { subState: 'incomplete', dunningAttempts: 0, hasPaymentMethod: false, cents: 0 };

const LIVE = ['incomplete', 'trialing', 'active', 'pastDue', 'unpaid'];

const control = instance({
  initialState: JSON.parse(JSON.stringify(INITIAL_STATE)),
  component: {
    modelShape: {
      subState: { type: 'string' },
      dunningAttempts: { type: 'number' },
      hasPaymentMethod: { type: 'boolean' },
      cents: { type: 'number' },
    },
    actions: {
      // A subscription created with a trial goes straight to trialing.
      START_TRIAL: { action: (d = {}) => ({ ...d }), schema: {}, domain: [{ cents: 1500 }] },
      PAYMENT_SUCCEEDED: { action: (d = {}) => ({ ...d }), schema: {}, domain: [{ cents: 1500 }] },
      PAYMENT_FAILED: { action: (d = {}) => ({ ...d }), schema: {}, domain: [{}] },
      TRIAL_ENDED: { action: (d = {}) => ({ ...d }), schema: {}, domain: [{}] },
      ATTACH_PAYMENT_METHOD: { action: (d = {}) => ({ ...d }), schema: {}, domain: [{}] },
      CANCEL: { action: (d = {}) => ({ ...d }), schema: {}, domain: [{}] },
      // Stripe expires an incomplete subscription ~23h after creation.
      INCOMPLETE_EXPIRED: { action: (d = {}) => ({ ...d }), schema: {}, domain: [{}] },
      // NEW: a refund zeroes the recurring amount without moving the
      // lifecycle. No fleet record predating v2 ever carried this action.
      REFUND_ISSUED: { action: (d = {}) => ({ ...d }), schema: {}, domain: [{}] },
    },
    acceptors: {
      START_TRIAL: (model) => (p, { reject, next, unchanged }) => {
        if (model.subState !== 'incomplete') return reject('trial-only-at-creation');
        next.subState = 'trialing';
        next.cents = Number(p.cents ?? 0);
        unchanged('dunningAttempts', 'hasPaymentMethod');
      },
      PAYMENT_SUCCEEDED: (model) => (p, { reject, next }) => {
        if (!LIVE.includes(model.subState)) return reject('not-collectable');
        // Payment on a trialing subscription is the trial converting early.
        next.subState = 'active';
        next.dunningAttempts = 0;
        next.hasPaymentMethod = true;
        next.cents = Number(p.cents ?? model.cents);
      },
      PAYMENT_FAILED: (model) => (p, { reject, next, unchanged }) => {
        if (!LIVE.includes(model.subState)) return reject('not-collectable');
        if (model.subState === 'incomplete') return reject('first-invoice-still-open');
        if (model.subState === 'unpaid') return reject('already-unpaid');
        // Dunning: each failure burns one attempt; the budget is finite and
        // exhausting it moves the subscription to unpaid, not to canceled —
        // Stripe keeps the record so the customer can recover it.
        const attempts = model.dunningAttempts + 1;
        next.dunningAttempts = attempts;
        next.subState = attempts >= MAX_DUNNING ? 'unpaid' : 'pastDue';
        unchanged('hasPaymentMethod', 'cents');
      },
      TRIAL_ENDED: (model) => (p, { reject, next, unchanged }) => {
        if (model.subState !== 'trialing') return reject('not-trialing');
        // No card on file when the trial lapses: Stripe cannot collect, so the
        // subscription lands in dunning rather than going active.
        if (!model.hasPaymentMethod) {
          next.dunningAttempts = 1;
          next.subState = 'pastDue';
          unchanged('hasPaymentMethod', 'cents');
          return;
        }
        next.subState = 'active';
        unchanged('dunningAttempts', 'hasPaymentMethod', 'cents');
      },
      ATTACH_PAYMENT_METHOD: (model) => (p, { reject, next, unchanged }) => {
        if (!LIVE.includes(model.subState)) return reject('not-live');
        if (model.hasPaymentMethod) return reject('already-attached');
        next.hasPaymentMethod = true;
        unchanged('subState', 'dunningAttempts', 'cents');
      },
      CANCEL: (model) => (p, { reject, next, unchanged }) => {
        if (!LIVE.includes(model.subState)) return reject('already-terminal');
        next.subState = 'canceled';
        unchanged('dunningAttempts', 'hasPaymentMethod', 'cents');
      },
      REFUND_ISSUED: (model) => (p, { reject, next, unchanged }) => {
        if (!['active', 'pastDue', 'unpaid'].includes(model.subState)) return reject('nothing-to-refund');
        next.cents = 0;
        unchanged('subState', 'dunningAttempts', 'hasPaymentMethod');
      },
      INCOMPLETE_EXPIRED: (model) => (p, { reject, next, unchanged }) => {
        if (model.subState !== 'incomplete') return reject('not-incomplete');
        next.subState = 'incompleteExpired';
        unchanged('dunningAttempts', 'hasPaymentMethod', 'cents');
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

module.exports = { instance, init, actions, getState, setState, MAX_DUNNING, LIVE };
