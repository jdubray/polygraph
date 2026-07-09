module.exports = {
  init() {
    return { status: 'no_code', attempts: 0 };
  },
  next(state, action, data) {
    if (action === 'ISSUE_CODE') {
      return { status: 'pending', attempts: 0 };
    }

    if (action === 'ATTEMPT') {
      if (state.status !== 'pending') {
        return { status: state.status, attempts: state.attempts };
      }

      const { match, expired } = data;

      if (expired === true) {
        return { status: 'pending', attempts: state.attempts };
      }

      if (expired === false) {
        if (match === true) {
          return { status: 'verified', attempts: state.attempts };
        }

        if (match === false) {
          const newAttempts = state.attempts + 1;
          const newStatus = newAttempts >= 3 ? 'locked' : 'pending';
          return { status: newStatus, attempts: newAttempts };
        }
      }

      return { status: state.status, attempts: state.attempts };
    }

    return { status: state.status, attempts: state.attempts };
  }
};