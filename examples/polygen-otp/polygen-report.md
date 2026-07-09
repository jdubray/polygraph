# polygen — authored spec report

> Consistency check, not a proof. This code has been model-checked against
> its own stated invariants and its demo corpus has been independently
> replayed — that is not the same as being correct. Review the contract and
> invariants below before trusting either.

## Contract

⚠️ **Model-drafted, not extracted from existing code — review before use.**

```json
{
  "lang": "javascript",
  "stateKeys": [
    {
      "name": "status",
      "type": "enum: 'no_code' | 'pending' | 'verified' | 'locked'"
    },
    {
      "name": "attempts",
      "type": "integer >= 0, count of failed LIVE (non-expired) mismatches since last code issuance"
    }
  ],
  "initState": {
    "status": "no_code",
    "attempts": 0
  },
  "actions": {
    "ISSUE_CODE": {
      "dataFields": {}
    },
    "ATTEMPT": {
      "dataFields": {
        "match": "boolean - whether the submitted code equals the currently issued code, independent of expiry",
        "expired": "boolean - whether the currently issued code has already expired at the moment of this check"
      }
    }
  },
  "dataDomain": {
    "ISSUE_CODE": {},
    "ATTEMPT": {
      "match": [
        true,
        false
      ],
      "expired": [
        true,
        false
      ]
    }
  },
  "terminalStates": [
    "verified"
  ],
  "specialRules": [
    {
      "name": "issue-resets-flow",
      "note": "ISSUE_CODE always sets status to 'pending' and attempts to 0, regardless of prior status (no_code, pending, verified, or locked). This is the only way to unlock a locked flow.",
      "whenState": "any",
      "whenAction": "ISSUE_CODE"
    },
    {
      "name": "attempt-noop-unless-pending",
      "note": "ATTEMPT has no effect (post == pre) unless status == 'pending'. In particular, attempts while 'locked', 'no_code', or 'verified' are no-ops.",
      "whenState": "status != 'pending'",
      "whenAction": "ATTEMPT"
    },
    {
      "name": "expired-never-verifies",
      "note": "If expired == true, the attempt can never transition status to 'verified', even if match == true. Expiry strictly overrides a matching code.",
      "whenState": "status == 'pending'",
      "whenAction": "ATTEMPT (expired == true)"
    },
    {
      "name": "expired-does-not-count-as-failure",
      "note": "If expired == true, attempts is NOT incremented regardless of match value, and status remains 'pending' (expiry is not evidence of user error, and never itself triggers a lock).",
      "whenState": "status == 'pending'",
      "whenAction": "ATTEMPT (expired == true)"
    },
    {
      "name": "live-mismatch-increments-attempts",
      "note": "If expired == false and match == false, attempts is incremented by 1.",
      "whenState": "status == 'pending'",
      "whenAction": "ATTEMPT (expired == false, match == false)"
    },
    {
      "name": "live-match-verifies",
      "note": "If expired == false and match == true, status transitions to 'verified'.",
      "whenState": "status == 'pending'",
      "whenAction": "ATTEMPT (expired == false, match == true)"
    },
    {
      "name": "lock-threshold",
      "note": "When attempts (after incrementing on a live mismatch) reaches the fixed limit of 3, status transitions to 'locked' instead of remaining 'pending'.",
      "whenState": "status == 'pending' && attempts == 2",
      "whenAction": "ATTEMPT (expired == false, match == false)"
    },
    {
      "name": "locked-blocks-verification",
      "note": "Once status == 'locked', no ATTEMPT can ever produce 'verified' until a new ISSUE_CODE resets the flow.",
      "whenState": "status == 'locked'",
      "whenAction": "ATTEMPT"
    }
  ],
  "noOpRule": "An action that does not apply in the current state yields post == pre."
}
```

## Code (`C:\Users\jjdub\AppData\Local\Temp\polygen-otp\next.cjs`)

```javascript
module.exports = {
  init() {
    return { status: 'no_code', attempts: 0 };
  },
  next(state, action, data) {
    if (action === 'ISSUE_CODE') {
      return { status: 'pending', attempts: 0 };
    }

    if (action === 'ATTEMPT') {
      if (state.status !== 'pending') {
        return { status: state.status, attempts: state.attempts };
      }

      const { match, expired } = data;

      if (expired === true) {
        return { status: 'pending', attempts: state.attempts };
      }

      if (expired === false) {
        if (match === true) {
          return { status: 'verified', attempts: state.attempts };
        }

        if (match === false) {
          const newAttempts = state.attempts + 1;
          const newStatus = newAttempts >= 3 ? 'locked' : 'pending';
          return { status: newStatus, attempts: newAttempts };
        }
      }

      return { status: state.status, attempts: state.attempts };
    }

    return { status: state.status, attempts: state.attempts };
  }
};
```

⚠️ **Proposed invariants — review before trusting; these encode the model's
reading of intent, not a verified spec.**

```javascript
export const stateInvariants = [
  {
    name: 'attempts-within-bounds',
    pred: (state) => state.attempts >= 0 && state.attempts <= 3,
  },
  {
    name: 'locked-only-at-limit',
    pred: (state) => state.status !== 'locked' || state.attempts >= 3,
  },
];

export const transitionInvariants = [
  {
    name: 'issue-resets-flow',
    pred: (pre, action, data, post) =>
      action !== 'ISSUE_CODE' ||
      (post.status === 'pending' && post.attempts === 0),
  },
  {
    name: 'attempt-noop-unless-pending',
    pred: (pre, action, data, post) =>
      !(action === 'ATTEMPT' && pre.status !== 'pending') ||
      (post.status === pre.status && post.attempts === pre.attempts),
  },
  {
    name: 'expired-never-verifies',
    pred: (pre, action, data, post) =>
      !(action === 'ATTEMPT' && pre.status === 'pending' && data && data.expired) ||
      post.status !== 'verified',
  },
  {
    name: 'expired-does-not-count-as-failure',
    pred: (pre, action, data, post) =>
      !(action === 'ATTEMPT' && pre.status === 'pending' && data && data.expired) ||
      (post.attempts === pre.attempts && post.status === 'pending'),
  },
  {
    name: 'live-mismatch-increments-attempts',
    pred: (pre, action, data, post) =>
      !(action === 'ATTEMPT' && pre.status === 'pending' && data && !data.expired && !data.match) ||
      post.attempts === pre.attempts + 1,
  },
  {
    name: 'live-match-verifies',
    pred: (pre, action, data, post) =>
      !(action === 'ATTEMPT' && pre.status === 'pending' && data && !data.expired && data.match) ||
      post.status === 'verified',
  },
  {
    name: 'lock-threshold',
    pred: (pre, action, data, post) =>
      !(action === 'ATTEMPT' && pre.status === 'pending' && data && !data.expired && !data.match && pre.attempts + 1 >= 3) ||
      post.status === 'locked',
  },
  {
    name: 'locked-blocks-verification',
    pred: (pre, action, data, post) =>
      !(action === 'ATTEMPT' && pre.status === 'locked') ||
      post.status !== 'verified',
  },
];
```

## Self-repair loop

Two defect classes are checked every round, in order: domain-ref gaps (a
`dataDomain` value the contract declares but the code never handles — these
are fixed FIRST, since until they're gone the checker may never even reach
what an invariant is meant to guard) and invariant violations.

| iteration | states explored | cap hit | domain gaps | violations |
|---|---|---|---|---|
| 0 | 8 | no | 4 | — |
| 1 | 8 | no | — | — |

**Iteration 0 domain-ref gaps (what got fixed before the next round):**
  - ATTEMPT.match = true (declared in dataDomain, never referenced in the code — the transition it should gate may be unreachable)
  - ATTEMPT.match = false (declared in dataDomain, never referenced in the code — the transition it should gate may be unreachable)
  - ATTEMPT.expired = true (declared in dataDomain, never referenced in the code — the transition it should gate may be unreachable)
  - ATTEMPT.expired = false (declared in dataDomain, never referenced in the code — the transition it should gate may be unreachable)

**Converged — no domain-ref gaps and no invariant violations reachable in the
final code**, over the explored (bounded) state space. Not a proof.

## Demo / regression trace corpus

- scenarios: **28** · windows: **134**
- corpus validated clean: no chaining/terminal problems.

## Independent replay sanity check

- windows replayed (separate process): **134** · non-pass: **0**

## Next steps

1. Review the contract and invariants above — both are the model's reading of
   your intent, not ground truth.
2. Wire `next()` into the real handler/reducer — call it, do not reimplement
   the transition logic inline.
3. After integration, run `/polygraph:verify` against REAL captured traces to
   catch drift between this pure model and the glue code around it.