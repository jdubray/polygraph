// check-product fixture — parent effect mapper: entering 'fulfilling' spawns
// one shipment child, completing via CHILD_DONE, cancelled on parent terminal
// via CANCEL_SHIPMENT.
'use strict';

module.exports.effects = function effects(pre, action, data, post, stepKind) {
  if (stepKind !== 'accepted') return [];
  const out = [];
  if (pre.poState !== 'fulfilling' && post.poState === 'fulfilling') {
    out.push({
      kind: 'spawnChild',
      machineId: 'shipment',
      childKey: 'c1',
      onComplete: 'CHILD_DONE',
      onParentTerminal: 'CANCEL_SHIPMENT',
    });
  }
  return out;
};
