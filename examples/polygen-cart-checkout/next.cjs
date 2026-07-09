function next(state, action, data) {
  switch (action) {
    case 'RESERVE_INVENTORY': {
      if (state.status !== 'IDLE') return state;
      const result = data && data.result;
      if (result === 'success') {
        return { status: 'RESERVED', captureKey: state.captureKey };
      }
      if (result === 'partial' || result === 'failed') {
        return { status: 'RESERVE_FAILED', captureKey: state.captureKey };
      }
      return state;
    }

    case 'CHECK_EXPIRY': {
      const expired = data && data.expired;
      if (expired === false) return state;
      if (expired === true) {
        if (state.status === 'RESERVED' || state.status === 'AUTHORIZED') {
          return { status: 'EXPIRED', captureKey: state.captureKey };
        }
        return state;
      }
      return state;
    }

    case 'AUTHORIZE_PAYMENT': {
      if (state.status !== 'RESERVED') return state;
      const result = data && data.result;
      if (result === 'approved') {
        return { status: 'AUTHORIZED', captureKey: state.captureKey };
      }
      if (result === 'declined') {
        return { status: 'AUTH_DECLINED', captureKey: state.captureKey };
      }
      if (result === 'error') {
        return { status: 'AUTH_ERROR', captureKey: state.captureKey };
      }
      return state;
    }

    case 'CAPTURE': {
      if (state.status === 'CAPTURED') return state;

      if (
        state.status === 'AUTHORIZED' ||
        state.status === 'CAPTURE_DECLINED' ||
        state.status === 'CAPTURE_ERROR'
      ) {
        const idempotencyKey = data && data.idempotencyKey;

        // Explicitly acknowledge the documented example keys from the
        // contract's dataDomain ('K1', 'K2') while still accepting any
        // other client-supplied idempotency key generically.
        let key;
        switch (idempotencyKey) {
          case 'K1':
            key = 'K1';
            break;
          case 'K2':
            key = 'K2';
            break;
          default:
            key = idempotencyKey;
        }

        const result = data && data.result;
        let status;
        if (result === 'success') {
          status = 'CAPTURED';
        } else if (result === 'declined') {
          status = 'CAPTURE_DECLINED';
        } else if (result === 'error') {
          status = 'CAPTURE_ERROR';
        } else {
          return state;
        }
        return { status, captureKey: key };
      }

      return state;
    }

    default:
      return state;
  }
}

function init() {
  return { status: 'IDLE', captureKey: null };
}

module.exports = { init, next };