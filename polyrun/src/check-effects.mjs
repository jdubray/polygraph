// polyrun effect-emission checker (M2, spec §6.2) — explores the machine ∘
// effect-mapper COMPOSITION and evaluates invariants over per-path effect
// emissions: not just "state never says charged twice" but "the chargeCard
// intent itself is never emitted twice on any reachable path".
//
// Reuses the pipeline's own semantics: makeSamAdapter (the {init,next} lean
// contract over a v2 module — rejections are observable no-ops) and
// domainFromManifest (what the module DECLARES is what gets explored).
//
// Exploration: depth-bounded enumeration of paths from the initial state.
// Per-step effect derivation mirrors the kernel: the mapper runs on accepted
// steps; steps where post === pre (rejected or identity) emit nothing, which
// matches edge-triggered mappers by construction. Bounds are reported, never
// silent: hitting maxDepth or maxPaths marks the run `bounded: true` with
// counts, so "0 violations" can never quietly mean "explored almost nothing".
'use strict';

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { loadSpec, stable } from '../../scripts/load-spec.mjs';

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
  /** True if `action` occurs in the path before emission index `i`. */
  actionBefore(actionName, i) {
    const step = this.emitted[i] ? this.emitted[i].step : this.actions.length + 1;
    return this.actions.slice(0, step - 1).some((a) => a.action === actionName);
  }
}

/**
 * Explore and check. Options:
 *   module, mapper, manifest (paths); isTerminal(state) or contract with
 *   terminalKey/terminalStates; invariants: path to a module exporting
 *   `effectInvariants: [{name, pred(path) -> boolean}]`;
 *   maxDepth (default 12), maxPaths (default 50_000).
 * Returns { violations, pathsExplored, statesSeen, bounded, notes }.
 */
export async function checkEffects(opts) {
  const mod = loadSpec(resolve(opts.module));
  const adapter = makeSamAdapter(mod);
  const domain = domainFromManifest(mod);
  const mapperMod = loadSpec(resolve(opts.mapper));
  if (typeof mapperMod.effects !== 'function') throw new Error('effect mapper does not export effects()');
  const mapper = mapperMod.effects;

  const invMod = await import(pathToFileURL(resolve(opts.invariants)).href);
  const invariants = invMod.effectInvariants ?? [];
  if (!Array.isArray(invariants) || invariants.length === 0) {
    throw new Error(`no effectInvariants exported by ${opts.invariants}`);
  }

  let isTerminal = opts.isTerminal;
  if (!isTerminal && opts.contract) {
    const contract = typeof opts.contract === 'string'
      ? JSON.parse((await import('node:fs')).readFileSync(resolve(opts.contract), 'utf-8'))
      : opts.contract;
    const key = contract.terminalKey ?? (contract.stateKeys && contract.stateKeys[0] && contract.stateKeys[0].name);
    const values = new Set(contract.terminalStates ?? []);
    isTerminal = (s) => values.has(s[key]);
  }
  if (!isTerminal) isTerminal = () => false;

  const maxDepth = opts.maxDepth ?? 12;
  const maxPaths = opts.maxPaths ?? 50_000;

  const initState = adapter.init();
  const violations = [];
  const statesSeen = new Set([stable(initState)]);
  let pathsExplored = 0;
  let bounded = false;
  const notes = [...domain.notes];

  const checkPath = (path) => {
    pathsExplored += 1;
    for (const inv of invariants) {
      let ok = false;
      try { ok = !!inv.pred(path); } catch (err) { notes.push(`invariant '${inv.name}' threw: ${err.message}`); }
      if (!ok && !violations.some((v) => v.invariant === inv.name)) {
        violations.push({
          invariant: inv.name,
          counterexample: path.actions.map((a) => `${a.action}(${JSON.stringify(a.data)})`),
          emitted: path.emitted,
          finalState: path.states[path.states.length - 1],
        });
      }
    }
  };

  // Iterative DFS so deep machines can't blow the JS stack.
  const stack = [{ state: initState, states: [initState], actions: [], emitted: [] }];
  while (stack.length > 0) {
    if (pathsExplored >= maxPaths) { bounded = true; break; }
    const node = stack.pop();
    if (node.actions.length >= maxDepth || isTerminal(node.state)) {
      bounded = bounded || (node.actions.length >= maxDepth && !isTerminal(node.state));
      checkPath(new Path(node.states, node.actions, node.emitted, isTerminal(node.state)));
      continue;
    }
    let extended = false;
    for (const step of domain.steps) {
      const post = adapter.next(node.state, step.action, step.data);
      const changed = stable(post) !== stable(node.state);
      if (!changed) continue; // rejected or identity: no edge, no emission
      // Loop guard: don't revisit a state already ON this path (simple paths).
      if (node.states.some((s) => stable(s) === stable(post))) continue;
      statesSeen.add(stable(post));
      const emissions = (mapper(node.state, step.action, step.data, post, 'accepted') || [])
        .filter((e) => e.kind !== 'timer' && e.kind !== 'cancelTimer')
        .map((e) => ({ kind: e.kind, payload: e.payload ?? {}, step: node.actions.length + 1 }));
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

  return { violations, pathsExplored, statesSeen: statesSeen.size, bounded, notes };
}

export function renderReport(result) {
  const lines = [];
  lines.push(`paths explored: ${result.pathsExplored} · states seen: ${result.statesSeen}${result.bounded ? ' · BOUNDED (raise --depth/--max-paths — unexplored behavior remains)' : ' · exhaustive within declared domains'}`);
  for (const n of result.notes) lines.push(`note: ${n}`);
  if (result.violations.length === 0) {
    lines.push('effect invariants: PASS');
  } else {
    for (const v of result.violations) {
      lines.push(`VIOLATION '${v.invariant}'`);
      lines.push(`  path   : ${v.counterexample.join(' → ')}`);
      lines.push(`  emitted: ${v.emitted.map((e) => `${e.kind}@${e.step}`).join(', ') || '(none)'}`);
      lines.push(`  final  : ${JSON.stringify(v.finalState)}`);
    }
  }
  return lines.join('\n');
}
