// polyvers CP-M3 product fixture — cross-machine invariants over the
// po-v1 × ship joint state (docs/composition-semantics.md §5).
'use strict';

export default {
  stateInvariants: [
    {
      name: 'no-delivered-shipment-under-cancelled-order',
      pred: (joint) => !(joint.parent.state.poState === 'cancelled'
        && Object.values(joint.children).some((c) => c.state.shipState === 'delivered')),
    },
    {
      name: 'terminal-parent-leaves-no-active-children',
      pred: (joint) => joint.parent.status !== 'terminal'
        || Object.values(joint.children).every((c) => c.status !== 'active'),
    },
  ],
  transitionInvariants: [],
};
