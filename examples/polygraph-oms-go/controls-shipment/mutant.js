// NEGATIVE control: sanitizing mutant of the Shipment workflow's
// observable transition function (SAM v2 strict profile) — including its
// SURPRISES: carrier updates applied verbatim (any string), regressions
// allowed, delivery reachable from anywhere post-booking.
'use strict';

const { createInstance } = require('@cognitive-fab/sam-pattern');

const instance = createInstance({ strict: true, hasAsyncActions: false, instanceName: 'shipMut' });

const INITIAL_STATE = { status: 'pending', booked: false };

const { intents } = instance({
  initialState: { ...INITIAL_STATE },
  component: {
    modelShape: { status: { type: 'string' }, booked: { type: 'boolean' } },
    actions: {
      BOOKED: { action: (d = {}) => ({ ...d }), schema: {}, domain: [{}] },
      CARRIER_UPDATE: {
        action: (d = {}) => ({ ...d }),
        schema: {},
        domain: [
          { status: 'booked' }, { status: 'dispatched' }, { status: 'delivered' },
          { status: 'pending' }, { status: 'lost-in-transit' },
        ],
      },
    },
    acceptors: {
      BOOKED: (model) => (p, { reject, next }) => {
        if (model.booked) return reject('booking-first');
        next.status = 'booked';
        next.booked = true;
      },
      CARRIER_UPDATE: (model) => (p, { reject, next, unchanged }) => {
        // Before booking the loop is not draining; after delivery the
        // workflow has completed: observably a no-op either way.
        if (!model.booked || model.status === 'delivered') {
          return reject('no-updates-before-booking-or-after-delivery');
        }
        // MUTANT: enforces the documented enum — which the audited code
        // does NOT do; must fail replay on the bogus-status trace.
        if (!['booked', 'dispatched', 'delivered'].includes(p.status)) {
          return reject('carrier-update-verbatim');
        }
        next.status = p.status;
        unchanged('booked');
      },
    },
    reactors: [],
  },
});

const getState = () => instance({}).getState();
const setState = (snapshot) => { instance({}).setState(snapshot); };
const init = () => { setState({ ...INITIAL_STATE }); };
const actions = Object.fromEntries(Object.keys(intents).map((n) => [n, (d = {}) => intents[n](d)]));

module.exports = { instance, init, actions, getState, setState };
