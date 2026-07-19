'use strict';
// Tier 3 · Pair A — the migration Medusa actually shipped, transcribed.
//
// polyvers demanded a migration because the `status` key was retyped (its
// domain widened from five members to seven). Medusa DID ship a migration for
// this change — `packages/modules/payment/src/migrations/Migration20250207132723.ts`
// — and reading it settles what the migration has to be:
//
//   up():   drop constraint payment_collection_status_check
//           add  constraint check("status" in ('not_paid','awaiting','authorized',
//                                'partially_authorized','canceled','failed','completed'))
//   down(): the same, restricted back to the original five
//
// That is a CHECK-CONSTRAINT WIDENING AND NOTHING ELSE. It contains no
// `UPDATE payment_collection SET status = ...`, and there is no backfill script
// anywhere in the repo at v2.5.0 (verified repo-wide). Existing rows keep
// exactly the status they had.
//
// So the faithful transcription is the IDENTITY. This is not a stub and not a
// convenience: writing anything else here would model a migration Medusa did
// not ship, and the whole question Pair A asks is what happens to a live fleet
// under the migration that WAS shipped.
//
// Every old status value remains legal under the new constraint — a widening
// cannot strand a row at the database level. Whether every old status value
// remains legal under the new version's RULES is a different question, and it
// is precisely the one the gates downstream of this file exist to answer.
module.exports.migrate = function migrate(oldState) {
  return {
    status: oldState.status,
    hasSessions: oldState.hasSessions,
    authorized: oldState.authorized,
    captured: oldState.captured,
    refunded: oldState.refunded,
  };
};
