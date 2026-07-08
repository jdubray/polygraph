'use strict';
// Apparent-intent reference: MAX_ATTEMPTS = 3, lock when the count REACHES 3
// (the >= a reader infers from the constant's name and intent). Differs from the
// code at exactly one window: the 3rd consecutive LOGIN_FAIL.
const MAX_ATTEMPTS = 3;
function init() {
  return { status: 'active', attempts: 0 };
}
function next(s, action) {
  if (action === 'LOGIN_FAIL' && s.status === 'active') {
    const a = s.attempts + 1;
    if (a >= MAX_ATTEMPTS) return { status: 'locked', attempts: a };
    return { status: 'active', attempts: a };
  }
  if (action === 'LOGIN_OK' && s.status === 'active') return { status: 'active', attempts: 0 };
  if (action === 'UNLOCK' && s.status === 'locked') return { status: 'active', attempts: 0 };
  return { status: s.status, attempts: s.attempts };
}
module.exports = { init, next };
