// OUT OF SCOPE — honest limitation of model checking over observable state.
//
// The real hazard is "activate without an actual payment," but "actual payment"
// is NOT in the observable state: the code treats an idempotency `conflict` as
// already-paid, and over this code alone that is self-consistent. The only
// invariant that would flag it — "active only ever follows an `ok` result" —
// is not a sound rule: it ASSERTS conflict-is-not-payment, which is precisely
// the thing the code cannot determine about the external processor (a conflict
// might mean a genuine prior success, or a replayed decline). Writing it would
// be encoding an unproven external assumption as an invariant.
//
// So we assert only what genuinely holds (a benign type invariant). The checker
// finds no violation — correctly. The true hazard needs a processor-sandbox
// probe, not reachability over the code. This is the same boundary that makes
// replay blind here: the missing information is external.
export const stateInvariants = [
  { name: 'status-is-valid', pred: (s) => ['pending', 'active'].includes(s.status) },
];
export const transitionInvariants = [];
