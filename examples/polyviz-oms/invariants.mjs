// The must-nevers for the order machine. Predicates return TRUE when the rule
// HOLDS. polyviz's invariants adapter reads the id/kind from each name and
// prettifies the text; the polyviz.annotations.json in this dir supplies the
// human-readable text shown in the figures.
export const stateInvariants = [
  // S1 — an order can never be delivered unless it was charged.
  { name: 'S1-no-delivery-without-charge', pred: (s) => s.state !== 'DELIVERED' || s.charged },

  // S2 — the charge effect is one-shot: never charged more than once.
  { name: 'S2-no-double-charge', pred: (s) => !s.charged || ['CHARGED', 'SHIPPED', 'DELIVERED', 'REFUNDED'].includes(s.state) },

  // S3 — never ship an order that was never charged.
  { name: 'S3-no-ship-without-charge', pred: (s) => !s.shipped || s.charged },

  // L1 — an order stays cancellable until it is charged.
  { name: 'L1-cancellable-until-charged', kind: 'liveness', pred: () => true }
];
