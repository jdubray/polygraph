# When the oracle copies the code: a failure mode of bare-next() verification

**Status:** experimental finding, N=3, single model (Opus 4.8), 8 machines.
A strong signal about *where* the method works, not a final verdict.
Measured 2026-07-07 with `eval/skill-ab.mjs`; raw data in `eval/results/`.

**Resolution (2026-07-08, v0.2.0):** this finding diagnosed a missing half of
the tool, not a dead end. Trace replay is only *conformance* checking; the
bug-finding half is *model checking* — iterating the faithful spec against
invariants. That half was added in v0.2.0 (`scripts/check.mjs`). On the same
five seeded machines where replay found **0/5**, model checking finds **5/5**
with shortest counterexamples (`npm run eval:check`). See §8 below — the negative
result stands as written and is what motivated the fix.

---

## Summary

On a suite of eight small state machines, we compared two ways of asking an LLM
"is this code correct?":

- **model alone** — give the model the source and ask it to spot any divergence
  between the code's behavior and what its source implies;
- **+ Polygraph** — run the bare-next() loop: have the model derive a
  `next(state, action, data)` spec from the source, replay real execution traces
  against it, and report a bug wherever all derived specs disagree with a trace.

The plain review **found 73%** of the seeded bugs. The Polygraph replay core
**found 0%** — and regressed on every seeded machine.

| arm | detection (5 seeded) | false-alarm (3 clean/oos) | accuracy (all 8) |
|---|---|---|---|
| model alone | **73%** | 0% | 83% |
| + Polygraph | **0%** | 0% | 38% |

The result is real, not a harness bug (we verified the generated specs were
valid and inspected what they contained). The mechanism is precise and it
explains *why bare-next() worked on the finixpos payment study but fails here* —
the two are the same phenomenon seen from opposite ends.

---

## 1. What bare-next() claims, and how it is supposed to find bugs

Bare-next() verifies code by having an LLM derive an independent transition
function from the source, then replaying real execution traces against it. A
window `(pre, action, data) → post` is a **code-finding** when *every* derived
spec, run from `pre`, produces a `post'` ≠ the recorded `post`. The pitch: the
derived spec is an "independent reading" of the source, so a disagreement means
the code did something its own source doesn't imply.

The load-bearing assumption is hidden in the word *independent*: **the spec only
catches a bug if it diverges from the code.** If the model's spec reproduces the
code faithfully — bug included — the spec agrees with the trace, and the bug is
invisible. Everything below is about when that assumption holds.

## 2. The experiment

Eight self-contained machines (`eval/machines/`), each with a clean step
boundary, a contract, a deterministic trace corpus, and ground truth:

- **5 seeded** — each contains one defect of the class bare-next() is *supposed*
  to catch: the code's behavior diverges from the natural reading of its own
  source (a sibling-path asymmetry, an off-by-one guard, a fall-through mutation
  under a no-op-looking action, a wrong comparison, a missing review step).
- **2 clean** — no divergence (false-alarm controls).
- **1 out-of-scope** — a self-consistent invariant violation (the kind bare-next()
  correctly *cannot* see), to confirm the method doesn't over-claim.

A **mechanism eval** (`npm run eval:mechanism`, deterministic, no API) first
proves the suite is valid: replaying a *hand-written apparent-intent* reference
spec against each machine's traces fails exactly the seeded window and passes
the clean ones. All 8 machines pass this check — the divergences are real and
detectable *in principle*.

Then the **A/B** (`eval/skill-ab.mjs`, Opus 4.8, N=3) runs the two arms above and
scores each verdict against ground truth (detection on seeded, no-false-alarm on
clean/oos), flagging any machine where Polygraph does worse than the plain
review.

## 3. The result and its mechanism

Polygraph scored 0/5 on the seeded machines. To rule out a harness artifact we
regenerated m01's specs with Opus and kept them. All three were valid (~830
chars, `module.exports = { next }`), and **all three replayed ALL-PASS — they
reproduced the buggy trace exactly.** Here is what Opus wrote for the seeded
machine (a subscription renewal whose bug is: the renewal path treats an
ambiguous `err5xx` as a hard decline → grace, while the parallel dunning path
correctly treats it as a no-op):

```js
if (action === 'RENEW_CHARGE' && s.status === 'active') {
  if (d.result === 'ok') return { status: 'active', attempts: 0 };
  return { status: 'grace', attempts: 1 };                          // reproduced the BUG
}
if (action === 'DUNNING_RETRY' && s.status === 'grace') {
  if (d.result === 'err5xx') return { status: 'grace', attempts: s.attempts }; // the correct sibling
  ...
}
```

Opus copied the source's **asymmetry** faithfully — the buggy renewal branch
*and* the correct dunning branch, exactly as written. It did not normalize the
two paths to match. So the spec agrees with the buggy trace → consistent → no
code-finding → nothing detected.

Meanwhile the plain-review arm, asked directly whether behavior diverges from
intent, engaged the model's *judgment* and flagged the asymmetry 73% of the
time.

**The general principle:** a code-finding requires `spec ≠ code`. A faithful
derivation gives `spec = code`. A capable model on small, legible code produces
a faithful derivation. Therefore bare-next() detects a bug only to the extent
the model *fails* to reproduce the code's literal behavior.

## 4. Reconciling with finixpos — this is regime, not contradiction

The finixpos payment study is the method's success story: five independent
Sonnet-5 derivations diverged from a production renewal path and caught a real
5xx double-charge. Why did divergence happen there and not here?

**The reproduction gap.** finixpos is a ~2,700-line production workflow. A model
cannot hold its literal control flow in one derivation, so it *reconstructs from
intent* — and the reconstruction diverges from the code's actual (buggy)
behavior. These eval machines are ~15-line FSMs where faithful literal
reproduction is trivial, so the model just copies the code, bug and all.

So the two results are one phenomenon:

> **Bare-next() bug detection rises with the reproduction gap — how far the
> code's literal behavior exceeds what the model will faithfully reproduce in a
> single derivation.** Large, tangled, or obfuscated code opens the gap (finixpos).
> Small, legible code closes it (this suite), and the method goes blind.

This also predicts an unusual **capability inversion**: a *stronger* model, being
a more faithful reproducer, may detect *fewer* of these bugs, not more. (Untested
here — we ran only Opus. A weaker model that normalizes toward "sensible"
behavior might, paradoxically, diverge more and catch more. Worth measuring.)

## 5. Threats to validity (read before over-concluding)

1. **This tests the mechanical replay core, not the full skill.** The Polygraph
   arm runs generate + replay + a mechanical verdict. It does **not** include the
   agent's own reading of the code — which is exactly the plain-review arm that
   scored 73%. The *full* Polygraph skill puts an agent in the loop who both
   reviews and replays, so the full skill should do **at least** as well as the
   review. The honest claim is therefore not "the skill hurts" but: **the replay
   mechanism, in isolation, adds nothing on this suite — and its "consistent"
   verdict can give false comfort that suppresses the review that would have
   caught the bug.** That suppression risk is the real hazard.
2. **The baseline prompt is leading.** It asks directly for an intent-vs-behavior
   divergence, which primes the model. Part of the gap is "a good leading prompt
   beats derive-and-replay," which is a fair thing to learn but not identical to
   "review beats the method" in every framing.
3. **Small sample, one model, one vendor.** N=3, Opus 4.8 only, 8 machines, all
   tiny. This is the method's *worst* regime by construction. It is a signal
   about the low end of the reproduction gap, not a global verdict.
4. **Seeded-bug legibility.** The defects are visible in ~15 lines. That is the
   point (it closes the reproduction gap) but it also means the suite does not
   yet probe the regime where the method claims value.

## 6. Implications

- **Bare-next() is not a general bug-finder.** Its detection power is a function
  of the reproduction gap, i.e. of code complexity *relative to model capacity* —
  not an absolute property. On code a model can trivially reproduce, it detects
  nothing and loses to a plain review.
- **"Consistent" can mean "the model copied the bug."** The consistency check's
  clean result on a strong model is weaker evidence than it looks: it certifies
  "the model can reproduce this code," which for buggy-but-legible code is false
  comfort. This sharpens the standing "consistency ≠ correctness" caveat into
  something more specific and more uncomfortable.
- **The tool's honest niche is large/complex systems** — exactly finixpos: code
  too big to hold in one derivation, where the replay surfaces divergences a
  human (or a single-pass review) would miss. The plugin's framing should say so,
  rather than implying general bug-finding.
- **The plain-review baseline is a strong tool in its own right** and, for small
  legible state machines, dominates. A responsible workflow uses review first and
  reserves the replay loop for the large-code regime.

## 7. What would confirm or falsify this

- **Add a large/complex machine** to the suite (hundreds of lines, tangled
  control flow). Prediction: Polygraph detection rises sharply as the
  reproduction gap opens; the review's advantage shrinks or reverses.
- **Sweep model strength** (e.g. a weaker model on the same suite). Prediction of
  the capability-inversion hypothesis: weaker models diverge more and detect more
  of these legible bugs.
- **Test the full agentic skill** (agent-in-session, with vs without the skill),
  not just the mechanical core. Prediction: the full skill ≥ review, because it
  contains the review.
- **Obfuscation sweep**: take one seeded machine and progressively bury the bug
  in complexity. Prediction: detection is monotonic in the reproduction gap.

Until those run, the defensible statement is the one at the top: on small,
legible state machines with a strong model, the bare-next() replay core does not
help and can mislead; its value lives in the large-code regime, and that regime
is not yet in this suite.

## 8. Resolution — the missing half was model checking

The finding above is about *replay*, which is only **conformance** checking:
"does the derived spec reproduce the traces?" A faithful spec reproduces the
code, bug included, so on legible code it conforms and replay stays silent.

That was never the whole method — it was the half the plugin had shipped. The
other half is what a spec is *for*: unlike everyday code, a total pure
`next(state, action, data)` relation can be **exhaustively iterated**. Explore
every reachable state from `init` over the action/data domain, and check
**invariants** — rules that encode *intent*, an independent source of truth the
buggy code violates. The faithful spec that hid the bug under replay **reaches**
the bad state under model checking.

This half was added in v0.2.0 (`scripts/check.mjs`; `npm run eval:check`). On the
identical five seeded machines:

| bug | replay (conformance) | model checking (invariants) |
|---|---|---|
| m01 grace-on-transient-5xx | missed (spec copied it) | **found** — `init → RENEW_CHARGE(err5xx) → grace` |
| m02 auth off-by-one | missed | **found** — reaches lock past the threshold |
| m03 heartbeat requeue | missed | **found** — HEARTBEAT changes status |
| m04 publish-without-approval | missed | **found** — PUBLISH from draft |
| m05 wrong partial-capture guard | missed | **found** — partial capture reached |
| **total** | **0/5** | **5/5** (clean stay clean, out-of-scope stays invisible) |

So the corrected conclusion: **replay checks conformance; model checking finds
bugs.** Replay's blind spot on legible code is real and worth knowing (it warns
against trusting a clean conformance run), but it is a property of the *weaker*
half. The bug-finding lives in iterating the spec against invariants — the same
step the finixpos study performed by hand in TLC, now built into the tool. The
honest limits carry over: model checking needs a bounded state space, and a
hazard that lives in an external service (not the observable state) is invisible
to both halves — that is the correlated-oracle boundary, unchanged.
