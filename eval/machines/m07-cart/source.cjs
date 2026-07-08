'use strict';
// Clean control: a shopping cart. ADD/REMOVE adjust the count; the cart is
// 'empty' at count 0 and 'active' otherwise; CHECKOUT from active locks it.
// No divergence — a faithful reading matches. Second clean machine for the
// false-alarm measurement.
function init() {
  return { status: 'empty', count: 0 };
}
function next(s, action, data) {
  const d = data || {};
  if (action === 'ADD' && s.status !== 'checked_out') {
    const c = s.count + (d.qty || 1);
    return { status: 'active', count: c };
  }
  if (action === 'REMOVE' && s.status === 'active') {
    const c = Math.max(0, s.count - (d.qty || 1));
    return { status: c === 0 ? 'empty' : 'active', count: c };
  }
  if (action === 'CHECKOUT' && s.status === 'active') {
    return { status: 'checked_out', count: s.count };
  }
  return { status: s.status, count: s.count };
}
module.exports = { init, next };
