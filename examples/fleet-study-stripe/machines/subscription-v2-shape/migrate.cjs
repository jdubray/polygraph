'use strict';
// migrate.cjs — scaffolded by polyvers from the shape diff
// (old contract 158a714e5fba → new contract cce988ab7662), then completed
// by hand. See MIGRATION-NOTE.md.
//
// Pure by contract: (oldState) → newState, no I/O, no clock — the migrate
// gate enforces determinism by double application.
//
// WHAT THE SCAFFOLD GOT WRONG, AND WHY THAT IS THE POINT.
// polyvers correctly read the diff as `cents` removed / `amountCents` +
// `currency` added, and initialized both from the new contract's initState —
// which sets `amountCents` to 0. Applied as scaffolded, every subscription in
// the fleet would have been migrated to a recurring amount of ZERO. The
// scaffold cannot know that `amountCents` is `cents` renamed rather than a
// genuinely new field; only a human reading both contracts knows that.
//
// The tool's contribution here is not the conversion. It is that the
// conversion was made a REVIEWABLE ARTIFACT with a named hole, instead of an
// implicit assumption inside a deploy.
module.exports.migrate = function migrate(oldState) {
  const next = {};
  // carried over unchanged
  next["subState"] = oldState["subState"];
  next["dunningAttempts"] = oldState["dunningAttempts"];
  next["hasPaymentMethod"] = oldState["hasPaymentMethod"];
  // HAND-EDITED: `cents` was renamed, not dropped. The scaffold's default of
  // 0 would have zeroed the fleet's billing amounts.
  next["amountCents"] = oldState["cents"];
  // v1 was single-currency by assumption — it had nowhere to record one.
  // Every record migrated from v1 is therefore USD by construction, which is
  // true of this fleet and must be re-checked before reuse on any other.
  next["currency"] = "usd";
  return next;
};
