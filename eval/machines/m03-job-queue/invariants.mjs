// Intent the seeded fall-through violates: HEARTBEAT is a liveness ping — pure
// observability — so it must never change the job's status. The faithful model
// reaches failed + HEARTBEAT -> idle (resurrecting a dead job), violating this.
export const transitionInvariants = [
  {
    name: 'heartbeat-never-changes-status',
    pred: (pre, action, data, post) => !(action === 'HEARTBEAT' && post.status !== pre.status),
  },
];
export const stateInvariants = [];
