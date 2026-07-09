export const stateInvariants = [
  {
    name: 'valid-status-enum',
    pred: (state) =>
      [
        'IDLE',
        'RESERVED',
        'RESERVE_FAILED',
        'AUTHORIZED',
        'AUTH_DECLINED',
        'AUTH_ERROR',
        'EXPIRED',
        'CAPTURED',
        'CAPTURE_DECLINED',
        'CAPTURE_ERROR',
      ].includes(state.status),
  },
];

export const transitionInvariants = [
  {
    name: 'partial-reservation-rollback',
    pred: (pre, action, data, post) => {
      if (action !== 'RESERVE_INVENTORY' || pre.status !== 'IDLE') return true;
      const result = data && data.result;
      if (result !== 'partial') return true;
      return post.status === 'RESERVE_FAILED';
    },
  },
  {
    name: 'reserve-only-from-idle',
    pred: (pre, action, data, post) => {
      if (action !== 'RESERVE_INVENTORY') return true;
      if (pre.status === 'IDLE') return true;
      return post.status === pre.status && post.captureKey === pre.captureKey;
    },
  },
  {
    name: 'expiry-window-releases-when-stalled',
    pred: (pre, action, data, post) => {
      if (action !== 'CHECK_EXPIRY') return true;
      const expired = data && data.expired;
      if (!expired) return true;
      if (pre.status !== 'RESERVED' && pre.status !== 'AUTHORIZED') return true;
      return post.status === 'EXPIRED';
    },
  },
  {
    name: 'expired-false-is-noop',
    pred: (pre, action, data, post) => {
      if (action !== 'CHECK_EXPIRY') return true;
      const expired = data && data.expired;
      if (expired) return true;
      return post.status === pre.status && post.captureKey === pre.captureKey;
    },
  },
  {
    name: 'authorize-only-while-reserved',
    pred: (pre, action, data, post) => {
      if (action !== 'AUTHORIZE_PAYMENT') return true;
      if (pre.status === 'RESERVED') return true;
      return post.status === pre.status && post.captureKey === pre.captureKey;
    },
  },
  {
    name: 'capture-idempotent-after-success',
    pred: (pre, action, data, post) => {
      if (action !== 'CAPTURE' || pre.status !== 'CAPTURED') return true;
      return post.status === pre.status && post.captureKey === pre.captureKey;
    },
  },
  {
    name: 'captured-is-terminal',
    pred: (pre, action, data, post) => {
      if (pre.status !== 'CAPTURED') return true;
      return post.status === 'CAPTURED';
    },
  },
  {
    name: 'capture-first-attempt-sets-key-and-status',
    pred: (pre, action, data, post) => {
      if (action !== 'CAPTURE' || pre.status !== 'AUTHORIZED') return true;
      const result = data && data.result;
      if (result !== 'success' && result !== 'declined' && result !== 'error') {
        return post.status === pre.status && post.captureKey === pre.captureKey;
      }
      const expected =
        result === 'success'
          ? 'CAPTURED'
          : result === 'declined'
          ? 'CAPTURE_DECLINED'
          : 'CAPTURE_ERROR';
      return post.status === expected && post.captureKey === (data && data.idempotencyKey);
    },
  },
  {
    name: 'capture-retry-allowed-after-failure',
    pred: (pre, action, data, post) => {
      if (
        action !== 'CAPTURE' ||
        (pre.status !== 'CAPTURE_DECLINED' && pre.status !== 'CAPTURE_ERROR')
      )
        return true;
      const result = data && data.result;
      if (result !== 'success' && result !== 'declined' && result !== 'error') {
        return post.status === pre.status && post.captureKey === pre.captureKey;
      }
      const expected =
        result === 'success'
          ? 'CAPTURED'
          : result === 'declined'
          ? 'CAPTURE_DECLINED'
          : 'CAPTURE_ERROR';
      return post.status === expected && post.captureKey === (data && data.idempotencyKey);
    },
  },
];