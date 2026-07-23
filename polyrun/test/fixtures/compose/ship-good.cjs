// check-product fixture — shipment child whose cancel window covers every
// non-terminal state (preparing AND inTransit): the composition-safe variant.
// Contrast with ../shipment-machine.cjs, which cancels only from 'preparing'
// and therefore leaves an inTransit shipment running under a cancelled order.
'use strict';

const { createInstance } = require('@cognitive-fab/sam-pattern');

const instance = createInstance({ strict: true, hasAsyncActions: false, instanceName: 'compose-ship-good' });

const INITIAL_STATE = { shipState: 'preparing' };

const control = instance({
  initialState: JSON.parse(JSON.stringify(INITIAL_STATE)),
  component: {
    modelShape: { shipState: { type: 'string' } },
    actions: {
      SHIP: { action: (d = {}) => ({ ...d }), schema: {}, domain: [{}] },
      DELIVER: { action: (d = {}) => ({ ...d }), schema: {}, domain: [{}] },
      CANCEL_SHIPMENT: { action: (d = {}) => ({ ...d }), schema: {}, domain: [{}] },
    },
    acceptors: {
      SHIP: (model) => (p, { reject, next }) => {
        if (model.shipState !== 'preparing') return reject('already-shipped');
        next.shipState = 'inTransit';
      },
      DELIVER: (model) => (p, { reject, next }) => {
        if (model.shipState !== 'inTransit') return reject('not-in-transit');
        next.shipState = 'delivered';
      },
      CANCEL_SHIPMENT: (model) => (p, { reject, next }) => {
        if (!['preparing', 'inTransit'].includes(model.shipState)) return reject('cancel-too-late');
        next.shipState = 'cancelledShipment';
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

module.exports = { instance, init, actions, getState, setState };
