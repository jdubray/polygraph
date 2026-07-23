// check-product fixture — shipment child whose cancel handler writes the
// frozen pre-state (throwing mid-step — the kernel FR-2.5/FR-1.3 poison
// class, the 2.1 face of 2.0's mutate-then-reject) when the kernel's
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
      SHIP: (model) => (p, { reject, next }) => {
        if (model.shipState !== 'preparing') return reject('already-shipped');
        next.shipState = 'inTransit';
      },
      DELIVER: (model) => (p, { reject, next }) => {
        if (model.shipState !== 'inTransit') return reject('not-in-transit');
        next.shipState = 'delivered';
      },
      CANCEL_SHIPMENT: (model) => (p, { reject, next }) => {
        if (p.reason === 'parent-terminal' && model.shipState === 'inTransit') {
          // DELIBERATE defect: write the frozen pre-state. Under sam-lib 2.1
          // next-state semantics this throws SamShapeError mid-step — the
          // same kernel FR-1.3/FR-2.5 poison class the 2.0 mutate-then-reject
          // exercised (a 2.1 `next` write before reject is discarded cleanly,
          // so the frozen-model write is how this defect stays reachable).
          model.shipState = 'recallRequested';
          return reject('carrier-recall-crashed'); // unreachable: the write above throws
        }
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
