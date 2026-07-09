// Intent the seeded bug violates: an ambiguous gateway error ('error') must
// never move an active subscription into past_due -- it is transient, so the
// row is left as-is (this is how the RETRY/dunning path already treats it).
// The faithful model reaches active + CHARGE(error) -> past_due, violating this.
export const transitionInvariants = [
  {
    name: 'no-past-due-on-transient-error',
    pred: (pre, action, data, post) =>
      !(pre.status === 'active' && action === 'CHARGE' && (data || {}).result === 'error' && post.status === 'past_due'),
  },
];
export const stateInvariants = [
  {
    name: 'no-retries-once-active',
    pred: (s) => !(s.status === 'active' && s.retries !== 0),
  },
];
