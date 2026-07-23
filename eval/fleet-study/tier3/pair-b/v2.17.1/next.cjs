// Tier 3 · Pair B · version N — Medusa `PaymentSessionStatus` at v2.17.1.
//
// Translated from medusajs/medusa at refs/tags/v2.17.1 (commit 9aadd07b63d0).
// FROZEN per docs/tier3-protocol.md §2 before v2.17.2's source was read.
// See VALIDATION.md for the per-transition mapping to upstream source.
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

const instance = createInstance({ strict: true, hasAsyncActions: false, instanceName: 'medusa-payment-session-v2.17.1' });

// Six members at v2.17.1, declared twice upstream and identically: the runtime
// enum in packages/core/utils/src/payment/payment-session.ts and a type-level
// mirror in packages/core/types/src/payment/common.ts.
const STATUS = ['authorized', 'captured', 'pending', 'requires_more', 'error', 'canceled'];

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
      // Every action carries a provider-reported status, because at v2.17.1
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
