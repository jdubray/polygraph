const same = (a, b) =>
  a.orderState === b.orderState &&
  a.fulfillments === b.fulfillments &&
  a.shipmentsDelivered === b.shipmentsDelivered &&
  a.shipmentsFailed === b.shipmentsFailed &&
  a.totalCents === b.totalCents &&
  a.txId === b.txId &&
  a.cancelReason === b.cancelReason;

const TERMINAL = ['rejected', 'cancelled', 'paymentFailed', 'completed', 'partiallyDelivered'];
const AWAITS = {
  FRAUD_PASSED: 'fraudCheck',
  FRAUD_FAILED: 'fraudCheck',
  CHARGE_SUCCEEDED: 'charging',
  CHARGE_FAILED: 'charging',
  CHARGE_TIMED_OUT: 'charging',
  AMEND_WINDOW_EXPIRED: 'awaitingAmend',
  SHIPMENT_COMPLETED: 'fulfilling',
};

export const stateInvariants = [
  {
    // Rollup counters never exceed fulfillments; while still fulfilling the
    // sum is strictly below fulfillments (rule: rollup).
    name: 'rollup-counters-bounded',
    pred: (s) =>
      s.shipmentsDelivered >= 0 &&
      s.shipmentsFailed >= 0 &&
      s.shipmentsDelivered + s.shipmentsFailed <= s.fulfillments &&
      (s.orderState !== 'fulfilling' ||
        s.shipmentsDelivered + s.shipmentsFailed < s.fulfillments),
  },
  {
    // Never fulfilling (or past it) without a recorded charge transaction.
    name: 'fulfilling-implies-txid',
    pred: (s) =>
      !['fulfilling', 'completed', 'partiallyDelivered'].includes(s.orderState) ||
      s.txId !== '',
  },
  {
    // A completed order delivered every shipment; partiallyDelivered means all
    // shipments accounted for with at least one failure.
    name: 'terminal-rollup-consistency',
    pred: (s) =>
      (s.orderState !== 'completed' ||
        (s.shipmentsFailed === 0 && s.shipmentsDelivered === s.fulfillments)) &&
      (s.orderState !== 'partiallyDelivered' ||
        (s.shipmentsFailed >= 1 &&
          s.shipmentsDelivered + s.shipmentsFailed === s.fulfillments)),
  },
];

export const transitionInvariants = [
  {
    // Terminal states are frozen: no action mutates anything once terminal.
    name: 'terminal-states-frozen',
    pred: (pre, action, data, post) =>
      !TERMINAL.includes(pre.orderState) || same(pre, post),
  },
  {
    // Never charged twice: once txId is set it never changes, and it is only
    // ever set by CHARGE_SUCCEEDED arriving in 'charging'.
    name: 'never-charged-twice',
    pred: (pre, action, data, post) => {
      if (pre.txId !== '') return post.txId === pre.txId;
      if (post.txId !== pre.txId)
        return action === 'CHARGE_SUCCEEDED' && pre.orderState === 'charging';
      return true;
    },
  },
  {
    // Completions/timers arriving in any state other than the one awaiting
    // them must leave the state entirely unchanged (at-least-once delivery).
    name: 'stale-completions-are-noops',
    pred: (pre, action, data, post) =>
      !(action in AWAITS) ||
      pre.orderState === AWAITS[action] ||
      same(pre, post),
  },
  {
    // CANCEL is blocked (no mutation) in charging and fulfilling, and only
    // cancels from pending/fraudCheck/awaitingAmend, recording the reason.
    name: 'cancel-rules',
    pred: (pre, action, data, post) => {
      if (action !== 'CANCEL') return true;
      if (['pending', 'fraudCheck', 'awaitingAmend'].includes(pre.orderState))
        return post.orderState === 'cancelled' && post.cancelReason === data.reason;
      return same(pre, post);
    },
  },
  {
    // SUBMIT (from pending) and AMEND (from awaitingAmend) record the new
    // fulfillments/total and reset both rollup counters to zero.
    name: 'submit-amend-resets-rollup',
    pred: (pre, action, data, post) => {
      if (action === 'SUBMIT' && pre.orderState === 'pending')
        return (
          post.orderState === 'fraudCheck' &&
          post.fulfillments === data.fulfillments &&
          post.totalCents === data.totalCents &&
          post.shipmentsDelivered === 0 &&
          post.shipmentsFailed === 0
        );
      if (action === 'AMEND' && pre.orderState === 'awaitingAmend')
        return (
          post.orderState === 'charging' &&
          post.fulfillments === data.fulfillments &&
          post.totalCents === data.totalCents &&
          post.shipmentsDelivered === 0 &&
          post.shipmentsFailed === 0
        );
      if (action === 'SUBMIT' || action === 'AMEND') return same(pre, post);
      return true;
    },
  },
  {
    // SHIPMENT_COMPLETED in fulfilling increments exactly the right counter
    // and finalizes the order exactly when the last shipment reports in.
    name: 'shipment-rollup-correct',
    pred: (pre, action, data, post) => {
      if (action !== 'SHIPMENT_COMPLETED' || pre.orderState !== 'fulfilling')
        return true;
      const delivered = data.childState && data.childState.shipState === 'delivered';
      const okCounts = delivered
        ? post.shipmentsDelivered === pre.shipmentsDelivered + 1 &&
          post.shipmentsFailed === pre.shipmentsFailed
        : post.shipmentsFailed === pre.shipmentsFailed + 1 &&
          post.shipmentsDelivered === pre.shipmentsDelivered;
      if (!okCounts) return false;
      const done = post.shipmentsDelivered + post.shipmentsFailed === pre.fulfillments;
      if (done)
        return post.orderState === (post.shipmentsFailed === 0 ? 'completed' : 'partiallyDelivered');
      return post.orderState === 'fulfilling';
    },
  },
];