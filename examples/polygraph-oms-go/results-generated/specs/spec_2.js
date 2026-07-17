'use strict';

const { createInstance } = require('@cognitive-fab/sam-pattern');

const instance = createInstance({ strict: true, hasAsyncActions: false });

// status: 'pending' | 'customerActionRequired' | 'processing' | 'completed'
//         | 'failed' | 'cancelled' | 'timedOut'
// fulfillments: array of 'pending' | 'unavailable' | 'processing'
//               | 'completed' | 'cancelled' | 'failed'
const INITIAL_STATE = { status: 'pending', fulfillments: [] };

const isUnfinished = (s) => s === 'pending' || s === 'processing';

// Mirrors allFulfillmentsFailed(): 'failed' only if every fulfillment failed
// (at least one); cancelled/completed mixes — even ALL-cancelled — complete.
const rollupStatus = (fulfillments) => {
  const failures = fulfillments.filter((s) => s === 'failed').length;
  return failures >= 1 && failures === fulfillments.length ? 'failed' : 'completed';
};

const control = instance({
  initialState: { ...INITIAL_STATE },
  component: {
    modelShape: {
      status: { type: 'string' },
      fulfillments: { type: 'array' },
    },
    actions: {
      RESERVED: {
        action: (data = {}) => ({ ...data }),
        schema: { available: { type: 'array', required: true } },
        domain: [
          { available: [true] },
          { available: [false] },
          { available: [true, true] },
          { available: [true, false] },
          { available: [false, false] },
        ],
      },
      CUSTOMER_ACTION: {
        action: (data = {}) => ({ ...data }),
        schema: { action: { type: 'string', required: true } },
        domain: [{ action: 'amend' }, { action: 'cancel' }],
      },
      CUSTOMER_TIMEOUT: {
        action: (data = {}) => ({ ...data }),
        schema: {},
        domain: [{}],
      },
      CHARGE_RESULT: {
        action: (data = {}) => ({ ...data }),
        schema: {
          index: { type: 'number', required: true },
          success: { type: 'boolean', required: true },
        },
        domain: [
          { index: 0, success: true },
          { index: 0, success: false },
          { index: 1, success: true },
          { index: 1, success: false },
        ],
      },
      SHIPMENT_RESULT: {
        action: (data = {}) => ({ ...data }),
        schema: {
          index: { type: 'number', required: true },
          ok: { type: 'boolean', required: true },
        },
        domain: [
          { index: 0, ok: true },
          { index: 0, ok: false },
          { index: 1, ok: true },
          { index: 1, ok: false },
        ],
      },
    },
    acceptors: {
      // buildFulfillments + routing: only meaningful from 'pending'.
      RESERVED: (model) => (proposal, { reject }) => {
        if (model.status !== 'pending') return reject('reservation-splits-and-routes');
        if (!Array.isArray(proposal.available) || proposal.available.length === 0) {
          return reject('out-of-scope-actions-are-noops');
        }
        let fulfillments = proposal.available.map((a) => (a ? 'pending' : 'unavailable'));
        if (fulfillments.some((s) => s === 'unavailable')) {
          // customerActionRequired branch of run()
          model.status = 'customerActionRequired';
          model.fulfillments = fulfillments;
        } else {
          // Straight to processing: all fulfillment goroutines start at once.
          fulfillments = fulfillments.map(() => 'processing');
          model.status = 'processing';
          model.fulfillments = fulfillments;
        }
      },
      CUSTOMER_ACTION: (model) => (proposal, { reject }) => {
        if (proposal.action === 'amend') {
          if (model.status !== 'customerActionRequired') {
            return reject('amend-cancels-unavailable-then-processes');
          }
          // cancelUnavailableFulfillments(), then processing starts:
          // every remaining pending fulfillment begins processing.
          const fulfillments = model.fulfillments.map((s) => {
            if (s === 'unavailable') return 'cancelled';
            if (s === 'pending') return 'processing';
            return s;
          });
          model.fulfillments = fulfillments;
          // If everything was cancelled, Await(completed == len) is trivially
          // satisfied and the order resolves in the same step (→ 'completed').
          model.status = fulfillments.some(isUnfinished)
            ? 'processing'
            : rollupStatus(fulfillments);
          return;
        }
        if (proposal.action === 'cancel') {
          if (model.status !== 'customerActionRequired') {
            return reject('cancel-leaves-fulfillments');
          }
          // The cancel path only updates the order status; fulfillment
          // statuses are left as they are in the source.
          model.status = 'cancelled';
          return;
        }
        // Invalid customer action value: no observable transition.
        return reject('out-of-scope-actions-are-noops');
      },
      CUSTOMER_TIMEOUT: (model) => (proposal, { reject }) => {
        if (model.status !== 'customerActionRequired') {
          return reject('timeout-cancels-everything');
        }
        // updateStatus(TimedOut) + cancelAllFulfillments()
        model.fulfillments = model.fulfillments.map(() => 'cancelled');
        model.status = 'timedOut';
      },
      CHARGE_RESULT: (model) => (proposal, { reject }) => {
        if (model.status !== 'processing') return reject('completion-rollup');
        const i = proposal.index;
        const current = model.fulfillments;
        if (!Number.isInteger(i) || i < 0 || i >= current.length || !isUnfinished(current[i])) {
          return reject('out-of-scope-actions-are-noops');
        }
        if (proposal.success) {
          // Successful charge: fulfillment stays 'processing' while its
          // shipment child runs — no observable change.
          return reject('out-of-scope-actions-are-noops');
        }
        // Charge failure: fulfillment fails; if it was the last unfinished
        // one, the order resolves in the same step.
        const fulfillments = current.map((s, k) => (k === i ? 'failed' : s));
        model.fulfillments = fulfillments;
        if (!fulfillments.some(isUnfinished)) {
          model.status = rollupStatus(fulfillments);
        }
      },
      SHIPMENT_RESULT: (model) => (proposal, { reject }) => {
        if (model.status !== 'processing') return reject('completion-rollup');
        const i = proposal.index;
        const current = model.fulfillments;
        if (!Number.isInteger(i) || i < 0 || i >= current.length || !isUnfinished(current[i])) {
          return reject('out-of-scope-actions-are-noops');
        }
        const fulfillments = current.map((s, k) =>
          k === i ? (proposal.ok ? 'completed' : 'failed') : s
        );
        model.fulfillments = fulfillments;
        if (!fulfillments.some(isUnfinished)) {
          model.status = rollupStatus(fulfillments);
        }
      },
    },
    reactors: [],
  },
});

const { intents } = control;

const getState = () => instance({}).getState();
const setState = (snapshot) => { instance({}).setState(snapshot); };

const init = () => { setState(INITIAL_STATE); };

const actions = {
  RESERVED: (data = {}) => intents.RESERVED(data),
  CUSTOMER_ACTION: (data = {}) => intents.CUSTOMER_ACTION(data),
  CUSTOMER_TIMEOUT: (data = {}) => intents.CUSTOMER_TIMEOUT(data),
  CHARGE_RESULT: (data = {}) => intents.CHARGE_RESULT(data),
  SHIPMENT_RESULT: (data = {}) => intents.SHIPMENT_RESULT(data),
};

module.exports = { instance, init, actions, getState, setState };