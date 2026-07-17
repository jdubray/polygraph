export const stateInvariants = [
  {
    name: 'ship-state-is-valid',
    pred: (state) =>
      ['preparing', 'inTransit', 'delivered', 'cancelledShipment'].includes(
        state.shipState
      ),
  },
];

export const transitionInvariants = [
  {
    // SHIP only succeeds from 'preparing' -> 'inTransit'; from anywhere else
    // it must be a rejected no-op (already-shipped), never a mutation.
    name: 'ship-only-from-preparing',
    pred: (pre, action, data, post) => {
      if (action !== 'SHIP') return true;
      if (pre.shipState === 'preparing') return post.shipState === 'inTransit';
      return post.shipState === pre.shipState;
    },
  },
  {
    // DELIVER only succeeds from 'inTransit' -> 'delivered'; from anywhere
    // else it must be a rejected no-op (not-in-transit).
    name: 'deliver-only-from-in-transit',
    pred: (pre, action, data, post) => {
      if (action !== 'DELIVER') return true;
      if (pre.shipState === 'inTransit') return post.shipState === 'delivered';
      return post.shipState === pre.shipState;
    },
  },
  {
    // CANCEL_SHIPMENT only succeeds from 'preparing' -> 'cancelledShipment';
    // once handed to the courier (or terminal) it must be a rejected no-op
    // (cancel-too-late).
    name: 'cancel-only-while-preparing',
    pred: (pre, action, data, post) => {
      if (action !== 'CANCEL_SHIPMENT') return true;
      if (pre.shipState === 'preparing')
        return post.shipState === 'cancelledShipment';
      return post.shipState === pre.shipState;
    },
  },
  {
    // Terminal states are absorbing: delivered can never become cancelled,
    // cancelled can never ship or deliver — no action escapes a terminal state.
    name: 'terminal-states-are-absorbing',
    pred: (pre, action, data, post) => {
      if (pre.shipState === 'delivered' || pre.shipState === 'cancelledShipment') {
        return post.shipState === pre.shipState;
      }
      return true;
    },
  },
  {
    // Any state change must be one of the three legal transitions — no silent
    // mutations or invented paths under duplicate/late deliveries.
    name: 'only-legal-transitions-occur',
    pred: (pre, action, data, post) => {
      if (pre.shipState === post.shipState) return true;
      return (
        (pre.shipState === 'preparing' &&
          post.shipState === 'inTransit' &&
          action === 'SHIP') ||
        (pre.shipState === 'inTransit' &&
          post.shipState === 'delivered' &&
          action === 'DELIVER') ||
        (pre.shipState === 'preparing' &&
          post.shipState === 'cancelledShipment' &&
          action === 'CANCEL_SHIPMENT')
      );
    },
  },
];