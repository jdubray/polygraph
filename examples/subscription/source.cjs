'use strict';
// Subscription billing: trialing -> active -> past_due -> canceled, with dunning
// retries. A charge result is 'ok' | 'declined' | 'error' ('error' is an
// ambiguous gateway timeout: no charge was confirmed either way).
//
// The RETRY (dunning) path treats 'error' as transient and leaves the row
// unchanged. The CHARGE path is structured the same way but is MISSING that
// guard: any non-ok result -- including a transient gateway error -- falls
// through to past_due. A reader comparing the two parallel charge paths would
// expect CHARGE to no-op on 'error' too, the way RETRY does; it does not.
function init() {
  return { status: 'trialing', retries: 0 };
}

function next(s, action, data) {
  const d = data || {};
  if (action === 'TRIAL_END' && s.status === 'trialing') {
    return { status: 'active', retries: 0 };
  }
  if (action === 'CHARGE' && s.status === 'active') {
    if (d.result === 'ok') return { status: 'active', retries: 0 };
    // NOTE: no 'error' guard here -- 'declined' and 'error' both fall through:
    return { status: 'past_due', retries: 1 };
  }
  if (action === 'RETRY' && s.status === 'past_due') {
    if (d.result === 'ok') return { status: 'active', retries: 0 };
    if (d.result === 'error') return { status: 'past_due', retries: s.retries }; // transient: no-op
    if (s.retries >= 3) return { status: 'canceled', retries: s.retries };
    return { status: 'past_due', retries: s.retries + 1 };
  }
  if (action === 'CANCEL') {
    return { status: 'canceled', retries: s.retries };
  }
  return { status: s.status, retries: s.retries };
}

module.exports = { init, next };
