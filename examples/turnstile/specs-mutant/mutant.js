// Negative control: the reference with ONE rule broken — PUSH while LOCKED
// wrongly unlocks. This must fail exactly the push-while-locked windows (the
// three no-op windows in the corpus) and pass everything else, proving the
// replay discriminates rather than passing everything.
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
    return { state: 'UNLOCKED', coins: s.coins }; // BUG: should be a no-op
  }
  return { state: s.state, coins: s.coins };
}

module.exports = { init, next };
