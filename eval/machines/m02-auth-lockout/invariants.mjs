// Intent the seeded off-by-one violates: the account must be locked once the
// failure count reaches MAX_ATTEMPTS (3). So it is never possible to be `active`
// with 3 or more accumulated failures. The faithful model (guard `> 3`) reaches
// active/attempts=3, violating this.
export const stateInvariants = [
  {
    name: 'locked-by-max-attempts',
    pred: (s) => !(s.status === 'active' && s.attempts >= 3),
  },
];
export const transitionInvariants = [];
