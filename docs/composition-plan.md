# Composition plan — closing the parent×child product check

Status: CP-M0 + CP-M1 LANDED (2026-07-18) — semantics note at
`docs/composition-semantics.md`, checker at `polyrun/src/check-product.mjs`
(`polyrun check-product`), fixtures + kernel-parity tests at
`polyrun/test/fixtures/compose/` and `polyrun/test/check-product.test.mjs`.
One recorded deviation from the plan below: CP-M1 did NOT extract a shared
`cascadeStep()` from the kernel — the checker mirrors `_dispatchInTxn` and
parity is enforced by tests that replay counterexamples through the real
kernel; the extraction remains a follow-up (with polyvers' `classifyStep()`
note).

CP-M2 LANDED (2026-07-18): contract-derived child abstraction
(`--abstract-child`, refinement-checked by exhaustive child BFS with
determinism double-pass + concrete cancel summary, own `--abstract-max-states`
cap, semantics §7) and seeded PCT sampling (`--pct`, semantics §8; the depth
guarantee is scoped to inter-target orderings). Second recorded deviation:
**POR is dropped, not deferred** — user-supplied invariants read the whole
joint state and cascade journal, making every reachable state and transition
property-visible, so any interleaving-pruning reduction would be UNSOUND
here and a sound one degenerates to full exploration (analysis in semantics
§9). A high-effort review pass (17 confirmed findings, all fixed) hardened
the abstraction: `$resolve` is provenance-flagged (unforgeable), poison-class
cancels surface as reachable-poison findings, unchecked deliveries raise
`abstract-unchecked-delivery`, and sampled results carry `ok: false`.
Remaining recorded follow-ups beyond cascadeStep()/classifyStep(): a shared
delivery ladder for check-product's deliver() and polyvers' stimulusOutcome()
(they have drifted on unnamed-reject/mutate-then-reject details), and a
shared seeded-BFS driver in scripts/ for the four hand-rolled reachability
walks.

CP-M3 LANDED (2026-07-18): `polyvers product` (polyvers/src/product.mjs)
runs the joint product check per rollout-window pairing (parent {old,new} ×
child {old,new}), memoizing identical pairings, with `--abstract-child`
pass-through. The headline test proves the pitch: a child whose cancel
window narrowed between versions PASSES the protocol/delivery matrix but
FAILS the product check on "shipment delivers under a cancelled order". The
matrix/VERSIONING/spec/README scope notes are flipped. Third recorded
deviation from the plan: pairings are explored from GENESIS under each
version pair, not seeded from live fleet snapshots — joint seeding needs a
polyrun joint-export (parent + linked children in one snapshot), recorded
below as the main CP-M3 follow-up; per-machine mid-flight coverage remains
the seeded semantic gate's job. Gate wiring into `polyrun deploy` was NOT
done (deploy is store-backed and per-machine; the product check needs
version PAIRS, which deploy does not know — `polyvers product` in CI is the
right seam).

CP-M4 LANDED (2026-07-18): `polyrun simulate` (polyrun/src/simulate.mjs,
semantics §10) — the seeded DST fleet simulator against the REAL kernel:
parity runs step the checker's model in lockstep (joint-state equality after
every dispatch — the structural kernel-parity check the replay tests only
sample), chaos runs add duplicate actionIds, stale-to-terminal deliveries,
and mid-commit store faults with same-actionId redelivery, with the soak
journal audit after every run. Deviation from the plan's sketch: implemented
as a first-class src module + CLI rather than growing soak.test.mjs — the
soak keeps the nondeterministic worker/timer storm; the simulator is the
deterministic, invariant-bearing, seed-replayable half. Boundary (disclosed
per report): outbox effects recorded not executed, timers not fired.

All four milestones are now landed. Remaining recorded follow-ups: joint
mid-flight seeding (polyrun joint-export), grandchildren, the shared
delivery ladder (deliver vs stimulusOutcome), the shared seeded-BFS driver,
and cascadeStep()/classifyStep() extraction — each becomes less urgent now
that the parity walk checks the mirror structurally on every simulate run.
Addresses: the reviewer comment that "real fleets fail in the interleavings" — the
parent×child product model check declared open in `docs/polyrun-spec.md` FR-8.3,
`docs/VERSIONING.md` ("What remains genuinely open"), `polyrun/README.md` scope
notes, and the scope note rendered in every `polyvers matrix` report
(`polyvers/src/matrix.mjs`).

---

## 1. The load-bearing observation: the kernel already did the reduction

The reviewer's fear — "real fleets fail in the interleavings" — is usually fatal
because a checker must enumerate arbitrary interleavings of *internal* steps
across machines. Polyrun's kernel makes that unnecessary:

- Every cascade (spawn, completion delivery into the parent, cancel delivery
  into children, signalChild) runs **synchronously inside the parent step's
  single ACID transaction**, depth-bounded by `MAX_CASCADE_DEPTH`
  (`polyrun/src/kernel.mjs`). There is no scheduler that can interleave a
  parent's step with its child's step mid-cascade.
- Per-instance dispatch is single-writer (`SELECT … FOR UPDATE`); losers re-run
  against fresh state and may observably reject.

So the **only** nondeterminism in a fleet is the **arrival order of top-level
external stimuli** (user actions, timers, effect completions, webhooks) across
instances. This is exactly IronFleet's reduction argument, except we don't need
to *argue* it — the kernel *enforces* it transactionally. Consequence:

> The joint state space is: product states `(parentState, {childKey → childState})`,
> with one transition per (machine, stimulus) pair, where each transition is the
> **deterministic cascade closure** of that stimulus. No internal interleavings
> exist to explore.

That turns "the hardest 20%" from an interleaving-explosion problem into a
product-state-explosion problem — still hard, but the same *kind* of hard the
existing exhaustive BFS (`scripts/check.mjs`) already handles, and amenable to
the standard mitigations (abstraction, POR, bounding) below.

A secondary nondeterminism source to model explicitly: **at-least-once /
stale delivery**. The kernel absorbs it as observable rejects; the product
checker must include duplicate/stale stimulus deliveries in the alphabet (as
the single-machine checker already does per `docs/polyrun-spec.md` §6.2).

## 2. What the literature says (and what we borrow)

- **Assume-guarantee / compositional testing — ModP (P language module system,
  Desai et al.)**: replace a component by a smaller abstraction at its interface
  when checking its peer; sound if the implementation refines the abstraction.
  Maps directly onto our shape: the parent sees the child *only* through the
  child's contract alphabet + terminal outcomes + named rejects. We can derive a
  **child abstraction machine** mechanically from `contract.json` (terminals +
  reject vocabulary) and check refinement with the existing `check.mjs` BFS.
- **IronFleet-style reduction**: contiguous-step equivalence justifies treating
  a host's step as atomic. Ours is enforced by the kernel transaction (§1); we
  document it as the soundness argument for the product semantics rather than
  proving it per-system.
- **Partial-order reduction (POR)**: stimuli addressed to different children
  commute unless a cascade touches the parent. With cascade closure as the step
  function, independence is *statically visible* (did the closure emit into the
  parent?), enabling a cheap sleep-set/ample-set style cut.
- **PCT (probabilistic concurrency testing, Burckhardt et al.) and its
  distributed variant (Ozkan et al., OOPSLA'18)**: when the product is too big
  to exhaust, randomized priority schedules with a small "bug depth" d find
  ordering bugs with provable probability. Our stimulus-interleaving space is
  precisely their event space; d=2 covers the classic completion-races-cancel
  class.
- **Deterministic simulation testing (FoundationDB, TigerBeetle, Antithesis)**:
  a seeded harness driving the *real* kernel (in-memory store, injectable
  clock — both already exist: `Runtime` takes `now`, the store has a
  fault-injection hook, `polyrun/test/soak.test.mjs` already races
  dispatchers) gives falsification power beyond the model checker's domain
  bounds, with replayable seeds.
- **Mixed-version upgrade failures (Zhang et al., SOSP'21; DUPTester)**:
  upgrade bugs concentrate in exactly the parent-vN × child-vM window that
  `polyvers matrix` enumerates; the product check must run **per version
  pairing**, not just at head.

## 3. Milestones

Convention: review-per-milestone, as with polyvers M0–M3.

### CP-M0 — Semantics + invariant surface (docs/spec first)
1. **Product semantics note** (new section in `docs/polyrun-spec.md` or a
   standalone `docs/composition-semantics.md`): define the joint state, the
   stimulus alphabet (including duplicate/stale deliveries), cascade closure as
   the step function, and the kernel-transaction reduction argument for why
   internal interleavings need not be explored. This is the soundness anchor;
   everything else cites it.
2. **Cross-machine invariant format**: `invariants.compose.mjs` exporting
   predicates over `({parent, children}, step)` — e.g.
   `no shipment dispatches after order cancel` becomes a transition invariant
   over the joint state. Same shape as `invariants.mjs` so polygen can author
   them later.
3. Fixture: the existing order×shipment pair
   (`polyvers/test/fixtures/order-v2-*`, `polyrun/test/fixtures/shipment-machine.cjs`)
   with 2–3 cross-machine invariants, at least one deliberately violated in a
   mutant to prove the checker can catch it.

### CP-M1 — `check-product`: exhaustive joint BFS (the core deliverable)
1. New `polyrun check-product` (module `polyrun/src/check-product.mjs`,
   generalizing `scripts/check.mjs`): BFS over joint states; each transition =
   pick (instance, stimulus from its declared domain) → run the **real cascade
   closure** (factor the pure part of `_dispatchInTxn` — spawn, onComplete,
   onParentTerminal, signalChild — into a store-free `cascadeStep()` the kernel
   and checker share, echoing the recorded polyvers follow-up to extract a
   shared `classifyStep()`).
2. Reuse: `stable()` from `scripts/load-spec.mjs` for joint-state hashing,
   `stimulusOutcome()` from `polyvers/src/gates.mjs` for kernel-parity verdicts,
   `synthesizeCorpus()`/`loadCorpus()` from `polyvers/src/corpus.mjs` to seed
   from live fleet snapshots (same trick as the semantic gate).
3. Output: shortest counterexample as an **interleaved ndjson trace** (each line
   tagged with instance id) — replayable by the existing trace tooling, and by
   the kernel itself against an in-memory store as an executable witness.
4. Bounds, stated loudly in the report (no silent caps): one parent × K children
   (start K=1, then K=2 for sibling races), declared finite domains, cascade
   depth ≤ 8, duplicate-delivery bound (each stimulus deliverable ≤2×).

### CP-M2 — Scale: abstraction + POR
1. **Contract-derived child abstraction**: auto-build a small machine from the
   child's `contract.json` (states = {running} ∪ terminals, plus named-reject
   observability); check the real child **refines** it with the existing BFS;
   then let `check-product` substitute the abstraction. This is the ModP
   assume-guarantee move, with refinement checked, not assumed.
2. **POR**: skip interleavings of stimuli whose cascade closures touch disjoint
   instance sets (statically detectable from closure output). Report the
   reduction factor.
3. Escape hatch when exhaustive still blows up: `--budget` switches to
   **PCT-mode** — seeded random priority schedules over the stimulus space with
   depth d (default 2), N schedules, seeds recorded in the report so every
   failure replays deterministically.

### CP-M3 — Version products: close the polyvers scope note
1. Extend `polyvers matrix` (or add `polyvers product`) to run `check-product`
   for each of the 2×2 rollout pairings (parent {old,new} × child {old,new}),
   seeded from live fleet snapshots — turning the matrix's protocol/delivery
   check into a full product model check per pairing.
2. On landing: update the four scope notes (`polyrun-spec.md` FR-8.3,
   `VERSIONING.md`, `polyrun/README.md`, `matrix.mjs` report text) from "open"
   to "closed for K≤2, exhaustive within declared domains; PCT-sampled beyond".
3. Gate wiring: `polyrun deploy` and `polyvers check` fail on a cross-machine
   invariant counterexample, same UX as the semantic gate.

### CP-M4 — DST harness (falsification beyond the model's bounds)
1. Grow `polyrun/test/soak.test.mjs` into a seeded deterministic fleet
   simulator: in-memory store, injected clock, scripted+randomized stimulus
   schedules, store fault injection; assert the same `invariants.compose.mjs`
   on the journals it produces. This catches what the model checker's domain
   bounds exclude (store faults, timer storms, retry pathologies) and validates
   that `cascadeStep()` stayed kernel-parity (divergence = bug in one of them).

## 4. Explicit non-goals (keep the honesty the reviewer credited)
- No peer-to-peer machine communication — composition stays parent/child, as
  the spec defines it.
- No unbounded-K children proof; K is a declared bound in the report.
- No modeling of external-world latencies beyond stale/duplicate delivery
  (same boundary as `docs/polyrun-spec.md` §6.2).
- Nothing here touches polynv.

## 5. Sequencing / effort
CP-M0 is small (docs + fixture) and de-risks everything. CP-M1 is the
substantial one — the `cascadeStep()` extraction is the only kernel-adjacent
surgery and doubles as the recorded shared-`classifyStep()` follow-up. CP-M2/M3
are incremental on top. CP-M4 can proceed in parallel after M1.
