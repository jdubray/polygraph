'use strict';
// Document approval workflow: draft -> review -> approved -> published, with
// reject and recall. PUBLISH is only meaningful from `approved` (that is the
// gate the whole workflow exists to enforce). But PUBLISH has an extra branch
// that publishes a `draft` directly, bypassing review entirely.
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
    if (s.status === 'draft') return { status: 'published' }; // bypasses review
    return { status: s.status };
  }
  return { status: s.status };
}
module.exports = { init, next };
