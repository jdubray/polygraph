// Intent invariants for auditing the reference app's Order workflow. These
// encode what a reasonable owner of an order system would EXPECT — which is
// exactly what no tool can derive from the code, because code with a
// surprising behavior is a faithful description of that behavior. Some of
// these are candidates we EXPECT the code to satisfy; the interesting ones
// are the candidates we suspect it does not (see the README's findings).
'use strict';

const ORDER = ['pending', 'customerActionRequired', 'processing', 'completed', 'failed', 'cancelled', 'timedOut'];
const FULFILLMENT = ['pending', 'unavailable', 'processing', 'completed', 'cancelled', 'failed'];

export const stateInvariants = [
  {
    name: 'enums-valid',
    pred: (s) => ORDER.includes(s.status) && Array.isArray(s.fulfillments) && s.fulfillments.every((f) => FULFILLMENT.includes(f)),
  },
  {
    // The candidate finding: an order should not report success when nothing
    // was fulfilled. The code sets Completed unless ALL fulfillments FAILED —
    // all-cancelled (e.g. every item unavailable, customer amends) also lands
    // on Completed with zero goods shipped and zero payment taken.
    name: 'completed-implies-some-fulfillment-completed',
    pred: (s) => s.status !== 'completed' || s.fulfillments.some((f) => f === 'completed'),
  },
  {
    // Weaker sibling of the above, still violated by partial failures being
    // reported as plain 'completed' with no partial marker in the status.
    name: 'completed-implies-no-failed-fulfillment',
    pred: (s) => s.status !== 'completed' || s.fulfillments.every((f) => f !== 'failed'),
  },
  {
    name: 'timedOut-implies-all-cancelled',
    pred: (s) => s.status !== 'timedOut' || s.fulfillments.every((f) => f === 'cancelled'),
  },
  {
    name: 'failed-implies-all-failed',
    pred: (s) => s.status !== 'failed' || (s.fulfillments.length > 0 && s.fulfillments.every((f) => f === 'failed')),
  },
  {
    // Cancellation is only offered before any charge is attempted, so a
    // cancelled order must never contain fulfillment work products.
    name: 'cancelled-implies-no-progress',
    pred: (s) => s.status !== 'cancelled' || s.fulfillments.every((f) => f === 'pending' || f === 'unavailable'),
  },
  {
    name: 'no-completion-before-processing',
    pred: (s) => !['pending', 'customerActionRequired'].includes(s.status) || s.fulfillments.every((f) => f !== 'completed' && f !== 'failed' && f !== 'processing'),
  },
];
