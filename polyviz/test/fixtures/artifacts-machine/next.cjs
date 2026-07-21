'use strict';
// Tiny bare next(state, action, data) module — no external deps — for adapter tests.
// Returns undefined for an inapplicable action (a common no-op convention), which
// exercises the adapter's undefined-before-sanitize guard.
function next(state, action) {
  if (action === 'go' && state.state === 'A') return { ...state, state: 'B' };
  if (action === 'finish' && state.state === 'B') return { ...state, state: 'DONE', executed: true };
  return undefined;
}
module.exports = { next };
