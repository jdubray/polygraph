// Intent the seeded wrong-comparison guard violates: a partial authorization
// (approved < requested amount) must be declined, never captured. The faithful
// model (guard `approved <= 0`) reaches AUTHORIZE(approved=60) on amount=100 ->
// captured with approved < amount, violating this.
export const transitionInvariants = [
  {
    name: 'no-partial-capture',
    pred: (pre, action, data, post) =>
      !(action === 'AUTHORIZE' && post.status === 'captured' && post.approved < pre.amount),
  },
];
export const stateInvariants = [];
