'use strict';
// Apparent-intent reference: HEARTBEAT is a pure liveness no-op in every state
// (what its name and its running-state use imply). Differs from the code at
// exactly one window: HEARTBEAT on a failed job.
function init() {
  return { status: 'idle' };
}
function next(s, action) {
  if (action === 'START' && s.status === 'idle') return { status: 'running' };
  if (action === 'COMPLETE' && s.status === 'running') return { status: 'done' };
  if (action === 'FAIL' && s.status === 'running') return { status: 'failed' };
  if (action === 'RESET') return { status: 'idle' };
  if (action === 'HEARTBEAT') return { status: s.status }; // no-op everywhere
  return { status: s.status };
}
module.exports = { init, next };
