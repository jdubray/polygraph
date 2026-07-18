// polyvers M0 fixture v1 — minimal order machine (SAM v2 strict profile).
// pending → SUBMIT → charging → CHARGE_OK → fulfilling → SHIP → completed
// CANCEL from pending|charging → cancelled. Terminal: completed, cancelled.
'use strict';

const { createInstance } = require('@cognitive-fab/sam-pattern');

const instance = createInstance({ strict: true, hasAsyncActions: false, instanceName: 'order-v2-landmine' });

const INITIAL_STATE = { orderState: 'pending', totalCents: 0, txId: '' };

const control = instance({
  initialState: JSON.parse(JSON.stringify(INITIAL_STATE)),
  component: {
    modelShape: {
      orderState: { type: 'string' },
      totalCents: { type: 'number' },
      txId: { type: 'string' },
    },
    actions: {
      SUBMIT: { action: (d = {}) => ({ ...d }), schema: {}, domain: [{ totalCents: 2500 }] },
      CHARGE_OK: { action: (d = {}) => ({ ...d }), schema: {}, domain: [{ txId: 'tx-1' }] },
      SHIP: { action: (d = {}) => ({ ...d }), schema: {}, domain: [{}] },
      CANCEL: { action: (d = {}) => ({ ...d }), schema: {}, domain: [{}] },
    },
    acceptors: {
      SUBMIT: (model) => (p, { reject }) => {
        if (model.orderState !== 'pending') return reject('already-submitted');
        if (!(Number.isInteger(p.totalCents) && p.totalCents >= 1000)) return reject('invalid-total');
        model.orderState = 'charging';
        model.totalCents = p.totalCents;
      },
      CHARGE_OK: (model) => (p, { reject }) => {
        if (model.orderState !== 'charging') return reject('stale-completion-rejects');
        model.orderState = 'fulfilling';
        model.txId = String(p.txId || '');
      },
      SHIP: (model) => (p, { reject }) => {
        if (model.orderState !== 'fulfilling') return reject('not-fulfilling');
        model.orderState = 'completed';
      },
      CANCEL: (model) => (p, { reject }) => {
        if (!['pending', 'charging'].includes(model.orderState)) return reject('not-cancellable');
        model.orderState = 'cancelled';
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
