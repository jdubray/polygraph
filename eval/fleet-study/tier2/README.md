# Fleet study · Tier 2 — three version changes against a captured fleet

FS-M3 of [`docs/fleet-study-plan.md`](../../../docs/fleet-study-plan.md).

```bash
# capture a fleet first (see examples/fleet-study-stripe/README.md)
node eval/fleet-study/tier2/run-versions.mjs [--corpus <dir>] [--seed 11]
```

Writes `results.md` (the cost table), `results.json` (machine-readable, with
every finding), and `adjudication.md` (the blind worksheet a human fills in).

## What is being run

Three changes to the same v1 subscription machine, in increasing severity, each
run twice — once before any migration exists, and once with the migration an
operator authored from `polyvers migrate scaffold`. Both runs are results: the
first says what the tool demanded, the second says whether the work satisfied
it. Verdicts were **predicted in the runner before the first execution** and a
broken prediction fails the run rather than being re-fitted.

| change | what it does | predicted |
|---|---|---|
| `v2-addition` | adds a `REFUND_ISSUED` action; nothing removed or altered | PASS |
| `v2-dunning` | retry budget 3 → 2, invariants tightened with it | FAIL |
| `v2-shape` | `cents` splits into `amountCents` + `currency` | PASS after a correct migration |

All three predictions held. `v2-shape` clearing only after migration is the
control: a shape gate that stayed red would have been measuring something other
than shape.

## The headline result

**`v2-dunning` model-checks clean from `init` and fails against the fleet.**

```
from init:        19 states explored, no invariant violations reachable ✓
from the fleet:   2 invariants violated, witness fleet.json#10
                  {subState: 'pastDue', dunningAttempts: 2, hasPaymentMethod: true, cents: 1500}
```

The machine is internally consistent. Every state it can reach from a fresh
start obeys every rule it declares. It is still not safe to deploy, because the
fleet holds a state the new version's rules forbid and the new version's own
`init`-reachable space never contains — a subscription mid-dunning at the exact
depth the narrowed budget makes terminal.

The two findings are distinct, and the second is the one that would have hurt:

1. `exhausted-dunning-is-unpaid` — `fleet.json#10` violates it *at rest*. Under
   a budget of 2, depth 2 means exhausted, so the record must be `unpaid`; it
   is `pastDue`.
2. `dunning-within-budget` — from that same live state, a single
   `PAYMENT_FAILED` drives `dunningAttempts` to 3, over the new budget. The
   machine can be driven past its own declared limit, but **only starting from
   a state the fleet holds and `init` cannot reach.**

This is the landmine the paper argues for, as an artifact rather than an
argument: from-`init` checking and a synthesized corpus both report clean,
because a synthesized corpus contains only states the model says are reachable.
Provenance is the whole difference.

## The migrations, and what they cost

Both were scaffolded by the tool and both needed a hand edit, for opposite
reasons — which is the more useful result than either alone.

- **`v2-shape`** — the scaffold read the diff correctly (`cents` removed,
  `amountCents` + `currency` added) and initialized the new keys from the new
  contract's `initState`, setting `amountCents` to **0**. Applied as
  scaffolded, every subscription in the fleet would have migrated to a
  recurring amount of zero. The scaffold cannot know a rename from a new
  field. Its contribution is not the conversion; it is that the conversion
  became a reviewable artifact with a named hole instead of an implicit
  assumption inside a deploy.

- **`v2-dunning`** — the scaffold detected the domain narrowing `0..3 → 0..2`
  as a retype and **refused to guess**, leaving a throwing hole. That refusal
  is correct: "what is a record at depth 3 when the budget becomes 2?" has
  three defensible answers that are not equivalent, one of which (clamp to 2,
  read as "one retry left") silently hands an exhausted customer a fourth
  attempt. The choice made — saturate, and let the invariants name the
  affected population — is recorded with its alternatives in
  `machines/subscription-v2-dunning/migrate.cjs`.

Everything else is free: all runs are local and deterministic, single-digit
seconds per change, **no API key**.

## A tool defect this study found

Running FS-M3 surfaced a real bug in `polyvers check`, now fixed.

`migrateGate` conflated two failure kinds under one `migratedCorpus: null`:

- **structural** — `migrate()` threw, was nondeterministic, or produced a state
  the module does not reproduce. The corpus genuinely cannot be trusted.
- **invariant** — `migrate()` ran cleanly, purely, and round-trips, but its
  output violates a rule. The corpus is complete and well-formed.

In the second case the CLI suppressed every downstream corpus gate and told
the operator *"results over an unmigrated old-shape corpus would misdiagnose
the failure"* — which was false, since the corpus was migrated and well-shaped.

The cost was not cosmetic. Under the old behavior `v2-dunning` reported one
finding: that the migration produced a violating state. Finding 2 above — the
reachability result, the one showing the machine can be driven past its own
budget from a live state — **was never computed.** The archetypal fleet case
is precisely when an operator most needs the pointwise gate's affected
population and the model check's reachability answer, and it was precisely the
case that suppressed both.

Fixed in `polyvers/src/gates.mjs` (partition the failure kinds; a structurally
sound migration hands its corpus downstream even when the gate is red on
invariants) and `polyvers/bin/polyvers.mjs` (the skip is marked `skipped: true`
so consumers can tell control flow from a claim). Regression tests in
`polyvers/test/m0.test.mjs`.

## Admissibility

`run-versions.mjs` reads the capture's `manifest.admissibleAsTier2` and stamps
every artifact with it. The offline corpus is **circular as evidence** — the v1
machine generated it — so the numbers above exercise the pipeline and are not
Tier 2 findings. Re-run against a `--live` Stripe capture for admissible
numbers; nothing else changes.

The exception is the tool defect, which is a fact about `polyvers` rather than
about the fleet, and stands independently of corpus provenance.

## Status

The pipeline, the three changes, the migrations, the cost columns, and the
blind worksheet are complete and runnable. **The findings are unadjudicated**
— `adjudication.md` has six rows awaiting TP/TI/FP judgments, which per plan §2
are made by a domain reader blind to the predictions, with a third reader
resolving disagreements. Adjudication against the offline corpus would not be
reportable anyway; it waits on the live capture.
