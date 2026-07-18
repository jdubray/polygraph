'use strict';

const { createInstance } = require('@cognitive-fab/sam-pattern');

const instance = createInstance({ strict: true, hasAsyncActions: false });

const INITIAL_STATE = {
  shipState: 'preparing',
};

const modelShape = {
  shipState: { type: 'string' },
};

const actionDefs = {
  SHIP: {
    action: (data = {}) => ({ ...data }),
    schema: {},
    domain: [{}],
  },
  DELIVER: {
    action: (data = {}) => ({ ...data }),
    schema: {},
    domain: [{}],
  },
  CANCEL_SHIPMENT: {
    action: (data = {}) => ({ ...data }),
    schema: {},
    domain: [{}],
  },
};

const acceptors = {
  SHIP: (model) => (proposal, { reject }) => {
    if (model.shipState !== 'preparing') {
      reject('already-shipped');
      return;
    }
    model.shipState = 'inTransit';
  },
  DELIVER: (model) => (proposal, { reject }) => {
    if (model.shipState !== 'inTransit') {
      reject('not-in-transit');
      return;
    }
    model.shipState = 'delivered';
  },
  CANCEL_SHIPMENT: (model) => (proposal, { reject }) => {
    if (model.shipState !== 'preparing') {
      reject('cancel-too-late');
      return;
    }
    model.shipState = 'cancelledShipment';
  },
};

const { intents } = instance({
  component: {
    modelShape,
    actions: actionDefs,
    acceptors,
  },
});

const actions = {
  SHIP: (data = {}) => intents.SHIP(data),
  DELIVER: (data = {}) => intents.DELIVER(data),
  CANCEL_SHIPMENT: (data = {}) => intents.CANCEL_SHIPMENT(data),
};

const getState = () => instance({}).getState();
const setState = (snapshot) => instance({}).setState(snapshot);
const init = () => setState(INITIAL_STATE);

module.exports = { instance, init, actions, getState, setState };