// Positive control: a hand-written reference next() for the subscription
// machine, derived by reading source.js. It must score 100% against the trace
// corpus (traces are ground truth -- they were driven through source.js).
//
// Note: this reference faithfully REPRODUCES the seeded bug (CHARGE + 'error'
// falls through to past_due). Replay only catches bugs where a derived spec
// DISAGREES with the code -- a faithful spec does not disagree, so Part 1
// (replay) is clean here. The bug is only found in Part 2 (invariant
// model-checking against invariants.mjs), which iterates the spec instead of
// just replaying observed traces.
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
    if (s.retries >= 3) return { status: 'canceled', retries: s.retries };
    return { status: 'past_due', retries: s.retries + 1 };
  }
  if (action === 'CANCEL') {
    return { status: 'canceled', retries: s.retries };
  }
  return { status: s.status, retries: s.retries };
}

module.exports = { init, next };
