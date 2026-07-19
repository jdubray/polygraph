'use strict';
// migrate.cjs — scaffolded by polyvers from the shape diff
// (old contract 158a714e5fba → new contract efa70d4dfb31), then completed
// by hand. See MIGRATION-NOTE.md.
//
// Pure by contract: (oldState) → newState, no I/O, no clock — the migrate
// gate enforces determinism by double application.
//
// THE HOLE THE SCAFFOLD LEFT WAS A POLICY QUESTION, NOT A CODING TASK.
// The only structural change is that `dunningAttempts` narrowed from 0..3 to
// 0..2. polyvers flagged it as a retype and refused to guess, which is the
// correct refusal: there is no mechanically derivable answer to "what is a
// record sitting at depth 3 when the budget becomes 2?"
//
// Three answers were available, and they are not equivalent:
//
//   clamp to 2   — the record looks like it has one retry left. WRONG: it has
//                  already burned three, and this hands it a fourth.
//   clamp to 2, and let the invariants speak
//                — what is written below. Depth 3 becomes depth 2, which
//                  under the new budget means EXHAUSTED. Any such record
//                  still sitting in `pastDue` now violates
//                  `exhausted-dunning-is-unpaid`, and the pointwise gate
//                  names each one. That is the honest outcome: the migration
//                  does not paper over the population, it surfaces it.
//   move to unpaid — resolves the invariant by editing the lifecycle. This is
//                  a BILLING DECISION (it stops retrying a live customer) and
//                  does not belong in a migration; it belongs in an operator
//                  runbook with finance's sign-off.
//
// The second is chosen deliberately: a migration should make the fleet's
// awkward population VISIBLE to the gates, not silently legal.
module.exports.migrate = function migrate(oldState) {
  const next = {};
  // carried over unchanged
  next["subState"] = oldState["subState"];
  next["hasPaymentMethod"] = oldState["hasPaymentMethod"];
  next["cents"] = oldState["cents"];
  // HAND-EDITED: 0..3 → 0..2. Saturate rather than truncate; see above.
  next["dunningAttempts"] = Math.min(oldState["dunningAttempts"], 2);
  return next;
};
