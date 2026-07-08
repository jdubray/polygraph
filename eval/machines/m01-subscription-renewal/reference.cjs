'use strict';
// Apparent-intent reference: what a faithful reader derives from source.js —
// the 5xx-is-transient guard applied to BOTH the renewal and dunning paths (the
// symmetry the source's structure implies). Differs from the code at exactly one
// window: RENEW_CHARGE{err5xx} in active.
function init() {
  return { status: 'active', attempts: 0 };
}
function next(s, action, data) {
  const d = data || {};
  if (action === 'RENEW_CHARGE' && s.status === 'active') {
    if (d.result === 'ok') return { status: 'active', attempts: 0 };
    if (d.result === 'err5xx') return { status: 'active', attempts: s.attempts }; // transient: no-op
    return { status: 'grace', attempts: 1 };
  }
  if (action === 'DUNNING_RETRY' && s.status === 'grace') {
    if (d.result === 'ok') return { status: 'active', attempts: 0 };
    if (d.result === 'err5xx') return { status: 'grace', attempts: s.attempts };
    if (s.attempts >= 3) return { status: 'canceled', attempts: s.attempts };
    return { status: 'grace', attempts: s.attempts + 1 };
  }
  if (action === 'CANCEL') return { status: 'canceled', attempts: s.attempts };
  return { status: s.status, attempts: s.attempts };
}
module.exports = { init, next };
