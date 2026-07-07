# Case study: the full loop on a production subscription-billing state machine

A real, end-to-end Polygraph run — contract → real traces → five independent
LLM-derived specs → replay → triaged findings — on a closed-source production
service that manages recurring SaaS subscription payments (create → active →
renew → dunning → lapse, plus cancel, card-update, and processor webhooks).

The source is proprietary and not included; internal names, file paths, and the
payment processor's name are generalized. What this shows is the **shape of a
full-loop run** and the **kind of finding it produces** — including one genuine
bug and an honest look at what the method can and cannot see.

## Setup

- **Contract.** Observable state = the subscription row's decision-driving fields
  (`status`, `autoRenew`, `periodEndMs`, `nextChargeAt`, `chargeAttempts`,
  `hasDue`). Actions = the handler boundary: `CREATE`, `RENEW_CHARGE`, `CANCEL`,
  `UPDATE_CARD`, `WEBHOOK_SUCCEEDED`, `WEBHOOK_FAILED`, `SWEEPER_TICK`. Two things
  ride in the action **data**, never read inside the spec: the effective *time*
  (`now` vs `periodEndMs` drives the notice/charge hops) and the *processor
  result* (`ok` / `declined` / `5xx` / `conflict`).
- **Traces.** Captured by instrumenting the transition boundary and running the
  existing test suite — 20 windows across the create, renew, decline→grace,
  dunning, cancel, and webhook scenarios. (The tests already stand up the
  datastore and a processor mock, so tapping the boundary yields real windows
  for free.)
- **Controls.** A hand-written reference `next()` scored **20/20**; a mutant with
  one broken rule failed **only** its target window. The replay discriminates —
  so the consistent windows are meaningful, not vacuous.
- **Generation.** Five independent specs from one reasoning model, replayed
  against the 20-window corpus.

## The prompts used

In a Claude Code session with the plugin installed, the whole run started from
one line:

```
/polygraph:polygraph run the full trace-capture-and-replay loop on the
subscription state machine: derive the contract, instrument the transition
boundary, capture real traces by running the existing test suite, write
positive+negative controls, then generate 5 specs and replay. Model time
(now vs periodEndMs) and the processor result as action data, not clock/IO reads.
```

The agent did Step 2 itself — instrumented the boundary, drove the suite,
produced the corpus — and only surfaced for the judgment calls (is the observable
state right, do the controls hold). Broken into steps, the same run is:

```
1. Build a Polygraph contract.json for the subscription state machine —
   observable state = the row's decision-driving fields; actions = the handler
   boundary (CREATE / RENEW_CHARGE / CANCEL / UPDATE_CARD / WEBHOOK_SUCCEEDED /
   WEBHOOK_FAILED / SWEEPER_TICK); carry time and processor-result in action data.

2. Instrument the transition boundary with withTracing and capture traces by
   running the test suite — one .ndjson per scenario family. Then validate the corpus.

3. Write a reference next() from the state diagram (must score 100%) and a mutant
   that breaks one rule (must fail only its window).

4. Generate 5 specs from the source and replay against the corpus; show findings.md.
```

The equivalent raw commands (the scripts are standalone; `<plugin>` =
`~/.claude/plugins/marketplaces/polygraph`):

```bash
# after instrumenting the boundary and running the suite to emit traces/:
node <plugin>/scripts/validate_corpus.mjs contract.json traces/

# controls (no API key):
node <plugin>/scripts/verify.mjs --contract contract.json --traces traces/ \
  --specs refs/ --out out/

# generate + replay:
node <plugin>/scripts/verify.mjs --contract contract.json \
  --source path/to/transition-source --traces traces/ \
  --model <id> --n 5 --max-tokens 32000 --out out/
```

(`--max-tokens 32000` matters for reasoning models — the first attempt without it
returned all-`unscoreable`; see the note below.)

## Result: 19/20 consistent — one real finding

All five independently-derived specs disagreed with the code on the **same**
window, in the **same** way:

| window: `active` + `(after period end, RENEW_CHARGE result=5xx)` | → |
|---|---|
| **Code (the trace):** | `grace`, `chargeAttempts = 1`, `hasDue = true` |
| **All 5 specs:** | stays `active` (no-op — "a 5xx is ambiguous, no charge confirmed, leave the row as-is") |

Because **all five** specs agree with each other and disagree with the code
*identically*, this is classified a **code-finding**, not a spec-error (a
spec-error is when generations disagree among themselves). And because the
controls held, it is not a contract artifact.

**The mechanism.** The models applied "a 5xx is ambiguous" handling uniformly.
The code applies it only in the *dunning* path — the dunning-5xx window scored
consistent, code and specs agreeing it is a no-op. But the *renewal* charge hop
treats **any** processor error, including a transient 503, as a confirmed
decline → move to grace. The next dunning retry then charges with a rotated
idempotency key, so **if the 503'd transfer had actually settled, the account is
double-charged.** The fix mirrors the dunning path: treat a `>= 500` processor
error as transient (let the same key retry), and only move to grace on a
confirmed `< 500` decline or a `FAILED` transfer.

This independently corroborated a bug a human reviewer had found by hand — five
blind derivations landing on the same divergence is strong signal.

## What the clean 19 do and don't tell you

The controls make the 19 consistent windows meaningful. But two limits are worth
stating plainly, because they are intrinsic to the method:

- **One "consistent" window hides a cross-boundary risk.** A separate window —
  a duplicate-key *conflict* treated as "already paid → activate" — scored
  consistent: the code and all five readers agree a conflict activates the row.
  Whether that is *correct* depends on whether the real processor can return a
  replayed **decline** as a conflict (which would activate an account without
  payment). That is a property of an external service, invisible to a
  consistency check over the code. It needs a **processor-sandbox probe** — the
  correlated-oracle boundary.
- **The double-charge itself is out of scope.** Polygraph flagged the *transition
  disagreement* (5xx → grace vs no-op). The double-charge is a *multi-window*
  consequence (grace, then a retry on a rotated key against a possibly-settled
  transfer) — a property across windows, not a single-step transition, so
  bare-`next()` replay surfaces the trigger, not the consequence.

## Practical note: reasoning models and the token budget

The first attempt returned all-`unscoreable`: the reasoning model spent its
whole token budget on its thinking block and emitted zero answer tokens
(`stop_reason: max_tokens`). Raising the budget fixed it. This is now the
default, and an empty generation fails loudly with a hint instead of silently
scoring `unscoreable-all` — but if you deliberately lower `--max-tokens` on a
reasoning model, that is the symptom to recognize.

## What this illustrates about the method

1. **Independent corroboration is the payoff.** Five blind derivations agreeing
   with each other and disagreeing with the code, identically, is a much stronger
   signal than one reviewer's hunch — and it points at an exact `(state, action,
   data)`.
2. **Controls are what make a clean result mean something.** Without the positive
   and negative controls, "19/20 consistent" could be vacuous; with them, it is
   evidence.
3. **The deepest risks live at the service boundary.** The conflict-means-paid
   question and the double-charge consequence both sit where the code meets an
   external processor — exactly where a code-only method must hand off to a real
   sandbox check. A clean run tells you where to point that check, not that you
   no longer need it.
