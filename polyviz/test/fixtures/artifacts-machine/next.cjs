'use strict';
// Tiny bare next(state, action, data) module — no external deps — for adapter tests.
function next(state, action) {
  const s = { ...state };
  if (action === 'go' && s.state === 'A') s.state = 'B';
  else if (action === 'finish' && s.state === 'B') { s.state = 'DONE'; s.executed = true; }
  return s;
}
module.exports = { next };
