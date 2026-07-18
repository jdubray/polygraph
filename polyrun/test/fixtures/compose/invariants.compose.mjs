// check-product fixture — CROSS-machine invariants over the parent×child
// joint state (docs/composition-semantics.md §5). These are the rules neither
// single-machine checker can see: each speaks about the parent AND its
// children at once.
'use strict';

export default {
  stateInvariants: [
    {
      // The reviewer's canonical example class: "no shipment dispatches after
      // order cancel" — here as its end-state witness: a delivered shipment
      // must never coexist with a cancelled order.
      name: 'no-delivered-shipment-under-cancelled-order',
      pred: (joint) => !(joint.parent.state.poState === 'cancelled'
        && Object.values(joint.children).some((c) => c.state.shipState === 'delivered')),
    },
    {
      // The cancel cascade must actually land: once the parent is terminal,
      // no child may remain active (a child whose cancel window is narrower
      // than its non-terminal states violates this).
      name: 'terminal-parent-leaves-no-active-children',
      pred: (joint) => joint.parent.status !== 'terminal'
        || Object.values(joint.children).every((c) => c.status !== 'active'),
    },
  ],
  transitionInvariants: [
    {
      // Completion integrity: the parent may only reach 'completed' while
      // every child it spawned is itself terminal.
      name: 'completed-parent-implies-terminal-children',
      pred: (pre, stimulus, post) => post.parent.state.poState !== 'completed'
        || Object.values(post.children).every((c) => c.status === 'terminal'),
    },
  ],
};
