'use strict';
// A small order-lifecycle machine as a bare next(state, action, data) module —
// no external dependencies, so this example runs anywhere. polyviz's machine
// adapter derives the transition graph by executing this over the contract's
// declared (action, data) domain (bounded reachability). An action that does
// not apply in the current state returns undefined (an observable no-op).
function next(state, action) {
  const s = { ...state };
  switch (state.state) {
    case 'NEW':
      if (action === 'submit') s.state = 'PENDING';
      else if (action === 'cancel') s.state = 'CANCELLED';
      else return undefined;
      break;
    case 'PENDING':
      if (action === 'charge') { s.state = 'CHARGED'; s.charged = true; }
      else if (action === 'cancel') s.state = 'CANCELLED';
      else return undefined;
      break;
    case 'CHARGED':
      if (action === 'ship') { s.state = 'SHIPPED'; s.shipped = true; }
      else if (action === 'refund') s.state = 'REFUNDED';
      else return undefined;
      break;
    case 'SHIPPED':
      if (action === 'deliver') s.state = 'DELIVERED';
      else return undefined;
      break;
    default:
      return undefined; // DELIVERED / CANCELLED / REFUNDED are terminal
  }
  return s;
}

module.exports = { next };
