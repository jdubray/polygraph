'use strict';
// Apparent-intent reference: identical to source.js (clean machine, no divergence).


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
