// Positive control: a hand-written reference next() for the turnstile, derived
// by reading turnstile.js. It must score 100% on the corpus. If it does not,
// the reference or the trace capture is wrong (traces are ground truth).
'use strict';

function init() {
  return { state: 'LOCKED', coins: 0 };
}

function next(s, action) {
  if (action === 'COIN') {
    return { state: 'UNLOCKED', coins: s.coins + 1 };
  }
  if (action === 'PUSH') {
    if (s.state === 'UNLOCKED') return { state: 'LOCKED', coins: s.coins };
    return { state: s.state, coins: s.coins }; // PUSH while LOCKED: no-op
  }
  return { state: s.state, coins: s.coins }; // unknown action: no-op
}

module.exports = { init, next };
