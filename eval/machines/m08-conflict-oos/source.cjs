'use strict';
// OUT OF SCOPE for bare-next(). A charge result is 'ok' | 'declined' | 'conflict'
// (an idempotency conflict). The code treats a conflict as "already paid" and
// activates. That is self-consistent with a faithful reading of the source — a
// reader derives conflict -> active too, so no single-step divergence exists.
// The actual hazard (the processor may return a *replayed decline* as a
// conflict, activating without payment) is a property of an EXTERNAL service,
// invisible to a consistency check over this code. It requires a sandbox probe.
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
