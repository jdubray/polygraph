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
// Module usage:  check({ specPath, contract, invariants, windows, maxStates, initialStates })
// CLI:  node check.mjs --spec <mod.js> --contract <c.json> --invariants <inv.mjs> [--traces <dir>] [--initial-states <states.json>] [--max-states N] [--json out]
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { loadWindows } from './replay.mjs';
import { loadSpec, stable, dataFieldsOf } from './load-spec.mjs';
import samAdapter from './sam-adapter.cjs';

const { isSamV2Module, makeSamAdapter, domainFromManifest } = samAdapter;

// Re-export the shared loader (eval scripts and older callers import it from
// here). ONE loader for the whole pipeline lives in load-spec.mjs; tv.mjs
// keeps an internal copy (keep-in-sync comments in both files).
export { loadSpec };

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
      // stable(): key-order-insensitive dedup (trace data is JSON-clean, so
      // stable output parses back with JSON.parse below).
      (observed[w.action][k] = observed[w.action][k] || new Set()).add(stable(val));
    }
  }
  const steps = []; // { action, data }
  const notes = [];
  for (const action of actions) {
    // dataFieldsOf: the SAME accessor build_prompt uses, so a contract written
    // with `data:` instead of `dataFields:` gets the same fields in the
    // explored domain as in the generation prompt.
    const fields = Object.keys(dataFieldsOf(contract.actions[action]));
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
 * Explore the reachable state graph of a spec and check invariants. The spec
 * is either a legacy {init, next} module or a v2 SAM strict-profile module
 * ({instance, init, actions, getState, setState} — auto-detected, driven
 * through scripts/sam-adapter.cjs with manifest() domains; pass
 * legacyBareNext: true to force the bare-next path).
 * invariants = { stateInvariants: [{name, pred:(state)=>bool}],
 *                transitionInvariants: [{name, pred:(pre,action,data,post)=>bool}] }
 * A predicate returns TRUE when the rule HOLDS; a FALSE (or throw) is a violation.
 * Every check runs a determinism double-pass: two identical explorations whose
 * digests differ add a 'deterministic-exploration' violation (kind
 * 'nondeterminism') and set result.nondeterministic.
 */
// initialStates: additional states seeded into the BFS frontier alongside
// init() — the versioning use (docs/VERSIONING.md, polyvers): explore the
// machine's rules FROM live fleet snapshots, so "can any currently existing
// instance be driven to a violation" becomes the same exhaustive check as
// "is the machine correct from init". Seeds dedupe against init and each
// other by stable(); counterexample paths record whether they start at init
// or at a seed.
// steps: an explicit (action, data) domain override — [{action, data}] — used
// by callers that must explore two modules over the SAME alphabet (polynv's
// mutation grade drives adapter-wrapped mutants with the original module's
// manifest domain). When provided it replaces domain building entirely; the
// caller owns alphabet correctness.
// Live progress/warning writes must never crash the check: a consumer that
// closed stderr mid-run (`2>&1 | head`) raises EPIPE on write.
const stderrLine = (line) => { try { process.stderr.write(line + '\n'); } catch { /* closed pipe */ } };

// driftThreshold: minimum distinct-value count before a state key is flagged
// as likely unbounded (see the drift detector inside explore()); exposed as an
// option for tests — the default is deliberately far below the maxStates
// default so a runaway machine warns long before the cap grinds.
export function check({ specModule, contract, invariants = {}, windows = [], maxStates = 100000, legacyBareNext = false, initialStates = [], steps: providedSteps = null, driftThreshold = 1000 }) {
  // ── Engine selection ──────────────────────────────────────────────────────
  // A v2 SAM strict-profile module is driven through the {init,next} adapter
  // (rejections return the input state — a legal, observable no-op) with the
  // (action, data) domain read from the spec's OWN manifest() declarations
  // instead of buildDomain() inference — the "silently EXCLUDED from
  // exploration" failure class disappears by construction. --legacy-bare-next
  // forces the bare-next path even for a module that happens to look v2.
  let mod = specModule;
  let steps, notes;
  let engine = 'legacy';
  if (!legacyBareNext && isSamV2Module(specModule)) {
    try {
      mod = makeSamAdapter(specModule);
      // The library's own obligation check FIRST: a module with no named
      // intents / schemas / domains would otherwise explore nothing and pass
      // vacuously. Strict modules throw here; non-strict ones RETURN the
      // problems array — both must fail loudly.
      const accessor = specModule.instance({});
      if (typeof accessor.validate === 'function') {
        const problems = accessor.validate();
        if (Array.isArray(problems) && problems.length) {
          return { ok: false, error: `v2 module fails validate(): ${problems.join('; ')}`, statesExplored: 0, capHit: false, violations: [], domainNotes: [], frozenKeys: [], driftWarnings: [], engine: 'sam-v2' };
        }
      }
      let intentNames;
      ({ steps, notes, intentNames } = domainFromManifest(specModule));
      engine = 'sam-v2';
      // The manifest is the exploration domain; a contract action missing
      // from it is silently unexplored unless we say so here. (Intents that
      // ARE in the manifest but lack a domain already get their own note.)
      // intentNames comes from the SAME manifest() read the domain came from,
      // so note and domain cannot disagree even if the getter is impure.
      const manifestIntents = new Set(intentNames);
      for (const a of Object.keys(contract?.actions || {})) {
        if (!manifestIntents.has(a)) notes.push(`contract action '${a}' is not in the module's manifest() — NOT explored`);
      }
    } catch (e) {
      return { ok: false, error: `v2 SAM module rejected by the adapter: ${e && e.message}`, statesExplored: 0, capHit: false, violations: [], domainNotes: [], frozenKeys: [], driftWarnings: [], engine: 'sam-v2' };
    }
  } else {
    if (!mod || typeof mod.next !== 'function' || typeof mod.init !== 'function') {
      return { ok: false, error: 'spec must export init() and next() (or the v2 SAM surface)', statesExplored: 0, capHit: false, violations: [], domainNotes: [], frozenKeys: [], driftWarnings: [] };
    }
    ({ steps, notes } = providedSteps ? { steps: providedSteps, notes: [] } : buildDomain(contract, windows));
  }
  // An empty exploration domain would visit only init() and pass every
  // invariant vacuously — that is a failed check, never a clean one.
  if (!steps.length) {
    const why = engine === 'sam-v2'
      ? "the module's manifest() yields no explorable (action, data) steps"
      : 'the contract declares no explorable actions (no dataDomain, none inferable from traces)';
    return { ok: false, error: `exploration domain is empty — ${why}${notes.length ? ` [${notes.join('; ')}]` : ''}`, statesExplored: 0, capHit: false, violations: [], domainNotes: notes, frozenKeys: [], driftWarnings: [], engine };
  }
  const stateInv = invariants.stateInvariants || [];
  const transInv = invariants.transitionInvariants || [];

  // One full BFS exploration. Kept as an inner function so the determinism
  // double-pass below can run it twice under identical inputs. `live` labels
  // the pass for the progress heartbeat; live console output NEVER enters the
  // determinism digest (heartbeats are clock-driven; drift warnings are
  // deterministic but printed only on pass 1 to avoid duplicates).
  const explore = (live = null) => {
    const violations = [];
    // ── Runaway guardrails (eval/FINDING-raft-field-study.md, lesson 2) ─────
    // An action that mints a fresh state forever (an unbounded monotonic
    // counter: raft's ElectionTimeout term bump) turns the default cap into a
    // silent multi-minute grind. The fix is telling the user EARLY, not
    // guessing a universal bound: (a) a drift detector — a key whose distinct
    // values track the number of discovered states is likely unbounded; (b) a
    // heartbeat line every ~10s so a long run is visibly alive and visibly
    // runaway. Both stderr-only; drift is also recorded in the result.
    const keyValues = new Map(); // key -> Set(stable(value)) over all graph states
    const driftWarned = new Set();
    const driftWarnings = [];
    const trackDrift = (state) => {
      if (!state || typeof state !== 'object' || Array.isArray(state)) return;
      for (const [k, v] of Object.entries(state)) {
        (keyValues.get(k) || keyValues.set(k, new Set()).get(k)).add(stable(v));
      }
    };
    // KNOWN SCOPE LIMIT: the detector is single-key (the raft term-bump
    // shape). A blowup that is a PRODUCT of two or more moderately-sized keys
    // (independent unbounded counters exploring a grid) keeps every per-key
    // ratio near zero and is invisible here — the heartbeat is the only
    // signal for that shape. Absence of a drift warning is NOT evidence of
    // boundedness.
    const checkDrift = (discovered) => {
      for (const [k, vals] of keyValues) {
        if (driftWarned.has(k) || vals.size < driftThreshold || vals.size < discovered * 0.5) continue;
        driftWarned.add(k);
        const msg = `state key '${k}' has ${vals.size} distinct values across ${discovered} discovered states and is still growing — the state space is likely unbounded in this key; abstract it in the contract or use a much smaller --max-states`;
        driftWarnings.push(msg);
        if (live === 'pass 1') stderrLine(`[check] WARNING: ${msg}`);
      }
    };
    // Env override validated: NaN (typo) falls back to the default instead of
    // silently disabling the heartbeat; negative values clamp to 0.
    const hbRaw = Number(process.env.POLYGRAPH_HEARTBEAT_MS ?? 10000);
    const heartbeatMs = Number.isFinite(hbRaw) ? Math.max(0, hbRaw) : 10000;
    const started = Date.now();
    let lastBeat = started;
    const seen = new Set(); // invariant names already recorded (keep shortest = first via BFS)
    let capHit = false;
    let init;
    try { init = mod.init(); }
    catch (e) { return { error: `init() threw: ${e && e.message}`, parent: new Map(), violations, capHit, seededStates: 0, driftWarnings }; }
    const initKey = stable(init);
    const parent = new Map([[initKey, { prev: null, action: null, data: null, state: init, origin: 'init' }]]);
    // Roots are collected EXPLICITLY (not inferred from "parent has only roots
    // right now") so the root-invariant loop below cannot silently reclassify
    // BFS-discovered states if code is ever inserted between here and there.
    const roots = [[initKey, parent.get(initKey)]];
    const queue = [[init, initKey]];
    // Seed the frontier with the provided initial states (deduped against
    // init and each other) — each is explored exactly like init. Seeds are
    // EXEMPT from the maxStates cap: the cap bounds what exploration
    // DISCOVERS, not how many fleet snapshots the caller already has —
    // otherwise a fleet at or above the cap would report BOUNDED with zero
    // transitions tried.
    for (const s of initialStates) {
      const k = stable(s);
      if (!parent.has(k)) {
        const node = { prev: null, action: null, data: null, state: s, origin: 'seed' };
        parent.set(k, node);
        roots.push([k, node]);
        queue.push([s, k]);
      }
    }
    const seededStates = roots.length - 1;

    const pathTo = (key) => {
      const chain = [];
      let k = key;
      while (k !== null && parent.has(k)) { const n = parent.get(k); chain.push({ action: n.action, data: n.data, state: n.state, origin: n.origin }); k = n.prev; }
      return chain.reverse();
    };
    // Dedup by (kind, name): a state invariant and a transition invariant may
    // legitimately share a name; keying on the name alone would hide one.
    // NOTE the consequence for seeded runs: ONE witness per invariant — the
    // first root (init, then seeds in input order) whose region reaches the
    // violation. The verdict is "compatible or not", not the affected-instance
    // list; callers must not read a single named seed as the blast radius.
    const record = (name, kind, path, detail) => { const k = `${kind}:${name}`; if (seen.has(k)) return; seen.add(k); violations.push({ invariant: name, kind, path, detail }); };

    // invariants on every root of the exploration (init + seeds)
    for (const [rk, node] of roots) {
      for (const inv of stateInv) {
        let ok; try { ok = inv.pred(node.state); } catch { ok = false; }
        if (!ok) record(inv.name, 'state', pathTo(rk), node.origin === 'seed' ? 'violated in a seeded initial state' : 'violated in the initial state');
      }
    }

    // The cap counts DISCOVERED states (init + everything BFS finds); seeds
    // are excluded so discovered = parent.size - seededStates.
    // Drift is about what exploration MINTS, so only init and BFS-discovered
    // states feed the detector. Seeded states are excluded on BOTH sides: a
    // fleet corpus (polyvers seeds every snapshot) carrying a per-instance
    // distinct key — an id, a timestamp — would otherwise inflate the
    // numerator past a denominator that already excludes seeds and flag a
    // perfectly bounded machine as unbounded.
    trackDrift(init);

    let head = 0; // index cursor — Array.shift() is O(n) per pop, O(n²) overall
    while (head < queue.length && parent.size - seededStates < maxStates) {
      // Heartbeat: clock-driven, stderr-only, checked every 256 pops so the
      // clock read never dominates a fast exploration.
      if (live && (head & 255) === 0) {
        const now = Date.now();
        if (now - lastBeat >= heartbeatMs) {
          lastBeat = now;
          stderrLine(`[check] exploring (${live})… ${parent.size - seededStates} states discovered, frontier ${queue.length - head}, ${Math.round((now - started) / 1000)}s elapsed`);
        }
      }
      const [s, sKey] = queue[head++];
      const sJson = JSON.stringify(s); // one stringify per state, one parse per step
      for (const { action, data } of steps) {
        let post;
        try { post = mod.next(JSON.parse(sJson), action, data); }
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
          queue.push([post, pKey]);
          trackDrift(post);
          const discovered = parent.size - seededStates;
          if ((discovered & 255) === 0) checkDrift(discovered);
        }
      }
    }
    // CAP HIT means the exploration was truncated: states remained unexpanded.
    // Completing with parent.size exactly AT the cap is a full exploration.
    if (head < queue.length) capHit = true;
    // Drift verdicts are only REPORTED for truncated runs: a runaway stopped
    // by a small cap between sampling points still deserves the warning (the
    // final checkDrift catches the tail), but an EXHAUSTED frontier is
    // definitive disproof of "still growing" — a large bounded machine (a
    // counter capped at 2000 in next()) must not be called likely-unbounded
    // after a complete exploration. A mid-run warning that exploration later
    // disproves is retracted LOUDLY, never silently contradicted by the result.
    if (capHit) {
      checkDrift(parent.size - seededStates);
    } else if (driftWarnings.length) {
      if (live === 'pass 1') stderrLine(`[check] exploration completed without hitting the cap — earlier drift warning(s) retracted; the flagged key(s) turned out bounded`);
      driftWarnings.length = 0;
    }
    return { parent, violations, capHit, seededStates, driftWarnings };
  };

  // ── Determinism double-pass ───────────────────────────────────────────────
  // Two identical explorations must produce the SAME state graph and the SAME
  // violations. A digest mismatch means the spec's transitions depend on
  // something outside (state, action, data) — Math.random, Date.now, retained
  // mutable module state — which invalidates both replay and exploration, so
  // it is surfaced as a first-class 'nondeterministic' finding.
  const digestOf = (r) => stable({
    states: [...r.parent.keys()].sort(),
    violations: r.violations.map((v) => ({ invariant: v.invariant, kind: v.kind, detail: v.detail })),
    capHit: r.capHit,
    error: r.error || null,
  });
  const pass1 = explore('pass 1');
  const pass2 = explore('pass 2');
  const nondeterministic = digestOf(pass1) !== digestOf(pass2);

  const { parent, violations, capHit, error, seededStates, driftWarnings } = pass1;
  if (error) return { ok: false, error, statesExplored: 0, capHit: false, violations: [], domainNotes: notes, frozenKeys: [], driftWarnings, engine, seededStates: 0 };

  // ── Frozen-field scan ─────────────────────────────────────────────────────
  // A state key whose value is identical across EVERY reachable state (init,
  // seeds, and everything BFS discovered) is invisible to this check: any
  // behavior gated on a non-default value of that key is structurally
  // unreachable from init, and the invariants pass vacuously over it. This is
  // not hypothetical — deleting a safety gate guarded by such a key still
  // model-checks clean (eval/FINDING-raft-field-study.md, `startIndex`). The
  // remedy is --initial-states seeding (or traces) with a non-default value;
  // seeded states join `parent`, so an unfreezing seed clears the warning by
  // construction. Reported as its own field, NOT in domainNotes: downstream
  // consumers (polynv precheck, polygen coverage) read domainNotes as
  // "alphabet was pruned", which this is not.
  const frozenKeys = [];
  {
    const states = [...parent.values()].map((n) => n.state);
    // A spec whose next() returns undefined/null/a primitive puts non-object
    // states in the graph (LLM-generated legacy specs routinely return
    // undefined for an unhandled action). Object.keys/`in` would throw and
    // turn that spec's REAL violations into a checker crash — skip the scan
    // for such degenerate graphs; the violations themselves still report.
    if (states.every((s) => s && typeof s === 'object' && !Array.isArray(s))) {
      const keys = new Set(states.flatMap((s) => Object.keys(s)));
      for (const key of keys) {
        let frozen = true;
        let first;
        for (let i = 0; i < states.length; i++) {
          if (!(key in states[i])) { frozen = false; break; }
          const v = stable(states[i][key]);
          if (i === 0) first = v;
          else if (v !== first) { frozen = false; break; }
        }
        if (frozen) frozenKeys.push({ key, value: states[0][key] });
      }
      frozenKeys.sort((a, b) => (a.key < b.key ? -1 : 1));
    }
  }
  if (nondeterministic) {
    violations.push({
      invariant: 'deterministic-exploration',
      kind: 'nondeterminism',
      path: [],
      detail: 'two identical explorations produced different state graphs or violations — the spec is nondeterministic (Math.random / Date.now / retained mutable state); its replay and exploration verdicts cannot be trusted',
    });
  }
  // statesExplored counts what exploration DISCOVERED (init + BFS finds);
  // seeded roots are reported separately so a seeded run cannot overstate
  // its coverage by counting states it was merely handed.
  return { ok: violations.length === 0, statesExplored: parent.size - seededStates, seededStates, capHit, violations, domainNotes: notes, frozenKeys, driftWarnings, engine, nondeterministic };
}

// ── Readable render ─────────────────────────────────────────────────────────
export function render(result) {
  const L = [];
  L.push(`states explored: ${result.statesExplored}${result.seededStates ? ` (+ ${result.seededStates} seeded)` : ''}${result.capHit ? ' (CAP HIT — exploration bounded)' : ''}`);
  if (result.error) { L.push(`ERROR: ${result.error}`); return L.join('\n'); }
  // Silent alphabet pruning must be VISIBLE: an action skipped for lack of a
  // data domain means the clean verdict below only covers the explored subset.
  const notes = result.domainNotes || [];
  for (const n of notes) L.push(`WARNING: ${n}`);
  // A likely-unbounded key means the cap (not the machine) decided where
  // exploration stopped — the verdict below covers an arbitrary prefix.
  for (const d of result.driftWarnings || []) L.push(`WARNING: ${d}`);
  // A frozen key means part of the machine's behavior space was structurally
  // out of reach — the clean verdict below is silent about anything it gates.
  for (const f of result.frozenKeys || []) {
    L.push(`WARNING: state key '${f.key}' is frozen at ${JSON.stringify(f.value)} — no explored action or seed ever changes it; if it gates behavior, this check cannot verify that behavior (seed --initial-states or capture traces with a non-default value)`);
  }
  if (result.ok) {
    L.push(notes.length
      ? `no invariant violations reachable over the EXPLORED alphabet ✓ (${notes.length} action/field(s) skipped — see warnings above)`
      : 'no invariant violations reachable ✓');
    return L.join('\n');
  }
  L.push(`${result.violations.length} invariant violation(s):`);
  for (const v of result.violations) {
    L.push(`\n  ✗ ${v.invariant} [${v.kind}] — ${v.detail}`);
    if (!v.path.length) continue; // e.g. a nondeterminism finding has no single counterexample path
    const fromSeed = v.path[0] && v.path[0].origin === 'seed';
    L.push(`    counterexample (shortest path from ${fromSeed ? 'a seeded state' : 'init'}):`);
    v.path.forEach((step, i) => {
      const st = typeof step.state === 'string' ? step.state : JSON.stringify(step.state);
      if (i === 0 && step.action === null) L.push(`      ${fromSeed ? 'seed' : 'init'}            ${st}`);
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
  if (!args.spec || !args.contract) { console.error('usage: node check.mjs --spec <mod.js> --contract <c.json> [--invariants <inv.mjs>] [--traces <dir>] [--initial-states <states.json>] [--max-states N] [--json out]'); process.exit(2); }
  const contract = JSON.parse(readFileSync(args.contract, 'utf-8'));
  const invariants = await loadInvariants(args.invariants);
  const windows = args.traces ? loadWindows(args.traces) : [];
  const specModule = loadSpec(args.spec);
  // --initial-states: a .json array of state objects seeded into the BFS
  // alongside init() — the versioning check "can any of THESE states be
  // driven to a violation under these rules". Malformed input is a usage
  // error (exit 2), never a stack trace and never 'machine bug' findings.
  let initialStates = [];
  if (args['initial-states']) {
    try {
      initialStates = JSON.parse(readFileSync(args['initial-states'], 'utf-8'));
    } catch (e) {
      console.error(`--initial-states '${args['initial-states']}': ${e && e.message}`); process.exit(2);
    }
    if (!Array.isArray(initialStates)) { console.error(`--initial-states '${args['initial-states']}' must be a JSON array of states`); process.exit(2); }
    const bad = initialStates.findIndex((s) => !s || typeof s !== 'object' || Array.isArray(s));
    if (bad >= 0) { console.error(`--initial-states '${args['initial-states']}': element ${bad} is not a state object — seeding non-states would report input garbage as machine findings`); process.exit(2); }
  }
  const result = check({ specModule, contract, invariants, windows, maxStates: Number(args['max-states'] || 100000), initialStates });
  console.log(render(result));
  if (args.json) { const { writeFileSync } = await import('node:fs'); writeFileSync(args.json, JSON.stringify(result, null, 2)); }
  process.exit(result.ok ? 0 : 1);
}
