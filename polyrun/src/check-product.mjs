// polyrun parent×child product model checker (composition plan CP-M1,
// docs/composition-semantics.md) — the joint-state exploration the spec's
// FR-8.3 scope note recorded as open.
//
// The reduction this rests on (semantics §1): the kernel runs every cascade
// (spawn / signalChild / child-terminal completion / parent-terminal cancel)
// synchronously inside the dispatching step's own transaction, so a fleet's
// only nondeterminism is the ORDER of top-level stimuli. One transition of
// the joint state = one stimulus + its deterministic cascade closure; no
// internal interleavings exist to explore.
//
// Kernel-parity contract (mirrors _dispatchInTxn, tested in
// test/check-product.test.mjs by replaying counterexamples through the real
// kernel):
// - non-active target → journaled status-reject, no state change (FR-1.2);
// - SamSchemaError → observable reject; acceptor reject → observable reject;
//   'unhandled' → journaled unhandled step;
// - throw / unreadable lastStep() / observable mutate-then-reject → the
//   POISON class: reported as a reachable-poison finding, branch not extended
//   (production halts the instance there);
// - the mapper runs on EVERY accepted parent step (identity-accepts
//   included), its output validated exactly as the kernel validates it —
//   undeclared kind, keyless/duplicate timer, malformed/duplicate spawn or
//   signal are the same poison class;
// - cascade depth is capped at the kernel's MAX_CASCADE_DEPTH.
//
// Alphabet boundary (semantics §3, disclosed in every report): actions wired
// as a live child's onComplete are cascade-owned — the kernel's derived
// actionId (`child:<id>:complete`) dedupes redelivery, so production delivers
// each completion exactly once, exactly when the model does. Everything else
// in the manifest-declared domains (onParentTerminal actions included) is
// external stimulus, deliverable in every reachable joint state — which is
// how stale/duplicate orderings get explored without extra machinery.
//
// Deterministic, no API key. Bounded exploration is a failing verdict unless
// explicitly accepted — check-effects doctrine, uniform across the tools.
//
// CP-M2 (semantics §7/§8):
// - Child ABSTRACTION (`abstractChildren`): an abstracted child collapses to
//   { running } ∪ its reachable terminal outcomes, discovered by an
//   exhaustive standalone BFS that doubles as the refinement check (every
//   reachable delivery must land accepted-or-named-reject; truncation or a
//   poison/unhandled outcome refuses the abstraction). Sound over-approx:
//   a PASS under abstraction implies a concrete PASS for invariants that
//   read abstracted children only through status/terminal state; a FAIL is
//   an abstract witness that needs a concrete confirming run.
// - PCT sampling (`pctSample`): seeded random priority schedules over the
//   stimulus space (Burckhardt et al.'s bug-depth discipline, scoped to
//   INTER-target orderings — same-target actions share a stream) for
//   products beyond exhaustive reach. A sampler falsifies; it never proves —
//   the report says SAMPLED, result.ok is always false, and the CLI treats
//   it like BOUNDED.
// - POR is dropped, not deferred (recorded CP-M2 deviation, semantics §9):
//   user-supplied invariants read the WHOLE joint state and the cascade
//   journal, so every reachable state and transition is property-visible —
//   any interleaving-pruning reduction would be UNSOUND here (it could skip
//   a reachable violating state), and sound POR degenerates to the full
//   exploration. The product explosion itself (M^K) is what abstraction
//   attacks.
'use strict';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { loadSpec, stable } from '../../scripts/load-spec.mjs';
import { resolveFireAt } from './duration.mjs';
import { MAX_CASCADE_DEPTH, sanitizeReplacer } from './kernel.mjs';

const require_ = createRequire(import.meta.url);
const { isSamV2Module, domainFromManifest } = require_('../../scripts/sam-adapter.cjs');

/** Internal sentinel: a poison-class defect inside a cascade closure. */
class PoisonDefect extends Error {
  constructor(target, message) { super(message); this.target = target; }
}

// ── machine defs ────────────────────────────────────────────────────────────

function loadMachineDef({ machineId, module: modulePath, contract: contractPath }) {
  const mod = loadSpec(resolve(modulePath));
  if (!isSamV2Module(mod)) {
    throw new Error(`machine '${machineId}': module does not export the v2 SAM surface { instance, init, actions, getState, setState }`);
  }
  // Same load gate as the kernel and check.mjs: a module that does not
  // validate strict-clean would explore nothing or poison at runtime.
  const acc = mod.instance({});
  if (typeof acc.validate === 'function') {
    const problems = acc.validate();
    if (Array.isArray(problems) && problems.length > 0) {
      throw new Error(`machine '${machineId}': module does not validate strict-clean: ${problems.join('; ')}`);
    }
  }
  const contract = JSON.parse(readFileSync(resolve(contractPath), 'utf-8'));
  const observableKeys = Array.isArray(contract.stateKeys) ? contract.stateKeys.map((k) => k.name) : null;
  const terminalKey = contract.terminalKey
    ?? (Array.isArray(contract.stateKeys) && contract.stateKeys[0] && contract.stateKeys[0].name);
  const terminalValues = new Set(contract.terminalStates ?? []);
  // Terminal metadata is load-bearing here: completions fire at child-terminal
  // and cancels at parent-terminal, so a contract without it would silently
  // model NEITHER and pass vacuously. Refuse instead — matrix doctrine
  // (polyvers/src/matrix.mjs terminalsFor refuses on exactly this).
  if (!terminalKey || terminalValues.size === 0) {
    throw new Error(`machine '${machineId}': contract declares no terminalStates/terminal key — terminal-driven cascades (completions, cancels) cannot be modeled, and a product check without them would pass vacuously; declare the terminal metadata (this is contract metadata, not machine behavior)`);
  }
  const isTerminal = (s) => terminalValues.has(s[terminalKey]);
  // Observable-is-total (kernel parity: registerMachine refuses the same
  // modules at load) — without it, projectState can fabricate or drop keys
  // and split one semantic state into two BFS nodes.
  if (observableKeys) {
    mod.init();
    const raw = JSON.parse(JSON.stringify(mod.getState(), sanitizeReplacer));
    const modKeys = Object.keys(raw);
    const extra = modKeys.filter((k) => !observableKeys.includes(k));
    const missing = observableKeys.filter((k) => !modKeys.includes(k));
    if (extra.length || missing.length) {
      throw new Error(`machine '${machineId}': contract stateKeys and module state disagree`
        + (extra.length ? ` — module keys not in contract: ${extra.join(', ')}` : '')
        + (missing.length ? ` — contract keys not in module state: ${missing.join(', ')}` : ''));
    }
  }
  const { steps, notes } = domainFromManifest(mod);
  return { machineId, mod, contract, observableKeys, isTerminal, steps, notes };
}

function projectState(def) {
  const raw = JSON.parse(JSON.stringify(def.mod.getState(), sanitizeReplacer));
  if (!def.observableKeys) return raw;
  const out = {};
  // Skip undefined values (gates.mjs projectState doctrine): an
  // explicit-undefined entry gets a distinct stable() key yet is dropped by
  // cloneJoint's JSON round-trip — the same semantic state would split into
  // two BFS nodes. Kernel snapshots never carry explicit undefined either
  // (they come JSON-parsed from the store).
  for (const k of def.observableKeys) if (raw[k] !== undefined) out[k] = raw[k];
  return out;
}

/** One delivery, classified — the kernel's dispatch ladder (kernel parity is
 *  the whole point; see the fidelity comment in the header). */
function deliver(def, state, action, data) {
  const handler = def.mod.actions[action];
  if (typeof handler !== 'function') {
    return { cls: 'unhandled', post: state, reason: `action '${action}' is not in the machine's action surface` };
  }
  let pre;
  try {
    // Kernel parity (kernel.mjs _dispatchInTxn): the module rejecting its own
    // projected snapshot is the "cannot happen" class — a poison, never a
    // checker crash.
    def.mod.init();
    def.mod.setState(state);
    pre = projectState(def);
  } catch (err) {
    return { cls: 'poison', post: state, reason: `module rejected snapshot: ${err && err.message}` };
  }
  try {
    handler(data);
  } catch (err) {
    if (err && err.name === 'SamSchemaError') {
      return { cls: 'rejected', post: pre, reason: err.message };
    }
    return { cls: 'poison', post: pre, reason: `action '${action}' threw: ${err && err.message}` };
  }
  const acc = def.mod.instance({});
  if (typeof acc.lastStep !== 'function') {
    return { cls: 'poison', post: pre, reason: 'module exposes no lastStep() — step classification unreadable' };
  }
  const step = acc.lastStep();
  if (!step || (step.intent !== undefined && step.intent !== null && step.intent !== action)) {
    return { cls: 'poison', post: pre, reason: `lastStep() did not classify action '${action}'` };
  }
  if (step.classification === 'rejected') {
    const after = projectState(def);
    // JSON.stringify, not stable(): the kernel's mutate-then-reject check is
    // key-order-sensitive (kernel.mjs FR-2.5) — parity over canonicalization.
    if (JSON.stringify(after) !== JSON.stringify(pre)) {
      return { cls: 'poison', post: pre, reason: `acceptor for '${action}' mutated the observable model and then rejected` };
    }
    const reason = (step.rejections && step.rejections[0] && step.rejections[0].reason) || null;
    return { cls: 'rejected', post: pre, reason, unnamed: !reason };
  }
  if (step.classification === 'unhandled') {
    return { cls: 'unhandled', post: pre, reason: `no acceptor handled '${action}'` };
  }
  // 'mutated' and 'identity-by-mutation' are both accepted (kernel parity).
  return { cls: 'accepted', post: projectState(def) };
}

// ── child abstraction (CP-M2, semantics §7) ─────────────────────────────────

export const RESOLVE_ACTION = '$resolve';

/**
 * Build the contract-derived abstraction of a child machine: an exhaustive
 * standalone BFS over the child's own declared domain that discovers every
 * reachable state and terminal outcome. The BFS IS the refinement check:
 * - truncation refuses (an unseen state could hide a terminal or a defect) —
 *   `abstractMaxStates` bounds THIS walk, deliberately separate from the
 *   joint cap (they carry opposite doctrines: joint overflow is a survivable
 *   BOUNDED verdict, child overflow is a hard refusal);
 * - any reachable delivery landing poison, unhandled, or an UNNAMED reject
 *   refuses (the doctrine is accepted-or-NAMED-reject — the same class the
 *   concrete path and the polyvers matrix flag);
 * - zero reachable terminals refuses (completions could never fire and the
 *   abstract child would run forever by construction);
 * - a determinism double-pass refuses a nondeterministic child (every other
 *   BFS in the pipeline carries one; an abstraction built from an arbitrary
 *   pass would silently vary the $resolve alphabet run to run).
 * Returns { terminals, reachableCount, covered, cancelFor(action) }:
 * `covered` is the set of stable({action,data}) deliveries the walk actually
 * exercised (the honest boundary of the refinement claim), and cancelFor
 * concretely delivers `action` (with the kernel's FR-8.4 payload) to every
 * reachable non-terminal state and summarizes it.
 */
export function buildAbstraction(def, { abstractMaxStates = 20000 } = {}) {
  const explore = () => {
    def.mod.init();
    const init = projectState(def);
    const seen = new Map([[stable(init), init]]);
    const queue = [init];
    let head = 0;
    while (head < queue.length) {
      const s = queue[head++];
      for (const { action, data } of def.steps) {
        const r = deliver(def, s, action, data);
        if (r.cls === 'poison' || r.cls === 'unhandled') {
          throw new Error(`abstraction refused for '${def.machineId}': delivering '${action}' in a reachable state is ${r.cls} (${r.reason}) — the abstraction assumes every delivery lands accepted or as a NAMED observable reject, which this child does not refine`);
        }
        if (r.cls === 'rejected' && r.unnamed) {
          throw new Error(`abstraction refused for '${def.machineId}': delivering '${action}' in a reachable state is rejected WITHOUT a reason — the refinement doctrine is accepted-or-NAMED-reject (the concrete path and the polyvers matrix flag exactly this); name the rule via contract specialRules`);
        }
        if (r.cls !== 'accepted') continue;
        const k = stable(r.post);
        if (!seen.has(k)) {
          // Cap at ENQUEUE time: completing with exactly abstractMaxStates
          // states is a full exploration (check.mjs cap semantics) — only a
          // state that would EXCEED the cap is a truncation.
          if (seen.size >= abstractMaxStates) {
            throw new Error(`abstraction refused for '${def.machineId}': the child's own state space is TRUNCATED at ${abstractMaxStates} — an unexplored state could hide a terminal outcome or a defect; raise abstractMaxStates (--abstract-max-states) or run concretely`);
          }
          seen.set(k, r.post);
          queue.push(r.post);
        }
      }
    }
    return seen;
  };
  // Determinism double-pass — refusal doctrine (synthesizeCorpus), because a
  // nondeterministic child makes the $resolve alphabet itself untrustworthy.
  const pass1 = explore();
  const pass2 = explore();
  if ([...pass1.keys()].sort().join('\n') !== [...pass2.keys()].sort().join('\n')) {
    throw new Error(`abstraction refused for '${def.machineId}': two identical explorations reached different state sets — the child is nondeterministic (Math.random / Date.now / retained mutable state); an abstraction built from either pass cannot be trusted`);
  }
  const all = [...pass1.values()];
  const terminals = all.filter((s) => def.isTerminal(s));
  const nonTerminals = all.filter((s) => !def.isTerminal(s));
  if (terminals.length === 0) {
    throw new Error(`abstraction refused for '${def.machineId}': no reachable terminal state — completions could never fire and the abstract child would run forever by construction`);
  }
  // The honest coverage boundary of the refinement claim: exactly the
  // (action, data) pairs the walk delivered. Anything outside it (creation
  // actions, mapper signals with other payloads) is NOT refinement-checked.
  const covered = new Set(def.steps.map(({ action, data }) => stable({ action, data })));

  const cancelMemo = new Map();
  const scanCancel = (action) => {
    // Concrete summary of the cancel action (with the kernel's exact FR-8.4
    // payload) over every reachable non-terminal state — this is what lets a
    // well-behaved child avoid the spurious stays-running over-approximation.
    const outcomes = new Map();
    let staysRunning = false;
    for (const s of nonTerminals) {
      const r = deliver(def, s, action, { reason: 'parent-terminal' });
      if (r.cls === 'poison') return { defect: 'poison', why: `cancel '${action}' POISONS in a reachable state (${r.reason})` };
      if (r.cls === 'unhandled') return { defect: 'unhandled', why: `cancel '${action}' is UNHANDLED in a reachable state (${r.reason})` };
      if (r.cls === 'rejected') {
        if (r.unnamed) return { defect: 'unnamed-reject', why: `cancel '${action}' is rejected WITHOUT a reason in a reachable state` };
        staysRunning = true;
        continue;
      }
      if (def.isTerminal(r.post)) outcomes.set(stable(r.post), r.post);
      else staysRunning = true;
    }
    if (!staysRunning && outcomes.size === 1) {
      return { deterministic: true, outcome: [...outcomes.values()][0] };
    }
    const shape = staysRunning
      ? `does not terminate the child from every reachable state`
      : `has ${outcomes.size} distinct terminal outcomes`;
    return {
      deterministic: false,
      why: `cancel '${action}' ${shape} — the abstract child stays running with $resolve enabled (over-approximation); expect parent-terminal-quiescence invariants to FAIL as abstract witnesses for this child — confirm with a concrete run`,
    };
  };
  const cancelFor = (action) => {
    if (!cancelMemo.has(action)) {
      // Same double-pass doctrine as the walk: the summary must reproduce.
      const s1 = scanCancel(action);
      const s2 = scanCancel(action);
      if (stable({ ...s1, outcome: s1.outcome ?? null }) !== stable({ ...s2, outcome: s2.outcome ?? null })) {
        throw new Error(`abstraction refused for '${def.machineId}': two identical cancel scans of '${action}' disagree — the child is nondeterministic`);
      }
      cancelMemo.set(action, s1);
    }
    return cancelMemo.get(action);
  };
  return { terminals, reachableCount: all.length, covered, cancelFor };
}

// ── the product step: one stimulus + its cascade closure ────────────────────

const cloneJoint = (j) => JSON.parse(JSON.stringify(j));

/**
 * Apply one stimulus { target, action, data, resolve? } to a joint state.
 * `resolve: true` marks the abstraction's $resolve move — a provenance
 * DISCRIMINANT, never inferred from the action name, so a mapper signal (or
 * a real machine action) named '$resolve' can neither forge a terminal nor
 * be shadowed. Returns { joint, cascade, defect, findings } — `cascade` is
 * the journal of the closure, `defect` a poison-class finding when
 * production would halt, `findings` the non-poison doctrine findings
 * ({ kind, message }) of this closure.
 */
export function productStep(joint, stim, ctx) {
  const { parentDef, machineDefs, mapper, declaredKinds } = ctx;
  const next = cloneJoint(joint);
  const cascade = [];
  const findings = [];
  const doctrine = (kind, message) => findings.push({ kind, message });

  // flags: viaCascade — kernel-synthesized delivery; isResolve — the
  // abstraction's top-level nondeterministic move (only alphabetFor mints
  // it); isCancel — the FR-8.4 parent-terminal cancel THIS closure issued
  // (only that dispatch may consume cancelFor's fixed-payload summary).
  const dispatch = (tgt, act, dat, depth, flags = {}) => {
    const { viaCascade = false, isResolve = false, isCancel = false } = flags;
    if (depth > MAX_CASCADE_DEPTH) {
      throw new PoisonDefect(tgt, `dispatch cascade exceeded depth ${MAX_CASCADE_DEPTH} (parent/child wiring cycle?)`);
    }
    const isParent = tgt === 'parent';
    const inst = isParent ? next.parent : next.children[tgt];
    if (!inst) throw new PoisonDefect('parent', `signalChild: no child with key '${tgt}'`);
    const def = isParent ? parentDef : machineDefs.get(inst.machineId);
    if (inst.status !== 'active') {
      // FR-1.2: terminal instances reject observably, never error.
      cascade.push({ target: tgt, action: act, data: dat, stepKind: 'rejected', reason: inst.status });
      return;
    }
    // ---- abstract child (CP-M2, semantics §7): {running} ∪ terminals ----
    if (!isParent && inst.abstract) {
      const abs = def.abstraction;
      const resolveTo = (terminalState) => {
        // Clone at install: terminalState aliases abstraction.terminals /
        // the cancel memo — a mutating invariant predicate must corrupt one
        // joint state at most, never the abstraction itself.
        const fresh = JSON.parse(JSON.stringify(terminalState));
        inst.state = fresh;
        inst.status = 'terminal';
        if (inst.onComplete) dispatch('parent', inst.onComplete, { childKey: tgt, childState: fresh }, depth + 1, { viaCascade: true });
      };
      if (isResolve) {
        // The abstraction's one nondeterministic move: the child resolves to
        // a reachable terminal outcome; the completion cascade runs concretely.
        cascade.push({ target: tgt, action: act, data: dat, stepKind: 'accepted' });
        resolveTo(dat);
        return;
      }
      if (isCancel) {
        const c = abs.cancelFor(act);
        if (c.defect) {
          // Kernel parity with the concrete path: a cancel that poisons is a
          // reachable-poison finding, an unhandled/unnamed one is the same
          // doctrine finding the concrete closure would raise — never a
          // silent over-approximation.
          if (c.defect === 'poison') throw new PoisonDefect(tgt, c.why);
          doctrine(c.defect === 'unhandled' ? 'unhandled-delivery' : 'unnamed-reject', `${c.why} (abstracted child '${tgt}')`);
          cascade.push({ target: tgt, action: act, data: dat, stepKind: 'abstract-noop', reason: c.why });
          return;
        }
        if (c.deterministic) {
          cascade.push({ target: tgt, action: act, data: dat, stepKind: 'accepted' });
          resolveTo(c.outcome);
        } else {
          // Over-approximation: the child stays running and $resolve remains
          // enabled — every concrete outcome is covered by a later resolve.
          cascade.push({ target: tgt, action: act, data: dat, stepKind: 'abstract-noop', reason: c.why });
        }
        return;
      }
      // Creation actions / mapper signals into an abstracted child. The
      // refinement walk only exercised the child's declared domain — a
      // delivery outside `covered` was NEVER checked, so claiming it lands
      // clean would be a lie; surface it instead of swallowing it.
      if (!abs.covered.has(stable({ action: act, data: dat }))) {
        doctrine('abstract-unchecked-delivery', `'${act}(${JSON.stringify(dat)})' delivered to abstracted child '${tgt}' was NOT exercised by the refinement walk (outside the child's declared domain) — its outcome is unverified; run concretely or add it to the child's domain`);
      }
      cascade.push({ target: tgt, action: act, data: dat, stepKind: 'abstract-noop', reason: 'delivery to an abstracted child — trajectories covered by the $resolve over-approximation' });
      return;
    }
    const res = deliver(def, inst.state, act, dat);
    if (res.cls === 'poison') throw new PoisonDefect(tgt, res.reason);
    if (res.cls === 'unhandled' && viaCascade) {
      // A cascade-delivered action landing unhandled is the undefined-behavior
      // class the matrix gate exists for — surface it even mid-product-check.
      doctrine('unhandled-delivery', `cascade-delivered '${act}' on '${tgt}' is UNHANDLED — neither accepted nor an observable reject`);
    }
    if (res.cls === 'rejected' && res.unnamed) {
      doctrine('unnamed-reject', `'${act}' on '${tgt}' is rejected WITHOUT a reason — the journal entry would be unexplained (name the rule via contract specialRules)`);
    }
    cascade.push({ target: tgt, action: act, data: dat, stepKind: res.cls === 'accepted' ? 'accepted' : res.cls, ...(res.reason ? { reason: res.reason } : {}) });
    if (res.cls !== 'accepted') return;

    const preState = inst.state;
    inst.state = res.post;
    const terminal = def.isTerminal(res.post);
    if (terminal) inst.status = 'terminal';

    // ---- kernel FR-8 cascade, in dispatch order ----
    if (isParent && mapper) {
      // The kernel runs the mapper on EVERY accepted step against the step's
      // (pre, action, data, post). A mapper throw aborts the dispatch
      // transaction in production — here it is a reachable-defect finding.
      let intents;
      try {
        intents = mapper(preState, act, dat, res.post, 'accepted') || [];
      } catch (err) {
        throw new PoisonDefect(tgt, `the effect mapper threw on '${act}': ${err && err.message} — in production this dispatch fails and rolls back`);
      }
      const spawns = [];
      const signals = [];
      const timerKeys = new Set();
      const childKeys = new Set();
      const signalKeys = new Set();
      for (const intent of intents) {
        if (intent.kind === 'spawnChild') {
          if (!machineDefs.has(intent.machineId)) throw new PoisonDefect(tgt, `spawnChild: machine '${intent.machineId}' is not registered`);
          if (typeof intent.childKey !== 'string' || !intent.childKey) throw new PoisonDefect(tgt, 'spawnChild: childKey is required');
          const childDef = machineDefs.get(intent.machineId);
          if (intent.onComplete && typeof parentDef.mod.actions[intent.onComplete] !== 'function') {
            throw new PoisonDefect(tgt, `spawnChild: onComplete action '${intent.onComplete}' is not in the parent's action surface`);
          }
          if (intent.creation && typeof childDef.mod.actions[intent.creation.action] !== 'function') {
            throw new PoisonDefect(tgt, `spawnChild: creation action '${intent.creation.action}' is not in machine '${intent.machineId}'`);
          }
          if (intent.onParentTerminal && typeof childDef.mod.actions[intent.onParentTerminal] !== 'function') {
            throw new PoisonDefect(tgt, `spawnChild: onParentTerminal action '${intent.onParentTerminal}' is not in machine '${intent.machineId}'`);
          }
          if (childKeys.has(intent.childKey)) {
            throw new PoisonDefect(tgt, `effect mapper emitted duplicate spawnChild key '${intent.childKey}' in one step`);
          }
          childKeys.add(intent.childKey);
          spawns.push(intent);
        } else if (intent.kind === 'signalChild') {
          if (typeof intent.childKey !== 'string' || !intent.childKey) throw new PoisonDefect(tgt, 'signalChild: childKey is required');
          if (typeof intent.action !== 'string' || !intent.action) throw new PoisonDefect(tgt, 'signalChild: action is required');
          const sig = `${intent.childKey}\u0000${intent.action}`;
          if (signalKeys.has(sig)) throw new PoisonDefect(tgt, `effect mapper emitted duplicate signalChild '${intent.action}' for key '${intent.childKey}' in one step`);
          signalKeys.add(sig);
          signals.push(intent);
        } else if (intent.kind === 'timer') {
          if (typeof intent.key !== 'string' || !intent.key) throw new PoisonDefect(tgt, 'effect mapper emitted a timer without a key');
          if (timerKeys.has(intent.key)) throw new PoisonDefect(tgt, `effect mapper emitted duplicate timer key '${intent.key}' in one step`);
          timerKeys.add(intent.key);
          try { resolveFireAt(intent, 0); } catch (err) { throw new PoisonDefect(tgt, `effect mapper: ${err.message}`); }
          // not executed: the action a timer eventually delivers is already in
          // the stimulus superset (semantics §3/§4)
        } else if (intent.kind === 'cancelTimer') {
          // Kernel parity: the kernel does NOT validate cancelTimer (a bad
          // key simply cancels nothing) — claiming a poison here would report
          // a halt production never performs. check-effects covers the
          // mapper-hygiene side of a keyless cancelTimer.
        } else if (declaredKinds.has(intent.kind)) {
          // outbox effect: acts on the outside world — validated, not executed
        } else {
          throw new PoisonDefect(tgt, `effect mapper emitted undeclared kind '${intent.kind}'`);
        }
      }
      for (const spawn of spawns) {
        if (next.children[spawn.childKey]) {
          // The kernel keys instances by sha(parent, childKey, seq): a
          // re-spawned key means a SECOND instance behind the same key and
          // ambiguous findChild/completion routing — a finding, not a
          // modelable behavior (semantics §2).
          doctrine('childkey-collision', `spawnChild re-uses key '${spawn.childKey}' while a child with that key exists — the kernel would create a second instance behind the same key, making signal/completion routing ambiguous`);
          continue;
        }
        const childDef = machineDefs.get(spawn.machineId);
        if (childDef.abstraction) {
          next.children[spawn.childKey] = {
            machineId: spawn.machineId,
            abstract: true,
            state: { $running: true },
            status: 'active',
            onComplete: spawn.onComplete ?? null,
            onParentTerminal: spawn.onParentTerminal ?? null,
          };
        } else {
          childDef.mod.init();
          const childInit = projectState(childDef);
          next.children[spawn.childKey] = {
            machineId: spawn.machineId,
            state: childInit,
            status: childDef.isTerminal(childInit) ? 'terminal' : 'active',
            onComplete: spawn.onComplete ?? null,
            onParentTerminal: spawn.onParentTerminal ?? null,
          };
        }
        if (spawn.creation) dispatch(spawn.childKey, spawn.creation.action, spawn.creation.data ?? {}, depth + 1, { viaCascade: true });
      }
      for (const signal of signals) {
        dispatch(signal.childKey, signal.action, signal.data ?? {}, depth + 1, { viaCascade: true });
      }
    }
    // FR-8.2: a child reaching terminal notifies its parent in the same
    // closure — even a terminal parent, which status-rejects it (production
    // journals exactly that).
    if (terminal && !isParent && inst.onComplete) {
      dispatch('parent', inst.onComplete, { childKey: tgt, childState: res.post }, depth + 1, { viaCascade: true });
    }
    // FR-8.4: a terminal parent cancels each active child, in spawn order; a
    // child that rejects the cancel stays active — journaled, never forced.
    // isCancel marks the one delivery cancelFor's fixed-payload summary is
    // valid for — a mapper signal reusing the same action NAME does not get it.
    if (terminal && isParent) {
      for (const [key, child] of Object.entries(next.children)) {
        if (child.status !== 'active' || !child.onParentTerminal) continue;
        dispatch(key, child.onParentTerminal, { reason: 'parent-terminal' }, depth + 1, { viaCascade: true, isCancel: true });
      }
    }
  };

  try {
    dispatch(stim.target, stim.action, stim.data, 0, { isResolve: stim.resolve === true });
  } catch (err) {
    if (err instanceof PoisonDefect) {
      return { joint: next, cascade, defect: { target: err.target, message: err.message }, findings };
    }
    throw err;
  }
  return { joint: next, cascade, defect: null, findings };
}

// ── explore ────────────────────────────────────────────────────────────────

/** Shared loader for the exhaustive checker and the PCT sampler: machine
 *  defs, mapper, invariants, abstraction construction, disclosure notes. */
async function loadProduct(opts) {
  const parentDef = loadMachineDef(opts.parent);
  const machineDefs = new Map();
  const abstractIds = new Set(opts.abstractChildren ?? []);
  for (const c of opts.children ?? []) {
    if (c.mapper) {
      // Only the parent's mapper is modeled (semantics §6): a child with its
      // own effects mapper runs cascades (spawns, signals, mapper poisons) in
      // production that this model never explores — a clean verdict over that
      // fleet would be unsound, so refuse loudly (BOUNDED/empty-invariants
      // doctrine).
      throw new Error(`child machine '${c.machineId}' has its own effects mapper — child-side cascades are not modeled by check-product v1 (docs/composition-semantics.md §6), so a verdict over this fleet would be unsound; refusing rather than certifying a product the model does not cover`);
    }
    machineDefs.set(c.machineId, loadMachineDef(c));
  }
  for (const id of abstractIds) {
    const def = machineDefs.get(id);
    if (!def) throw new Error(`abstractChildren names '${id}', which is not among the given child machines`);
    // Deliberately NOT opts.maxStates: the joint cap and the child refinement
    // cap carry opposite doctrines (BOUNDED verdict vs hard refusal) — one
    // knob for both let a lowered joint cap spuriously refuse an abstraction
    // nowhere near its own limit.
    def.abstraction = buildAbstraction(def, { abstractMaxStates: opts.abstractMaxStates ?? 20000 });
  }

  const mapperMod = loadSpec(resolve(opts.parent.mapper));
  if (typeof mapperMod.effects !== 'function') throw new Error('the parent effect mapper does not export effects()');
  const mapper = mapperMod.effects;
  const manifest = opts.parent.manifest
    ? JSON.parse(readFileSync(resolve(opts.parent.manifest), 'utf-8'))
    : { effects: {} };
  const declaredKinds = new Set(Object.keys(manifest.effects ?? {}));

  let invariants = opts.invariants ?? {};
  if (typeof invariants === 'string') {
    const invMod = await import(pathToFileURL(resolve(invariants)).href);
    invariants = invMod.default ?? invMod;
  }
  const stateInv = invariants.stateInvariants ?? [];
  const transInv = invariants.transitionInvariants ?? [];
  if (stateInv.length + transInv.length === 0) {
    throw new Error('no cross-machine invariants (stateInvariants/transitionInvariants) — a product check with nothing to check would pass vacuously; refusing');
  }

  const notes = [
    ...parentDef.notes.map((n) => `parent: ${n}`),
    ...[...machineDefs.values()].flatMap((d) => d.notes.map((n) => `${d.machineId}: ${n}`)),
  ];
  if ((opts.children ?? []).length === 0) {
    notes.push('no child machines given — spawnChild would be an unregistered-machine finding; this is a single-machine run in product clothing');
  }
  for (const id of abstractIds) {
    const a = machineDefs.get(id).abstraction;
    notes.push(`child '${id}' is ABSTRACTED: ${a.reachableCount} concrete state(s) collapse to running + ${a.terminals.length} terminal outcome(s); its non-terminal concrete states never appear in the joint space, so invariants that read them are NOT checked against this child — a PASS is sound for status/terminal-reading invariants, a FAIL is an abstract witness needing a concrete confirming run`);
  }

  const initJoint = () => {
    parentDef.mod.init();
    const s = projectState(parentDef);
    return {
      parent: { machineId: opts.parent.machineId, state: s, status: parentDef.isTerminal(s) ? 'terminal' : 'active' },
      children: {},
    };
  };

  return { parentDef, machineDefs, mapper, declaredKinds, stateInv, transInv, notes, abstractIds, initJoint };
}

/** One violation recorder per engine run: dedup by (kind, invariant), path
 *  built LAZILY — pathFn only runs when the finding is actually kept (most
 *  candidate paths are dedup-discarded). */
const makeRecorder = (violations) => {
  const seen = new Set();
  return (name, kind, pathFn, detail) => {
    const k = `${kind}:${name}`;
    if (seen.has(k)) return;
    seen.add(k);
    violations.push({ invariant: name, kind, path: pathFn(), detail });
  };
};

/** The stimulus alphabet at a joint state (semantics §3): parent domain minus
 *  ACTIVE children's cascade-owned completion actions, plus each active
 *  child's own domain ($resolve moves — stimulus.resolve: true — for
 *  abstracted children). The alphabet depends only on the joint's
 *  COMPOSITION (parent status + each child's wiring/status), not its state
 *  values, so results are memoized by that signature; callers share the
 *  returned array and must not mutate it. `excluded` collects the
 *  cascade-owned exclusions for disclosure. */
function alphabetFor(joint, parentDef, machineDefs, { memo, excluded } = {}) {
  const signature = memo && stable({
    p: joint.parent.status,
    c: Object.entries(joint.children).map(([k, c]) => [k, c.machineId, c.status, c.abstract ?? false, c.onComplete, c.onParentTerminal]),
  });
  const cached = memo && memo.get(signature);
  if (cached) {
    if (excluded) for (const a of cached.completionActions) excluded.add(a);
    return cached.stimuli;
  }
  const completionActions = new Set(
    Object.values(joint.children).filter((c) => c.status === 'active').map((c) => c.onComplete).filter(Boolean));
  if (excluded) for (const a of completionActions) excluded.add(a);
  const stimuli = [];
  if (joint.parent.status === 'active') {
    for (const { action, data } of parentDef.steps) {
      if (completionActions.has(action)) continue;
      stimuli.push({ target: 'parent', action, data });
    }
  }
  for (const [key, child] of Object.entries(joint.children)) {
    if (child.status !== 'active') continue;
    const def = machineDefs.get(child.machineId);
    if (child.abstract) {
      // resolve: true is the provenance discriminant — only minted here,
      // never inferred from the action name (productStep).
      for (const t of def.abstraction.terminals) stimuli.push({ target: key, action: RESOLVE_ACTION, data: t, resolve: true });
    } else {
      for (const { action, data } of def.steps) stimuli.push({ target: key, action, data });
    }
  }
  if (memo) memo.set(signature, { stimuli, completionActions });
  return stimuli;
}

/**
 * checkProduct({ parent, children, invariants, maxStates, abstractChildren,
 *                abstractMaxStates })
 *   parent:   { machineId, module, contract, mapper, manifest? } (paths)
 *   children: [{ machineId, module, contract, mapper? }] — a child with its
 *             own mapper is REFUSED (child-side cascades are v1 out of scope;
 *             certifying a product the model does not cover would be unsound)
 *   invariants: path to an invariants.compose.mjs (or the loaded object)
 *   abstractChildren: machineIds to abstract (semantics §7)
 * Returns { ok, statesExplored, capHit, violations, notes, engine,
 *           nondeterministic, excludedActions, abstracted }.
 */
export async function checkProduct(opts) {
  const { parentDef, machineDefs, mapper, declaredKinds, stateInv, transInv, notes, abstractIds, initJoint } = await loadProduct(opts);
  const maxStates = opts.maxStates ?? 20000;
  const ctx = { parentDef, machineDefs, mapper, declaredKinds };
  const alphaMemo = new Map(); // composition-signature → alphabet (shared by both passes)

  const explore = () => {
    const violations = [];
    const record = makeRecorder(violations);

    const init = initJoint();
    const initKey = stable(init);
    const parent = new Map([[initKey, { prev: null, stimulus: null, cascade: [], joint: init }]]);
    const queue = [[init, initKey]];
    const excluded = new Set(); // completion actions seen wired on live children — disclosed

    const pathTo = (key) => {
      const chain = [];
      let k = key;
      while (k !== null && parent.has(k)) {
        const n = parent.get(k);
        chain.push({ stimulus: n.stimulus, cascade: n.cascade, joint: n.joint });
        k = n.prev;
      }
      return chain.reverse();
    };

    for (const inv of stateInv) {
      let ok; try { ok = inv.pred(init); } catch { ok = false; }
      if (!ok) record(inv.name, 'state', () => pathTo(initKey), 'violated in the initial joint state');
    }

    let capHit = false;
    let head = 0;
    while (head < queue.length && parent.size < maxStates) {
      const [joint, jointKey] = queue[head++];
      const stimuli = alphabetFor(joint, parentDef, machineDefs, { memo: alphaMemo, excluded });

      for (const stim of stimuli) {
        const { joint: post, cascade, defect, findings } = productStep(joint, stim, ctx);
        const stepPath = () => [...pathTo(jointKey), { stimulus: stim, cascade, joint: post }];
        for (const d of findings) {
          record(`${d.kind}:${stim.target}:${stim.action}`, 'doctrine', stepPath, d.message);
        }
        if (defect) {
          record(`reachable-poison:${defect.target}:${stim.action}`, 'poison', stepPath,
            `production would POISON instance '${defect.target}' here: ${defect.message}`);
          continue; // production halts; the branch has no successor
        }
        if (transInv.length) {
          const stimulusForInv = { ...stim, cascade };
          for (const inv of transInv) {
            let ok; try { ok = inv.pred(joint, stimulusForInv, post); } catch { ok = false; }
            if (!ok) record(inv.name, 'transition', stepPath, `violated by [${stim.target}] ${stim.action} from this joint state`);
          }
        }
        const postKey = stable(post);
        if (!parent.has(postKey)) {
          for (const inv of stateInv) {
            let ok; try { ok = inv.pred(post); } catch { ok = false; }
            if (!ok) record(inv.name, 'state', stepPath, 'reachable joint state violates the rule');
          }
          parent.set(postKey, { prev: jointKey, stimulus: stim, cascade, joint: post });
          queue.push([post, postKey]);
        }
      }
    }
    if (head < queue.length) capHit = true;
    return { parent, violations, capHit, excluded };
  };

  // Determinism double-pass — same doctrine as scripts/check.mjs.
  const digestOf = (r) => stable({
    states: [...r.parent.keys()].sort(),
    violations: r.violations.map((v) => ({ invariant: v.invariant, kind: v.kind, detail: v.detail })),
    capHit: r.capHit,
  });
  const pass1 = explore();
  const pass2 = explore();
  const nondeterministic = digestOf(pass1) !== digestOf(pass2);
  const { parent, violations, capHit, excluded } = pass1;
  if (nondeterministic) {
    violations.push({
      invariant: 'deterministic-exploration',
      kind: 'nondeterminism',
      path: [],
      detail: 'two identical explorations produced different joint-state graphs or findings — a machine or the mapper is nondeterministic (Math.random / Date.now / retained mutable state); the product verdict cannot be trusted',
    });
  }
  for (const a of excluded) {
    notes.push(`parent action '${a}' is cascade-owned (wired as a live child's onComplete) — delivered by the cascade at child-terminal, EXCLUDED from the external alphabet (kernel dedupes redelivery via the derived actionId)`);
  }
  return {
    ok: violations.length === 0 && !capHit,
    statesExplored: parent.size,
    capHit,
    violations,
    notes,
    engine: 'product-v1',
    nondeterministic,
    // Machine-readable form of the alphabet-boundary disclosure above, for
    // --json consumers (the note strings are for humans).
    excludedActions: [...excluded].sort(),
    abstracted: [...abstractIds].sort(),
  };
}

// ── PCT sampling (CP-M2, semantics §8) ─────────────────────────────────────

/** Deterministic PRNG (mulberry32) — seeded, no Math.random/Date.now. */
const mulberry32 = (a) => () => {
  a |= 0; a = (a + 0x6D2B79F5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/**
 * pctSample({ parent, children, invariants, abstractChildren?, schedules,
 *             pctDepth, pctSteps, seed }) — seeded random priority schedules
 * over the stimulus space (the PCT discipline: each target stream gets a
 * random priority; the highest-priority enabled stream fires; d-1 random
 * points demote a stream). The depth discipline orders INTER-target
 * stimuli; two actions of the same target share a stream and interleave
 * uniform-randomly (semantics §8 scopes the guarantee accordingly). A
 * sampler FALSIFIES — it never proves; `ok` is ALWAYS false (BOUNDED
 * doctrine — a sampled run is never a pass; distinguish outcomes via
 * `violations`), and the CLI requires --allow-sampled to accept a clean one.
 * Returns { sampled: true, ok: false, schedules, pctDepth, pctSteps, seed,
 *           statesTouched, violations, notes, excludedActions, abstracted }.
 */
export async function pctSample(opts) {
  const { parentDef, machineDefs, mapper, declaredKinds, stateInv, transInv, notes, abstractIds, initJoint } = await loadProduct(opts);
  const schedules = opts.schedules ?? 200;
  const pctDepth = opts.pctDepth ?? 2;
  const pctSteps = opts.pctSteps ?? 50;
  const seed = opts.seed ?? 1;
  if (schedules < 1 || pctDepth < 1 || pctSteps < 1) throw new Error(`invalid PCT bounds: schedules=${schedules} depth=${pctDepth} steps=${pctSteps}`);
  if (pctDepth - 1 > pctSteps) {
    // The d-1 demotion points are distinct steps in [1..pctSteps]; more
    // demotions than steps is unsatisfiable and would spin forever.
    throw new Error(`invalid PCT bounds: pctDepth ${pctDepth} needs ${pctDepth - 1} distinct demotion steps but only ${pctSteps} step(s) exist — lower --pct-depth or raise --pct-steps`);
  }
  const rng = mulberry32(seed);
  const ctx = { parentDef, machineDefs, mapper, declaredKinds };
  const alphaMemo = new Map();
  const excluded = new Set();

  const violations = [];
  const record = makeRecorder(violations);
  const statesTouched = new Set();

  // The init joint is deterministic — check it once, not per schedule.
  const initial = initJoint();
  statesTouched.add(stable(initial));
  for (const inv of stateInv) {
    let ok; try { ok = inv.pred(initial); } catch { ok = false; }
    if (!ok) record(inv.name, 'state', () => [{ stimulus: null, cascade: [], joint: initial }], `violated in the initial joint state [seed ${seed}]`);
  }

  for (let sched = 0; sched < schedules; sched++) {
    let joint = initJoint();
    const path = [{ stimulus: null, cascade: [], joint }];
    // d-1 demotion points, chosen up front (PCT's priority-change points).
    const changeAt = new Set();
    while (changeAt.size < pctDepth - 1) changeAt.add(1 + Math.floor(rng() * pctSteps));
    const priorities = new Map();

    for (let step = 1; step <= pctSteps; step++) {
      const stimuli = alphabetFor(joint, parentDef, machineDefs, { memo: alphaMemo, excluded });
      if (stimuli.length === 0) break; // everything terminal — schedule done
      const targets = [...new Set(stimuli.map((s) => s.target))].sort();
      for (const t of targets) if (!priorities.has(t)) priorities.set(t, rng());
      if (changeAt.has(step)) {
        const ts = [...priorities.keys()].sort();
        priorities.set(ts[Math.floor(rng() * ts.length)], -step); // below all base priorities, monotonically lower
      }
      const best = targets.reduce((a, b) => (priorities.get(b) > priorities.get(a) ? b : a));
      const options = stimuli.filter((s) => s.target === best);
      const stim = options[Math.floor(rng() * options.length)];

      const { joint: post, cascade, defect, findings } = productStep(joint, stim, ctx);
      const stepPath = () => [...path, { stimulus: stim, cascade, joint: post }];
      for (const d of findings) record(`${d.kind}:${stim.target}:${stim.action}`, 'doctrine', stepPath, `${d.message} [schedule ${sched}, seed ${seed}]`);
      if (defect) {
        record(`reachable-poison:${defect.target}:${stim.action}`, 'poison', stepPath, `production would POISON instance '${defect.target}' here: ${defect.message} [schedule ${sched}, seed ${seed}]`);
        break; // production halts this instance; end the schedule
      }
      if (transInv.length) {
        const stimulusForInv = { ...stim, cascade };
        for (const inv of transInv) {
          let ok; try { ok = inv.pred(joint, stimulusForInv, post); } catch { ok = false; }
          if (!ok) record(inv.name, 'transition', stepPath, `violated by [${stim.target}] ${stim.action} from this joint state [schedule ${sched}, seed ${seed}]`);
        }
      }
      const postKey = stable(post);
      if (!statesTouched.has(postKey)) {
        statesTouched.add(postKey);
        for (const inv of stateInv) {
          let ok; try { ok = inv.pred(post); } catch { ok = false; }
          if (!ok) record(inv.name, 'state', stepPath, `reachable joint state violates the rule [schedule ${sched}, seed ${seed}]`);
        }
      }
      joint = post;
      path.push({ stimulus: stim, cascade, joint });
    }
  }

  notes.push(`PCT sampling: ${schedules} schedule(s) × ≤${pctSteps} step(s), bug depth ${pctDepth}, seed ${seed} — a SAMPLER falsifies, it never proves; re-run with the same seed to reproduce exactly`);
  for (const a of excluded) {
    notes.push(`parent action '${a}' is cascade-owned (wired as a live child's onComplete) — delivered by the cascade at child-terminal, EXCLUDED from the external alphabet (kernel dedupes redelivery via the derived actionId)`);
  }
  return {
    sampled: true,
    // BOUNDED doctrine, machine-readable: a sampled run is NEVER a pass —
    // --json consumers gating on .ok must not greenlight an unproven fleet
    // (the CLI's --allow-sampled acknowledgment governs the exit code only).
    ok: false,
    schedules, pctDepth, pctSteps, seed,
    statesTouched: statesTouched.size,
    violations,
    notes,
    engine: 'product-pct',
    excludedActions: [...excluded].sort(),
    abstracted: [...abstractIds].sort(),
  };
}

// ── render ─────────────────────────────────────────────────────────────────

const shortJoint = (j) => {
  const kids = Object.entries(j.children)
    .map(([k, c]) => `${k}:${JSON.stringify(c.state)}${c.status === 'terminal' ? '†' : ''}`)
    .join(' ');
  return `parent:${JSON.stringify(j.parent.state)}${j.parent.status === 'terminal' ? '†' : ''}${kids ? `  ${kids}` : ''}`;
};

export function renderProduct(result) {
  const L = [];
  if (result.sampled) {
    L.push(`PCT sampling: ${result.schedules} schedule(s) × ≤${result.pctSteps} step(s), depth ${result.pctDepth}, seed ${result.seed} · joint states touched: ${result.statesTouched} — SAMPLED, not exhaustive`);
  } else {
    L.push(`joint states explored: ${result.statesExplored}${result.capHit ? ' (CAP HIT — exploration bounded; a bounded run is NOT a pass)' : ''}`);
  }
  for (const n of result.notes ?? []) L.push(`note: ${n}`);
  if (result.violations.length === 0) {
    L.push(result.sampled
      ? 'no violations found by sampling — NOT a proof of absence (run the exhaustive check, or raise --pct/--pct-steps)'
      : result.capHit ? 'no findings over the BOUNDED exploration (raise --max-states)' : 'no cross-machine invariant violations reachable ✓');
    return L.join('\n');
  }
  L.push(`${result.violations.length} finding(s):`);
  for (const v of result.violations) {
    L.push(`\n  ✗ ${v.invariant} [${v.kind}] — ${v.detail}`);
    if (!v.path.length) continue;
    L.push(result.sampled ? '    witness (sampled stimulus sequence from init):' : '    counterexample (shortest stimulus sequence from init):');
    v.path.forEach((step, i) => {
      if (i === 0 && !step.stimulus) { L.push(`      init             ${shortJoint(step.joint)}`); return; }
      const s = step.stimulus;
      L.push(`      [${s.target}] ${s.action}(${JSON.stringify(s.data)}) -> ${shortJoint(step.joint)}`);
      for (const c of step.cascade.slice(1)) {
        L.push(`        ↳ [${c.target}] ${c.action} ${c.stepKind}${c.reason ? ` (${c.reason})` : ''}`);
      }
    });
  }
  return L.join('\n');
}
