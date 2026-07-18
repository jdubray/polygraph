# Composition semantics — the parent×child product model

Status: CP-M0 of `docs/composition-plan.md`. This note is the soundness anchor
for `polyrun check-product` (CP-M1): it defines the joint state, the stimulus
alphabet, the step function, and the reduction argument for why the checker
does not need to explore internal interleavings.

## 1. The reduction: the kernel already serialized the fleet

The classic reason product model checking is intractable is that a checker
must consider arbitrary interleavings of *internal* steps across machines.
polyrun's kernel removes that class by construction:

1. **Cascades are atomic.** Every consequence of a dispatched step — spawns,
   `signalChild`, the child-terminal completion into the parent, the
   parent-terminal cancel into each child — runs synchronously inside the SAME
   store transaction as the step that caused it, depth-bounded by
   `MAX_CASCADE_DEPTH` (`polyrun/src/kernel.mjs`, FR-8). No scheduler exists
   that can interleave another machine's step into the middle of a cascade: a
   concurrent dispatch to any instance the cascade touches serializes on the
   row lock and observes the fully-committed cascade or none of it.
2. **Per-instance dispatch is single-writer** (`SELECT … FOR UPDATE`, FR-2.4).
   A racing dispatcher loses the lock, re-reads, and re-runs against fresh
   state — its step lands strictly before or strictly after, never during.

Consequence — the reduction this whole design rests on:

> Every execution of a parent and its children is observationally equal to a
> sequence of **atomic cascade closures**, one per top-level stimulus, in some
> total order. The ONLY nondeterminism is which stimulus lands next.

This is the reduction argument IronFleet had to construct by hand (contiguous
host steps ≍ atomic steps); here the transaction boundary enforces it, so the
checker may treat "one stimulus + its full cascade" as a single transition of
the joint state.

## 2. The joint state

For one parent instance and the children it spawned:

```
joint = {
  parent:   { machineId, state, status },          // status: active | terminal
  children: { [childKey]: { machineId, state, status,
                            onComplete, onParentTerminal } }
}
```

- `state` is the contract's observable projection — the same object the kernel
  persists and journals; nothing hidden participates in identity.
- The wiring fields (`onComplete`, `onParentTerminal`) are part of the joint
  state: two joints with identical machine states but different wiring behave
  differently under cascade.
- Children are keyed by `childKey`. The kernel keys instances by
  `sha(parentId, childKey, seq)`, so re-spawning an existing key creates a
  SECOND instance behind the same key and makes `signalChild`/`findChild`
  ambiguous — the model flags that as a finding (`childkey-collision`) rather
  than modeling the ambiguity.

## 3. The stimulus alphabet

A transition of the joint state is `(target, action, data)` — one top-level
dispatch. The alphabet at a joint state is:

- for the **parent**, every `(action, data)` in its manifest-declared domain
  (the same declared-domain source `scripts/check.mjs` explores — timers and
  webhooks deliver actions from this same set, so the superset covers them),
  **minus** actions wired as some live child's `onComplete`;
- for each **active child**, every `(action, data)` in its manifest-declared
  domain.

Two deliberate boundaries, both kernel-parity:

- **Completion actions are cascade-owned.** The kernel delivers a child's
  completion under the derived actionId `child:<id>:complete`, so at-least-once
  redelivery dedupes: production delivers each completion exactly once, at the
  moment the child's terminal step commits — which is exactly when the model
  delivers it. Externally injecting completion actions with fresh actionIds is
  outside the composition contract and would force invariant authors to guard
  against states production cannot produce; the exclusion is disclosed in
  every report. The exclusion holds only while the wiring child is ACTIVE:
  once it is terminal, its completion action returns to the alphabet — the
  kernel's dedupe covers only the derived actionId, so a stale external
  redelivery with a fresh actionId IS deliverable in production and must be
  explored. (`onParentTerminal` actions are never excluded: they are
  ordinary actions external callers may also send — e.g. a direct shipment
  cancel — so they stay in the alphabet.)
- **Non-active targets are skipped.** Dispatch to a terminal instance is a
  status-reject with no state change (FR-1.2) — it can never produce a new
  joint state. Inside a cascade the status-reject IS modeled (a completion
  arriving at a terminal parent journals as rejected, same as production).

**At-least-once / stale delivery needs no extra machinery.** Because the BFS
delivers every alphabet stimulus at every reachable joint state, "SHIP
redelivered after delivery", "DELIVER after cancel", and every other
stale/duplicate ordering is just another explored edge — the same argument
`docs/polyrun-spec.md` §6.2 makes for the single-machine checker, now over the
joint space.

## 4. The step function: deterministic cascade closure

`productStep(joint, target, action, data)` mirrors the kernel's
`_dispatchInTxn` ladder exactly:

1. target not `active` → journaled status-reject, joint unchanged;
2. deliver `(action, data)` to the target module (rehydrate → fire → classify
   via `lastStep()`, the same ladder as `polyvers`' `stimulusOutcome`):
   `SamSchemaError` → observable reject; acceptor reject → observable reject
   (unnamed reason is reported as a doctrine finding); `unhandled` → journaled
   unhandled step (reported as a doctrine finding when cascade-delivered);
   throw / unreadable classification / observable mutate-then-reject → the
   poison class — reported as a reachable-poison finding and the branch is not
   extended (production halts the instance there);
3. on an accepted **parent** step, run the effect mapper and validate its
   output exactly as the kernel does (undeclared kind, keyless/duplicate
   timer, malformed/duplicate spawn or signal → poison class): execute
   `spawnChild` (child appears at its `init()` state; the optional creation
   action dispatches at depth+1) and `signalChild` (depth+1);
4. an accepted step that makes a **child** terminal dispatches `onComplete`
   into the parent (depth+1) — even a terminal parent, which status-rejects
   it, as in production;
5. an accepted step that makes the **parent** terminal dispatches each active
   child's `onParentTerminal` (depth+1) in spawn order; a child that rejects
   it stays active — journaled, never forced (FR-8.4);
6. recursion beyond `MAX_CASCADE_DEPTH` (8) is the kernel's wiring-cycle
   poison — reported as a finding.

Timers, `cancelTimer`, and outbox effect intents emitted along the way are
validated (step 3) but not executed: outbox effects act on the outside world,
and the actions their completions/timers eventually deliver are already in the
stimulus superset of §3.

## 5. Cross-machine invariants

`invariants.compose.mjs` exports the joint-state analogue of `invariants.mjs`:

```js
export default {
  stateInvariants:      [{ name, pred(joint) }],
  transitionInvariants: [{ name, pred(preJoint, stimulus, postJoint) }],
};
```

`stimulus` is `{ target, action, data, cascade }`, where `cascade` lists every
journaled sub-step of the closure (`{ target, action, stepKind, reason? }`) —
so a transition invariant can say "no cascade step dispatches a shipment after
the order cancelled" directly.

Alongside the author's invariants, the checker always reports the built-in
doctrine classes reachable in the product: the poison class (step 2/3/6),
unhandled cascade deliveries, unnamed rejects, and `childkey-collision`.

## 6. Scope and honesty

- **One parent, its direct children.** Only the parent's mapper runs; a child
  with its own mapper (grandchildren) is out of scope for v1 — same boundary
  as the `polyvers matrix`. The BFS is exhaustive within the declared domains
  or it says BOUNDED, which is a failing verdict unless explicitly accepted
  (`--allow-bounded`) — check-effects doctrine, uniform across the tools.
- **Determinism double-pass**: two identical explorations must produce the
  same graph and findings, or the run reports nondeterminism instead of a
  verdict — same as `scripts/check.mjs`.
- **Kernel parity is partially tested**: the test suite replays
  invariant-violation counterexample stimulus sequences through the real
  kernel (in-memory store) and asserts the same joint outcome; poison- and
  doctrine-class findings rely on the mirrored dispatch ladder. Extracting a
  shared `cascadeStep()` the kernel itself consumes — making parity
  structural for every class — remains a recorded follow-up
  (`docs/composition-plan.md`, with polyvers' `classifyStep()` note).
- Version pairings (parent-vN × child-vM over the polyvers matrix) are CP-M3;
  until then this closes the product check for the versions given to it.

## 7. Child abstraction (CP-M2)

`--abstract-child <machineId>` collapses a child to `{ running } ∪ its
reachable terminal outcomes`, shrinking the product from `P × M^K` toward
`P × (1+T)^K`. The **refinement check is the construction itself**: an
exhaustive standalone BFS of the concrete child over its declared domain
discovers every reachable state and terminal — truncation refuses, a
reachable poison/unhandled delivery refuses (the abstraction assumes every
delivery lands accepted-or-named-reject), and zero reachable terminals
refuses. Given that, every concrete behavior is covered: the child is either
non-terminal (abstract `running`) or at a terminal in the discovered set,
reached by the abstraction's one nondeterministic move — `$resolve(t)` for
each discovered terminal `t`, which fires the completion cascade concretely.

The refinement walk carries the pipeline's determinism double-pass (two
identical explorations must reach the same state set, or the abstraction is
refused — a nondeterministic child would silently vary the `$resolve`
alphabet), and its cap is a **separate knob** (`--abstract-max-states`) from
the joint cap: the joint cap's overflow is a survivable BOUNDED verdict, the
child walk's overflow is a hard refusal, and one knob for both would let a
deliberately lowered joint cap spuriously refuse a healthy abstraction.

The `$resolve` move is minted only by the checker's own alphabet builder and
carried as a provenance flag on the stimulus — never inferred from the
action name — so a mapper signal (or a real machine action) named
`$resolve` can neither forge a terminal nor be shadowed.

The parent-terminal cancel is summarized **concretely**: the cancel action
(with the kernel's exact FR-8.4 payload) is delivered to every reachable
non-terminal child state. If it always lands on one single terminal, the
abstract cancel is deterministic and precise. If it poisons anywhere, that
is a **reachable-poison finding**, exactly as the concrete path reports it —
never a silent over-approximation; unhandled and unnamed-reject cancels
surface as the same doctrine findings the concrete path raises. Any other
shape (rejects somewhere, stays non-terminal, multiple terminal outcomes) is
over-approximated as stays-running with `$resolve` still enabled — disclosed
in the cascade as `abstract-noop`. **Consequence, stated plainly**: for a
child whose cancel is total but multi-outcome, parent-terminal-quiescence
invariants ("no active child once the parent is terminal") will FAIL as
abstract witnesses by construction — run such pairs concretely; the
summary's `why` string says so at the point of failure. The cancel summary
applies ONLY to the cancel the closure itself issues; a mapper signal
reusing the same action name is not assumed to behave like the cancel.

Deliveries into an abstracted child that the refinement walk never exercised
(creation actions, mapper signals with payloads outside the declared domain)
are NOT covered by the refinement claim — each such delivery raises an
`abstract-unchecked-delivery` finding rather than being silently absorbed.

Soundness boundary, disclosed in every report: an abstracted child never
exhibits its non-terminal concrete states, so invariants that read them are
not checked against it. A PASS is sound for invariants that read abstracted
children only through `status` and terminal states; a FAIL is an **abstract
witness** — confirm it with a concrete run before acting on it.

## 8. PCT sampling (CP-M2)

`--pct N [--pct-depth D] [--pct-steps L] [--seed S]` switches from exhaustive
BFS to seeded random priority schedules over the same stimulus space —
Burckhardt et al.'s PCT discipline: each target stream draws a random
priority, the highest-priority enabled stream fires, and D−1 pre-chosen
points demote a random stream. **Scope of the depth guarantee**: streams are
keyed per target instance, so the discipline orders stimuli BETWEEN targets
(the completion-races-cancel class — the headline product bug — is exactly
inter-target); two actions of the SAME target share a stream and interleave
uniform-randomly, so raising D does not help same-machine ordering bugs.
D−1 must not exceed L (the demotion points are distinct steps; the sampler
refuses otherwise). Every schedule replays exactly under its seed. A sampler
falsifies — it never proves: the report says SAMPLED, `ok` is `false` even
when nothing was found (machine-readable BOUNDED doctrine — `--json`
consumers must not greenlight an unproven fleet), and a clean sampled run
exits nonzero unless explicitly accepted with `--allow-sampled`.

## 9. Partial-order reduction: dropped, not deferred (CP-M2 deviation)

The plan named POR as a CP-M2 scaling lever. The reason it is dropped is
**soundness, not redundancy**: POR prunes interleavings whose intermediate
states are invisible to the property being checked (for independent stimuli
`a`, `b` from state `s`, it explores one order and never generates the
intermediate joint state of the other). This checker's properties are
**user-supplied predicates over the whole joint state and the cascade
journal** — any reachable joint state may be exactly the one a state
invariant rejects, and any transition the one a transition invariant
rejects. With every state and transition property-visible, the ample-set
condition forces the full exploration: a sound POR here degenerates to no
reduction, and an unsound one could silently skip a reachable violating
state — a checker that certifies fleets with reachable violations. (BFS
dedup of converging paths is a separate, already-present economy; it merges
endpoints but still visits every reachable state, which is what soundness
requires.) The genuine explosion is the product itself (`M^K`), which
abstraction (§7) attacks directly and sampling (§8) falls back on. Recorded
here so a future maintainer facing product blow-up does not re-derive POR
and ship the unsound variant.

## 10. The DST fleet simulator (CP-M4)

`polyrun simulate` closes the loop from the other side: where the checker
explores a MODEL of the kernel exhaustively, the simulator drives the REAL
kernel — fresh in-memory stores, an injected clock, seeded mulberry32
schedules — and asserts the same `invariants.compose.mjs` on the durable
joint state after every dispatch.

Two run modes, both byte-reproducible from the seed:

- **Parity runs** step the checker's model in LOCKSTEP with the kernel:
  after every dispatch, the durable joint state must equal the model's
  `productStep` result exactly, and a kernel poison must coincide with a
  model defect. This is the STRUCTURAL kernel-parity check — the
  counterexample-replay tests sample parity at a few points; the parity
  walk asserts it at every step of every seeded schedule, so drift between
  `_dispatchInTxn` and its mirror surfaces as a `parity-divergence` finding
  naming the exact stimulus.
- **Chaos runs** add what the model deliberately excludes: duplicate
  actionIds (must hit the dedupe path with no state change), deliveries to
  terminal instances (must land as the FR-1.2 status-reject), and store
  faults injected mid-commit followed by same-actionId redelivery (the
  at-least-once crash-retry path — the transaction must have rolled back
  cleanly). After every run the journals audit against the soak invariants:
  dense seqs, chained accepted steps, snapshot = last accepted post.

Boundary, disclosed in every report: outbox effects are recorded but not
executed and timers are not fired (no worker loop) — the actions their
completions would deliver are already in the external-stimulus superset
(§3/§4), the same boundary the checker draws. The nondeterministic
worker/timer surface remains the soak test's job (`polyrun/test/
soak.test.mjs`, the Jepsen-style storm). A simulator falsifies; a clean run
is evidence, never a proof — pair it with `polyrun check-product`. Every
finding carries `{seed, run, step, trail}` for exact reproduction.
