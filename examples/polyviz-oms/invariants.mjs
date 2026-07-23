// The must-nevers for the order machine. Predicates return TRUE when the rule
// HOLDS, and each label claims only what its predicate actually checks.
// polyviz's invariants adapter reads id/kind from each name; the
// polyviz.annotations.json in this dir supplies the human-readable text shown
// in the figures.
export const stateInvariants = [
  // S1 — an order can never be delivered unless it was charged. This is the
  // invariant the counterexample trace (bug.ndjson) violates at its last step.
  { name: 'S1-no-delivery-without-charge', pred: (s) => s.state !== 'DELIVERED' || s.charged },

  // S2 — the charged flag only ever appears at or after the CHARGED state
  // (a set flag can never coexist with NEW / PENDING / CANCELLED).
  { name: 'S2-charged-implies-post-charge', pred: (s) => !s.charged || ['CHARGED', 'SHIPPED', 'DELIVERED', 'REFUNDED'].includes(s.state) },

  // L1 — cancellability is a REACHABILITY property ("from every pre-charge
  // state, cancel reaches CANCELLED"), not a predicate over a single state —
  // it is checked by a reachability pass, not here. Declared so it renders in
  // the figures with an honest `unchecked` status (see the annotations file).
  { name: 'L1-cancellable-until-charged', kind: 'liveness', pred: () => true }
];
