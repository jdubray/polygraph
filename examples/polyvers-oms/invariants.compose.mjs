// Cross-machine invariants for the OMS order × shipment product
// (docs/composition-semantics.md §5) — rules neither single-machine
// invariants file can state: each reads the order AND its shipments at once.
'use strict';

export default {
  stateInvariants: [
    {
      // A delivered shipment must never coexist with a cancelled order.
      name: 'no-delivered-shipment-under-cancelled-order',
      pred: (joint) => !(joint.parent.state.orderState === 'cancelled'
        && Object.values(joint.children).some((c) => c.state.shipState === 'delivered')),
    },
    {
      // Once the order is terminal, no shipment may still be running.
      name: 'terminal-order-leaves-no-active-shipments',
      pred: (joint) => joint.parent.status !== 'terminal'
        || Object.values(joint.children).every((c) => c.status !== 'active'),
    },
  ],
  transitionInvariants: [],
};
