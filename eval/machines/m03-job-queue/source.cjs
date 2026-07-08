'use strict';
// Job lifecycle. HEARTBEAT is a liveness ping — by its name and its use in the
// running state, a reader reads it as an observability no-op. But it has a
// fall-through branch: a HEARTBEAT on a FAILED job silently requeues it to idle
// (resurrecting a job the operator believes is dead).
function init() {
  return { status: 'idle' };
}
function next(s, action) {
  if (action === 'START' && s.status === 'idle') return { status: 'running' };
  if (action === 'COMPLETE' && s.status === 'running') return { status: 'done' };
  if (action === 'FAIL' && s.status === 'running') return { status: 'failed' };
  if (action === 'RESET') return { status: 'idle' };
  if (action === 'HEARTBEAT') {
    if (s.status === 'failed') return { status: 'idle' }; // fall-through: requeues a failed job
    return { status: s.status }; // ping: no-op
  }
  return { status: s.status };
}
module.exports = { init, next };
