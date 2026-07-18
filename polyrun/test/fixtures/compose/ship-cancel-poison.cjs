// check-product fixture — shipment child whose cancel handler MUTATES the
// model and then rejects (the kernel FR-2.5 poison class) when the kernel's
// FR-8.4 payload arrives while inTransit. The domain walk (payload {}) never
// sees it; only cancelFor's concrete probe with { reason: 'parent-terminal' }
// does — the case an abstraction must surface as a reachable poison, never
// swallow as an over-approximation.
'use strict';

const { createInstance } = require('@cognitive-fab/sam-pattern');

const instance = createInstance({ strict: true, hasAsyncActions: false, instanceName: 'compose-ship-cancel-poison' });

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
        if (p.reason === 'parent-terminal' && model.shipState === 'inTransit') {
          model.shipState = 'recallRequested'; // mutate…
          return reject('carrier-recall-crashed'); // …then reject: FR-2.5 poison
        }
        if (!['preparing', 'inTransit'].includes(model.shipState)) return reject('cancel-too-late');
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
