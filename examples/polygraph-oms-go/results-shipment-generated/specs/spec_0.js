'use strict';

const { createInstance } = require('@cognitive-fab/sam-pattern');

const instance = createInstance({ strict: true, hasAsyncActions: false });

// status: 'pending' | 'booked' | 'dispatched' | 'delivered' (documented set,
// NOT enforced by the code — carrier values are applied verbatim, finding S1)
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
      // BOOKED (the BookShipment activity completing) is only applicable
      // while status == 'pending'; it moves the shipment to 'booked'.
      BOOKED: (model) => (proposal, { reject }) => {
        if (model.status !== 'pending' || model.booked === true) {
          return reject('booking-first');
        }
        model.status = 'booked';
        model.booked = true;
      },
      // CARRIER_UPDATE: before booking the receive loop is not draining
      // (signal buffers — observable no-op) and after 'delivered' the
      // workflow has completed (terminal). Otherwise the carrier's status
      // is applied VERBATIM (including out-of-enum values, duplicates,
      // and regressions).
      CARRIER_UPDATE: (model) => (proposal, { reject }) => {
        if (model.booked === false || model.status === 'delivered') {
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