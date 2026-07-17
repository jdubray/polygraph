// Test fixture: a minimal shipment child machine (SAM v2 strict profile).
// preparing → SHIP → inTransit → DELIVER → delivered (terminal)
// preparing → CANCEL_SHIPMENT → cancelledShipment (terminal)
'use strict';

const { createInstance } = require('@cognitive-fab/sam-pattern');

const instance = createInstance({ strict: true, hasAsyncActions: false, instanceName: 'shipment' });

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
      SHIP: (model) => (p, { reject }) => {
        if (model.shipState !== 'preparing') return reject('already-shipped');
        model.shipState = 'inTransit';
      },
      DELIVER: (model) => (p, { reject }) => {
        if (model.shipState !== 'inTransit') return reject('not-in-transit');
        model.shipState = 'delivered';
      },
      CANCEL_SHIPMENT: (model) => (p, { reject }) => {
        if (model.shipState !== 'preparing') return reject('cancel-too-late');
        model.shipState = 'cancelledShipment';
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
