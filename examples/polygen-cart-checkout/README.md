# polygen example — cart checkout (reserve → authorize → capture)

Generated end to end by `polygen` from a feature description — no hand-written
code. This is the fuller worked example: unlike `examples/polygen-otp`, this
run's first draft had a real defect that the self-repair loop caught and
fixed. See `../case-study-polygen-domain-gap.md` for the full narrative.

```bash
node scripts/polygen.mjs \
  --intent "A cart checkout flow: reserve inventory, then authorize payment,
then capture. Reservations expire after a timeout if checkout stalls. If
inventory reservation partially fails (some items out of stock), any items
that WERE already reserved in this attempt must be rolled back (released) --
never left reserved with a failed checkout. Capture is idempotent, keyed by an
idempotency key supplied on the capture action: retrying capture with the SAME
idempotency key after a capture has already completed for this checkout must
return the same completed/captured state without charging again. Retrying
with a DIFFERENT (new) idempotency key is only allowed to proceed to a fresh
capture attempt if the PRIOR key's capture attempt failed (was declined or
errored) -- not if it already succeeded." \
  --model sonnet-5 --out examples/polygen-cart-checkout --repair-max 3
```

> Historical record — this is the exact command that produced the committed
> artifacts; do not rewrite the model. The *current* recommendation for new
> runs is `opus-4.8` or better (see the Models section of the root README).

## What happened (short version)

Iteration 0: the drafted contract declared `dataDomain` values the authored
code never referenced (`CHECK_EXPIRY.expired`, `AUTHORIZE_PAYMENT.result =
"approved"`, `CAPTURE.idempotencyKey = "K1"/"K2"`) — a naming/handling
mismatch between the two independent model calls that drafted the contract
and wrote the code. Only 6 of the machine's states were reachable as a result.
polygen's domain-ref cross-check caught this and drove one repair round.
Iteration 1: 13 states reachable, 0 domain gaps, 0 invariant violations —
converged.

Full report, including the itemized gap list and the final code/invariants,
is in `polygen-report.md`.

**One caveat, disclosed rather than hidden**: two of the five iteration-0
"gaps" (the `idempotencyKey` values `"K1"`/`"K2"`) were a false positive —
the code already handled the idempotency key correctly, just generically
(`key = idempotencyKey`) rather than by branching on the literal values. The
domain-ref check is a heuristic (string presence, not real reference
analysis) and can't distinguish "handled generically" from "not handled."
The repair added a slightly redundant `switch` on the literal values to
satisfy it — harmless, but worth knowing the checked-in code has it.

## Files

- `contract.json` — model-drafted from the intent above.
- `next.cjs` — the authored, self-repaired transition function.
- `invariants.mjs` — model-proposed invariants (idempotent-capture,
  no-reservation-leak-on-partial-failure, expired-never-authorizes, etc.).
- `traces/*.ndjson` — synthesized demo/regression corpus (90 windows),
  independently replayed in a separate process (0 failures).
- `polygen-report.md` — the full report, including the repair-loop history.

To replay the checked-in artifacts without any API call:

```bash
node scripts/validate_corpus.mjs examples/polygen-cart-checkout/contract.json examples/polygen-cart-checkout/traces
node scripts/check.mjs --spec examples/polygen-cart-checkout/next.cjs \
  --contract examples/polygen-cart-checkout/contract.json \
  --invariants examples/polygen-cart-checkout/invariants.mjs
```
