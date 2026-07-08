'use strict';
// Subscription renewal + dunning. A charge result is 'ok' | 'declined' | 'err5xx'.
// The dunning path treats an ambiguous 5xx as transient (leave the row as-is).
// The renewal path is structured the same way but is MISSING that 5xx guard, so
// any non-ok result — including a transient 503 — falls through to grace.
// A reader comparing the two parallel paths would expect renewal to no-op on 5xx
// too; it does not. (This is the divergence.)
function init() {
  return { status: 'active', attempts: 0 };
}
function next(s, action, data) {
  const d = data || {};
  if (action === 'RENEW_CHARGE' && s.status === 'active') {
    if (d.result === 'ok') return { status: 'active', attempts: 0 };
    // NOTE: no err5xx guard here — falls through:
    return { status: 'grace', attempts: 1 };
  }
  if (action === 'DUNNING_RETRY' && s.status === 'grace') {
    if (d.result === 'ok') return { status: 'active', attempts: 0 };
    if (d.result === 'err5xx') return { status: 'grace', attempts: s.attempts }; // transient: no-op
    if (s.attempts >= 3) return { status: 'canceled', attempts: s.attempts };
    return { status: 'grace', attempts: s.attempts + 1 };
  }
  if (action === 'CANCEL') return { status: 'canceled', attempts: s.attempts };
  return { status: s.status, attempts: s.attempts };
}
module.exports = { init, next };
