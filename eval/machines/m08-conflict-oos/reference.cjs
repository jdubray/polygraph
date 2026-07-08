'use strict';
// Apparent-intent reference: identical to source.js. A faithful reader derives
// conflict -> active from the source literally, so there is NO single-step
// divergence — the method correctly finds nothing. The real risk is at the
// external-service boundary (a replayed decline returned as a conflict).
function init() {
  return { status: 'pending' };
}
function next(s, action, data) {
  const d = data || {};
  if (action === 'CHARGE' && s.status === 'pending') {
    if (d.result === 'ok') return { status: 'active' };
    if (d.result === 'conflict') return { status: 'active' }; // treats conflict as already-paid
    if (d.result === 'declined') return { status: 'pending' };
    return { status: s.status };
  }
  return { status: s.status };
}
module.exports = { init, next };
