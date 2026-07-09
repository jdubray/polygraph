# Case study: polygen finds a bug in itself (and gets fixed)

This walks through `examples/polygen-cart-checkout`, the run that motivated
polygen's domain-ref cross-check. It's an honest account, including a false
positive the fix introduces — not a highlight reel.

## The setup

polygen was asked, in one sentence, to write a cart checkout state machine:
reserve inventory → authorize payment → capture, with reservation timeouts,
rollback of partially-reserved items on a failed reservation, and idempotent
capture retries keyed by a client-supplied idempotency key. No code existed;
the whole point was to see whether the tool could author something verifiable
from a blank slate. Model: `sonnet-5`.

## What happened on the first attempt

polygen's pipeline drafts the contract and authors the code as **two
independent model calls** — nothing forces them to agree on how they name
things. The first run's contract declared:

```json
"dataDomain": {
  "RESERVE": { "result": ["all_ok", "partial_fail", "all_fail"] }
}
```

...but the authored `next()` checked:

```js
if (result === 'success') { return { status: 'reserved', ... }; }
if (result === 'partial_fail' || result === 'all_fail') { return { status: 'reservation_failed', ... }; }
```

`'success'` never occurs in the declared domain — only `all_ok` does, and
that value matches neither branch, so it silently fell through to a no-op.
**The machine could never reach `reserved`, `authorized`, or `captured` at
all.** The self-repair loop, which model-checks the code against its own
invariants, found **zero violations** and reported `converged: true` — because
there was almost nothing left to violate. Only 2 of the machine's states were
ever reachable. A clean report, for the wrong reason.

This is the sharpest way to see why "no violations found" is not the same as
"correct": a model checker can only report on what it can *reach*.

## The fix

Added a cross-check (`findDataDomainRefGaps` in `scripts/polygen.mjs`) that
verifies every value declared in the contract's `dataDomain` is referenced
verbatim somewhere in the authored code. It's a heuristic — string presence,
not real reference analysis — but cheap and effective. Gaps are now repaired
**before** invariant-checking even starts, because until they're gone, the
checker may never reach what an invariant is meant to guard.

## The re-run (what's checked in)

Same intent, re-run after the fix. Iteration 0:

| iteration | states explored | domain gaps | violations |
|---|---|---|---|
| 0 | 6 | 5 | — |
| 1 | 13 | 0 | 0 |

The 5 flagged gaps:
- `CHECK_EXPIRY.expired = true` / `= false` — the code used a different field
  entirely for the timeout check.
- `AUTHORIZE_PAYMENT.result = "approved"` — same class of mismatch as the
  first run.
- `CAPTURE.idempotencyKey = "K1"` / `"K2"` — see the caveat below.

One repair round later: 13 states reachable (up from 6), 0 domain gaps, 0
invariant violations. The final `next()`, `invariants.mjs`, and a 90-window
synthesized trace corpus (0 independent-replay failures) are checked in at
`examples/polygen-cart-checkout/`.

## The honest caveat: a false positive

Two of the five gaps weren't real. `CAPTURE.idempotencyKey`'s declared values
(`"K1"`, `"K2"`) are just two concrete instances of an opaque identifier — the
correct implementation compares it generically (`key = idempotencyKey`),
never branching on the literal string. The heuristic can't distinguish
"handled generically" from "not handled at all," so it flagged both as gaps.
The repair round obliged by adding a `switch` that explicitly echoes `'K1'`
and `'K2'` back — functionally identical to the generic assignment, just more
verbose. Harmless, but it's in the checked-in code, and it's a real limitation
of the heuristic worth knowing before you trust a "0 domain gaps" line at face
value on a contract with opaque-identifier-style fields (tokens, keys, IDs).

A related, lower-severity finding from the same session: the model-drafted
`specialRules` sometimes wrote `whenState`/`whenAction` as free-text
expressions (`"status == 'pending'"`) instead of the bare enum value
(`"pending"`) that `validate_corpus.mjs` actually matches against — so
special-rule coverage always reported 0/8 rules covered, even though the
underlying behavior was fine (chaining and terminal-state checks passed, and
`check.mjs` found 0 violations). Fixed in the prompt for future runs
(`buildContractDraftPrompt` now requires exact values); the checked-in example
still shows the original noisy coverage output, left as-is rather than
re-spending API credits to regenerate a cosmetically cleaner report.

## What this illustrates about the method

1. **Two independent generations can silently disagree**, and the failure
   mode (a coverage collapse, not a crash) looks exactly like success unless
   something checks for it specifically.
2. **A converged self-repair loop is not a proof** — it's bounded by what the
   checker could reach, which is itself bounded by whether the contract and
   the code agree on vocabulary.
3. **Heuristics that catch real defects also produce false positives** — the
   idempotency-key case here is the cost of a cheap, string-presence check
   instead of real static analysis. Disclosing that cost is part of using the
   method honestly, the same way `polygraph`'s own findings are leads to
   investigate, not proofs.
