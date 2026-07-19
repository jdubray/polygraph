// The mapping layer between Stripe and the machine (fleet study Tier 2).
//
// This module is where the study is falsifiable. Everything else is
// plumbing; these two functions assert "a Stripe subscription in status X
// IS our state Y" and "Stripe event E IS our action A". If the mapping is
// wrong, the corpus is wrong, and every number downstream is wrong with it.
// They are therefore kept small, pure, and free of API calls so they can be
// unit-tested without a key.
'use strict';

/** Stripe subscription.status → our subState. Stripe's vocabulary is the
 *  authority; ours differs only in camelCase and in NOT modelling `paused`
 *  (see UNMAPPED below). */
const STATUS = {
  incomplete: 'incomplete',
  incomplete_expired: 'incompleteExpired',
  trialing: 'trialing',
  active: 'active',
  past_due: 'pastDue',
  unpaid: 'unpaid',
  canceled: 'canceled',
};

/** Stripe statuses we deliberately do NOT model, and why. A capture that
 *  meets one must fail loudly rather than coerce it into a neighbour —
 *  silently folding `paused` into `active` would manufacture fleet states
 *  that Stripe never held. */
export const UNMAPPED = {
  paused: 'pause_collection is a billing-behaviour modifier, not a lifecycle state; modelling it needs a fifth key and is out of scope for v1',
};

/** Stripe event type → our action alphabet. Events not listed are ignored:
 *  they carry no transition for the projected state (e.g. invoice.created,
 *  customer.updated, payment_method.attached on an already-carded customer). */
const EVENT = {
  'invoice.payment_succeeded': 'PAYMENT_SUCCEEDED',
  'invoice.paid': 'PAYMENT_SUCCEEDED',
  'invoice.payment_failed': 'PAYMENT_FAILED',
  'customer.subscription.deleted': 'CANCEL',
  'payment_method.attached': 'ATTACH_PAYMENT_METHOD',
};

/**
 * Project a Stripe subscription object onto the contract's four observable
 * keys. THIS FUNCTION IS THE PROJECTION BOUND made executable — everything
 * it drops is outside every guarantee the study makes.
 *
 * `dunningAttempts` is not a Stripe field; it is derived from the open
 * invoice's attempt_count, which is what Stripe's smart-retry schedule
 * actually increments.
 */
export function projectSubscription(sub, { openInvoice = null, maxDunning = 3 } = {}) {
  const mapped = STATUS[sub.status];
  if (!mapped) {
    const why = UNMAPPED[sub.status] ?? 'unknown Stripe status';
    throw new Error(`unmapped Stripe subscription status '${sub.status}': ${why} (subscription ${sub.id})`);
  }
  const attempts = Math.min(Number(openInvoice?.attempt_count ?? 0), maxDunning);
  return {
    subState: mapped,
    // A terminal record carries no live dunning: Stripe stops retrying, and
    // our 'terminal-is-not-mid-dunning' invariant asserts exactly this.
    dunningAttempts: (mapped === 'canceled' || mapped === 'incompleteExpired') ? 0 : attempts,
    hasPaymentMethod: Boolean(sub.default_payment_method || sub.customer?.invoice_settings?.default_payment_method),
    cents: Number(sub.items?.data?.[0]?.price?.unit_amount ?? 0),
  };
}

/** Stripe event → our action, or null when the event carries no projected
 *  transition. Returning null (rather than guessing) keeps unmodelled events
 *  out of the trace corpus instead of inventing windows for them. */
export function actionForEvent(event) {
  const action = EVENT[event?.type];
  if (!action) return null;
  const obj = event.data?.object ?? {};
  if (action === 'PAYMENT_SUCCEEDED') {
    return { action, data: { cents: Number(obj.amount_paid ?? obj.amount_due ?? 0) } };
  }
  return { action, data: {} };
}

/** A trial that lapses produces no single Stripe event we can key on — the
 *  status simply moves off `trialing` at the period boundary. The capture
 *  therefore synthesises TRIAL_ENDED when it observes that transition, and
 *  records that it did so, because a synthesised action is weaker evidence
 *  than an observed one. */
export function synthesiseTrialEnd(preState, postState) {
  return preState.subState === 'trialing' && postState.subState !== 'trialing'
    ? { action: 'TRIAL_ENDED', data: {}, synthesised: true }
    : null;
}

export const STRIPE_STATUS_MAP = STATUS;
export const STRIPE_EVENT_MAP = EVENT;
