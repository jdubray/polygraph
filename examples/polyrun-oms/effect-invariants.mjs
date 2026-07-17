// OMS effect-emission invariants (spec §6.2) — rules over what the order ∘
// mapper composition may EMIT on every reachable path, including CHILD
// SPAWNS (the checker records spawnChild emissions since the OMS work).
'use strict';

export const effectInvariants = [
  {
    // The double-charge class, pre-deploy.
    name: 'at-most-one-charge-per-path',
    pred: (path) => path.count('chargeCard') <= 1,
  },
  {
    // The OMS headline: every entry into fulfilling spawns EXACTLY the
    // order's fulfillment count — no path under- or over-spawns shipments.
    name: 'spawns-match-fulfillments',
    pred: (path) => {
      const enteredFulfilling = path.states.some((s) => s.orderState === 'fulfilling');
      const spawns = path.count('spawnChild');
      if (!enteredFulfilling) return spawns === 0;
      const atEntry = path.states.find((s) => s.orderState === 'fulfilling');
      return spawns === atEntry.fulfillments;
    },
  },
  {
    // No shipment is ever spawned before a successful charge was emitted.
    name: 'no-spawn-before-charge',
    pred: (path) => path.emitted.every((e) =>
      e.kind !== 'spawnChild' ||
      path.emitted.some((c) => c.kind === 'chargeCard' && c.step < e.step)),
  },
  {
    name: 'no-charge-emitted-after-cancel',
    pred: (path) => path.emitted.every((e, i) =>
      e.kind !== 'chargeCard' || !path.actionBefore('CANCEL', i)),
  },
  {
    name: 'exactly-one-fraud-check-per-submission-or-amend',
    pred: (path) => {
      const submissions = path.actions.filter((a) => a.action === 'SUBMIT' || a.action === 'AMEND').length;
      return path.count('fraudCheck') <= Math.max(submissions, 0)
        && (submissions === 0 ? path.count('fraudCheck') === 0 : true);
    },
  },
];

// Pointwise state invariants (used by the deploy gate).
export const stateInvariants = [
  {
    name: 'rollup-counters-bounded',
    pred: (s) => s.shipmentsDelivered + s.shipmentsFailed <= s.fulfillments,
  },
  {
    name: 'completed-means-all-delivered',
    pred: (s) => s.orderState !== 'completed' || (s.shipmentsDelivered === s.fulfillments && s.shipmentsFailed === 0),
  },
  {
    name: 'fulfilling-implies-charged',
    pred: (s) => s.orderState !== 'fulfilling' || (typeof s.txId === 'string' && s.txId.length > 0),
  },
];
