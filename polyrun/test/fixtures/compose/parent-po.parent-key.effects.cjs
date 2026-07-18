// check-product fixture — a mapper that spawns a child under childKey
// 'parent', colliding with the joint model's reserved parent target key.
// Production routes this correctly (instances key by sha(parent, childKey,
// seq)); the model cannot, so it must REFUSE rather than silently misroute.
'use strict';

module.exports.effects = function effects(pre, action, data, post, stepKind) {
  if (stepKind !== 'accepted') return [];
  if (pre.poState !== 'fulfilling' && post.poState === 'fulfilling') {
    return [{
      kind: 'spawnChild',
      machineId: 'shipment',
      childKey: 'parent',
      onComplete: 'CHILD_DONE',
      onParentTerminal: 'CANCEL_SHIPMENT',
    }];
  }
  return [];
};
