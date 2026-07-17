// NEGATIVE control: mutated reference spec of the Order workflow's
// observable transition function (SAM v2 strict profile). Written from the
// vendored Go source — including its SURPRISES (all-cancelled completes,
// partial failures complete, cancel leaves fulfillment statuses). The
// harness must score this at 100% before any generated spec is trusted.
'use strict';

const { createInstance } = require('@cognitive-fab/sam-pattern');

const instance = createInstance({ strict: true, hasAsyncActions: false, instanceName: 'orderMut' });

const INITIAL_STATE = { status: 'pending', fulfillments: [] };

const finishRollup = (model) => {
  const fs = model.fulfillments;
  const unfinished = fs.some((f) => f === 'pending' || f === 'processing');
  if (unfinished) return;
  // Mirrors allFulfillmentsFailed(): failed only when EVERY fulfillment
  // failed (>=1); everything else — including all-cancelled — completes.
  const failures = fs.filter((f) => f === 'failed').length;
  model.status = failures >= 1 && failures === fs.length ? 'failed' : 'completed';
};

const { intents } = instance({
  initialState: JSON.parse(JSON.stringify(INITIAL_STATE)),
  component: {
    modelShape: {
      status: { type: 'string' },
      fulfillments: { type: 'array' },
    },
    actions: {
      RESERVED: { action: (d = {}) => ({ ...d }), schema: {}, domain: [{ available: [true] }, { available: [false] }, { available: [true, true] }, { available: [true, false] }, { available: [false, false] }] },
      CUSTOMER_ACTION: { action: (d = {}) => ({ ...d }), schema: {}, domain: [{ action: 'amend' }, { action: 'cancel' }] },
      CUSTOMER_TIMEOUT: { action: (d = {}) => ({ ...d }), schema: {}, domain: [{}] },
      CHARGE_RESULT: { action: (d = {}) => ({ ...d }), schema: {}, domain: [{ index: 0, success: true }, { index: 0, success: false }, { index: 1, success: true }, { index: 1, success: false }] },
      SHIPMENT_RESULT: { action: (d = {}) => ({ ...d }), schema: {}, domain: [{ index: 0, ok: true }, { index: 0, ok: false }, { index: 1, ok: true }, { index: 1, ok: false }] },
    },
    acceptors: {
      RESERVED: (model) => (p, { reject }) => {
        if (model.status !== 'pending') return reject('reservation-splits-and-routes');
        if (!Array.isArray(p.available) || p.available.length === 0) return reject('reservation-splits-and-routes');
        const fs = p.available.map((a) => (a ? 'pending' : 'unavailable'));
        if (fs.includes('unavailable')) {
          model.status = 'customerActionRequired';
          model.fulfillments = fs;
        } else {
          model.status = 'processing';
          model.fulfillments = fs.map(() => 'processing');
        }
      },
      CUSTOMER_ACTION: (model) => (p, { reject }) => {
        if (model.status !== 'customerActionRequired') return reject('out-of-scope-actions-are-noops');
        if (p.action === 'cancel') {
          // The code path returns without touching fulfillment statuses.
          model.status = 'cancelled';
          return;
        }
        if (p.action !== 'amend') return reject('out-of-scope-actions-are-noops');
        model.fulfillments = model.fulfillments.map((f) => (f === 'unavailable' ? 'cancelled' : f));
        model.status = 'processing';
        model.fulfillments = model.fulfillments.map((f) => (f === 'pending' ? 'processing' : f));
        finishRollup(model); // all-cancelled amend completes IN THE SAME STEP
      },
      CUSTOMER_TIMEOUT: (model) => (p, { reject }) => {
        if (model.status !== 'customerActionRequired') return reject('out-of-scope-actions-are-noops');
        model.fulfillments = model.fulfillments.map(() => 'cancelled');
        model.status = 'timedOut';
      },
      CHARGE_RESULT: (model) => (p, { reject }) => {
        if (model.status !== 'processing') return reject('out-of-scope-actions-are-noops');
        if (!Number.isInteger(p.index) || model.fulfillments[p.index] !== 'processing') return reject('out-of-scope-actions-are-noops');
        // MUTANT: charge failures are silently absorbed (the failure branch
        // is gone) — the negative control the harness must catch.
        finishRollup(model);
      },
      SHIPMENT_RESULT: (model) => (p, { reject }) => {
        if (model.status !== 'processing') return reject('out-of-scope-actions-are-noops');
        if (!Number.isInteger(p.index) || model.fulfillments[p.index] !== 'processing') return reject('out-of-scope-actions-are-noops');
        model.fulfillments = model.fulfillments.map((f, i) => (i === p.index ? (p.ok ? 'completed' : 'failed') : f));
        finishRollup(model);
      },
    },
    reactors: [],
  },
});

const getState = () => instance({}).getState();
const setState = (snapshot) => { instance({}).setState(snapshot); };
const init = () => { setState(JSON.parse(JSON.stringify(INITIAL_STATE))); };
const actions = Object.fromEntries(Object.keys(intents).map((n) => [n, (d = {}) => intents[n](d)]));

module.exports = { instance, init, actions, getState, setState };
