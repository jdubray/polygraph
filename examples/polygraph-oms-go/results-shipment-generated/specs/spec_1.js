'use strict';

const { createInstance } = require('@cognitive-fab/sam-pattern');

const instance = createInstance({ strict: true, hasAsyncActions: false });

// status: 'pending' | 'booked' | 'dispatched' | 'delivered' — documented values,
// but the code applies carrier-reported statuses VERBATIM (finding S1), so any
// string can appear once booked.
// booked: whether the BookShipment activity has completed (the carrier-update
// receive loop only drains signals after booking).
const INITIAL_STATE = { status: 'pending', booked: false };

const control = instance({
  initialState: { ...INITIAL_STATE },
  component: {
    modelShape: {
      status: { type: 'string' },
      booked: { type: 'boolean' },
    },
    actions: {
      BOOKED: {
        action: (data = {}) => ({ ...data }),
        schema: {},
        domain: [{}],
      },
      CARRIER_UPDATE: {
        action: (data = {}) => ({ ...data }),
        schema: { status: { type: 'string', required: true } },
        domain: [
          { status: 'booked' },
          { status: 'dispatched' },
          { status: 'delivered' },
          { status: 'pending' },
          { status: 'lost-in-transit' },
        ],
      },
    },
    acceptors: {
      // BookShipment completes exactly once, and only while the shipment is
      // still 'pending' (before booking). Anywhere else it is a no-op.
      BOOKED: (model) => (proposal, { reject }) => {
        if (model.booked || model.status !== 'pending') {
          return reject('booking-first');
        }
        model.status = 'booked';
        model.booked = true;
      },
      // The receive loop drains carrier updates only after booking and exits
      // permanently once status becomes 'delivered'. While draining, the
      // signal's status is applied VERBATIM — including out-of-enum values,
      // duplicates, and regressions (even back to 'pending').
      CARRIER_UPDATE: (model) => (proposal, { reject }) => {
        if (!model.booked || model.status === 'delivered') {
          return reject('no-updates-before-booking-or-after-delivery');
        }
        if (typeof proposal.status !== 'string') {
          return reject('carrier-update-verbatim');
        }
        model.status = proposal.status;
      },
    },
    reactors: [],
  },
});

const { intents } = control;

const getState = () => instance({}).getState();
const setState = (snapshot) => { instance({}).setState(snapshot); };

const init = () => { setState(INITIAL_STATE); };

const actions = {
  BOOKED: (data = {}) => intents.BOOKED(data),
  CARRIER_UPDATE: (data = {}) => intents.CARRIER_UPDATE(data),
};

module.exports = { instance, init, actions, getState, setState };