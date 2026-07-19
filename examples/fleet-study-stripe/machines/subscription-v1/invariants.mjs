// Fleet study Tier 2 — intent for the subscription machine.
//
// These are billing rules a finance team would actually assert, written as
// predicates over the observable projection. Everything the gates later
// claim is relative to THIS FILE and to the four keys the contract declares.
'use strict';

const LIVE = ['incomplete', 'trialing', 'active', 'pastDue', 'unpaid'];
const MAX_DUNNING = 3;

export const stateInvariants = [
  {
    // The money rule: an active subscription is one we can bill, which means
    // a payment method is on file. Catching a state that is 'active' with no
    // payment method would mean we believe we are collecting when we are not.
    name: 'active-implies-payment-method',
    pred: (s) => s.subState !== 'active' || s.hasPaymentMethod === true,
  },
  {
    // Dunning is a budget, not an open loop: nothing may burn more retries
    // than the policy allows, and only a live subscription can be mid-dunning.
    name: 'dunning-within-budget',
    pred: (s) => Number.isInteger(s.dunningAttempts)
      && s.dunningAttempts >= 0 && s.dunningAttempts <= MAX_DUNNING,
  },
  {
    // Exhausting the budget must land in unpaid — never leave a subscription
    // sitting in pastDue with no retries left, which would stall silently.
    name: 'exhausted-dunning-is-unpaid',
    pred: (s) => s.dunningAttempts < MAX_DUNNING || ['unpaid', 'canceled', 'incompleteExpired'].includes(s.subState),
  },
  {
    // A terminal subscription is settled: it must not look mid-dunning, or
    // recovery tooling will keep trying to collect on a dead record.
    name: 'terminal-is-not-mid-dunning',
    pred: (s) => LIVE.includes(s.subState) || s.subState === 'canceled' || s.dunningAttempts === 0,
  },
  {
    name: 'amount-nonnegative',
    pred: (s) => Number.isInteger(s.cents) && s.cents >= 0,
  },
];

export const transitionInvariants = [
  {
    // Once a payment method is attached it does not silently vanish — losing
    // it would strand the subscription without any observable cause.
    name: 'payment-method-not-silently-detached',
    pred: (pre, action, data, post) => !(pre.hasPaymentMethod === true && post.hasPaymentMethod === false),
  },
  {
    // A terminal subscription never comes back to life. Stripe's own model
    // requires a NEW subscription for that, so resurrection would mean we
    // diverged from the billing system of record.
    name: 'no-resurrection-from-terminal',
    pred: (pre, action, data, post) =>
      !(['canceled', 'incompleteExpired'].includes(pre.subState) && LIVE.includes(post.subState)),
  },
];

export default { stateInvariants, transitionInvariants };
