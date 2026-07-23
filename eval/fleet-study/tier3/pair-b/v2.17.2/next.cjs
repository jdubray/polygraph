// Tier 3 · Pair B · version N+1 — Medusa `PaymentSessionStatus` at v2.17.2.
//
// Derived MECHANICALLY from the frozen v2.17.1 translation (commit a305507) by
// adding one member to the status domain. Nothing else changed, because nothing
// else in the module changed: PR #15085 does not touch
// `packages/modules/payment/src/services/payment-module.ts` at all. Every write
// path below is byte-identical to version N's, verified against the commit's
// own file list.
//
// The new member is `pending_authorization`, for deferred payment methods —
// bank transfers, payment links, vouchers — which providers may now report to
// say an order should be creatable before authorization completes.
//
// WHAT CHANGED ABOVE THIS MODEL, and is deliberately out of scope: the new
// behaviour lives in core-flows, not in the payment module. `authorizePaymentSessionStep`
// gained an early `return new StepResponse(null)` on the new status;
// `validateCartPaymentsStep` added it to the statuses it will process; and a new
// `authorizePaymentSessionForOrderWorkflow` guards `status !== PENDING_AUTHORIZATION`
// with a throw. This model's scope is the module's session state machine, the
// same scope version N was frozen at, so those consumers are noted rather than
// modelled — changing scope between the two versions of a pair would make the
// comparison meaningless.
//
// A DIFFERENT SHAPE OF MACHINE FROM PAIR A. The payment COLLECTION status is
// computed internally from amounts. The payment SESSION status is not computed
// at all — it is REPORTED BY THE PAYMENT PROVIDER and written verbatim:
//
//   createPaymentSession:    status = providerPaymentSession.status ?? PENDING
//   updatePaymentSession:    status = data.status ?? providerData.status ?? session.status
//   authorizePaymentSession: whatever authorizePayment() returned
//
// There is NO validation, no enum-membership check, and no mapping table in
// `payment-module.ts`. The only transformation anywhere is in
// `authorizePaymentSession_`, which collapses CAPTURED into AUTHORIZED:
//
//   if (status === PaymentSessionStatus.CAPTURED) { status = AUTHORIZED; isCaptured = true }
//
// so `captured` is never persisted BY THE AUTHORIZE PATH — capture-ness lives
// on the separate `Payment` entity. It remains reachable as a stored session
// status, because create/update write provider values through untouched.
//
// THE MUTATE-THEN-THROW PATH. When the provider returns anything other than
// authorized/captured, `authorizePaymentSession` WRITES that status and THEN
// raises a MedusaError. The row is persisted; the error is control flow for the
// caller. This model treats the write as the outcome, because the question here
// is what states the fleet holds — and it holds the written one. The throw is
// recorded in VALIDATION.md rather than modelled as a rejection, since a
// rejection would imply the state did not change, which is false.
//
// DECLARED ABSTRACTIONS: `authorized_at` and the presence of a linked `Payment`
// are modelled as booleans — the code tests both only for presence, in the
// idempotency guard. Amounts, `data`, `context` and `currency_code` are
// OUTSIDE the projection: they are passed to providers but never read to decide
// a session status.
'use strict';

const { createInstance } = require('@cognitive-fab/sam-pattern');

const instance = createInstance({ strict: true, hasAsyncActions: false, instanceName: 'medusa-payment-session-v2.17.2' });

// SEVEN members at v2.17.2 — the six from v2.17.1 plus `pending_authorization`
// — declared twice upstream and identically: the runtime enum in
// packages/core/utils/src/payment/payment-session.ts and a type-level mirror in
// packages/core/types/src/payment/common.ts.
//
// The database CHECK constraint agrees. `Migration20260411223700.ts` widens
// `payment_session_status_check` to exactly these seven, and it shipped in
// April 2026 — roughly two months BEFORE the June 2026 feature commit. The
// constraint was widened ahead of the code that uses it, which is the correct
// order for a widening.
const STATUS = ['authorized', 'captured', 'pending', 'requires_more', 'error', 'canceled', 'pending_authorization'];

// Model default: `model.enum(PaymentSessionStatus).default(PENDING)` in
// packages/modules/payment/src/models/payment-session.ts. A row is `pending`
// at rest before any provider round trip resolves.
const INITIAL_STATE = { status: 'pending', authorizedAt: false, hasPayment: false };

const control = instance({
  initialState: JSON.parse(JSON.stringify(INITIAL_STATE)),
  component: {
    modelShape: {
      status: { type: 'string' },
      authorizedAt: { type: 'boolean' },
      hasPayment: { type: 'boolean' },
    },
    actions: {
      // Every action carries a provider-reported status, because at v2.17.2
      // that is where session status comes from. The domain is the full
      // declared enum: a provider may report any member.
      PROVIDER_INITIATE: {
        action: (d = {}) => ({ ...d }), schema: {},
        domain: STATUS.map((s) => ({ providerStatus: s })),
      },
      PROVIDER_UPDATE: {
        action: (d = {}) => ({ ...d }), schema: {},
        domain: STATUS.map((s) => ({ providerStatus: s })),
      },
      PROVIDER_AUTHORIZE: {
        action: (d = {}) => ({ ...d }), schema: {},
        domain: STATUS.map((s) => ({ providerStatus: s })),
      },
    },
    acceptors: {
      // createPaymentSession: `status: providerPaymentSession.status ?? PENDING`.
      // Unguarded — there is no current status to guard against, the row is new.
      PROVIDER_INITIATE: (model) => (p, { next, unchanged }) => {
        next.status = p.providerStatus;
        unchanged('authorizedAt', 'hasPayment');
      },

      // updatePaymentSession. The upstream comment states the intent outright:
      // "Allow the caller to explicitly set the status (eg. due to a webhook),
      // fallback to the update response, and finally to the existing status."
      // No guard on the current status.
      PROVIDER_UPDATE: (model) => (p, { next, unchanged }) => {
        next.status = p.providerStatus;
        unchanged('authorizedAt', 'hasPayment');
      },

      // authorizePaymentSession.
      PROVIDER_AUTHORIZE: (model) => (p, { reject, next, unchanged }) => {
        // The ONLY guard in this machine, and note what it keys on: the
        // presence of `authorized_at` and a linked Payment — NOT the status
        // value. `if (session.payment && session.authorized_at) return ...`
        if (model.hasPayment && model.authorizedAt) return reject('already-authorized');

        if (p.providerStatus === 'authorized' || p.providerStatus === 'captured') {
          // authorizePaymentSession_ collapses CAPTURED into AUTHORIZED before
          // persisting; captured-ness is tracked on the Payment entity.
          next.status = 'authorized';
          next.authorizedAt = true;
          next.hasPayment = true;
          return;
        }
        // Mutate-then-throw: the provider's status IS written, then a
        // MedusaError is raised. The persisted state is the written one.
        next.status = p.providerStatus;
        unchanged('authorizedAt', 'hasPayment');
      },
    },
    reactors: [],
  },
});

const { intents } = control;
const getState = () => instance({}).getState();
const setState = (snapshot) => { instance({}).setState(snapshot); };
const init = () => { setState(INITIAL_STATE); };
const actions = Object.fromEntries(Object.keys(intents).map((n) => [n, (d = {}) => intents[n](d)]));

module.exports = { instance, init, actions, getState, setState, STATUS };
