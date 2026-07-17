const TERMINAL = ['cancelled', 'rejected', 'paymentFailed', 'completed'];
const STATES = ['pending', 'fraudCheck', 'awaitingAmend', 'charging', 'shipping', ...TERMINAL];
const same = (a, b) =>
  a.orderState === b.orderState &&
  a.totalCents === b.totalCents &&
  a.txId === b.txId &&
  a.cancelReason === b.cancelReason;

export const stateInvariants = [
  {
    name: 'order-state-is-valid',
    pred: (s) => STATES.includes(s.orderState),
  },
  {
    // Never shipped without a successful charge: shipping/completed require a txId.
    name: 'shipped-implies-charged',
    pred: (s) =>
      (s.orderState !== 'shipping' && s.orderState !== 'completed') ||
      (typeof s.txId === 'string' && s.txId.length > 0),
  },
  {
    // A cancelled or rejected order never holds a transaction id.
    name: 'cancelled-or-rejected-never-has-txid',
    pred: (s) =>
      (s.orderState !== 'cancelled' && s.orderState !== 'rejected') || s.txId === '',
  },
  {
    // Every ended-for-a-reason state records why (incl. amend-window-expired path).
    name: 'ended-states-record-reason',
    pred: (s) =>
      !['cancelled', 'rejected', 'paymentFailed'].includes(s.orderState) ||
      (typeof s.cancelReason === 'string' && s.cancelReason.length > 0),
  },
];

export const transitionInvariants = [
  {
    // cancel-blocked-while-charging: CANCEL in charging must be a pure reject.
    name: 'cancel-blocked-while-charging',
    pred: (pre, action, data, post) =>
      !(action === 'CANCEL' && pre.orderState === 'charging') || same(pre, post),
  },
  {
    // stale-completions-reject: completions/timers outside their awaiting state
    // must leave the model byte-for-byte unchanged (at-least-once safety).
    name: 'stale-completions-are-no-ops',
    pred: (pre, action, data, post) => {
      const awaits = {
        CHARGE_SUCCEEDED: 'charging',
        CHARGE_FAILED: 'charging',
        CHARGE_TIMED_OUT: 'charging',
        AMEND_WINDOW_EXPIRED: 'awaitingAmend',
        SHIPMENT_DELIVERED: 'shipping',
      };
      if (!(action in awaits)) return true;
      if (pre.orderState === awaits[action]) return true;
      return same(pre, post);
    },
  },
  {
    // Terminal states never re-open or mutate under any action.
    name: 'terminal-states-are-frozen',
    pred: (pre, action, data, post) =>
      !TERMINAL.includes(pre.orderState) || same(pre, post),
  },
  {
    // Never charged twice: txId only ever set by CHARGE_SUCCEEDED from charging,
    // and once set it is immutable.
    name: 'txid-written-once-only-by-successful-charge',
    pred: (pre, action, data, post) => {
      if (post.txId === pre.txId) return true;
      return (
        pre.txId === '' &&
        action === 'CHARGE_SUCCEEDED' &&
        pre.orderState === 'charging' &&
        post.orderState === 'shipping' &&
        post.txId.length > 0
      );
    },
  },
  {
    // Timer expiry cancels with the exact contracted reason.
    name: 'amend-expiry-cancels-with-reason',
    pred: (pre, action, data, post) =>
      !(action === 'AMEND_WINDOW_EXPIRED' && pre.orderState === 'awaitingAmend') ||
      (post.orderState === 'cancelled' && post.cancelReason === 'amend-window-expired'),
  },
];