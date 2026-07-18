// OMS order effect mapper — pure, edge-triggered (spec §4.1). The OMS twist
// over the basic demo: entering 'fulfilling' spawns ONE SHIPMENT CHILD PER
// FULFILLMENT (keys f1..fN), each notifying the order via SHIPMENT_COMPLETED
// on its terminal state and accepting CANCEL_SHIPMENT if the order ever goes
// terminal while a shipment is still preparing.
'use strict';

const CHARGE_TIMEOUT_MS = 12_000;
const AMEND_WINDOW_MS = 8_000;

module.exports.effects = function effects(pre, action, data, post, stepKind) {
  if (stepKind !== 'accepted') return [];
  const entered = (s) => pre.orderState !== s && post.orderState === s;
  const out = [];

  if (entered('fraudCheck')) {
    out.push({ kind: 'fraudCheck', payload: { totalCents: post.totalCents, fulfillments: post.fulfillments } });
  }
  if (entered('charging')) {
    out.push({ kind: 'chargeCard', payload: { amountCents: post.totalCents } });
    out.push({ kind: 'timer', key: 'chargeTimeout', fireInMs: CHARGE_TIMEOUT_MS, action: 'CHARGE_TIMED_OUT', data: {} });
  }
  if (entered('awaitingAmend')) {
    out.push({ kind: 'timer', key: 'amendWindow', fireInMs: AMEND_WINDOW_MS, action: 'AMEND_WINDOW_EXPIRED', data: {} });
  }
  if (entered('fulfilling')) {
    for (let i = 1; i <= post.fulfillments; i++) {
      out.push({
        kind: 'spawnChild',
        machineId: 'shipment',
        childKey: `f${i}`,
        onComplete: 'SHIPMENT_COMPLETED',
        onParentTerminal: 'CANCEL_SHIPMENT',
      });
    }
  }
  return out;
};
