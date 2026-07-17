// Intent invariants for the Shipment workflow audit. As with the Order
// audit, these encode what a reasonable owner would EXPECT — the
// interesting ones are the candidates we suspect the code does not enforce.
'use strict';

const DOCUMENTED = ['pending', 'booked', 'dispatched', 'delivered'];
const RANK = { pending: 0, booked: 1, dispatched: 2, delivered: 3 };

export const stateInvariants = [
  {
    // Candidate finding S1: the carrier update is applied verbatim, so any
    // string a carrier sends becomes the shipment's status.
    name: 'status-is-a-documented-value',
    pred: (s) => DOCUMENTED.includes(s.status),
  },
];

export const transitionInvariants = [
  {
    // Candidate finding S2: a shipment's progress should be monotonic —
    // once dispatched it should not observably return to 'booked' (or
    // 'pending'). The receive loop enforces nothing of the sort.
    name: 'status-never-regresses',
    pred: (pre, action, data, post) => {
      const a = RANK[pre.status];
      const b = RANK[post.status];
      if (a === undefined || b === undefined) return true; // S1's territory
      return b >= a;
    },
  },
  {
    // Sanity: delivery is terminal — nothing transitions out of it.
    name: 'delivered-is-terminal',
    pred: (pre, action, data, post) => pre.status !== 'delivered' || post.status === 'delivered',
  },
  {
    // A booked shipment must never observably return to the pre-booking
    // status (the sharpest regression the checker found: CARRIER_UPDATE
    // with status 'pending' is applied verbatim).
    name: 'booked-never-returns-to-pending',
    pred: (pre, action, data, post) => !pre.booked || post.status !== 'pending',
  },
];
