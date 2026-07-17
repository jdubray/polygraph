'use strict';

const { createInstance } = require('@cognitive-fab/sam-pattern');

const instance = createInstance({ strict: true, hasAsyncActions: false });

// status: 'pending' | 'customerActionRequired' | 'processing' | 'completed'
//       | 'failed' | 'cancelled' | 'timedOut'
// fulfillments: array of
//   'pending' | 'unavailable' | 'processing' | 'completed' | 'cancelled' | 'failed'
const INITIAL_STATE = { status: 'pending', fulfillments: [] };

// A fulfillment is "unfinished" while it is still awaited by the workflow.
const isUnfinished = (s) => s === 'pending' || s === 'processing';

// Order completion roll-up: 'failed' iff every fulfillment failed (>= 1),
// otherwise 'completed' (mixes and even all-cancelled complete the order).
const rollupStatus = (fulfillments) => {
  const failures = fulfillments.filter((s) => s === 'failed').length;
  if (failures >= 1 && failures === fulfillments.length) return 'failed';
  return 'completed';
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
      RESERVED: (model) => (proposal, { reject }) => {
        if (model.status !== 'pending') {
          return reject('out-of-scope-actions-are-noops');
        }
        const available = proposal.available;
        if (!Array.isArray(available) || available.length === 0) {
          return reject('reservation-splits-and-routes');
        }
        const fulfillments = available.map((a) =>
          a === true ? 'pending' : 'unavailable'
        );
        if (fulfillments.some((s) => s === 'unavailable')) {
          model.status = 'customerActionRequired';
          model.fulfillments = fulfillments;
        } else {
          // No customer action required: the workflow immediately starts
          // processing every fulfillment in the same step.
          model.status = 'processing';
          model.fulfillments = fulfillments.map(() => 'processing');
        }
      },

      CUSTOMER_ACTION: (model) => (proposal, { reject }) => {
        if (model.status !== 'customerActionRequired') {
          return reject('out-of-scope-actions-are-noops');
        }
        if (proposal.action === 'cancel') {
          // Order cancelled; fulfillment statuses are left as they are.
          model.status = 'cancelled';
          return;
        }
        if (proposal.action === 'amend') {
          // Unavailable fulfillments are cancelled, then processing starts.
          const fulfillments = model.fulfillments.map((s) => {
            if (s === 'unavailable') return 'cancelled';
            if (s === 'pending') return 'processing';
            return s;
          });
          if (fulfillments.some(isUnfinished)) {
            model.status = 'processing';
          } else {
            // All fulfillments were unavailable → all cancelled → processing
            // completes immediately (zero failures is not all-failed).
            model.status = rollupStatus(fulfillments);
          }
          model.fulfillments = fulfillments;
          return;
        }
        // Invalid customer action: the code does not act on it here.
        return reject('amend-cancels-unavailable-then-processes');
      },

      CUSTOMER_TIMEOUT: (model) => (proposal, { reject }) => {
        if (model.status !== 'customerActionRequired') {
          return reject('out-of-scope-actions-are-noops');
        }
        // Every fulfillment is cancelled; the order times out.
        model.status = 'timedOut';
        model.fulfillments = model.fulfillments.map(() => 'cancelled');
      },

      CHARGE_RESULT: (model) => (proposal, { reject }) => {
        if (model.status !== 'processing') {
          return reject('out-of-scope-actions-are-noops');
        }
        const i = proposal.index;
        if (
          !Number.isInteger(i) ||
          i < 0 ||
          i >= model.fulfillments.length ||
          model.fulfillments[i] !== 'processing'
        ) {
          // No matching unfinished fulfillment awaits this charge result.
          return reject('completion-rollup');
        }
        if (proposal.success === true) {
          // Charge succeeded: fulfillment stays 'processing' while its
          // shipment child workflow runs. No observable change.
          return;
        }
        // Charge failed: the fulfillment fails; no shipment is started.
        const fulfillments = model.fulfillments.slice();
        fulfillments[i] = 'failed';
        model.fulfillments = fulfillments;
        if (!fulfillments.some(isUnfinished)) {
          model.status = rollupStatus(fulfillments);
        }
      },

      SHIPMENT_RESULT: (model) => (proposal, { reject }) => {
        if (model.status !== 'processing') {
          return reject('out-of-scope-actions-are-noops');
        }
        const i = proposal.index;
        if (
          !Number.isInteger(i) ||
          i < 0 ||
          i >= model.fulfillments.length ||
          model.fulfillments[i] !== 'processing'
        ) {
          // No matching unfinished fulfillment awaits this shipment result.
          return reject('completion-rollup');
        }
        const fulfillments = model.fulfillments.slice();
        fulfillments[i] = proposal.ok === true ? 'completed' : 'failed';
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