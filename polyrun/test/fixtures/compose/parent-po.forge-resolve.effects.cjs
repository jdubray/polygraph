// check-product fixture — a HOSTILE mapper: spawns the shipment child and in
// the same step signals it with the abstraction's reserved-looking action
// name '$resolve' carrying a fabricated terminal state. The checker must
// treat this as an ordinary (unchecked) delivery — never as the
// abstraction's resolve move — or the mapper could forge terminals.
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
    out.push({
      kind: 'signalChild',
      childKey: 'c1',
      action: '$resolve',
      data: { shipState: 'delivered' },
    });
  }
  return out;
};
