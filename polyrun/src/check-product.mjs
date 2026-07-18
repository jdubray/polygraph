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

// ── the product step: one stimulus + its cascade closure ────────────────────

const cloneJoint = (j) => JSON.parse(JSON.stringify(j));

/**
 * Apply (target, action, data) to a joint state. Returns
 * { joint, cascade, defect } — `cascade` is the journal of the closure
 * ({target, action, data, stepKind, reason?} per sub-step), `defect` a
 * poison-class finding ({target, message}) when production would halt.
 * `doctrine(kind, message)` collects non-poison findings (unnamed rejects,
 * unhandled cascade deliveries, childKey collisions).
 */
export function productStep(joint, target, action, data, ctx) {
  const { parentDef, machineDefs, mapper, declaredKinds, doctrine } = ctx;
  const next = cloneJoint(joint);
  const cascade = [];

  const dispatch = (tgt, act, dat, depth, viaCascade) => {
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
        childDef.mod.init();
        next.children[spawn.childKey] = {
          machineId: spawn.machineId,
          state: projectState(childDef),
          status: childDef.isTerminal(projectState(childDef)) ? 'terminal' : 'active',
          onComplete: spawn.onComplete ?? null,
          onParentTerminal: spawn.onParentTerminal ?? null,
        };
        if (spawn.creation) dispatch(spawn.childKey, spawn.creation.action, spawn.creation.data ?? {}, depth + 1, true);
      }
      for (const signal of signals) {
        dispatch(signal.childKey, signal.action, signal.data ?? {}, depth + 1, true);
      }
    }
    // FR-8.2: a child reaching terminal notifies its parent in the same
    // closure — even a terminal parent, which status-rejects it (production
    // journals exactly that).
    if (terminal && !isParent && inst.onComplete) {
      dispatch('parent', inst.onComplete, { childKey: tgt, childState: res.post }, depth + 1, true);
    }
    // FR-8.4: a terminal parent cancels each active child, in spawn order; a
    // child that rejects the cancel stays active — journaled, never forced.
    if (terminal && isParent) {
      for (const [key, child] of Object.entries(next.children)) {
        if (child.status !== 'active' || !child.onParentTerminal) continue;
        dispatch(key, child.onParentTerminal, { reason: 'parent-terminal' }, depth + 1, true);
      }
    }
  };

  try {
    dispatch(target, action, data, 0, false);
  } catch (err) {
    if (err instanceof PoisonDefect) {
      return { joint: next, cascade, defect: { target: err.target, message: err.message } };
    }
    throw err;
  }
  return { joint: next, cascade, defect: null };
}

// ── explore ────────────────────────────────────────────────────────────────

/**
 * checkProduct({ parent, children, invariants, maxStates })
 *   parent:   { machineId, module, contract, mapper, manifest? } (paths)
 *   children: [{ machineId, module, contract, mapper? }] — a child with its
 *             own mapper is REFUSED (child-side cascades are v1 out of scope;
 *             certifying a product the model does not cover would be unsound)
 *   invariants: path to an invariants.compose.mjs (or the loaded object)
 * Returns { ok, statesExplored, capHit, violations, notes, engine,
 *           nondeterministic, excludedActions }.
 */
export async function checkProduct(opts) {
  const parentDef = loadMachineDef(opts.parent);
  const machineDefs = new Map();
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

  const maxStates = opts.maxStates ?? 20000;
  const notes = [
    ...parentDef.notes.map((n) => `parent: ${n}`),
    ...[...machineDefs.values()].flatMap((d) => d.notes.map((n) => `${d.machineId}: ${n}`)),
  ];
  if ((opts.children ?? []).length === 0) {
    notes.push('no child machines given — spawnChild would be an unregistered-machine finding; this is a single-machine run in product clothing');
  }

  const explore = () => {
    const violations = [];
    const seen = new Set();
    const record = (name, kind, path, detail) => {
      const k = `${kind}:${name}`;
      if (seen.has(k)) return;
      seen.add(k);
      violations.push({ invariant: name, kind, path, detail });
    };

    parentDef.mod.init();
    const initJoint = {
      parent: { machineId: opts.parent.machineId, state: projectState(parentDef), status: parentDef.isTerminal(projectState(parentDef)) ? 'terminal' : 'active' },
      children: {},
    };
    const initKey = stable(initJoint);
    const parent = new Map([[initKey, { prev: null, stimulus: null, cascade: [], joint: initJoint }]]);
    const queue = [[initJoint, initKey]];
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
      let ok; try { ok = inv.pred(initJoint); } catch { ok = false; }
      if (!ok) record(inv.name, 'state', pathTo(initKey), 'violated in the initial joint state');
    }

    let capHit = false;
    let head = 0;
    while (head < queue.length && parent.size < maxStates) {
      const [joint, jointKey] = queue[head++];

      // Alphabet at this joint state (semantics §3): parent domain minus
      // cascade-owned completion actions, plus each ACTIVE child's domain.
      // ACTIVE children only (the header's "live child" boundary): a terminal
      // child's completion already fired, and the kernel's dedupe covers only
      // the derived actionId — an external redelivery with a fresh actionId
      // IS deliverable in production, so it must stay in the alphabet.
      const completionActions = new Set(
        Object.values(joint.children).filter((c) => c.status === 'active').map((c) => c.onComplete).filter(Boolean));
      for (const a of completionActions) excluded.add(a);
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
        for (const { action, data } of def.steps) stimuli.push({ target: key, action, data });
      }

      const doctrineFindings = [];
      const ctx = {
        parentDef, machineDefs, mapper, declaredKinds,
        doctrine: (kind, message) => doctrineFindings.push({ kind, message }),
      };
      for (const stim of stimuli) {
        doctrineFindings.length = 0;
        const { joint: post, cascade, defect } = productStep(joint, stim.target, stim.action, stim.data, ctx);
        const stepPath = () => [...pathTo(jointKey), { stimulus: stim, cascade, joint: post }];
        for (const d of doctrineFindings) {
          record(`${d.kind}:${stim.target}:${stim.action}`, 'doctrine', stepPath(), d.message);
        }
        if (defect) {
          record(`reachable-poison:${defect.target}:${stim.action}`, 'poison', stepPath(),
            `production would POISON instance '${defect.target}' here: ${defect.message}`);
          continue; // production halts; the branch has no successor
        }
        const stimulusForInv = { ...stim, cascade };
        for (const inv of transInv) {
          let ok; try { ok = inv.pred(joint, stimulusForInv, post); } catch { ok = false; }
          if (!ok) record(inv.name, 'transition', stepPath(), `violated by [${stim.target}] ${stim.action} from this joint state`);
        }
        const postKey = stable(post);
        if (!parent.has(postKey)) {
          for (const inv of stateInv) {
            let ok; try { ok = inv.pred(post); } catch { ok = false; }
            if (!ok) record(inv.name, 'state', stepPath(), 'reachable joint state violates the rule');
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
  L.push(`joint states explored: ${result.statesExplored}${result.capHit ? ' (CAP HIT — exploration bounded; a bounded run is NOT a pass)' : ''}`);
  for (const n of result.notes ?? []) L.push(`note: ${n}`);
  if (result.violations.length === 0) {
    L.push(result.capHit ? 'no findings over the BOUNDED exploration (raise --max-states)' : 'no cross-machine invariant violations reachable ✓');
    return L.join('\n');
  }
  L.push(`${result.violations.length} finding(s):`);
  for (const v of result.violations) {
    L.push(`\n  ✗ ${v.invariant} [${v.kind}] — ${v.detail}`);
    if (!v.path.length) continue;
    L.push('    counterexample (shortest stimulus sequence from init):');
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
