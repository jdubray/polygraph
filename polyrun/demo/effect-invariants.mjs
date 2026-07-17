// Effect-emission invariants for the OMS order machine (spec §6.2): rules
// about what the machine ∘ mapper composition may EMIT, over every reachable
// path — the layer Temporal has no counterpart for.
'use strict';

export const effectInvariants = [
  {
    // The double-charge class, pre-deploy: no path may emit chargeCard twice.
    name: 'at-most-one-charge-per-path',
    pred: (path) => path.count('chargeCard') <= 1,
  },
  {
    // A cancelled order must never have a charge intent emitted afterwards.
    name: 'no-charge-emitted-after-cancel',
    pred: (path) => path.emitted.every((e, i) =>
      e.kind !== 'chargeCard' || !path.actionBefore('CANCEL', i)),
  },
  {
    // Shipping is unreachable without a charge intent having been emitted.
    name: 'shipment-implies-prior-charge',
    pred: (path) => path.emitted.every((e) =>
      e.kind !== 'dispatchShipment' ||
      path.emitted.some((c) => c.kind === 'chargeCard' && c.step < e.step)),
  },
  {
    name: 'at-most-one-shipment-per-path',
    pred: (path) => path.count('dispatchShipment') <= 1,
  },
  {
    // Every order gets exactly one fraud check, at the start of the flow.
    name: 'exactly-one-fraud-check-when-submitted',
    pred: (path) => {
      const submitted = path.actions.some((a) => a.action === 'SUBMIT');
      const n = path.count('fraudCheck');
      return submitted ? n === 1 : n === 0;
    },
  },
];
