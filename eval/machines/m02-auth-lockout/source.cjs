'use strict';
// Login lockout. Policy (per the naming): MAX_ATTEMPTS = 3 — lock the account
// when the attempt count REACHES 3. The guard uses `> 3` instead of `>= 3`, an
// off-by-one, so the account actually locks on the 4th failure, not the 3rd.
const MAX_ATTEMPTS = 3;
function init() {
  return { status: 'active', attempts: 0 };
}
function next(s, action) {
  if (action === 'LOGIN_FAIL' && s.status === 'active') {
    const a = s.attempts + 1;
    if (a > MAX_ATTEMPTS) return { status: 'locked', attempts: a }; // off-by-one (should be >=)
    return { status: 'active', attempts: a };
  }
  if (action === 'LOGIN_OK' && s.status === 'active') return { status: 'active', attempts: 0 };
  if (action === 'UNLOCK' && s.status === 'locked') return { status: 'active', attempts: 0 };
  return { status: s.status, attempts: s.attempts };
}
module.exports = { init, next };
