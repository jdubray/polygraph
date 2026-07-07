// The "production code" under audit: a classic turnstile.
//
// Observable behavior (what a reader must derive — the audit does NOT tell the
// model this, it derives it from the source):
//   - COIN: accept a coin (coins += 1) and unlock.
//   - PUSH while UNLOCKED: the visitor passes through; re-lock.
//   - PUSH while LOCKED: nothing happens (the arm doesn't turn).
'use strict';

class Turnstile {
  constructor() {
    this.state = 'LOCKED'; // 'LOCKED' | 'UNLOCKED'
    this.coins = 0;
  }

  coin() {
    this.coins += 1;
    this.state = 'UNLOCKED';
  }

  push() {
    if (this.state === 'UNLOCKED') {
      this.state = 'LOCKED';
    }
    // PUSH while LOCKED: no observable change.
  }

  /** The observable-state projection used by the contract. */
  observable() {
    return { state: this.state, coins: this.coins };
  }
}

module.exports = { Turnstile };
