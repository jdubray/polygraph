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
      "name": "shipState",
      "type": "enum: 'preparing' | 'inTransit' | 'delivered' | 'cancelledShipment'"
    }
  ],
  "initState": {
    "shipState": "preparing"
  },
  "actions": {
    "SHIP": {
      "dataFields": {}
    },
    "DELIVER": {
      "dataFields": {}
    },
    "CANCEL_SHIPMENT": {
      "dataFields": {}
    }
  },
  "dataDomain": {
    "SHIP": {},
    "DELIVER": {},
    "CANCEL_SHIPMENT": {}
  },
  "terminalKey": "shipState",
  "terminalStates": [
    "delivered",
    "cancelledShipment"
  ],
  "specialRules": [
    {
      "name": "already-shipped",
      "note": "SHIP is only applicable while shipState == 'preparing'; in any other state it is an observable rejection (reason = this rule's name).",
      "whenState": "shipState != 'preparing'",
      "whenAction": "SHIP"
    },
    {
      "name": "not-in-transit",
      "note": "DELIVER is only applicable while shipState == 'inTransit'; in any other state it is an observable rejection (reason = this rule's name).",
      "whenState": "shipState != 'inTransit'",
      "whenAction": "DELIVER"
    },
    {
      "name": "cancel-too-late",
      "note": "CANCEL_SHIPMENT is only applicable while shipState == 'preparing' — once handed to the courier a shipment cannot be cancelled; in any other state it is an observable rejection (reason = this rule's name). This action is also the parent order's declared onParentTerminal cancel, so it MUST be delivery-safe: late or duplicate deliveries reject cleanly.",
      "whenState": "shipState != 'preparing'",
      "whenAction": "CANCEL_SHIPMENT"
    }
  ],
  "noOpRule": "An action that does not apply in the current state is reject(reason) — an observable no-op with post == pre, never a throw and never a silent mutation (completions and timers are delivered at-least-once)."
}
```

## Code (`C:\Users\jjdub\code\polygraph\polyrun\test\fixtures\polygen-shipment\next.cjs`)

```javascript
'use strict';

const { createInstance } = require('@cognitive-fab/sam-pattern');

const instance = createInstance({ strict: true, hasAsyncActions: false });

const INITIAL_STATE = {
  shipState: 'preparing',
};

const modelShape = {
  shipState: { type: 'string' },
};

const actionDefs = {
  SHIP: {
    action: (data = {}) => ({ ...data }),
    schema: {},
    domain: [{}],
  },
  DELIVER: {
    action: (data = {}) => ({ ...data }),
    schema: {},
    domain: [{}],
  },
  CANCEL_SHIPMENT: {
    action: (data = {}) => ({ ...data }),
    schema: {},
    domain: [{}],
  },
};

const acceptors = {
  SHIP: (model) => (proposal, { reject }) => {
    if (model.shipState !== 'preparing') {
      reject('already-shipped');
      return;
    }
    model.shipState = 'inTransit';
  },
  DELIVER: (model) => (proposal, { reject }) => {
    if (model.shipState !== 'inTransit') {
      reject('not-in-transit');
      return;
    }
    model.shipState = 'delivered';
  },
  CANCEL_SHIPMENT: (model) => (proposal, { reject }) => {
    if (model.shipState !== 'preparing') {
      reject('cancel-too-late');
      return;
    }
    model.shipState = 'cancelledShipment';
  },
};

const { intents } = instance({
  component: {
    modelShape,
    actions: actionDefs,
    acceptors,
  },
});

const actions = {
  SHIP: (data = {}) => intents.SHIP(data),
  DELIVER: (data = {}) => intents.DELIVER(data),
  CANCEL_SHIPMENT: (data = {}) => intents.CANCEL_SHIPMENT(data),
};

const getState = () => instance({}).getState();
const setState = (snapshot) => instance({}).setState(snapshot);
const init = () => setState(INITIAL_STATE);

module.exports = { instance, init, actions, getState, setState };
```

⚠️ **Proposed invariants — review before trusting; these encode the model's
reading of intent, not a verified spec.**

```javascript
export const stateInvariants = [
  {
    name: 'ship-state-is-valid',
    pred: (state) =>
      ['preparing', 'inTransit', 'delivered', 'cancelledShipment'].includes(
        state.shipState
      ),
  },
];

export const transitionInvariants = [
  {
    // SHIP only succeeds from 'preparing' -> 'inTransit'; from anywhere else
    // it must be a rejected no-op (already-shipped), never a mutation.
    name: 'ship-only-from-preparing',
    pred: (pre, action, data, post) => {
      if (action !== 'SHIP') return true;
      if (pre.shipState === 'preparing') return post.shipState === 'inTransit';
      return post.shipState === pre.shipState;
    },
  },
  {
    // DELIVER only succeeds from 'inTransit' -> 'delivered'; from anywhere
    // else it must be a rejected no-op (not-in-transit).
    name: 'deliver-only-from-in-transit',
    pred: (pre, action, data, post) => {
      if (action !== 'DELIVER') return true;
      if (pre.shipState === 'inTransit') return post.shipState === 'delivered';
      return post.shipState === pre.shipState;
    },
  },
  {
    // CANCEL_SHIPMENT only succeeds from 'preparing' -> 'cancelledShipment';
    // once handed to the courier (or terminal) it must be a rejected no-op
    // (cancel-too-late).
    name: 'cancel-only-while-preparing',
    pred: (pre, action, data, post) => {
      if (action !== 'CANCEL_SHIPMENT') return true;
      if (pre.shipState === 'preparing')
        return post.shipState === 'cancelledShipment';
      return post.shipState === pre.shipState;
    },
  },
  {
    // Terminal states are absorbing: delivered can never become cancelled,
    // cancelled can never ship or deliver — no action escapes a terminal state.
    name: 'terminal-states-are-absorbing',
    pred: (pre, action, data, post) => {
      if (pre.shipState === 'delivered' || pre.shipState === 'cancelledShipment') {
        return post.shipState === pre.shipState;
      }
      return true;
    },
  },
  {
    // Any state change must be one of the three legal transitions — no silent
    // mutations or invented paths under duplicate/late deliveries.
    name: 'only-legal-transitions-occur',
    pred: (pre, action, data, post) => {
      if (pre.shipState === post.shipState) return true;
      return (
        (pre.shipState === 'preparing' &&
          post.shipState === 'inTransit' &&
          action === 'SHIP') ||
        (pre.shipState === 'inTransit' &&
          post.shipState === 'delivered' &&
          action === 'DELIVER') ||
        (pre.shipState === 'preparing' &&
          post.shipState === 'cancelledShipment' &&
          action === 'CANCEL_SHIPMENT')
      );
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
| 0 | 4 | no | no | — | — |

**Converged — no domain-ref gaps and no invariant violations reachable in the
final code**, over the explored (bounded) state space. Not a proof.

## Demo / regression trace corpus

- scenarios: **16** · windows: **56**
- corpus validated clean: no chaining/terminal problems.
- ⚠️ special rule 'already-shipped' is exercised by only 0 window(s) (< 3) — thin regression coverage for that rule
- ⚠️ special rule 'not-in-transit' is exercised by only 0 window(s) (< 3) — thin regression coverage for that rule
- ⚠️ special rule 'cancel-too-late' is exercised by only 0 window(s) (< 3) — thin regression coverage for that rule

## Independent replay sanity check

- windows replayed (separate process): **56** · non-pass: **0**

## Next steps

1. Review the contract and invariants above — both are the model's reading of
   your intent, not ground truth.
2. Wire the machine into the real handler/reducer via its exported `actions` —
   call the intents, do not reimplement the transition logic inline.
3. After integration, run `/polygraph:verify` against REAL captured traces to
   catch drift between this pure model and the glue code around it.