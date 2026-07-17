# polygen — authored spec report

> Consistency check, not a proof. This code has been model-checked against
> its own stated invariants and its demo corpus has been independently
> replayed — that is not the same as being correct. Review the contract and
> invariants below before trusting either.

- artifact: **SAM v2 strict-profile module** (`{ instance, init, actions, getState, setState }`, vendored sam-lib 2.0.0-alpha; strict validate() gate at every stage boundary)

## Contract

```json
{
  "lang": "javascript",
  "stateKeys": [
    {
      "name": "orderState",
      "type": "enum: 'pending' | 'fraudCheck' | 'awaitingAmend' | 'charging' | 'fulfilling' | 'completed' | 'partiallyDelivered' | 'rejected' | 'paymentFailed' | 'cancelled'"
    },
    {
      "name": "fulfillments",
      "type": "integer 0..2 — number of shipments this order splits into (0 until submitted)"
    },
    {
      "name": "shipmentsDelivered",
      "type": "integer 0..2 — shipments that completed with outcome 'delivered'"
    },
    {
      "name": "shipmentsFailed",
      "type": "integer 0..2 — shipments that completed with outcome 'cancelledShipment'"
    },
    {
      "name": "totalCents",
      "type": "integer >= 0, order total in cents"
    },
    {
      "name": "txId",
      "type": "string, payment transaction id ('' until charged)"
    },
    {
      "name": "cancelReason",
      "type": "string, why the order ended early ('' otherwise)"
    }
  ],
  "initState": {
    "orderState": "pending",
    "fulfillments": 0,
    "shipmentsDelivered": 0,
    "shipmentsFailed": 0,
    "totalCents": 0,
    "txId": "",
    "cancelReason": ""
  },
  "actions": {
    "SUBMIT": {
      "dataFields": {
        "fulfillments": "integer 1..2 — how many shipments the order's items split into",
        "totalCents": "integer > 0"
      }
    },
    "FRAUD_PASSED": {
      "dataFields": {
        "itemsAvailable": "boolean — whether all items are in stock"
      }
    },
    "FRAUD_FAILED": {
      "dataFields": {
        "reason": "string"
      }
    },
    "AMEND": {
      "dataFields": {
        "fulfillments": "integer 1..2, amended fulfillment count",
        "totalCents": "integer > 0, amended total"
      }
    },
    "AMEND_WINDOW_EXPIRED": {
      "dataFields": {}
    },
    "CHARGE_SUCCEEDED": {
      "dataFields": {
        "txId": "string"
      }
    },
    "CHARGE_FAILED": {
      "dataFields": {
        "reason": "string"
      }
    },
    "CHARGE_TIMED_OUT": {
      "dataFields": {}
    },
    "SHIPMENT_COMPLETED": {
      "dataFields": {
        "childKey": "string — which shipment child completed",
        "childState": "object — the child's terminal state, e.g. { shipState: 'delivered' } or { shipState: 'cancelledShipment' }"
      }
    },
    "CANCEL": {
      "dataFields": {
        "reason": "string"
      }
    }
  },
  "dataDomain": {
    "SUBMIT": {
      "fulfillments": [
        1,
        2
      ],
      "totalCents": [
        2500
      ]
    },
    "FRAUD_PASSED": {
      "itemsAvailable": [
        true,
        false
      ]
    },
    "FRAUD_FAILED": {
      "reason": [
        "suspicious"
      ]
    },
    "AMEND": {
      "fulfillments": [
        1
      ],
      "totalCents": [
        1900
      ]
    },
    "AMEND_WINDOW_EXPIRED": {},
    "CHARGE_SUCCEEDED": {
      "txId": [
        "tx-1"
      ]
    },
    "CHARGE_FAILED": {
      "reason": [
        "declined"
      ]
    },
    "CHARGE_TIMED_OUT": {},
    "SHIPMENT_COMPLETED": {
      "childKey": [
        "f1",
        "f2"
      ],
      "childState": [
        {
          "shipState": "delivered"
        },
        {
          "shipState": "cancelledShipment"
        }
      ]
    },
    "CANCEL": {
      "reason": [
        "customer-request"
      ]
    }
  },
  "terminalKey": "orderState",
  "terminalStates": [
    "completed",
    "partiallyDelivered",
    "rejected",
    "paymentFailed",
    "cancelled"
  ],
  "specialRules": [
    {
      "name": "cancel-blocked-while-charging",
      "note": "CANCEL while orderState == 'charging' is rejected (reason = this rule's name): a charge decision is in flight and must resolve first.",
      "whenState": "orderState == 'charging'",
      "whenAction": "CANCEL"
    },
    {
      "name": "fulfillment-in-progress",
      "note": "CANCEL while orderState == 'fulfilling' is rejected (reason = this rule's name): shipments are already with couriers; per-shipment cancellation is the shipment machine's business, not the order's.",
      "whenState": "orderState == 'fulfilling'",
      "whenAction": "CANCEL"
    },
    {
      "name": "rollup",
      "note": "SHIPMENT_COMPLETED (only applicable in 'fulfilling') increments shipmentsDelivered when childState.shipState == 'delivered', otherwise shipmentsFailed. When shipmentsDelivered + shipmentsFailed reaches fulfillments the order transitions: to 'completed' if shipmentsFailed == 0, else to 'partiallyDelivered'. While in 'fulfilling', shipmentsDelivered + shipmentsFailed is strictly less than fulfillments by construction.",
      "whenState": "orderState == 'fulfilling'",
      "whenAction": "SHIPMENT_COMPLETED"
    },
    {
      "name": "stale-completions-reject",
      "note": "Completions and timer expiries (FRAUD_*, CHARGE_*, AMEND_WINDOW_EXPIRED, SHIPMENT_COMPLETED) arriving in any state other than the one that awaits them are observable rejections (post == pre) — at-least-once delivery makes late and duplicate arrivals normal, never faults.",
      "whenState": "any non-awaiting state",
      "whenAction": "FRAUD_PASSED | FRAUD_FAILED | CHARGE_SUCCEEDED | CHARGE_FAILED | CHARGE_TIMED_OUT | AMEND_WINDOW_EXPIRED | SHIPMENT_COMPLETED"
    },
    {
      "name": "amend-resets-rollup",
      "note": "SUBMIT and AMEND set fulfillments from their data and reset shipmentsDelivered and shipmentsFailed to 0.",
      "whenState": "orderState == 'pending' (SUBMIT) or 'awaitingAmend' (AMEND)",
      "whenAction": "SUBMIT | AMEND"
    }
  ],
  "noOpRule": "An action that does not apply in the current state is reject(reason) — an observable no-op with post == pre, never a throw and never a silent mutation."
}
```

## Code (`C:\Users\jjdub\code\polygraph\examples\polyrun-oms\machines\order\next.cjs`)

```javascript
'use strict';

const { createInstance } = require('@cognitive-fab/sam-pattern');

const instance = createInstance({ strict: true, hasAsyncActions: false });

const INITIAL_STATE = {
  orderState: 'pending',
  fulfillments: 0,
  shipmentsDelivered: 0,
  shipmentsFailed: 0,
  totalCents: 0,
  txId: '',
  cancelReason: '',
};

const modelShape = {
  orderState: { type: 'string' },
  fulfillments: { type: 'number' },
  shipmentsDelivered: { type: 'number' },
  shipmentsFailed: { type: 'number' },
  totalCents: { type: 'number' },
  txId: { type: 'string' },
  cancelReason: { type: 'string' },
};

const componentActions = {
  SUBMIT: {
    action: (data = {}) => ({ ...data }),
    schema: {
      fulfillments: { type: 'number', required: true },
      totalCents: { type: 'number', required: true },
    },
    domain: [
      { fulfillments: 1, totalCents: 2500 },
      { fulfillments: 2, totalCents: 2500 },
    ],
  },
  FRAUD_PASSED: {
    action: (data = {}) => ({ ...data }),
    schema: { itemsAvailable: { type: 'boolean', required: true } },
    domain: [{ itemsAvailable: true }, { itemsAvailable: false }],
  },
  FRAUD_FAILED: {
    action: (data = {}) => ({ ...data }),
    schema: { reason: { type: 'string', required: true } },
    domain: [{ reason: 'suspicious' }],
  },
  AMEND: {
    action: (data = {}) => ({ ...data }),
    schema: {
      fulfillments: { type: 'number', required: true },
      totalCents: { type: 'number', required: true },
    },
    domain: [{ fulfillments: 1, totalCents: 1900 }],
  },
  AMEND_WINDOW_EXPIRED: {
    action: (data = {}) => ({ ...data }),
    schema: {},
    domain: [{}],
  },
  CHARGE_SUCCEEDED: {
    action: (data = {}) => ({ ...data }),
    schema: { txId: { type: 'string', required: true } },
    domain: [{ txId: 'tx-1' }],
  },
  CHARGE_FAILED: {
    action: (data = {}) => ({ ...data }),
    schema: { reason: { type: 'string', required: true } },
    domain: [{ reason: 'declined' }],
  },
  CHARGE_TIMED_OUT: {
    action: (data = {}) => ({ ...data }),
    schema: {},
    domain: [{}],
  },
  SHIPMENT_COMPLETED: {
    action: (data = {}) => ({ ...data }),
    schema: {
      childKey: { type: 'string', required: true },
      childState: { type: 'object', required: true },
    },
    domain: [
      { childKey: 'f1', childState: { shipState: 'delivered' } },
      { childKey: 'f1', childState: { shipState: 'cancelledShipment' } },
      { childKey: 'f2', childState: { shipState: 'delivered' } },
      { childKey: 'f2', childState: { shipState: 'cancelledShipment' } },
    ],
  },
  CANCEL: {
    action: (data = {}) => ({ ...data }),
    schema: { reason: { type: 'string', required: true } },
    domain: [{ reason: 'customer-request' }],
  },
};

// Contract's exact spellings for SHIPMENT_COMPLETED.childState.shipState
const SHIP_STATE_DELIVERED = 'delivered';
const SHIP_STATE_CANCELLED_SHIPMENT = 'cancelledShipment';

const acceptors = {
  SUBMIT: (model) => (proposal, { reject }) => {
    if (model.orderState !== 'pending') {
      return reject('amend-resets-rollup');
    }
    model.fulfillments = proposal.fulfillments;
    model.totalCents = proposal.totalCents;
    model.shipmentsDelivered = 0;
    model.shipmentsFailed = 0;
    model.orderState = 'fraudCheck';
  },

  FRAUD_PASSED: (model) => (proposal, { reject }) => {
    if (model.orderState !== 'fraudCheck') {
      return reject('stale-completions-reject');
    }
    if (proposal.itemsAvailable === true) {
      model.orderState = 'charging';
    } else {
      model.orderState = 'awaitingAmend';
    }
  },

  FRAUD_FAILED: (model) => (proposal, { reject }) => {
    if (model.orderState !== 'fraudCheck') {
      return reject('stale-completions-reject');
    }
    model.orderState = 'rejected';
    model.cancelReason = proposal.reason;
  },

  AMEND: (model) => (proposal, { reject }) => {
    if (model.orderState !== 'awaitingAmend') {
      return reject('amend-resets-rollup');
    }
    model.fulfillments = proposal.fulfillments;
    model.totalCents = proposal.totalCents;
    model.shipmentsDelivered = 0;
    model.shipmentsFailed = 0;
    model.orderState = 'charging';
  },

  AMEND_WINDOW_EXPIRED: (model) => (proposal, { reject }) => {
    if (model.orderState !== 'awaitingAmend') {
      return reject('stale-completions-reject');
    }
    model.orderState = 'cancelled';
    model.cancelReason = 'amend-window-expired';
  },

  CHARGE_SUCCEEDED: (model) => (proposal, { reject }) => {
    if (model.orderState !== 'charging') {
      return reject('stale-completions-reject');
    }
    model.txId = proposal.txId;
    model.orderState = 'fulfilling';
  },

  CHARGE_FAILED: (model) => (proposal, { reject }) => {
    if (model.orderState !== 'charging') {
      return reject('stale-completions-reject');
    }
    model.orderState = 'paymentFailed';
    model.cancelReason = proposal.reason;
  },

  CHARGE_TIMED_OUT: (model) => (proposal, { reject }) => {
    if (model.orderState !== 'charging') {
      return reject('stale-completions-reject');
    }
    model.orderState = 'paymentFailed';
    model.cancelReason = 'charge-timed-out';
  },

  SHIPMENT_COMPLETED: (model) => (proposal, { reject }) => {
    if (model.orderState !== 'fulfilling') {
      return reject('stale-completions-reject');
    }
    if (model.shipmentsDelivered + model.shipmentsFailed >= model.fulfillments) {
      return reject('rollup');
    }
    if (!proposal.childState || typeof proposal.childState !== 'object') {
      return reject('rollup');
    }
    const shipState = proposal.childState.shipState;
    if (shipState === SHIP_STATE_DELIVERED) {
      // childState = { shipState: 'delivered' } — count as delivered
      model.shipmentsDelivered = model.shipmentsDelivered + 1;
    } else if (shipState === SHIP_STATE_CANCELLED_SHIPMENT) {
      // childState = { shipState: 'cancelledShipment' } — count as failed
      model.shipmentsFailed = model.shipmentsFailed + 1;
    } else {
      return reject('rollup');
    }
    if (model.shipmentsDelivered + model.shipmentsFailed === model.fulfillments) {
      if (model.shipmentsFailed === 0) {
        model.orderState = 'completed';
      } else {
        model.orderState = 'partiallyDelivered';
      }
    }
  },

  CANCEL: (model) => (proposal, { reject }) => {
    if (model.orderState === 'charging') {
      return reject('cancel-blocked-while-charging');
    }
    if (model.orderState === 'fulfilling') {
      return reject('fulfillment-in-progress');
    }
    if (
      model.orderState !== 'pending' &&
      model.orderState !== 'fraudCheck' &&
      model.orderState !== 'awaitingAmend'
    ) {
      return reject('cancel-not-applicable');
    }
    model.orderState = 'cancelled';
    model.cancelReason = proposal.reason;
  },
};

const { intents } = instance({
  initialState: INITIAL_STATE,
  component: {
    name: 'order',
    modelShape,
    actions: componentActions,
    acceptors,
  },
});

const getState = () => instance({}).getState();
const setState = (snapshot) => instance({}).setState(snapshot);
const init = () => setState(INITIAL_STATE);

const actions = {
  SUBMIT: (data = {}) => intents.SUBMIT(data),
  FRAUD_PASSED: (data = {}) => intents.FRAUD_PASSED(data),
  FRAUD_FAILED: (data = {}) => intents.FRAUD_FAILED(data),
  AMEND: (data = {}) => intents.AMEND(data),
  AMEND_WINDOW_EXPIRED: (data = {}) => intents.AMEND_WINDOW_EXPIRED(data),
  CHARGE_SUCCEEDED: (data = {}) => intents.CHARGE_SUCCEEDED(data),
  CHARGE_FAILED: (data = {}) => intents.CHARGE_FAILED(data),
  CHARGE_TIMED_OUT: (data = {}) => intents.CHARGE_TIMED_OUT(data),
  SHIPMENT_COMPLETED: (data = {}) => intents.SHIPMENT_COMPLETED(data),
  CANCEL: (data = {}) => intents.CANCEL(data),
};

module.exports = { instance, init, actions, getState, setState };
```

⚠️ **Proposed invariants — review before trusting; these encode the model's
reading of intent, not a verified spec.**

```javascript
const same = (a, b) =>
  a.orderState === b.orderState &&
  a.fulfillments === b.fulfillments &&
  a.shipmentsDelivered === b.shipmentsDelivered &&
  a.shipmentsFailed === b.shipmentsFailed &&
  a.totalCents === b.totalCents &&
  a.txId === b.txId &&
  a.cancelReason === b.cancelReason;

const TERMINAL = ['rejected', 'cancelled', 'paymentFailed', 'completed', 'partiallyDelivered'];
const AWAITS = {
  FRAUD_PASSED: 'fraudCheck',
  FRAUD_FAILED: 'fraudCheck',
  CHARGE_SUCCEEDED: 'charging',
  CHARGE_FAILED: 'charging',
  CHARGE_TIMED_OUT: 'charging',
  AMEND_WINDOW_EXPIRED: 'awaitingAmend',
  SHIPMENT_COMPLETED: 'fulfilling',
};

export const stateInvariants = [
  {
    // Rollup counters never exceed fulfillments; while still fulfilling the
    // sum is strictly below fulfillments (rule: rollup).
    name: 'rollup-counters-bounded',
    pred: (s) =>
      s.shipmentsDelivered >= 0 &&
      s.shipmentsFailed >= 0 &&
      s.shipmentsDelivered + s.shipmentsFailed <= s.fulfillments &&
      (s.orderState !== 'fulfilling' ||
        s.shipmentsDelivered + s.shipmentsFailed < s.fulfillments),
  },
  {
    // Never fulfilling (or past it) without a recorded charge transaction.
    name: 'fulfilling-implies-txid',
    pred: (s) =>
      !['fulfilling', 'completed', 'partiallyDelivered'].includes(s.orderState) ||
      s.txId !== '',
  },
  {
    // A completed order delivered every shipment; partiallyDelivered means all
    // shipments accounted for with at least one failure.
    name: 'terminal-rollup-consistency',
    pred: (s) =>
      (s.orderState !== 'completed' ||
        (s.shipmentsFailed === 0 && s.shipmentsDelivered === s.fulfillments)) &&
      (s.orderState !== 'partiallyDelivered' ||
        (s.shipmentsFailed >= 1 &&
          s.shipmentsDelivered + s.shipmentsFailed === s.fulfillments)),
  },
];

export const transitionInvariants = [
  {
    // Terminal states are frozen: no action mutates anything once terminal.
    name: 'terminal-states-frozen',
    pred: (pre, action, data, post) =>
      !TERMINAL.includes(pre.orderState) || same(pre, post),
  },
  {
    // Never charged twice: once txId is set it never changes, and it is only
    // ever set by CHARGE_SUCCEEDED arriving in 'charging'.
    name: 'never-charged-twice',
    pred: (pre, action, data, post) => {
      if (pre.txId !== '') return post.txId === pre.txId;
      if (post.txId !== pre.txId)
        return action === 'CHARGE_SUCCEEDED' && pre.orderState === 'charging';
      return true;
    },
  },
  {
    // Completions/timers arriving in any state other than the one awaiting
    // them must leave the state entirely unchanged (at-least-once delivery).
    name: 'stale-completions-are-noops',
    pred: (pre, action, data, post) =>
      !(action in AWAITS) ||
      pre.orderState === AWAITS[action] ||
      same(pre, post),
  },
  {
    // CANCEL is blocked (no mutation) in charging and fulfilling, and only
    // cancels from pending/fraudCheck/awaitingAmend, recording the reason.
    name: 'cancel-rules',
    pred: (pre, action, data, post) => {
      if (action !== 'CANCEL') return true;
      if (['pending', 'fraudCheck', 'awaitingAmend'].includes(pre.orderState))
        return post.orderState === 'cancelled' && post.cancelReason === data.reason;
      return same(pre, post);
    },
  },
  {
    // SUBMIT (from pending) and AMEND (from awaitingAmend) record the new
    // fulfillments/total and reset both rollup counters to zero.
    name: 'submit-amend-resets-rollup',
    pred: (pre, action, data, post) => {
      if (action === 'SUBMIT' && pre.orderState === 'pending')
        return (
          post.orderState === 'fraudCheck' &&
          post.fulfillments === data.fulfillments &&
          post.totalCents === data.totalCents &&
          post.shipmentsDelivered === 0 &&
          post.shipmentsFailed === 0
        );
      if (action === 'AMEND' && pre.orderState === 'awaitingAmend')
        return (
          post.orderState === 'charging' &&
          post.fulfillments === data.fulfillments &&
          post.totalCents === data.totalCents &&
          post.shipmentsDelivered === 0 &&
          post.shipmentsFailed === 0
        );
      if (action === 'SUBMIT' || action === 'AMEND') return same(pre, post);
      return true;
    },
  },
  {
    // SHIPMENT_COMPLETED in fulfilling increments exactly the right counter
    // and finalizes the order exactly when the last shipment reports in.
    name: 'shipment-rollup-correct',
    pred: (pre, action, data, post) => {
      if (action !== 'SHIPMENT_COMPLETED' || pre.orderState !== 'fulfilling')
        return true;
      const delivered = data.childState && data.childState.shipState === 'delivered';
      const okCounts = delivered
        ? post.shipmentsDelivered === pre.shipmentsDelivered + 1 &&
          post.shipmentsFailed === pre.shipmentsFailed
        : post.shipmentsFailed === pre.shipmentsFailed + 1 &&
          post.shipmentsDelivered === pre.shipmentsDelivered;
      if (!okCounts) return false;
      const done = post.shipmentsDelivered + post.shipmentsFailed === pre.fulfillments;
      if (done)
        return post.orderState === (post.shipmentsFailed === 0 ? 'completed' : 'partiallyDelivered');
      return post.orderState === 'fulfilling';
    },
  },
];
```

## Self-repair loop

Two defect classes are checked every round, in order: domain-ref gaps (a
`dataDomain` value the contract declares but the code never handles — these
are fixed FIRST, since until they're gone the checker may never even reach
what an invariant is meant to guard) and invariant violations.

| iteration | states explored | cap hit | nondeterministic | domain gaps | violations |
|---|---|---|---|---|---|
| 0 | 1 | no | no | 2 | submit-amend-resets-rollup, cancel-rules |
| 1 | 1 | no | no | 2 | submit-amend-resets-rollup, cancel-rules |
| 2 | 1 | no | no | 2 | submit-amend-resets-rollup, cancel-rules |
| 3 | 1 | no | no | 2 | submit-amend-resets-rollup, cancel-rules |

**Iteration 0 domain-ref gaps (what got fixed before the next round):**
  - SHIPMENT_COMPLETED.childState = {"shipState":"delivered"} (declared in dataDomain, never referenced in the code — the transition it should gate may be unreachable)
  - SHIPMENT_COMPLETED.childState = {"shipState":"cancelledShipment"} (declared in dataDomain, never referenced in the code — the transition it should gate may be unreachable)

**Iteration 1 domain-ref gaps (what got fixed before the next round):**
  - SHIPMENT_COMPLETED.childState = {"shipState":"delivered"} (declared in dataDomain, never referenced in the code — the transition it should gate may be unreachable)
  - SHIPMENT_COMPLETED.childState = {"shipState":"cancelledShipment"} (declared in dataDomain, never referenced in the code — the transition it should gate may be unreachable)

**Iteration 2 domain-ref gaps (what got fixed before the next round):**
  - SHIPMENT_COMPLETED.childState = {"shipState":"delivered"} (declared in dataDomain, never referenced in the code — the transition it should gate may be unreachable)
  - SHIPMENT_COMPLETED.childState = {"shipState":"cancelledShipment"} (declared in dataDomain, never referenced in the code — the transition it should gate may be unreachable)

**Iteration 3 domain-ref gaps (what got fixed before the next round):**
  - SHIPMENT_COMPLETED.childState = {"shipState":"delivered"} (declared in dataDomain, never referenced in the code — the transition it should gate may be unreachable)
  - SHIPMENT_COMPLETED.childState = {"shipState":"cancelledShipment"} (declared in dataDomain, never referenced in the code — the transition it should gate may be unreachable)

⚠️ **DID NOT CONVERGE within the repair budget.**

Unresolved domain-ref gaps (the checker's exploration may be understating what
it actually examined):
  - SHIPMENT_COMPLETED.childState = {"shipState":"delivered"} (declared in dataDomain, never referenced in the code — the transition it should gate may be unreachable)
  - SHIPMENT_COMPLETED.childState = {"shipState":"cancelledShipment"} (declared in dataDomain, never referenced in the code — the transition it should gate may be unreachable)

The final code still reaches: submit-amend-resets-rollup, cancel-rules.

Do NOT treat this as clean — fix by hand or re-run with a higher --repair-max.

## Demo / regression trace corpus

- scenarios: **16** · windows: **81**
- ⚠️ **16 corpus problem(s) survived the feedback retry:**
  - all_shipments_failed_partial_rollup.ndjson: ends in 'pending', not a declared terminal state
  - amend_resets_rollup_then_completed.ndjson: ends in 'pending', not a declared terminal state
  - amend_window_expired_cancelled.ndjson: ends in 'pending', not a declared terminal state
  - cancel_blocked_then_fulfilling_blocked_then_completed.ndjson: ends in 'pending', not a declared terminal state
  - cancel_from_awaiting_amend.ndjson: ends in 'pending', not a declared terminal state
  - cancel_from_fraud_check_with_submit_noop.ndjson: ends in 'pending', not a declared terminal state
  - cancel_from_pending_with_late_submit.ndjson: ends in 'pending', not a declared terminal state
  - duplicate_charge_retries_then_partial.ndjson: ends in 'pending', not a declared terminal state
  - fraud_rejected_with_stale_charge.ndjson: ends in 'pending', not a declared terminal state
  - happy_path_two_shipments_completed.ndjson: ends in 'pending', not a declared terminal state
  - late_completions_after_terminal.ndjson: ends in 'pending', not a declared terminal state
  - partial_delivery_mixed_rollup.ndjson: ends in 'pending', not a declared terminal state
  - payment_declined_with_cancel_blocked.ndjson: ends in 'pending', not a declared terminal state
  - payment_timeout_with_cancel_blocked.ndjson: ends in 'pending', not a declared terminal state
  - single_shipment_completed_rollup.ndjson: ends in 'pending', not a declared terminal state
  - stale_completions_before_submit_then_completed.ndjson: ends in 'pending', not a declared terminal state
- ⚠️ special rule 'cancel-blocked-while-charging' is exercised by only 0 window(s) (< 3) — thin regression coverage for that rule
- ⚠️ special rule 'fulfillment-in-progress' is exercised by only 0 window(s) (< 3) — thin regression coverage for that rule
- ⚠️ special rule 'rollup' is exercised by only 0 window(s) (< 3) — thin regression coverage for that rule
- ⚠️ special rule 'stale-completions-reject' is exercised by only 0 window(s) (< 3) — thin regression coverage for that rule
- ⚠️ special rule 'amend-resets-rollup' is exercised by only 0 window(s) (< 3) — thin regression coverage for that rule

## Independent replay sanity check

- windows replayed (separate process): **81** · non-pass: **0**

## Next steps

1. Review the contract and invariants above — both are the model's reading of
   your intent, not ground truth.
2. Wire the machine into the real handler/reducer via its exported `actions` —
   call the intents, do not reimplement the transition logic inline.
3. After integration, run `/polygraph:verify` against REAL captured traces to
   catch drift between this pure model and the glue code around it.