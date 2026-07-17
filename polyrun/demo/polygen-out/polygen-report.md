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
      "type": "enum: 'pending' | 'fraudCheck' | 'awaitingAmend' | 'charging' | 'shipping' | 'completed' | 'rejected' | 'paymentFailed' | 'cancelled'"
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
    "totalCents": 0,
    "txId": "",
    "cancelReason": ""
  },
  "actions": {
    "SUBMIT": {
      "dataFields": {
        "totalCents": "integer > 0"
      }
    },
    "FRAUD_PASSED": {
      "dataFields": {
        "itemsAvailable": "boolean - whether all items are in stock"
      }
    },
    "FRAUD_FAILED": {
      "dataFields": {
        "reason": "string"
      }
    },
    "AMEND": {
      "dataFields": {
        "totalCents": "integer > 0, amended order total"
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
    "CANCEL": {
      "dataFields": {
        "reason": "string"
      }
    },
    "SHIPMENT_DELIVERED": {
      "dataFields": {}
    }
  },
  "dataDomain": {
    "SUBMIT": {
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
    "CANCEL": {
      "reason": [
        "customer-request"
      ]
    },
    "SHIPMENT_DELIVERED": {}
  },
  "terminalKey": "orderState",
  "terminalStates": [
    "completed",
    "rejected",
    "paymentFailed",
    "cancelled"
  ],
  "specialRules": [
    {
      "name": "cancel-blocked-while-charging",
      "note": "CANCEL while orderState == 'charging' is rejected ('charge-in-flight'): a charge decision has been emitted and must resolve before the order can end.",
      "whenState": "orderState == 'charging'",
      "whenAction": "CANCEL"
    },
    {
      "name": "stale-completions-reject",
      "note": "Charge/shipment completions and timer expiries arriving in any state other than the one that awaits them are observable rejections (post == pre), never faults — this is what makes at-least-once delivery and stale timers safe.",
      "whenState": "any non-awaiting state",
      "whenAction": "CHARGE_SUCCEEDED | CHARGE_FAILED | CHARGE_TIMED_OUT | AMEND_WINDOW_EXPIRED | SHIPMENT_DELIVERED"
    }
  ],
  "noOpRule": "An action that does not apply in the current state is reject(reason) — an observable no-op with post == pre."
}
```

## Code (`C:\Users\jjdub\code\polygraph\polyrun\demo\polygen-out\next.cjs`)

```javascript
'use strict';

const { createInstance } = require('@cognitive-fab/sam-pattern');

const instance = createInstance({ strict: true, hasAsyncActions: false });

const INITIAL_STATE = {
  orderState: 'pending',
  totalCents: 0,
  txId: '',
  cancelReason: '',
};

const modelShape = {
  orderState: { type: 'string' },
  totalCents: { type: 'number' },
  txId: { type: 'string' },
  cancelReason: { type: 'string' },
};

const actionDefs = {
  SUBMIT: {
    action: (data = {}) => ({ ...data }),
    schema: { totalCents: { type: 'number', required: true } },
    domain: [{ totalCents: 2500 }],
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
    schema: { totalCents: { type: 'number', required: true } },
    domain: [{ totalCents: 1900 }],
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
  CANCEL: {
    action: (data = {}) => ({ ...data }),
    schema: { reason: { type: 'string', required: true } },
    domain: [{ reason: 'customer-request' }],
  },
  SHIPMENT_DELIVERED: {
    action: (data = {}) => ({ ...data }),
    schema: {},
    domain: [{}],
  },
};

const acceptors = {
  SUBMIT: (model) => (proposal, { reject }) => {
    if (model.orderState !== 'pending') {
      return reject('submit-not-applicable');
    }
    if (typeof proposal.totalCents !== 'number' ||
        !Number.isInteger(proposal.totalCents) ||
        proposal.totalCents < 0) {
      return reject('invalid-total');
    }
    model.orderState = 'fraudCheck';
    model.totalCents = proposal.totalCents;
  },

  FRAUD_PASSED: (model) => (proposal, { reject }) => {
    if (model.orderState !== 'fraudCheck') {
      return reject('fraud-result-not-applicable');
    }
    if (typeof proposal.itemsAvailable !== 'boolean') {
      return reject('invalid-items-available');
    }
    if (proposal.itemsAvailable) {
      model.orderState = 'charging';
    } else {
      model.orderState = 'awaitingAmend';
    }
  },

  FRAUD_FAILED: (model) => (proposal, { reject }) => {
    if (model.orderState !== 'fraudCheck') {
      return reject('fraud-result-not-applicable');
    }
    if (typeof proposal.reason !== 'string' || proposal.reason === '') {
      return reject('invalid-reason');
    }
    model.orderState = 'rejected';
    model.cancelReason = proposal.reason;
  },

  AMEND: (model) => (proposal, { reject }) => {
    if (model.orderState !== 'awaitingAmend') {
      return reject('amend-not-applicable');
    }
    if (typeof proposal.totalCents !== 'number' ||
        !Number.isInteger(proposal.totalCents) ||
        proposal.totalCents < 0) {
      return reject('invalid-total');
    }
    model.orderState = 'charging';
    model.totalCents = proposal.totalCents;
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
    if (typeof proposal.txId !== 'string' || proposal.txId === '') {
      return reject('invalid-tx-id');
    }
    model.orderState = 'shipping';
    model.txId = proposal.txId;
  },

  CHARGE_FAILED: (model) => (proposal, { reject }) => {
    if (model.orderState !== 'charging') {
      return reject('stale-completions-reject');
    }
    if (typeof proposal.reason !== 'string' || proposal.reason === '') {
      return reject('invalid-reason');
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

  CANCEL: (model) => (proposal, { reject }) => {
    if (model.orderState === 'charging') {
      return reject('cancel-blocked-while-charging');
    }
    if (model.orderState !== 'pending' &&
        model.orderState !== 'fraudCheck' &&
        model.orderState !== 'awaitingAmend') {
      return reject('cancel-not-applicable');
    }
    if (typeof proposal.reason !== 'string' || proposal.reason === '') {
      return reject('invalid-reason');
    }
    model.orderState = 'cancelled';
    model.cancelReason = proposal.reason;
  },

  SHIPMENT_DELIVERED: (model) => (proposal, { reject }) => {
    if (model.orderState !== 'shipping') {
      return reject('stale-completions-reject');
    }
    model.orderState = 'completed';
  },
};

const { intents } = instance({
  component: {
    modelShape,
    actions: actionDefs,
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
  CANCEL: (data = {}) => intents.CANCEL(data),
  SHIPMENT_DELIVERED: (data = {}) => intents.SHIPMENT_DELIVERED(data),
};

init();

module.exports = { instance, init, actions, getState, setState };
```

⚠️ **Proposed invariants — review before trusting; these encode the model's
reading of intent, not a verified spec.**

```javascript
const TERMINAL = ['cancelled', 'rejected', 'paymentFailed', 'completed'];
const STATES = ['pending', 'fraudCheck', 'awaitingAmend', 'charging', 'shipping', ...TERMINAL];
const same = (a, b) =>
  a.orderState === b.orderState &&
  a.totalCents === b.totalCents &&
  a.txId === b.txId &&
  a.cancelReason === b.cancelReason;

export const stateInvariants = [
  {
    name: 'order-state-is-valid',
    pred: (s) => STATES.includes(s.orderState),
  },
  {
    // Never shipped without a successful charge: shipping/completed require a txId.
    name: 'shipped-implies-charged',
    pred: (s) =>
      (s.orderState !== 'shipping' && s.orderState !== 'completed') ||
      (typeof s.txId === 'string' && s.txId.length > 0),
  },
  {
    // A cancelled or rejected order never holds a transaction id.
    name: 'cancelled-or-rejected-never-has-txid',
    pred: (s) =>
      (s.orderState !== 'cancelled' && s.orderState !== 'rejected') || s.txId === '',
  },
  {
    // Every ended-for-a-reason state records why (incl. amend-window-expired path).
    name: 'ended-states-record-reason',
    pred: (s) =>
      !['cancelled', 'rejected', 'paymentFailed'].includes(s.orderState) ||
      (typeof s.cancelReason === 'string' && s.cancelReason.length > 0),
  },
];

export const transitionInvariants = [
  {
    // cancel-blocked-while-charging: CANCEL in charging must be a pure reject.
    name: 'cancel-blocked-while-charging',
    pred: (pre, action, data, post) =>
      !(action === 'CANCEL' && pre.orderState === 'charging') || same(pre, post),
  },
  {
    // stale-completions-reject: completions/timers outside their awaiting state
    // must leave the model byte-for-byte unchanged (at-least-once safety).
    name: 'stale-completions-are-no-ops',
    pred: (pre, action, data, post) => {
      const awaits = {
        CHARGE_SUCCEEDED: 'charging',
        CHARGE_FAILED: 'charging',
        CHARGE_TIMED_OUT: 'charging',
        AMEND_WINDOW_EXPIRED: 'awaitingAmend',
        SHIPMENT_DELIVERED: 'shipping',
      };
      if (!(action in awaits)) return true;
      if (pre.orderState === awaits[action]) return true;
      return same(pre, post);
    },
  },
  {
    // Terminal states never re-open or mutate under any action.
    name: 'terminal-states-are-frozen',
    pred: (pre, action, data, post) =>
      !TERMINAL.includes(pre.orderState) || same(pre, post),
  },
  {
    // Never charged twice: txId only ever set by CHARGE_SUCCEEDED from charging,
    // and once set it is immutable.
    name: 'txid-written-once-only-by-successful-charge',
    pred: (pre, action, data, post) => {
      if (post.txId === pre.txId) return true;
      return (
        pre.txId === '' &&
        action === 'CHARGE_SUCCEEDED' &&
        pre.orderState === 'charging' &&
        post.orderState === 'shipping' &&
        post.txId.length > 0
      );
    },
  },
  {
    // Timer expiry cancels with the exact contracted reason.
    name: 'amend-expiry-cancels-with-reason',
    pred: (pre, action, data, post) =>
      !(action === 'AMEND_WINDOW_EXPIRED' && pre.orderState === 'awaitingAmend') ||
      (post.orderState === 'cancelled' && post.cancelReason === 'amend-window-expired'),
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
| 0 | 17 | no | no | — | — |

**Converged — no domain-ref gaps and no invariant violations reachable in the
final code**, over the explored (bounded) state space. Not a proof.

## Demo / regression trace corpus

- scenarios: **18** · windows: **79**
- corpus validated clean: no chaining/terminal problems.
- ⚠️ special rule 'cancel-blocked-while-charging' is exercised by only 0 window(s) (< 3) — thin regression coverage for that rule
- ⚠️ special rule 'stale-completions-reject' is exercised by only 0 window(s) (< 3) — thin regression coverage for that rule

## Independent replay sanity check

- windows replayed (separate process): **79** · non-pass: **0**

## Next steps

1. Review the contract and invariants above — both are the model's reading of
   your intent, not ground truth.
2. Wire the machine into the real handler/reducer via its exported `actions` —
   call the intents, do not reimplement the transition logic inline.
3. After integration, run `/polygraph:verify` against REAL captured traces to
   catch drift between this pure model and the glue code around it.