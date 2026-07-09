export const stateInvariants = [
  {
    name: 'attempts-within-bounds',
    pred: (state) => state.attempts >= 0 && state.attempts <= 3,
  },
  {
    name: 'locked-only-at-limit',
    pred: (state) => state.status !== 'locked' || state.attempts >= 3,
  },
];

export const transitionInvariants = [
  {
    name: 'issue-resets-flow',
    pred: (pre, action, data, post) =>
      action !== 'ISSUE_CODE' ||
      (post.status === 'pending' && post.attempts === 0),
  },
  {
    name: 'attempt-noop-unless-pending',
    pred: (pre, action, data, post) =>
      !(action === 'ATTEMPT' && pre.status !== 'pending') ||
      (post.status === pre.status && post.attempts === pre.attempts),
  },
  {
    name: 'expired-never-verifies',
    pred: (pre, action, data, post) =>
      !(action === 'ATTEMPT' && pre.status === 'pending' && data && data.expired) ||
      post.status !== 'verified',
  },
  {
    name: 'expired-does-not-count-as-failure',
    pred: (pre, action, data, post) =>
      !(action === 'ATTEMPT' && pre.status === 'pending' && data && data.expired) ||
      (post.attempts === pre.attempts && post.status === 'pending'),
  },
  {
    name: 'live-mismatch-increments-attempts',
    pred: (pre, action, data, post) =>
      !(action === 'ATTEMPT' && pre.status === 'pending' && data && !data.expired && !data.match) ||
      post.attempts === pre.attempts + 1,
  },
  {
    name: 'live-match-verifies',
    pred: (pre, action, data, post) =>
      !(action === 'ATTEMPT' && pre.status === 'pending' && data && !data.expired && data.match) ||
      post.status === 'verified',
  },
  {
    name: 'lock-threshold',
    pred: (pre, action, data, post) =>
      !(action === 'ATTEMPT' && pre.status === 'pending' && data && !data.expired && !data.match && pre.attempts + 1 >= 3) ||
      post.status === 'locked',
  },
  {
    name: 'locked-blocks-verification',
    pred: (pre, action, data, post) =>
      !(action === 'ATTEMPT' && pre.status === 'locked') ||
      post.status !== 'verified',
  },
];