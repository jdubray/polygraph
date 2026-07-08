'use strict';
// Card capture. A partial authorization (approved < requested) must be declined
// — you don't capture a partial. The guard that is supposed to reject partials
// only checks `approved <= 0`, so a genuine partial (e.g. 60 of 100) sails
// through to `captured`.
function init() {
  return { status: 'pending', amount: 0, approved: 0 };
}
function next(s, action, data) {
  const d = data || {};
  if (action === 'REQUEST' && s.status === 'pending') {
    return { status: 'pending', amount: d.amount, approved: 0 };
  }
  if (action === 'AUTHORIZE' && s.status === 'pending') {
    if (d.approved <= 0) return { status: 'declined', amount: s.amount, approved: 0 }; // meant to reject partials
    return { status: 'captured', amount: s.amount, approved: d.approved };
  }
  return { status: s.status, amount: s.amount, approved: s.approved };
}
module.exports = { init, next };
