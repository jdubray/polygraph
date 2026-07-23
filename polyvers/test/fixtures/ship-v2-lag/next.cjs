// polyvers CP-M3 product fixture — shipment child whose cancel window
// NARROWED between versions: v1 cancels from preparing|inTransit, this v2
// cancels only from 'preparing'. Protocol/delivery is intact (the cancel
// still lands as a NAMED reject), so `polyvers matrix` passes it — but the
// JOINT product check finds the interleaving: parent cancels while
// inTransit → cancel rejected → shipment delivers under a cancelled order.
'use strict';

const { createInstance } = require('@cognitive-fab/sam-pattern');

const instance = createInstance({ strict: true, hasAsyncActions: false, instanceName: 'ship-v2-lag' });

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
        if (model.shipState !== 'preparing') return reject('cancel-too-late');
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
