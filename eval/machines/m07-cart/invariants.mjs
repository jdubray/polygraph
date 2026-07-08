// Clean machine. Correct intent: the item count is never negative, and an
// `empty` cart has exactly zero items. Both HOLD for the faithful model — no
// violation (false-alarm control). NOTE: ADD grows the count without bound, so
// exploration is bounded by --max-states; a clean run reports no violation
// within that bound.
export const stateInvariants = [
  { name: 'count-non-negative', pred: (s) => s.count >= 0 },
  { name: 'empty-iff-zero', pred: (s) => (s.status === 'empty') === (s.count === 0) || s.status === 'checked_out' },
];
export const transitionInvariants = [];
