# polygen example — OTP verification flow

Generated end to end by `polygen` from a one-line feature description — no
hand-written code. Command used:

```bash
node scripts/polygen.mjs \
  --intent "A one-time-password (OTP) verification flow for login step-up
auth. A code is issued with a short expiry. The user submits an attempt; on
match it verifies, on mismatch it counts as a failed attempt. Too many failed
attempts locks the flow (requiring a fresh code to be issued to unlock). A
code that has expired should be handled the same way whether the user submits
a correct-looking or incorrect code -- an expired code should never verify,
and checking an expired code should not count against the attempt limit the
same way a live wrong-code guess does, since expiry is not evidence of user
error." \
  --model opus-4.8 --out examples/polygen-otp --repair-max 3
```

Full run details, the drafted contract, the authored code, the proposed
invariants, and the self-repair history are in **`polygen-report.md`** — read
that first.

## What happened

The first draft's `next()` used different field names than the contract's
`dataDomain` declared (`ATTEMPT.match`/`ATTEMPT.expired` were declared but
never referenced in the code as written) — the domain-gap check caught this
at iteration 0 and the repair round fixed it in one pass. Final result:
**converged, 8 states explored, 0 domain gaps, 0 invariant violations**, a
134-window demo corpus, 0 independent-replay failures.

## Files

- `contract.json` — model-drafted from the intent above (review before
  trusting; it's the design spec, not extracted ground truth).
- `next.cjs` — the authored, self-repaired transition function.
- `invariants.mjs` — model-proposed invariants (`expired-never-verifies`,
  `expired-attempt-no-penalty`, `lockout-on-threshold`, etc.).
- `traces/*.ndjson` — synthesized demo/regression corpus, independently
  replayed in a separate process (0 failures).
- `polygen-report.md` — the full report, including the repair-loop history.

To reproduce: run the command above (needs `ANTHROPIC_API_KEY`; results won't
be byte-identical since generation is not deterministic, but should converge
similarly). To replay the checked-in artifacts against `next.cjs` without any
API call:

```bash
node scripts/validate_corpus.mjs examples/polygen-otp/contract.json examples/polygen-otp/traces
node scripts/check.mjs --spec examples/polygen-otp/next.cjs \
  --contract examples/polygen-otp/contract.json \
  --invariants examples/polygen-otp/invariants.mjs
```
