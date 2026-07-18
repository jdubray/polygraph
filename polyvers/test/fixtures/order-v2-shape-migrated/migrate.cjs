'use strict';
// migrate.cjs — the v1 → v2-shape migration (fixture): trackingId is new,
// initialized to the new contract's initState default. Pure by construction.
module.exports.migrate = function migrate(oldState) {
  return {
    orderState: oldState.orderState,
    totalCents: oldState.totalCents,
    txId: oldState.txId,
    trackingId: '',
  };
};
