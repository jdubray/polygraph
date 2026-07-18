'use strict';
// migrate.cjs — SCAFFOLDED by polyvers from the shape diff
// (old contract ee657efe674c → new contract 4309037f403e).
// Pure by contract: (oldState) → newState, no I/O, no clock — the migrate
// gate enforces determinism by double application.
// HOLE: an unfilled TODO fails the migrate gate loudly — each hole throws
// independently, so deleting one line cannot silently drop a key.
const HOLE = (msg) => { throw new Error(msg); };
module.exports.migrate = function migrate(oldState) {
  const next = {};
  // carried over unchanged
  next["orderState"] = oldState["orderState"];
  next["fulfillments"] = oldState["fulfillments"];
  next["shipmentsDelivered"] = oldState["shipmentsDelivered"];
  next["shipmentsFailed"] = oldState["shipmentsFailed"];
  next["totalCents"] = oldState["totalCents"];
  next["txId"] = oldState["txId"];
  next["cancelReason"] = oldState["cancelReason"];
  // added in the new shape — initialized from the new contract's initState
  next["amendCount"] = 0;
  return next;
};
