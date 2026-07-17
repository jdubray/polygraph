// Effect mapper for the order machine — pure, edge-triggered on state
// transitions (spec §4.1). No I/O, no clock, no randomness: durations are
// relative (fireInMs) and resolved by the kernel at commit time.
//
// In the full pipeline this file is polygen-drafted and human-reviewed, same
// rule as contract/invariants (§4.3 / decision log #1).
'use strict';

// Demo-scale durations. Production values would be hours/days; the semantics
// (stale firings reject observably) are identical at any scale.
const CHARGE_TIMEOUT_MS = 12_000;
const AMEND_WINDOW_MS = 8_000;

module.exports.effects = function effects(pre, action, data, post, stepKind) {
  if (stepKind !== 'accepted') return [];
  const entered = (s) => pre.orderState !== s && post.orderState === s;
  const out = [];

  if (entered('fraudCheck')) {
    out.push({ kind: 'fraudCheck', payload: { totalCents: post.totalCents } });
  }
  if (entered('charging')) {
    out.push({ kind: 'chargeCard', payload: { amountCents: post.totalCents } });
    out.push({ kind: 'timer', key: 'chargeTimeout', fireInMs: CHARGE_TIMEOUT_MS, action: 'CHARGE_TIMED_OUT', data: {} });
  }
  if (entered('awaitingAmend')) {
    out.push({ kind: 'timer', key: 'amendWindow', fireInMs: AMEND_WINDOW_MS, action: 'AMEND_WINDOW_EXPIRED', data: {} });
  }
  if (entered('shipping')) {
    out.push({ kind: 'dispatchShipment', payload: { txId: post.txId, totalCents: post.totalCents } });
  }
  return out;
};
