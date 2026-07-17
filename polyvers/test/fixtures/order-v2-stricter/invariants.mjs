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
  {
    // STRENGTHENED in this version: v1's reachable init state (totalCents: 0)
    // violates it — the gate must name that state before the deploy.
    name: 'total-positive',
    pred: (s) => Number.isInteger(s.totalCents) && s.totalCents > 0,
  },
];
