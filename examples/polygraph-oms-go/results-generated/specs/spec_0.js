'use strict';

const { createInstance } = require('@cognitive-fab/sam-pattern');

const instance = createInstance({ strict: true, hasAsyncActions: false });

// status: 'pending' | 'customerActionRequired' | 'processing' | 'completed'
//       | 'failed' | 'cancelled' | 'timedOut'
// fulfillments: array of 'pending' | 'unavailable' | 'processing'
//             | 'completed' | 'cancelled' | 'failed'
const INITIAL_STATE = { status: 'pending', fulfillments: [] };

const UNFINISHED = ['pending', 'processing'];
const isUnfinished = (s) => UNFINISHED.indexOf(s) !== -1;

// Order-level completion resolution when the last fulfillment finishes:
// 'failed' iff every fulfillment is 'failed' (and there is at least one),
// otherwise 'completed' (mixes and even all-cancelled roll up to 'completed').
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
      // ReserveItems resolved: build one fulfillment per availability entry.
      RESERVED: (model) => (proposal, { reject }) => {
        if (model.status !== 'pending') {
          return reject('reservation-splits-and-routes');
        }
        const available = Array.isArray(proposal.available) ? proposal.available : null;
        if (!available || available.length === 0) {
          return reject('out-of-scope-actions-are-noops');
        }
        const built = available.map((a) => (a === true ? 'pending' : 'unavailable'));
        if (built.some((s) => s === 'unavailable')) {
          // Some fulfillment is unavailable: await customer action.
          model.fulfillments = built;
          model.status = 'customerActionRequired';
        } else {
          // Everything available: order starts processing and every
          // fulfillment goroutine starts immediately in the same step.
          model.fulfillments = built.map(() => 'processing');
          model.status = 'processing';
        }
      },

      CUSTOMER_ACTION: (model) => (proposal, { reject }) => {
        if (proposal.action === 'amend') {
          if (model.status !== 'customerActionRequired') {
            return reject('amend-cancels-unavailable-then-processes');
          }
          // Unavailable fulfillments are cancelled; the order moves to
          // processing and remaining fulfillments start processing.
          const next = model.fulfillments.map((s) => {
            if (s === 'unavailable') return 'cancelled';
            if (s === 'pending') return 'processing';
            return s;
          });
          model.fulfillments = next;
          if (next.some(isUnfinished)) {
            model.status = 'processing';
          } else {
            // All fulfillments were unavailable → all cancelled → processing
            // completes immediately (zero failures ≠ all-failed).
            model.status = rollupStatus(next);
          }
          return undefined;
        }
        if (proposal.action === 'cancel') {
          if (model.status !== 'customerActionRequired') {
            return reject('cancel-leaves-fulfillments');
          }
          // Order cancelled; fulfillment statuses are left as they are.
          model.status = 'cancelled';
          return undefined;
        }
        // Invalid customer action string: observable no-op.
        return reject('out-of-scope-actions-are-noops');
      },

      CUSTOMER_TIMEOUT: (model) => (proposal, { reject }) => {
        if (model.status !== 'customerActionRequired') {
          return reject('timeout-cancels-everything');
        }
        model.fulfillments = model.fulfillments.map(() => 'cancelled');
        model.status = 'timedOut';
      },

      CHARGE_RESULT: (model) => (proposal, { reject }) => {
        if (model.status !== 'processing') {
          return reject('completion-rollup');
        }
        const i = proposal.index;
        if (
          typeof i !== 'number' ||
          !Number.isInteger(i) ||
          i < 0 ||
          i >= model.fulfillments.length ||
          !isUnfinished(model.fulfillments[i])
        ) {
          return reject('out-of-scope-actions-are-noops');
        }
        if (proposal.success === true) {
          // Charge succeeded: fulfillment stays 'processing' while its
          // shipment child runs — no observable change.
          return undefined;
        }
        // Charge failed: fulfillment fails; roll up if it was the last one.
        const next = model.fulfillments.slice();
        next[i] = 'failed';
        model.fulfillments = next;
        if (!next.some(isUnfinished)) {
          model.status = rollupStatus(next);
        }
        return undefined;
      },

      SHIPMENT_RESULT: (model) => (proposal, { reject }) => {
        if (model.status !== 'processing') {
          return reject('completion-rollup');
        }
        const i = proposal.index;
        if (
          typeof i !== 'number' ||
          !Number.isInteger(i) ||
          i < 0 ||
          i >= model.fulfillments.length ||
          !isUnfinished(model.fulfillments[i])
        ) {
          return reject('out-of-scope-actions-are-noops');
        }
        const next = model.fulfillments.slice();
        next[i] = proposal.ok === true ? 'completed' : 'failed';
        model.fulfillments = next;
        if (!next.some(isUnfinished)) {
          model.status = rollupStatus(next);
        }
        return undefined;
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