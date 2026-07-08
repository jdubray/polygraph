// Intent the seeded bypass violates: the workflow exists to gate publishing on
// approval, so a document may only become `published` from the `approved` state.
// The faithful model reaches draft + PUBLISH -> published (bypassing review),
// violating this.
export const transitionInvariants = [
  {
    name: 'publish-only-from-approved',
    pred: (pre, action, data, post) => !(post.status === 'published' && pre.status !== 'approved'),
  },
];
export const stateInvariants = [];
