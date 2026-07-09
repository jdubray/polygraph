// Negative control: reference.js with the dunning cancellation threshold
// broken (3 retries -> 2). It should disagree with the trace corpus on
// exactly the windows where RETRY pushes attempts from 2 -> 3 without yet
// canceling (s5_dunning_to_cancel), producing code-finding/spec-error
// verdicts there and nowhere else -- proof the corpus is specific enough to
// catch a localized defect.
'use strict';

function init() {
  return { status: 'trialing', retries: 0 };
}

function next(s, action, data) {
  const d = data || {};
  if (action === 'TRIAL_END' && s.status === 'trialing') {
    return { status: 'active', retries: 0 };
  }
  if (action === 'CHARGE' && s.status === 'active') {
    if (d.result === 'ok') return { status: 'active', retries: 0 };
    return { status: 'past_due', retries: 1 };
  }
  if (action === 'RETRY' && s.status === 'past_due') {
    if (d.result === 'ok') return { status: 'active', retries: 0 };
    if (d.result === 'error') return { status: 'past_due', retries: s.retries };
    if (s.retries >= 2) return { status: 'canceled', retries: s.retries }; // BUG: should be >= 3
    return { status: 'past_due', retries: s.retries + 1 };
  }
  if (action === 'CANCEL') {
    return { status: 'canceled', retries: s.retries };
  }
  return { status: s.status, retries: s.retries };
}

module.exports = { init, next };
