// Adapter: a Polygraph contract.json + its SAM module (next.cjs) → viz-model
// `machine` section (spec §4.3). The contract lists states but no transition
// edges — they are derived by a bounded, deterministic BFS over the module's
// declared (action, data) domain, then projected onto the abstract `state`
// field. This EXECUTES the target module (the reachability driver polyvers/
// polyrun already use); it is pure reachability, not invariant-checking.

import { createRequire, Module } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const MAX_STATES = 20000; // runaway backstop; log if hit

// Our install root (contains node_modules) — the fallback resolution base.
const OUR_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * require() a target module, resolving any bare package it needs (e.g.
 * '@cognitive-fab/sam-pattern') from our install if the module lives outside our
 * tree with no node_modules of its own. The resolver patch is SCOPED to the
 * synchronous require() call and restored in finally — no process-wide state
 * change (unlike mutating NODE_PATH + Module._initPaths()). Relative/absolute
 * requests are unaffected: the `paths` option only influences bare specifiers.
 */
function requireModule(modulePath) {
  const require = createRequire(pathToFileURL(modulePath));
  const original = Module._resolveFilename;
  Module._resolveFilename = function (request, parent, isMain, options) {
    try {
      return original.call(this, request, parent, isMain, options);
    } catch (err) {
      if (err && err.code === 'MODULE_NOT_FOUND') {
        return original.call(this, request, parent, isMain, { ...(options ?? {}), paths: [OUR_ROOT] });
      }
      throw err;
    }
  };
  try {
    return require(modulePath);
  } finally {
    Module._resolveFilename = original;
  }
}

// The abstract-state key: its NAME (the field holding the lifecycle state — not
// necessarily "state"; e.g. OMS uses "orderState") and its ordered enum VALUES.
function stateKeyInfo(contract) {
  const key = (contract.stateKeys ?? []).find(
    (k) => k.name === 'state' || /^\s*enum\s*:/i.test(k.type ?? '')
  );
  if (!key) return { name: 'state', values: [] };
  const m = /enum\s*:(.*)$/i.exec(key.type ?? '');
  // Strip surrounding quotes so declared ids match the module's runtime values
  // (some contracts quote the enum members: `enum: 'pending' | 'charging'`).
  const values = m
    ? m[1].split('|').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
    : [];
  return { name: key.name ?? 'state', values };
}

// One-shot effect flags: boolean stateKeys whose false→true flip marks an effect
// emission (transmit/execute/…). Field names come from the contract, not baked in.
function effectFlags(contract) {
  return (contract.stateKeys ?? [])
    .filter((k) => /^\s*boolean\b/i.test(k.type ?? ''))
    .map((k) => k.name);
}

// Cartesian product of an action's declared data-field domains (as the checker
// builds it from contract.dataDomain).
function stepsForAction(contract, action) {
  const dom = contract.dataDomain?.[action] ?? {};
  const fields = Object.keys(dom);
  if (!fields.length) return [{ action, data: {} }];
  let combos = [{}];
  for (const f of fields) {
    const next = [];
    for (const c of combos) for (const v of dom[f]) next.push({ ...c, [f]: v });
    combos = next;
  }
  return combos.map((data) => ({ action, data }));
}

const sanitize = (o) => JSON.parse(JSON.stringify(o, (k, v) => {
  if (typeof k === 'string' && k.startsWith('__')) return undefined;
  if (typeof v === 'function') return undefined;
  return v;
}));

// Build a next(state, action, data) driver for the loaded module. Supports a SAM
// v2 module ({ init, setState, actions, getState }) and a bare next() export.
function makeDriver(mod) {
  if (mod && typeof mod.setState === 'function' && mod.actions && typeof mod.getState === 'function') {
    return function next(state, action, data) {
      if (typeof mod.init === 'function') mod.init();
      mod.setState(JSON.parse(JSON.stringify(state)));
      const act = mod.actions[action];
      if (typeof act !== 'function') return state; // unknown action → no-op
      act(data);
      let rejected = false;
      try {
        const step = mod.instance?.({}).lastStep?.();
        if (step && step.classification === 'rejected') rejected = true;
      } catch { /* fall through to state comparison */ }
      const post = sanitize(mod.getState());
      return rejected ? state : post;
    };
  }
  const bare = typeof mod === 'function' ? mod : mod?.next;
  if (typeof bare === 'function') {
    return (state, action, data) => {
      const out = bare(state, action, data);
      return out == null ? state : sanitize(out); // guard undefined/null before sanitize()
    };
  }
  throw new Error('machine adapter: module is neither a SAM v2 module nor a bare next() export');
}

function initialState(mod, contract) {
  if (mod && typeof mod.init === 'function' && typeof mod.getState === 'function') {
    mod.init();
    return sanitize(mod.getState());
  }
  if (contract.initState) return sanitize(contract.initState);
  throw new Error('machine adapter: cannot determine the initial state (no init()/getState or contract.initState)');
}

/**
 * Derive the abstract state-machine graph. Returns { states, transitions }
 * ready for the viz-model `machine` section (labels/kicker/emphasis are the
 * caller's to enrich from annotations).
 */
export function deriveMachine(contract, modulePath, { log = () => {} } = {}) {
  const mod = requireModule(modulePath);
  const next = makeDriver(mod);

  const steps = Object.keys(contract.actions ?? {}).flatMap((a) => stepsForAction(contract, a));
  const terminal = new Set(contract.terminalStates ?? []);
  const { name: stateField, values: declared } = stateKeyInfo(contract);
  const effFlags = effectFlags(contract);

  // BFS over full states; collapse to abstract (from[stateField] --event--> to).
  const key = (s) => JSON.stringify(s);
  const init = initialState(mod, contract);
  const seen = new Set([key(init)]);
  const queue = [init];
  const edges = new Map(); // "from|event|to" -> { from, event, to, effects:Set }
  let capped = false;

  while (queue.length) {
    const s = queue.shift();
    for (const { action, data } of steps) {
      const p = next(s, action, data);
      const from = s[stateField];
      const to = p[stateField];
      if (from !== to) {
        const ek = `${from}|${action}|${to}`;
        const rec = edges.get(ek) ?? { from, event: action, to, effects: new Set() };
        for (const f of effFlags) if (!s[f] && p[f]) rec.effects.add(f);
        edges.set(ek, rec);
      }
      const pk = key(p);
      if (!seen.has(pk)) {
        if (seen.size >= MAX_STATES) { capped = true; continue; }
        seen.add(pk);
        queue.push(p);
      }
    }
  }
  if (capped) log(`polyviz: machine BFS hit the ${MAX_STATES}-state cap — graph may be incomplete`);
  log(`polyviz: machine reachable full-states=${seen.size}, abstract transitions=${edges.size}`);

  // States: declared order (fallback to those seen in edges), kind by terminal.
  const inEdges = new Set([...edges.values()].flatMap((e) => [e.from, e.to]));
  const stateIds = declared.length ? declared : [...inEdges];
  const states = stateIds.map((id) => ({ id, label: id, kind: terminal.has(id) ? 'terminal' : 'normal' }));

  // Deterministic transition order: by from index, then event, then to.
  const order = new Map(stateIds.map((id, i) => [id, i]));
  const transitions = [...edges.values()]
    .sort((a, b) =>
      (order.get(a.from) ?? 0) - (order.get(b.from) ?? 0) ||
      a.event.localeCompare(b.event) ||
      (order.get(a.to) ?? 0) - (order.get(b.to) ?? 0))
    .map((e) => {
      const eff = [...e.effects];
      const t = { from: e.from, event: e.event, to: e.to, guard: '', effect: eff.join(' · ') };
      t.emphasis = eff.length ? 'accent' : 'none';
      return t;
    });

  return { states, transitions };
}
