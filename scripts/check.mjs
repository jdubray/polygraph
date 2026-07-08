// Explicit-state model checker for a bare-next() spec.
//
// This is the SECOND half of the method. Replay (tv.mjs) checks whether a
// derived spec CONFORMS to real traces — it finds a bug only when the spec
// DISAGREES with the code, which a faithful spec does not (see
// eval/FINDING-faithful-reproduction.md). This checker does what you actually
// write a spec FOR: it ITERATES the total pure relation next(state, action,
// data) exhaustively — every reachable state from init() over a finite
// action/data domain — and checks INVARIANTS (rules encoding intent) at each
// state and transition. A faithful spec that copied a bug will, when explored,
// REACH a state that violates an intent-invariant, with a shortest
// counterexample path. That is a bug the replay cannot see.
//
// Deterministic: no API, no randomness, no clock.
//
// Module usage:  check({ specPath, contract, invariants, windows, maxStates })
// CLI:  node check.mjs --spec <mod.js> --contract <c.json> --invariants <inv.mjs> [--traces <dir>] [--max-states N] [--json out]
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { loadWindows } from './replay.mjs';

// ── Spec loader (same CJS-in-any-package mechanism as tv.mjs) ───────────────
export function loadSpec(specPath) {
  const abs = resolve(specPath);
  const code = readFileSync(abs, 'utf-8');
  const module = { exports: {} };
  const require = createRequire(abs);
  const compiled = vm.compileFunction(code, ['module', 'exports', 'require', '__filename', '__dirname'], { filename: abs });
  compiled(module, module.exports, require, abs, dirname(abs));
  return module.exports;
}

// ── Canonical state key (stable across key order) ──────────────────────────
function stable(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
}

// ── Build the (action, data) domain from the contract + observed traces ────
// dataDomain in the contract wins; otherwise values are inferred from the trace
// corpus; an action with no data fields contributes a single {} step.
export function buildDomain(contract, windows = []) {
  const actions = Object.keys(contract.actions || {});
  const observed = {}; // action -> field -> Set(values)
  for (const w of windows) {
    const d = w.data || {};
    observed[w.action] = observed[w.action] || {};
    for (const [k, val] of Object.entries(d)) {
      (observed[w.action][k] = observed[w.action][k] || new Set()).add(JSON.stringify(val));
    }
  }
  const steps = []; // { action, data }
  const notes = [];
  for (const action of actions) {
    const fields = Object.keys(contract.actions[action].dataFields || {});
    if (fields.length === 0) { steps.push({ action, data: {} }); continue; }
    const perField = fields.map((f) => {
      const fromContract = contract.dataDomain?.[action]?.[f];
      if (Array.isArray(fromContract)) return fromContract;
      const inferred = observed[action]?.[f];
      if (inferred && inferred.size) return [...inferred].map((s) => JSON.parse(s));
      notes.push(`no domain for ${action}.${f} (no contract dataDomain, none in traces) — skipped`);
      return [];
    });
    if (perField.some((vals) => vals.length === 0)) continue; // can't enumerate this action
    // cartesian product over the fields
    let combos = [{}];
    fields.forEach((f, i) => {
      const next = [];
      for (const c of combos) for (const v of perField[i]) next.push({ ...c, [f]: v });
      combos = next;
    });
    for (const data of combos) steps.push({ action, data });
  }
  return { steps, notes };
}

/**
 * Explore the reachable state graph of a {init, next} module and check invariants.
 * invariants = { stateInvariants: [{name, pred:(state)=>bool}],
 *                transitionInvariants: [{name, pred:(pre,action,data,post)=>bool}] }
 * A predicate returns TRUE when the rule HOLDS; a FALSE (or throw) is a violation.
 */
export function check({ specModule, contract, invariants = {}, windows = [], maxStates = 100000 }) {
  const mod = specModule;
  if (!mod || typeof mod.next !== 'function' || typeof mod.init !== 'function') {
    return { ok: false, error: 'spec must export init() and next()', statesExplored: 0, capHit: false, violations: [] };
  }
  const stateInv = invariants.stateInvariants || [];
  const transInv = invariants.transitionInvariants || [];
  const { steps, notes } = buildDomain(contract, windows);

  const clone = (o) => JSON.parse(JSON.stringify(o));
  const init = mod.init();
  const initKey = stable(init);
  const parent = new Map([[initKey, { prev: null, action: null, data: null, state: init }]]);
  const queue = [init];
  const violations = [];
  const seen = new Set(); // invariant names already recorded (keep shortest = first via BFS)
  let capHit = false;

  const pathTo = (key) => {
    const chain = [];
    let k = key;
    while (k !== null && parent.has(k)) { const n = parent.get(k); chain.push({ action: n.action, data: n.data, state: n.state }); k = n.prev; }
    return chain.reverse();
  };
  const record = (name, kind, path, detail) => { if (seen.has(name)) return; seen.add(name); violations.push({ invariant: name, kind, path, detail }); };

  // invariants on the initial state
  for (const inv of stateInv) {
    let ok; try { ok = inv.pred(init); } catch { ok = false; }
    if (!ok) record(inv.name, 'state', pathTo(initKey), 'violated in the initial state');
  }

  while (queue.length && parent.size < maxStates) {
    const s = queue.shift();
    const sKey = stable(s);
    for (const { action, data } of steps) {
      let post;
      try { post = mod.next(clone(s), action, data); }
      catch (e) {
        record(`next() threw on ${action}`, 'throw', [...pathTo(sKey), { action, data, state: `THREW: ${e && e.message}` }], String(e && e.message || e));
        continue;
      }
      // transition invariants
      for (const inv of transInv) {
        let ok; try { ok = inv.pred(s, action, data, post); } catch { ok = false; }
        if (!ok) record(inv.name, 'transition', [...pathTo(sKey), { action, data, state: post }], `violated by ${action} from this state`);
      }
      const pKey = stable(post);
      if (!parent.has(pKey)) {
        for (const inv of stateInv) {
          let ok; try { ok = inv.pred(post); } catch { ok = false; }
          if (!ok) record(inv.name, 'state', [...pathTo(sKey), { action, data, state: post }], `reachable state violates the rule`);
        }
        parent.set(pKey, { prev: sKey, action, data, state: post });
        queue.push(post);
      }
    }
  }
  if (parent.size >= maxStates) capHit = true;
  return { ok: violations.length === 0, statesExplored: parent.size, capHit, violations, domainNotes: notes };
}

// ── Readable render ─────────────────────────────────────────────────────────
export function render(result) {
  const L = [];
  L.push(`states explored: ${result.statesExplored}${result.capHit ? ' (CAP HIT — exploration bounded)' : ''}`);
  if (result.error) { L.push(`ERROR: ${result.error}`); return L.join('\n'); }
  if (result.ok) { L.push('no invariant violations reachable ✓'); return L.join('\n'); }
  L.push(`${result.violations.length} invariant violation(s):`);
  for (const v of result.violations) {
    L.push(`\n  ✗ ${v.invariant} [${v.kind}] — ${v.detail}`);
    L.push('    counterexample (shortest path from init):');
    v.path.forEach((step, i) => {
      const st = typeof step.state === 'string' ? step.state : JSON.stringify(step.state);
      if (i === 0 && step.action === null) L.push(`      init            ${st}`);
      else L.push(`      ${step.action}(${JSON.stringify(step.data)}) -> ${st}`);
    });
  }
  return L.join('\n');
}

// ── CLI ─────────────────────────────────────────────────────────────────────
async function loadInvariants(path) {
  if (!path) return {};
  const mod = await import(pathToFileURL(resolve(path)).href);
  return mod.default || mod;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) if (process.argv[i].startsWith('--')) { args[process.argv[i].slice(2)] = process.argv[i + 1]; i++; }
  if (!args.spec || !args.contract) { console.error('usage: node check.mjs --spec <mod.js> --contract <c.json> [--invariants <inv.mjs>] [--traces <dir>] [--max-states N] [--json out]'); process.exit(2); }
  const contract = JSON.parse(readFileSync(args.contract, 'utf-8'));
  const invariants = await loadInvariants(args.invariants);
  const windows = args.traces ? loadWindows(args.traces) : [];
  const specModule = loadSpec(args.spec);
  const result = check({ specModule, contract, invariants, windows, maxStates: Number(args['max-states'] || 100000) });
  console.log(render(result));
  if (args.json) { const { writeFileSync } = await import('node:fs'); writeFileSync(args.json, JSON.stringify(result, null, 2)); }
  process.exit(result.ok ? 0 : 1);
}
