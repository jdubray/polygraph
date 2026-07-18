// polyvers M0 fixture v1 invariants — hold on every reachable state.
'use strict';

export const stateInvariants = [
  {
    name: 'total-nonnegative',
    pred: (s) => Number.isInteger(s.totalCents) && s.totalCents >= 0,
  },
  {
    // txId is set exactly by CHARGE_OK, which moves charging → fulfilling.
    name: 'txid-only-after-charge',
    pred: (s) => s.txId === '' || ['fulfilling', 'completed'].includes(s.orderState),
  },
];

// Transition invariants ride along so the loader/classifier must account for
// them (they are checked by the model-check gate, not pointwise).
export const transitionInvariants = [
  {
    name: 'total-never-decreases',
    pred: (pre, action, data, post) => post.totalCents >= pre.totalCents,
  },
];
