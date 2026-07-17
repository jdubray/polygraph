// polyrun effect-emission checker (M2, spec §6.2) — explores the machine ∘
// effect-mapper COMPOSITION and evaluates invariants over per-path effect
// emissions: not just "state never says charged twice" but "the chargeCard
// intent itself is never emitted twice on any reachable path".
//
// Fidelity contract with the kernel (both directions):
// - the kernel runs the mapper on EVERY accepted step, including
//   identity-accepts (post === pre). An identity-accept that emits is
//   repeatable unboundedly in production (each fresh actionId re-fires it),
//   so the checker classifies steps via lastStep() and reports any
//   identity-accept emission as a violation in its own right;
// - the kernel POISONS on mapper defects (undeclared kind, keyless/
//   malformed/duplicate timer, invalid spawn/signal shapes). The checker
//   reproduces those validations against the manifest during exploration and
//   reports them as violations — that whole poison class is statically
//   detectable here.
//
// Exploration: depth-bounded enumeration of SIMPLE paths from the initial
// state. Cycle edges (returning to a state already on the path) are pruned
// and COUNTED: when any were cut, the report says counting invariants were
// verified over simple paths only — never "exhaustive". Bounds are reported,
// never silent.
'use strict';

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { loadSpec, stable } from '../../scripts/load-spec.mjs';
import { resolveFireAt } from './duration.mjs';

const require_ = createRequire(import.meta.url);
const { makeSamAdapter, domainFromManifest } = require_('../../scripts/sam-adapter.cjs');

/** A path handed to effect invariants. */
class Path {
  constructor(states, actions, emitted, terminal) {
    this.states = states;     // [state0, state1, ...]
    this.actions = actions;   // [{action, data}, ...]
    this.emitted = emitted;   // [{kind, payload, step}] — step is 1-based
    this.terminal = terminal; // path ended in a declared terminal state
  }
  count(kind) { return this.emitted.filter((e) => e.kind === kind).length; }
  /** True if `action` occurs at or before the step that produced emission
   *  index `i` — "at or before", so an emission made BY the cancel step
   *  itself counts as after-cancel (what invariant authors mean). */
  actionBefore(actionName, i) {
    const step = this.emitted[i] ? this.emitted[i].step : this.actions.length + 1;
    return this.actions.slice(0, step).some((a) => a.action === actionName);
  }
}

/** Reproduce the kernel's mapper-output validation (kernel.mjs effect
 *  processing) — anything the kernel would POISON on is a static violation.
 *  Returns the manifest-declared emissions. */
function validateIntents(intents, manifest, violations, pathDescr) {
  const out = [];
  const timerKeys = new Set();
  const childKeys = new Set();
  const declared = manifest?.effects ?? {};
  for (const intent of intents) {
    if (intent.kind === 'timer') {
      if (typeof intent.key !== 'string' || !intent.key) {
        violations.push({ invariant: 'mapper-defect:timer-without-key', counterexample: pathDescr(), emitted: [], detail: JSON.stringify(intent) });
      } else if (timerKeys.has(intent.key)) {
        violations.push({ invariant: 'mapper-defect:duplicate-timer-key', counterexample: pathDescr(), emitted: [], detail: intent.key });
      } else {
        timerKeys.add(intent.key);
        try { resolveFireAt(intent, 0); }
        catch (err) { violations.push({ invariant: 'mapper-defect:bad-timer-duration', counterexample: pathDescr(), emitted: [], detail: err.message }); }
      }
    } else if (intent.kind === 'cancelTimer') {
      if (typeof intent.key !== 'string' || !intent.key) {
        violations.push({ invariant: 'mapper-defect:cancelTimer-without-key', counterexample: pathDescr(), emitted: [], detail: JSON.stringify(intent) });
      }
    } else if (intent.kind === 'spawnChild') {
      if (typeof intent.childKey !== 'string' || !intent.childKey || typeof intent.machineId !== 'string' || !intent.machineId) {
        violations.push({ invariant: 'mapper-defect:spawnChild-shape', counterexample: pathDescr(), emitted: [], detail: JSON.stringify(intent) });
      } else if (childKeys.has(intent.childKey)) {
        violations.push({ invariant: 'mapper-defect:duplicate-spawn-key', counterexample: pathDescr(), emitted: [], detail: intent.childKey });
      } else childKeys.add(intent.childKey);
    } else if (intent.kind === 'signalChild') {
      if (typeof intent.childKey !== 'string' || !intent.childKey || typeof intent.action !== 'string' || !intent.action) {
        violations.push({ invariant: 'mapper-defect:signalChild-shape', counterexample: pathDescr(), emitted: [], detail: JSON.stringify(intent) });
      }
    } else if (declared[intent.kind]) {
      out.push(intent);
    } else {
      violations.push({ invariant: 'mapper-defect:undeclared-kind', counterexample: pathDescr(), emitted: [], detail: String(intent.kind) });
    }
  }
  return out;
}

/**
 * Explore and check. Options: module, mapper, manifest (paths); contract or
 * isTerminal; invariants (module exporting effectInvariants); maxDepth
 * (default 12), maxPaths (default 50_000).
 * Returns { violations, violationCounts, pathsExplored, statesSeen,
 *           cyclesPruned, bounded, notes }.
 */
export async function checkEffects(opts) {
  const mod = loadSpec(resolve(opts.module));
  const adapter = makeSamAdapter(mod);
  const domain = domainFromManifest(mod);
  const mapperMod = loadSpec(resolve(opts.mapper));
  if (typeof mapperMod.effects !== 'function') throw new Error('effect mapper does not export effects()');
  const mapper = mapperMod.effects;
  const manifest = opts.manifest
    ? JSON.parse(readFileSync(resolve(opts.manifest), 'utf-8'))
    : null;
  if (!manifest) throw new Error('check-effects requires the effects manifest (kind validation is part of the check)');

  const invMod = await import(pathToFileURL(resolve(opts.invariants)).href);
  const invariants = invMod.effectInvariants ?? [];
  if (!Array.isArray(invariants) || invariants.length === 0) {
    throw new Error(`no effectInvariants exported by ${opts.invariants}`);
  }

  let isTerminal = opts.isTerminal;
  if (!isTerminal && opts.contract) {
    const contract = typeof opts.contract === 'string'
      ? JSON.parse(readFileSync(resolve(opts.contract), 'utf-8'))
      : opts.contract;
    const key = contract.terminalKey ?? (contract.stateKeys && contract.stateKeys[0] && contract.stateKeys[0].name);
    const values = new Set(contract.terminalStates ?? []);
    isTerminal = (s) => values.has(s[key]);
  }
  if (!isTerminal) isTerminal = () => false;

  const maxDepth = opts.maxDepth ?? 12;
  const maxPaths = opts.maxPaths ?? 50_000;
  if (!Number.isFinite(maxDepth) || !Number.isFinite(maxPaths) || maxDepth < 1 || maxPaths < 1) {
    throw new Error(`invalid bounds: maxDepth=${maxDepth} maxPaths=${maxPaths}`);
  }

  /** Post-step classification via lastStep(): the adapter's {init,next}
   *  contract erases the accepted/rejected distinction for post===pre, and
   *  the kernel runs the mapper on identity-ACCEPTS. */
  const classify = (action) => {
    try {
      const step = mod.instance({}).lastStep();
      if (!step || (step.intent !== undefined && step.intent !== null && step.intent !== action)) return 'unhandled';
      return step.classification; // rejected | unhandled | mutated | identity-by-mutation
    } catch { return 'unhandled'; }
  };

  const initState = adapter.init();
  const violations = [];
  const violationCounts = new Map();
  const statesSeen = new Set([stable(initState)]);
  let pathsExplored = 0;
  let cyclesPruned = 0;
  let bounded = false;
  const notes = [...domain.notes];

  const record = (v) => {
    violationCounts.set(v.invariant, (violationCounts.get(v.invariant) ?? 0) + 1);
    if (!violations.some((x) => x.invariant === v.invariant)) violations.push(v);
  };

  const checkPath = (path) => {
    pathsExplored += 1;
    for (const inv of invariants) {
      let ok = false, threw = null;
      try { ok = !!inv.pred(path); } catch (err) { threw = err.message; }
      if (threw) {
        record({ invariant: inv.name, counterexample: path.actions.map((a) => `${a.action}(${JSON.stringify(a.data)})`), emitted: path.emitted, finalState: path.states[path.states.length - 1], detail: `predicate threw: ${threw}` });
      } else if (!ok) {
        record({ invariant: inv.name, counterexample: path.actions.map((a) => `${a.action}(${JSON.stringify(a.data)})`), emitted: path.emitted, finalState: path.states[path.states.length - 1] });
      }
    }
  };

  // Iterative DFS so deep machines can't blow the JS stack.
  const stack = [{ state: initState, states: [initState], actions: [], emitted: [] }];
  while (stack.length > 0) {
    if (pathsExplored >= maxPaths) { bounded = true; break; }
    const node = stack.pop();
    const descr = () => node.actions.map((a) => `${a.action}(${JSON.stringify(a.data)})`);
    if (node.actions.length >= maxDepth || isTerminal(node.state)) {
      bounded = bounded || (node.actions.length >= maxDepth && !isTerminal(node.state));
      checkPath(new Path(node.states, node.actions, node.emitted, isTerminal(node.state)));
      continue;
    }
    let extended = false;
    for (const step of domain.steps) {
      const post = adapter.next(node.state, step.action, step.data);
      const changed = stable(post) !== stable(node.state);
      const cls = changed ? 'mutated' : classify(step.action);
      const accepted = cls === 'mutated' || cls === 'identity-by-mutation';
      if (!accepted) continue; // observable rejection: no edge, no emission — same as the kernel

      const stepDescr = () => [...descr(), `${step.action}(${JSON.stringify(step.data)})`];
      const intents = mapper(node.state, step.action, step.data, post, 'accepted') || [];
      const emissions = validateIntents(intents, manifest, violations, stepDescr)
        .map((e) => ({ kind: e.kind, payload: e.payload ?? {}, step: node.actions.length + 1 }));

      if (!changed) {
        // Identity-accept: the kernel runs the mapper here too, and a fresh
        // actionId can re-fire it forever — ANY emission is a violation by
        // construction (no bound on repetitions exists).
        if (emissions.length > 0 || intents.length > 0) {
          record({
            invariant: 'identity-accept-emits',
            counterexample: stepDescr(),
            emitted: emissions,
            finalState: post,
            detail: `action '${step.action}' is accepted without changing state yet the mapper emits — production repeats this unboundedly`,
          });
        }
        continue; // no new node: state unchanged
      }
      // Loop guard: don't revisit a state already ON this path (simple paths).
      if (node.states.some((s) => stable(s) === stable(post))) {
        cyclesPruned += 1;
        // A cycle edge that EMITS is repeatable in production — per-path
        // counting invariants cannot see it, so surface it directly.
        if (emissions.length > 0) {
          record({
            invariant: 'cycle-edge-emits',
            counterexample: stepDescr(),
            emitted: emissions,
            finalState: post,
            detail: `edge returns to an earlier state on the path while emitting — production can loop this, defeating per-path counts`,
          });
        }
        continue;
      }
      statesSeen.add(stable(post));
      stack.push({
        state: post,
        states: [...node.states, post],
        actions: [...node.actions, { action: step.action, data: step.data }],
        emitted: [...node.emitted, ...emissions],
      });
      extended = true;
    }
    if (!extended) {
      // No outgoing edges (all steps reject): the path ends here.
      checkPath(new Path(node.states, node.actions, node.emitted, isTerminal(node.state)));
    }
  }

  return {
    violations,
    violationCounts: Object.fromEntries(violationCounts),
    pathsExplored,
    statesSeen: statesSeen.size,
    cyclesPruned,
    bounded,
    notes,
  };
}

export function renderReport(result) {
  const lines = [];
  const coverage = result.bounded
    ? 'BOUNDED (raise --depth/--max-paths — unexplored behavior remains)'
    : result.cyclesPruned > 0
      ? `simple paths only (${result.cyclesPruned} cycle edge(s) pruned — counting invariants hold over simple paths; emitting cycle edges are reported separately)`
      : 'exhaustive within declared domains';
  lines.push(`paths explored: ${result.pathsExplored} · states seen: ${result.statesSeen} · ${coverage}`);
  for (const n of result.notes) lines.push(`note: ${n}`);
  if (result.violations.length === 0) {
    lines.push('effect invariants: PASS');
  } else {
    for (const v of result.violations) {
      const extra = (result.violationCounts[v.invariant] ?? 1) - 1;
      lines.push(`VIOLATION '${v.invariant}'${extra > 0 ? ` (+${extra} further violating path(s))` : ''}${v.detail ? ` — ${v.detail}` : ''}`);
      lines.push(`  path   : ${v.counterexample.join(' → ')}`);
      lines.push(`  emitted: ${v.emitted.map((e) => `${e.kind}@${e.step}`).join(', ') || '(none)'}`);
      if (v.finalState) lines.push(`  final  : ${JSON.stringify(v.finalState)}`);
    }
  }
  return lines.join('\n');
}
