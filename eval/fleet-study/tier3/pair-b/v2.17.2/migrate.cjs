'use strict';
// Tier 3 · Pair B — the migration Medusa actually shipped, transcribed.
//
// polyvers demanded a migration because `status` was retyped (its domain
// widened from six members to seven). Medusa shipped one:
// `packages/modules/payment/src/migrations/Migration20260411223700.ts`
//
//   up():   drop constraint payment_session_status_check
//           add  constraint check("status" in ('authorized','captured','pending',
//                                'requires_more','error','canceled','pending_authorization'))
//   down(): the same, restricted back to the original six
//
// A CHECK-CONSTRAINT WIDENING AND NOTHING ELSE — no UPDATE, no backfill. So the
// faithful transcription is the IDENTITY, exactly as in Pair A.
//
// NOTE ON ORDERING, which is the one thing Pair B does better than Pair A: this
// migration shipped 2026-04, about two months BEFORE the 2026-06 feature commit
// that added the member to the TypeScript enum. The database was taught to
// accept the value before any code could emit it. For a widening that is the
// correct order, and it means no deployment window exists in which a provider
// could report `pending_authorization` into a database that would reject it.
module.exports.migrate = function migrate(oldState) {
  return {
    status: oldState.status,
    authorizedAt: oldState.authorizedAt,
    hasPayment: oldState.hasPayment,
  };
};
