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
