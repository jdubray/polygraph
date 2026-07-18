// check-product fixture — parent purchase-order machine.
// pending → START → fulfilling → CHILD_DONE → completed; CANCEL (from
// pending|fulfilling) → cancelled. Spawns one shipment child on entering
// 'fulfilling' (see parent-po.effects.cjs).
'use strict';

const { createInstance } = require('@cognitive-fab/sam-pattern');

const instance = createInstance({ strict: true, hasAsyncActions: false, instanceName: 'compose-po' });

const INITIAL_STATE = { poState: 'pending' };

const control = instance({
  initialState: JSON.parse(JSON.stringify(INITIAL_STATE)),
  component: {
    modelShape: { poState: { type: 'string' } },
    actions: {
      START: { action: (d = {}) => ({ ...d }), schema: {}, domain: [{}] },
      CHILD_DONE: { action: (d = {}) => ({ ...d }), schema: {}, domain: [{ childKey: 'c1', childState: { shipState: 'delivered' } }] },
      CANCEL: { action: (d = {}) => ({ ...d }), schema: {}, domain: [{}] },
    },
    acceptors: {
      START: (model) => (p, { reject }) => {
        if (model.poState !== 'pending') return reject('already-started');
        model.poState = 'fulfilling';
      },
      CHILD_DONE: (model) => (p, { reject }) => {
        if (model.poState !== 'fulfilling') return reject('stale-completion');
        model.poState = 'completed';
      },
      CANCEL: (model) => (p, { reject }) => {
        if (!['pending', 'fulfilling'].includes(model.poState)) return reject('not-cancellable');
        model.poState = 'cancelled';
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
