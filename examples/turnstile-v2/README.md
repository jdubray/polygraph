# Turnstile — v2 (SAM strict profile) example

The `examples/turnstile` machine with its reference spec ported to the v2
artifact contract: a [sam-lib 2.0.0-alpha](https://github.com/jdubray/sam-lib)
strict-profile module exporting `{ instance, init, actions, getState, setState }`,
with a declared `modelShape`, per-intent schemas and domains, and the contract's
`push-while-locked-is-noop` special rule expressed as `reject('push-while-locked-is-noop')`
instead of a silent fall-through.

The contract and traces are identical to `examples/turnstile` (the machine is
the same; only the spec artifact changed). Replay it with the default (v2) path:

```sh
node scripts/verify.mjs \
  --contract examples/turnstile-v2/contract.json \
  --traces   examples/turnstile-v2/traces \
  --specs    examples/turnstile-v2/specs \
  --out      examples/turnstile-v2/out
```

All 12 windows replay consistent; the three PUSH-while-LOCKED windows carry
`classification: "rejected"` with the contract-anchored `rejectionReason` —
the triage evidence the legacy bare-next replayer could never produce.
(`--legacy-bare-next` selects the old bare-next path; see `examples/turnstile`.)
