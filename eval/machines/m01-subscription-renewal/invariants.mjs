// Intent the seeded bug violates: an ambiguous transient error (err5xx) must
// never move an active subscription into grace — it is transient, so the row is
// left as-is (this is how the dunning path already treats it). The faithful
// model reaches active + RENEW_CHARGE(err5xx) -> grace, violating this.
export const transitionInvariants = [
  {
    name: 'no-grace-on-transient-5xx',
    pred: (pre, action, data, post) =>
      !(pre.status === 'active' && action === 'RENEW_CHARGE' && (data || {}).result === 'err5xx' && post.status === 'grace'),
  },
];
export const stateInvariants = [];
