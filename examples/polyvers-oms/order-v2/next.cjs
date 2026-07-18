'use strict';

const { createInstance } = require('@cognitive-fab/sam-pattern');

const instance = createInstance({ strict: true, hasAsyncActions: false });

const INITIAL_STATE = {
  orderState: 'pending',
  fulfillments: 0,
  shipmentsDelivered: 0,
  shipmentsFailed: 0,
  totalCents: 0,
  txId: '',
  cancelReason: '',
  amendCount: 0,
};

const modelShape = {
  orderState: { type: 'string' },
  fulfillments: { type: 'number' },
  shipmentsDelivered: { type: 'number' },
  shipmentsFailed: { type: 'number' },
  totalCents: { type: 'number' },
  txId: { type: 'string' },
  cancelReason: { type: 'string' },
  amendCount: { type: 'number' },
};

const componentActions = {
  SUBMIT: {
    action: (data = {}) => ({ ...data }),
    schema: {
      fulfillments: { type: 'number', required: true },
      totalCents: { type: 'number', required: true },
    },
    domain: [
      { fulfillments: 1, totalCents: 2500 },
      { fulfillments: 2, totalCents: 2500 },
    ],
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
    schema: {
      fulfillments: { type: 'number', required: true },
      totalCents: { type: 'number', required: true },
    },
    domain: [{ fulfillments: 1, totalCents: 1900 }],
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
  SHIPMENT_COMPLETED: {
    action: (data = {}) => ({ ...data }),
    schema: {
      childKey: { type: 'string', required: true },
      childState: { type: 'object', required: true },
    },
    domain: [
      { childKey: 'f1', childState: { shipState: 'delivered' } },
      { childKey: 'f1', childState: { shipState: 'cancelledShipment' } },
      { childKey: 'f2', childState: { shipState: 'delivered' } },
      { childKey: 'f2', childState: { shipState: 'cancelledShipment' } },
    ],
  },
  CANCEL: {
    action: (data = {}) => ({ ...data }),
    schema: { reason: { type: 'string', required: true } },
    domain: [{ reason: 'customer-request' }],
  },
};

// Contract's exact spellings for SHIPMENT_COMPLETED.childState.shipState
const SHIP_STATE_DELIVERED = 'delivered';
const SHIP_STATE_CANCELLED_SHIPMENT = 'cancelledShipment';

const acceptors = {
  SUBMIT: (model) => (proposal, { reject }) => {
    if (model.orderState !== 'pending') {
      return reject('amend-resets-rollup');
    }
    model.fulfillments = proposal.fulfillments;
    model.totalCents = proposal.totalCents;
    model.shipmentsDelivered = 0;
    model.shipmentsFailed = 0;
    model.orderState = 'fraudCheck';
  },

  FRAUD_PASSED: (model) => (proposal, { reject }) => {
    if (model.orderState !== 'fraudCheck') {
      return reject('stale-completions-reject');
    }
    if (proposal.itemsAvailable === true) {
      model.orderState = 'charging';
    } else {
      model.orderState = 'awaitingAmend';
    }
  },

  FRAUD_FAILED: (model) => (proposal, { reject }) => {
    if (model.orderState !== 'fraudCheck') {
      return reject('stale-completions-reject');
    }
    model.orderState = 'rejected';
    model.cancelReason = proposal.reason;
  },

  AMEND: (model) => (proposal, { reject }) => {
    // v2: count amendments (shape + rule change, gated by polyvers)
    if (model.orderState !== 'awaitingAmend') {
      return reject('amend-resets-rollup');
    }
    model.fulfillments = proposal.fulfillments;
    model.totalCents = proposal.totalCents;
    model.shipmentsDelivered = 0;
    model.shipmentsFailed = 0;
    model.orderState = 'charging';
    model.amendCount += 1;
  },

  AMEND_WINDOW_EXPIRED: (model) => (proposal, { reject }) => {
    if (model.orderState !== 'awaitingAmend') {
      return reject('stale-completions-reject');
    }
    model.orderState = 'cancelled';
    model.cancelReason = 'amend-window-expired';
  },

  CHARGE_SUCCEEDED: (model) => (proposal, { reject }) => {
    if (model.orderState !== 'charging') {
      return reject('stale-completions-reject');
    }
    model.txId = proposal.txId;
    model.orderState = 'fulfilling';
  },

  CHARGE_FAILED: (model) => (proposal, { reject }) => {
    if (model.orderState !== 'charging') {
      return reject('stale-completions-reject');
    }
    model.orderState = 'paymentFailed';
    model.cancelReason = proposal.reason;
  },

  CHARGE_TIMED_OUT: (model) => (proposal, { reject }) => {
    if (model.orderState !== 'charging') {
      return reject('stale-completions-reject');
    }
    model.orderState = 'paymentFailed';
    model.cancelReason = 'charge-timed-out';
  },

  SHIPMENT_COMPLETED: (model) => (proposal, { reject }) => {
    if (model.orderState !== 'fulfilling') {
      return reject('stale-completions-reject');
    }
    if (model.shipmentsDelivered + model.shipmentsFailed >= model.fulfillments) {
      return reject('rollup');
    }
    if (!proposal.childState || typeof proposal.childState !== 'object') {
      return reject('rollup');
    }
    const shipState = proposal.childState.shipState;
    if (shipState === SHIP_STATE_DELIVERED) {
      // childState = { shipState: 'delivered' } — count as delivered
      model.shipmentsDelivered = model.shipmentsDelivered + 1;
    } else if (shipState === SHIP_STATE_CANCELLED_SHIPMENT) {
      // childState = { shipState: 'cancelledShipment' } — count as failed
      model.shipmentsFailed = model.shipmentsFailed + 1;
    } else {
      return reject('rollup');
    }
    if (model.shipmentsDelivered + model.shipmentsFailed === model.fulfillments) {
      if (model.shipmentsFailed === 0) {
        model.orderState = 'completed';
      } else {
        model.orderState = 'partiallyDelivered';
      }
    }
  },

  CANCEL: (model) => (proposal, { reject }) => {
    if (model.orderState === 'charging') {
      return reject('cancel-blocked-while-charging');
    }
    if (model.orderState === 'fulfilling') {
      return reject('fulfillment-in-progress');
    }
    if (
      model.orderState !== 'pending' &&
      model.orderState !== 'fraudCheck' &&
      model.orderState !== 'awaitingAmend'
    ) {
      return reject('cancel-not-applicable');
    }
    model.orderState = 'cancelled';
    model.cancelReason = proposal.reason;
  },
};

const { intents } = instance({
  initialState: INITIAL_STATE,
  component: {
    // REPAIR (hand-applied, see REPAIR-NOTE.md): the generated `name: 'order'`
    // made this a NAMED component, binding acceptors to a LOCAL state tree —
    // every guard read undefined and rejected. Acceptors must operate on the
    // shared instance state tree, so the component is anonymous.
    modelShape,
    actions: componentActions,
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
  SHIPMENT_COMPLETED: (data = {}) => intents.SHIPMENT_COMPLETED(data),
  CANCEL: (data = {}) => intents.CANCEL(data),
};

module.exports = { instance, init, actions, getState, setState };