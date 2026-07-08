'use strict';
// Apparent-intent reference: PUBLISH is the approval gate — it only applies from
// `approved`; from any other state it is a no-op. Differs from the code at
// exactly one window: PUBLISH from draft.
function init() {
  return { status: 'draft' };
}
function next(s, action) {
  if (action === 'SUBMIT' && s.status === 'draft') return { status: 'review' };
  if (action === 'APPROVE' && s.status === 'review') return { status: 'approved' };
  if (action === 'REJECT' && s.status === 'review') return { status: 'rejected' };
  if (action === 'RECALL' && s.status === 'review') return { status: 'draft' };
  if (action === 'PUBLISH') {
    if (s.status === 'approved') return { status: 'published' };
    return { status: s.status }; // not approved: no-op
  }
  return { status: s.status };
}
module.exports = { init, next };
