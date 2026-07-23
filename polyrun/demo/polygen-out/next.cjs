'use strict';

const { createInstance } = require('@cognitive-fab/sam-pattern');

const instance = createInstance({ strict: true, hasAsyncActions: false });

const INITIAL_STATE = {
  orderState: 'pending',
  totalCents: 0,
  txId: '',
  cancelReason: '',
};

const modelShape = {
  orderState: { type: 'string' },
  totalCents: { type: 'number' },
  txId: { type: 'string' },
  cancelReason: { type: 'string' },
};

const actionDefs = {
  SUBMIT: {
    action: (data = {}) => ({ ...data }),
    schema: { totalCents: { type: 'number', required: true } },
    domain: [{ totalCents: 2500 }],
  },
  FRAUD_PASSED: {
    action: (data = {}) => ({ ...data }),
    schema: { itemsAvailable: { type: 'boolean', required: true } },
    domain: [{ itemsAvailable: true }, { itemsAvailable: false }],
  },
  FRAUD_FAILED: {
    action: (data = {}) => ({ ...data }),
    schema: { reason: { type: 'string', required: true } },
    domain: [{ reason: 'suspicious' }],
  },
  AMEND: {
    action: (data = {}) => ({ ...data }),
    schema: { totalCents: { type: 'number', required: true } },
    domain: [{ totalCents: 1900 }],
  },
  AMEND_WINDOW_EXPIRED: {
    action: (data = {}) => ({ ...data }),
    schema: {},
    domain: [{}],
  },
  CHARGE_SUCCEEDED: {
    action: (data = {}) => ({ ...data }),
    schema: { txId: { type: 'string', required: true } },
    domain: [{ txId: 'tx-1' }],
  },
  CHARGE_FAILED: {
    action: (data = {}) => ({ ...data }),
    schema: { reason: { type: 'string', required: true } },
    domain: [{ reason: 'declined' }],
  },
  CHARGE_TIMED_OUT: {
    action: (data = {}) => ({ ...data }),
    schema: {},
    domain: [{}],
  },
  CANCEL: {
    action: (data = {}) => ({ ...data }),
    schema: { reason: { type: 'string', required: true } },
    domain: [{ reason: 'customer-request' }],
  },
  SHIPMENT_DELIVERED: {
    action: (data = {}) => ({ ...data }),
    schema: {},
    domain: [{}],
  },
};

const acceptors = {
  SUBMIT: (model) => (proposal, { reject, next, unchanged }) => {
    if (model.orderState !== 'pending') {
      return reject('submit-not-applicable');
    }
    if (typeof proposal.totalCents !== 'number' ||
        !Number.isInteger(proposal.totalCents) ||
        proposal.totalCents < 0) {
      return reject('invalid-total');
    }
    next.orderState = 'fraudCheck';
    next.totalCents = proposal.totalCents;
    unchanged('txId', 'cancelReason');
  },

  FRAUD_PASSED: (model) => (proposal, { reject, next, unchanged }) => {
    if (model.orderState !== 'fraudCheck') {
      return reject('fraud-result-not-applicable');
    }
    if (typeof proposal.itemsAvailable !== 'boolean') {
      return reject('invalid-items-available');
    }
    if (proposal.itemsAvailable) {
      next.orderState = 'charging';
    } else {
      next.orderState = 'awaitingAmend';
    }
    unchanged('totalCents', 'txId', 'cancelReason');
  },

  FRAUD_FAILED: (model) => (proposal, { reject, next, unchanged }) => {
    if (model.orderState !== 'fraudCheck') {
      return reject('fraud-result-not-applicable');
    }
    if (typeof proposal.reason !== 'string' || proposal.reason === '') {
      return reject('invalid-reason');
    }
    next.orderState = 'rejected';
    next.cancelReason = proposal.reason;
    unchanged('totalCents', 'txId');
  },

  AMEND: (model) => (proposal, { reject, next, unchanged }) => {
    if (model.orderState !== 'awaitingAmend') {
      return reject('amend-not-applicable');
    }
    if (typeof proposal.totalCents !== 'number' ||
        !Number.isInteger(proposal.totalCents) ||
        proposal.totalCents < 0) {
      return reject('invalid-total');
    }
    next.orderState = 'charging';
    next.totalCents = proposal.totalCents;
    unchanged('txId', 'cancelReason');
  },

  AMEND_WINDOW_EXPIRED: (model) => (proposal, { reject, next, unchanged }) => {
    if (model.orderState !== 'awaitingAmend') {
      return reject('stale-completions-reject');
    }
    next.orderState = 'cancelled';
    next.cancelReason = 'amend-window-expired';
    unchanged('totalCents', 'txId');
  },

  CHARGE_SUCCEEDED: (model) => (proposal, { reject, next, unchanged }) => {
    if (model.orderState !== 'charging') {
      return reject('stale-completions-reject');
    }
    if (typeof proposal.txId !== 'string' || proposal.txId === '') {
      return reject('invalid-tx-id');
    }
    next.orderState = 'shipping';
    next.txId = proposal.txId;
    unchanged('totalCents', 'cancelReason');
  },

  CHARGE_FAILED: (model) => (proposal, { reject, next, unchanged }) => {
    if (model.orderState !== 'charging') {
      return reject('stale-completions-reject');
    }
    if (typeof proposal.reason !== 'string' || proposal.reason === '') {
      return reject('invalid-reason');
    }
    next.orderState = 'paymentFailed';
    next.cancelReason = proposal.reason;
    unchanged('totalCents', 'txId');
  },

  CHARGE_TIMED_OUT: (model) => (proposal, { reject, next, unchanged }) => {
    if (model.orderState !== 'charging') {
      return reject('stale-completions-reject');
    }
    next.orderState = 'paymentFailed';
    next.cancelReason = 'charge-timed-out';
    unchanged('totalCents', 'txId');
  },

  CANCEL: (model) => (proposal, { reject, next, unchanged }) => {
    if (model.orderState === 'charging') {
      return reject('cancel-blocked-while-charging');
    }
    if (model.orderState !== 'pending' &&
        model.orderState !== 'fraudCheck' &&
        model.orderState !== 'awaitingAmend') {
      return reject('cancel-not-applicable');
    }
    if (typeof proposal.reason !== 'string' || proposal.reason === '') {
      return reject('invalid-reason');
    }
    next.orderState = 'cancelled';
    next.cancelReason = proposal.reason;
    unchanged('totalCents', 'txId');
  },

  SHIPMENT_DELIVERED: (model) => (proposal, { reject, next, unchanged }) => {
    if (model.orderState !== 'shipping') {
      return reject('stale-completions-reject');
    }
    next.orderState = 'completed';
    unchanged('totalCents', 'txId', 'cancelReason');
  },
};

const { intents } = instance({
  component: {
    modelShape,
    actions: actionDefs,
    acceptors,
  },
});

const getState = () => instance({}).getState();
const setState = (snapshot) => instance({}).setState(snapshot);
const init = () => setState(INITIAL_STATE);

const actions = {
  SUBMIT: (data = {}) => intents.SUBMIT(data),
  FRAUD_PASSED: (data = {}) => intents.FRAUD_PASSED(data),
  FRAUD_FAILED: (data = {}) => intents.FRAUD_FAILED(data),
  AMEND: (data = {}) => intents.AMEND(data),
  AMEND_WINDOW_EXPIRED: (data = {}) => intents.AMEND_WINDOW_EXPIRED(data),
  CHARGE_SUCCEEDED: (data = {}) => intents.CHARGE_SUCCEEDED(data),
  CHARGE_FAILED: (data = {}) => intents.CHARGE_FAILED(data),
  CHARGE_TIMED_OUT: (data = {}) => intents.CHARGE_TIMED_OUT(data),
  CANCEL: (data = {}) => intents.CANCEL(data),
  SHIPMENT_DELIVERED: (data = {}) => intents.SHIPMENT_DELIVERED(data),
};

init();

module.exports = { instance, init, actions, getState, setState };