# Fleet study — plan for the paper's empirical section

**Status: PLAN v1.0 — not started.** Addresses the reviewer ask: *"one real-fleet
case study for polyvers with cost and hit/false-positive numbers."* The other
two review items (Worker Versioning engagement; the explicit
observable-projection bound) are **parked** and tracked separately.

---

## 1. The problem this plan solves

The paper's §"A worked example" describes the OMS fixture and reports **no
numbers**. A reviewer cannot tell from it whether `polyvers` finds real
incompatibilities, how often it cries wolf, or what running it costs.

The naive fix — "run it on a real fleet" — does not actually work, because
the binding constraint is **not fleet realism, it is ground truth**:

- a **synthetic** fleet with planted defects gives perfect ground truth and
  no external validity;
- a **live** fleet gives external validity and no ground truth — you can
  count what the tool flagged, but not what it missed, so "hit rate" has no
  denominator and is unfalsifiable.

There are only three honest sources of ground truth: *you plant it*, *an
expert adjudicates it*, or *someone else already recorded it*. This plan
uses all three, in that order, as three tiers. The structure deliberately
mirrors the doctrine the paper already champions for Polygraph — **controls
before trust** — so the evaluation is held to the standard the tool
advertises.

**Design rule for the whole study: every number is reported per tier, and no
tier's number is presented as if it came from another.**

---

## 2. Pre-registered definitions (fix these BEFORE running anything)

Reviewers will attack a single "false positive" figure, because `polyvers`
findings are not binary. Three buckets, decided in advance:

| bucket | definition | counts as |
|---|---|---|
| **TP — true incompatibility** | the new version genuinely mishandles a state the fleet holds: a state that fails to round-trip, an old-version stimulus that becomes undefined behavior, a live state drivable to an invariant violation, a migration that loses or corrupts meaning | a hit |
| **TI — true but intended** | the finding is correct and the behavior is deliberate — most importantly a *strengthened invariant naming live violators*. The tool did exactly its job; a human decides what those instances mean | **its own row** — never folded into either other bucket |
| **FP — spurious** | tool error: bad domain inference, over-conservative stimulus superset, a BOUNDED run misread as a verdict, a gate misfiring on a cosmetic change | a false positive |

**Adjudication protocol.** Each finding is judged by a domain reader against
the artifact and, where available, the maintainers' record. Judgments are
made **blind to which tier produced the finding**. Disagreements are
resolved by a third reader; the count of disagreements is reported (a study
that never disagrees with itself is not adjudicating).

**Pre-registered null result.** If a tier produces zero TPs, that is
published as-is: *"N version pairs across M live instances produced k true
incompatibilities (k=0)"*. The cost numbers stand on their own regardless.
Committing to this now is what separates evidence from marketing.

---

## 3. What gets measured (identical columns for every tier)

Per version pair:

- **corpus**: instances, distinct states after `stable()` dedup, provenance
  tier (live export / archive / synthesized), fleet age span
- **classification**: lanes fired, gates demanded
- **findings**: TP / TI / FP per gate, one witness each
- **cost**: wall-clock per gate, states explored, cap hit yes/no, peak RSS,
  **$0 API** (assert it — the free-and-deterministic story is a headline
  result against a determinism sandbox you maintain forever)
- **human cost**: minutes to author `invariants.compose.mjs` / fill migration
  holes — the honest denominator nobody reports
- **invariant strength**: `polynv grade --include-invariants` kill ratio, so
  every verdict carries the trust tier it was measured against

---

## 4. Tier 1 — seeded control (recall against known ground truth)

**Question:** does each gate catch the defect class it claims, and does the
*fleet-seeded* model check catch landmines that from-init checking misses?

**Method.** Extend `polyvers/test/fixtures/` into a generator that plants a
catalogue of known defects into version pairs, one per lane:

| lane | planted defect |
|---|---|
| shape | key removed / retyped with no migration; migration that drops a field |
| semantic | **landmine**: a state reachable under v1, unreachable under v2, drivable to a violation under v2's rules |
| vocabulary | action removed while in-flight timers still deliver it; reject-reason renamed; terminal state removed |
| intent | invariant strengthened past live states; invariant weakened silently |
| migration | impure migration; projection-unequal; invariant-violating output |
| composition | child cancel window narrowed (the CP-M3 case: passes the matrix, fails `product`) |

For each: run the gates against **both** corpus tiers (real-shaped snapshots
vs. `--synthesize`) and report recall per tier. The synthesized-tier recall
is expected to be *worse* for landmines by construction — that is a result,
not a bug, and it quantifies the paper's existing claim that synthesis is
the weakest tier.

**Deliverable:** `eval/fleet-study/tier1/` — generator, fixture matrix,
`results.json`, and a recall table.
**Effort:** small. Most scaffolding exists (`landmine-fleet.json`,
`order-v2-*` fixtures, `runMatrix`/`runProductMatrix` harnesses).

---

## 5. Tier 2 — the real fleet (cost + external validity)

**Question:** what does this cost, and what does it find, on a fleet that
accumulated heterogeneously under real time and a real API?

**System: Stripe test mode + Test Clocks.** Rationale:

- free, public, no production risk;
- subscriptions/invoices are *the* canonical long-running state machine, and
  the same domain as the paper's existing double-charge case study;
- **Test Clocks** advance months of billing deterministically, so the fleet
  ages genuinely (trialing, active, past_due, unpaid, paused, incomplete,
  mid-dunning, partially refunded) without waiting a quarter;
- Stripe versions its own API, which yields a real cross-version delivery
  story for the stimuli gate rather than a synthetic one.

**Method.**
1. Model the subscription lifecycle as a SAM v2 strict-profile machine
   (`contract.json` scoped to the observable projection — record explicitly
   what is *outside* it, since that is the bound on every claim made here).
2. Drive a fleet of N≈500–2000 subscriptions through varied trajectories over
   several test-clock "months", capturing `{pre, action, data, post}` windows
   from the webhook stream. The journal doubles as the trace corpus.
3. Export the fleet as a snapshot corpus.
4. Ship **three** version changes of increasing severity: a pure addition, a
   rules change, and a shape change requiring migration.
5. Run `classify` → `check --snapshots` → `migrate scaffold` → `check` again,
   plus `product` if a parent/child decomposition is modelled.
6. Adjudicate every finding into TP/TI/FP; record all cost columns.

**Fallbacks if Stripe proves awkward:** GitHub PR lifecycle via the REST API
(genuinely long-lived heterogeneous states, webhook event stream, free) or a
Shopify/PayPal sandbox. Selection criterion: *can the fleet age, and can I
observe every transition?*

**Deliverable:** `examples/fleet-study-stripe/` — machine, contract,
invariants, capture harness, exported corpus (scrubbed), committed reports.
**Effort:** medium — the capture harness is the bulk.

---

## 6. Tier 3 — archaeology (independent ground truth; the citable tier)

**Question:** on version changes made by *other people* for their own
reasons, does `polyvers` flag what the maintainers themselves had to handle?

**Method.** Pick an OSS project with a genuine order/payment state machine
*and* a real release history. Replay consecutive released version pairs and
use **the maintainers' own record as ground truth**:

- they shipped a migration for this change → a finding that names it is a
  **TP**;
- an issue reports upgrade breakage matching the finding → **TP**;
- no correlate and a domain reader judges it benign → **FP**;
- correct but deliberate (a documented breaking change) → **TI**.

**Candidates**, in preference order:

1. **Medusa** (TS) — order/fulfilment/payment state machines; JS/TS lands
   inside polygen's supported language; frequent releases with migrations.
2. **Saleor** (Python) — very explicit order/payment FSM with documented
   migrations; cross-language audit is itself a demonstration (cf. the
   existing Go OMS example).
3. Any project whose *own* changelog names state-machine changes.

The fleet for each pair is generated by running the app at version N
(seed + drive), so Tiers 2 and 3 can share one capture harness.

**This is the tier that makes the section citable**, because ground truth is
external to us. It also lets the paper cite the SOSP'21 upgrade-failure
methodology rather than defend a bespoke one.

**Deliverable:** `eval/fleet-study/tier3/` — version-pair matrix, per-pair
reports, ground-truth mapping table with links to the upstream migration or
issue for every TP.
**Effort:** medium–large; dominated by getting each version to run.

---

## 7. Milestones

| id | content | gate |
|---|---|---|
| **FS-M0** | This plan + pre-registered definitions committed *before* any run | plan reviewed |
| **FS-M1** | Tier 1 generator, fixture matrix, recall table | recall reported per lane × corpus tier |
| **FS-M2** | Capture harness + Stripe fleet generated and exported | corpus provenance documented; projection bound stated |
| **FS-M3** | Tier 2 three version changes run and adjudicated | TP/TI/FP + full cost columns |

FS-M3 is **built but not adjudicated**: `eval/fleet-study/tier2/` runs the three
changes end-to-end with predicted verdicts, migrations, cost columns, and a
blind worksheet. Adjudication is deliberately withheld until a `--live` corpus
exists, because TP/FP rates computed over the circular offline corpus would not
be reportable under §2. The run did produce one result that stands independent
of provenance — a suppression bug in `polyvers check` that hid the study's most
valuable finding — since that is a fact about the tool, not about the fleet.
| **FS-M4** | Tier 3 version-pair replay with upstream ground truth | every TP linked to an upstream artifact |
| **FS-M5** | Paper §"A worked example" rewritten around the numbers | reviewer ask answered |

Each milestone gets the repo's standard adversarial review before the next
begins.

---

## 8. Risks, stated up front

- **The tool finds nothing on the real fleet.** Handled by §2's pre-registered
  null result. Cost numbers still stand.
- **Adjudication is us judging our own tool.** Mitigated by blind judging, a
  third reader, reported disagreement counts, and Tier 3's external ground
  truth. Stated as a limitation regardless.
- **Test Clocks are not "real time".** They advance real API state
  deterministically; the fleet is real, its *aging* is simulated. Say so
  plainly rather than implying a quarter of production data.
- **Selection bias in Tier 3.** Report every version pair attempted,
  including those excluded for not running — an excluded-pairs count is part
  of the result.
- **The corpus may carry PII.** Test mode only, scrub before committing, and
  document the scrub.

---

## 9. Explicit non-goals

- Not a benchmark against Temporal. The Worker Versioning engagement is a
  *separate* parked item and belongs in the comparison section, not here.
- Not a claim about machines outside the SAM v2 strict profile with finite
  declared domains.
- Not a claim beyond the observable projection — which is the parked item
  that must land before this section can be read honestly.
