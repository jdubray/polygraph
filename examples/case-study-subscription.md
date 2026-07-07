# Case study: a production SaaS subscription-billing state machine

A real Polygraph verification session, on a closed-source production system that
manages recurring subscription payments (create → active → renew → dunning →
lapse, plus cancel, card-update, and processor webhooks). The source is
proprietary and not included here; this write-up shows **what a verification
session produces** and the **kinds of findings** it surfaces. Internal file
names, line numbers, product terms, and the payment processor's name have been
generalized.

## The prompt

> *"verify the subscription state machine"*

That one line triggers the skill. The agent read the transition code (create,
the renewal sweeper, cancel, card-update, and the webhook handler) plus the
shared helpers, ran the test suite, and traced every path.

## The verdict

**Sound and internally consistent — the full test suite passes, and the seven
documented alignment properties (C1–C7) are all implemented correctly.** One
material assumption remains unverified (a real-service question, already
tracked); two cosmetic items have no behavioral impact.

## The state machine, as reconstructed from the code

```
free ──create──▶ pending ──inline charge OK──▶ active
                    │  └─decline──────────────▶ free (revert, "payment failed" email)
                    │  └─cancel-after-timeout──▶ free   (never charged)
                    │  └─sweeper backstop (>10min, same idempotency key)──▶ active | free
 active ──T-3 notice (now < period end)──▶ send notice, park next charge at period end
 active ──charge hop (now ≥ period end)──▶ charge next period ──OK──▶ active (+receipt)
                                                              └─decline──▶ grace
 active ──no card──▶ grace
 grace  ──dunning retry (per-attempt keys)──decline──▶ grace ··· 3 attempts ··▶ lapsed (+ended email)
 grace  ──retry OK / update-card──▶ active (+receipt)
 active/grace ──cancel──▶ auto-renew off, access to period end, then sweeper ──▶ lapsed
 webhook charge.SUCCEEDED (guard: tier = active) ─ confirms only, never resurrects pending/grace
 webhook charge.FAILED    (guard: tier = active) ─ active ▶ grace, seeds next charge = now
```

## What the session confirmed correct

- **Attempt accounting** matches the "3 attempts, ~3-day grace" policy: a failed
  renewal is attempt 1 (enter grace), the two dunning retries are attempts 2 & 3,
  and the account lapses on the third confirmed decline. A webhook-seeded grace
  row counts the reported failure as attempt 1 (an unconditional set, not a
  create-if-absent — correctly avoiding an extra free retry).
- **Cancel-after-timeout**: the auto-renew-off check runs *before* the
  charge/grace branches, so a cancelled pending row reverts and a cancelled grace
  row lapses — neither is ever charged or re-dunned.
- **Webhook vs sweeper**: activation is guarded on tier = active, so a stray
  `charge.SUCCEEDED` cannot activate a pending/grace/cancelled row; recovery is
  left to the sweeper, which rewrites the billing period correctly.
- **Idempotency & clamping**: per-attempt keys advance only on a *confirmed*
  decline; the period-end date clamps month-end correctly (a Feb-28 anchor →
  Mar-31 case passes).
- **Concurrency**: every advancing write (notice mark, window claim, attempt
  bump, grace/revert) is a conditional update that no-ops on a lost race — so
  overlapping sweeps cannot double-charge or double-email.

## The one material risk (the finding that matters)

**"Idempotency-conflict-means-paid."** The renewal path treats *any* processor
idempotency conflict as "already charged → activate." If the processor replays a
stored *decline* for a reused key — e.g. the attempt-advance database write
crashes after a declined retry, so the next sweep re-sends the same key — this
would recover an account to **active without payment**.

Whether the processor returns a replayed decline as a 4xx conflict (wrong path)
or as a `state: FAILED` transfer (handled correctly) is **decline-replay
semantics that the code cannot settle by reading itself** — it needs one check
against the real processor sandbox. The code is correct if replayed declines come
back as `FAILED`, wrong if they come back as conflicts.

> This is the same bug *class* Polygraph's origin study found in a different
> payment system (a duplicate-key / conflict response treated as success). It is
> a recurring payment-integration hazard — and note how a clean, all-tests-pass
> verdict still leaves it open, because it depends on the behavior of a service
> outside the code. That is the **correlated-oracle boundary**: the deepest
> assurance requires validating one assumption against reality, not just against
> the code and its own tests.

## Two cosmetic items (no behavioral impact)

- A billing-gate helper is **dead code** — defined but never called. Worth noting
  because, if it were wired up, it would *contradict* the live access gate (it
  blocks grace-period access unless paid-through, whereas the running system
  intentionally grants access for the whole dunning window). The live behavior is
  the intended one; the unused function should be deleted or reconciled to avoid a
  future footgun.
- A `graceUntil` deadline is **written but never enforced** — lapse is driven
  purely by attempt count, not the `now + 3d` timestamp. Harmless/vestigial, but
  if the sweeper stalled, a grace period could outlast three days.

## What this illustrates about the method

1. **The output is a reconstructed state diagram + a ranked verdict**, not a
   pass/fail bit — the diagram *is* the independent reading of the source, and it
   is where a reviewer's eye catches structural gaps.
2. **A clean verdict is a consistency result, not a proof.** Every test passing
   and every documented property holding still left one material risk — and it
   was the one the code *couldn't* resolve about itself.
3. **The material risk lives at the boundary with an external service.** The
   correct next step is not more code-reading; it is the sandbox check. This is
   the same escalation the method always points to: validate the assumption the
   oracle can't.
