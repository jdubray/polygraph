'use strict';
// Apparent-intent reference: a partial authorization (approved < requested
// amount) is declined; only a full-or-over authorization captures. Differs from
// the code at exactly one window: a partial approval on a pending request.
function init() {
  return { status: 'pending', amount: 0, approved: 0 };
}
function next(s, action, data) {
  const d = data || {};
  if (action === 'REQUEST' && s.status === 'pending') {
    return { status: 'pending', amount: d.amount, approved: 0 };
  }
  if (action === 'AUTHORIZE' && s.status === 'pending') {
    if (d.approved < s.amount) return { status: 'declined', amount: s.amount, approved: 0 }; // reject partials
    return { status: 'captured', amount: s.amount, approved: d.approved };
  }
  return { status: s.status, amount: s.amount, approved: s.approved };
}
module.exports = { init, next };
