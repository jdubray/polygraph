'use strict';
// Clean control: a traffic light cycles red -> green -> yellow -> red on NEXT.
// No divergence — a faithful reading matches the behavior exactly. Present to
// measure the false-alarm rate (a clean machine must NOT be flagged).
function init() {
  return { light: 'red' };
}
function next(s, action) {
  if (action === 'NEXT') {
    const cycle = { red: 'green', green: 'yellow', yellow: 'red' };
    return { light: cycle[s.light] };
  }
  return { light: s.light };
}
module.exports = { init, next };
