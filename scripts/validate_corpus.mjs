// Validate a trace corpus BEFORE using it: chaining, terminal states, no-op
// windows, and a (pre-state x action) coverage table with a warning for any
// special rule under-covered. The corpus is ground truth — this catches capture
// bugs, not modeling bugs.
//
// Usage: node validate_corpus.mjs <contract.json> <traces-dir-or-file>
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stable } from './load-spec.mjs';

// Canonical (key-order-insensitive) equality — the same definition the
// replayers and checker use. Raw JSON.stringify would report a false "chain
// break" whenever a capturer emits post and the next pre with different key
// order.
const eq = (a, b) => stable(a) === stable(b);

/** The primary state field = the first declared key (the control state). */
function stateField(contract) {
  const k = contract.stateKeys[0];
  return typeof k === 'string' ? k : k.name;
}

/**
 * specialRules declare `whenState`/`whenAction` as the SHORT EXPRESSIONS the
 * contract convention uses — `orderState == 'charging'`, `shipState !=
 * 'preparing'`, `subState in ('canceled','unpaid')`, `A | B | C` — not as bare
 * literals. Comparing them to a state value with `===` (as this tally did
 * until 2026-07) can never match, so every polygen-shaped contract reported
 * 0 windows for every rule and warned about it forever. Found while capturing
 * the fleet-study corpus: the repo's OWN demo corpus, which contains traces
 * named `cancel_blocked_while_charging_*`, scored 0 for that rule.
 *
 * These matchers parse the three structured forms and report anything else as
 * unparseable rather than silently counting it as a miss.
 */
function matchState(expr, preState) {
  if (!expr) return true;
  const e = expr.trim();
  const lits = (s) => [...s.matchAll(/'([^']*)'/g)].map((m) => m[1]);
  // Two conventions ship in this repo, and both are legitimate:
  //   bare literal — "LOCKED"                     (the turnstile examples)
  //   expression   — "orderState == 'charging'"   (polygen-authored contracts)
  // Anything else is prose ("any non-awaiting state") and is unmeasurable.
  if (!/[=!]|\bin\s*\(/.test(e)) return /\s/.test(e) ? null : e === preState;
  const inMatch = /\bin\s*\(([^)]*)\)/.exec(e);
  if (inMatch) {
    const set = lits(inMatch[1]);
    return /!\s*in|\bnot\s+in/.test(e) ? !set.includes(preState) : set.includes(preState);
  }
  if (/!==?/.test(e)) return !lits(e).includes(preState);
  if (/==?/.test(e)) return lits(e).includes(preState);
  return null;
}

function matchAction(expr, action) {
  if (!expr) return true;
  return expr.split('|').map((s) => s.trim()).filter(Boolean).includes(action);
}

export function validateCorpus(contract, tracePath) {
  const sf = stateField(contract);
  const terminals = new Set(contract.terminalStates || []);
  const declaredActions = new Set(Object.keys(contract.actions || {}));
  const ruleWindows = {}; // ruleName -> count of windows matching its declared (state, action)
  for (const r of contract.specialRules || []) ruleWindows[r.name] = 0;
  // Rules whose whenState is prose rather than an expression: counted as
  // UNMEASURABLE rather than as zero, so a documentation choice never reads
  // as missing coverage.
  const unparseableRules = new Set();

  const problems = [];
  const coverage = {}; // `${pre}|${action}` -> count
  const seenKeys = new Set(); // declared state keys observed anywhere in the corpus
  let total = 0, noops = 0;

  let files;
  try {
    files = readdirSync(tracePath).filter((f) => f.endsWith('.ndjson')).sort().map((f) => join(tracePath, f));
  } catch {
    files = [tracePath];
  }

  for (const f of files) {
    const scenario = f.replace(/^.*[\\/]/, '');
    const windows = readFileSync(f, 'utf-8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    windows.forEach((w, i) => {
      total++;
      // Window shape first: a malformed window must be a REPORTED problem,
      // not a crash — and a window with an empty post would replay vacuously.
      const isObj = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
      if (!isObj(w.pre) || !isObj(w.post) || typeof w.action !== 'string') {
        problems.push(`${scenario}[${i}]: malformed window — pre/post must be objects and action a string`);
        return;
      }
      if (Object.keys(w.post).length === 0) {
        problems.push(`${scenario}[${i}]: post is EMPTY — the window would replay vacuously (projection over zero keys)`);
      }
      // The PRIMARY state field (control state) must be present in every
      // window — a capture bug that renames it poisons every downstream
      // comparison. Other declared keys may legitimately be absent per
      // window (SAM getState() omits undefined-valued keys); they are
      // checked corpus-wide below instead.
      if (!(sf in w.pre)) problems.push(`${scenario}[${i}]: pre is missing declared state key '${sf}'`);
      if (!(sf in w.post)) problems.push(`${scenario}[${i}]: post is missing declared state key '${sf}'`);
      for (const k of contract.stateKeys || []) {
        const keyName = typeof k === 'string' ? k : k.name;
        if (keyName in w.pre || keyName in w.post) seenKeys.add(keyName);
      }
      const pre = w.pre[sf];
      const key = `${pre}|${w.action}`;
      coverage[key] = (coverage[key] || 0) + 1;

      // undeclared action: an ERROR, not a warning. The v2 strict pipeline
      // cannot no-op an action outside the contract alphabet (schemas and
      // acceptors are keyed by name), so a corpus that exercises one is a
      // contract gap that must be fixed at the contract, not absorbed.
      if (!declaredActions.has(w.action)) {
        problems.push(`${scenario}[${i}]: action '${w.action}' is not declared in the contract's actions`);
      }

      // chaining: post[k] == pre[k+1]
      if (i + 1 < windows.length && !eq(w.post, windows[i + 1].pre)) {
        problems.push(`${scenario}[${i}]: post != next pre (chain break)`);
      }
      // no-op detection (pre == post): count it
      if (eq(w.pre, w.post)) noops++;

      // special-rule tally (a rule "matches" a window if its declared pre-state
      // and action are present; declared as { name, note, whenState?, whenAction? })
      for (const r of contract.specialRules || []) {
        const stateOk = matchState(r.whenState, pre);
        if (stateOk === null) { unparseableRules.add(r.name); continue; }
        if (stateOk && matchAction(r.whenAction, w.action)) ruleWindows[r.name]++;
      }
    });

    // terminal expectation: scenario's last post primary state should be terminal
    if (windows.length && terminals.size) {
      const lastState = windows[windows.length - 1].post[sf];
      if (!terminals.has(lastState)) {
        problems.push(`${scenario}: ends in '${lastState}', not a declared terminal state`);
      }
    }
  }

  // A zero-window corpus can't be ground truth for anything — validating it
  // "clean" would be a silent-clean path. Make it a hard problem.
  if (files.length === 0) problems.push(`no .ndjson files found in ${tracePath}`);
  else if (total === 0) problems.push(`corpus contains zero windows (all files empty)`);

  // A declared key that never appears in ANY window was renamed or dropped by
  // the capture projection (per-window absence is legitimate — getState()
  // omits undefined-valued keys — corpus-wide absence is not).
  if (total > 0) {
    for (const k of contract.stateKeys || []) {
      const keyName = typeof k === 'string' ? k : k.name;
      if (!seenKeys.has(keyName)) problems.push(`declared state key '${keyName}' never appears in any window (renamed or dropped by the capture projection?)`);
    }
  }

  // A rule whose whenState is prose cannot be tallied mechanically, so it is
  // never counted as under-covered — that would be reporting a documentation
  // style as missing test coverage.
  const underCovered = Object.entries(ruleWindows)
    .filter(([n, c]) => c < 3 && !unparseableRules.has(n))
    .map(([n, c]) => ({ rule: n, windows: c }));

  return { total, noops, coverage, ruleWindows, underCovered, problems, unmeasurableRules: [...unparseableRules] };
}

function printReport(rep) {
  console.log(`Windows: ${rep.total} (${rep.noops} no-op)`);
  console.log('\nCoverage (pre-state x action):');
  const rows = Object.entries(rep.coverage).sort();
  const w = Math.max(...rows.map(([k]) => k.length), 8);
  for (const [k, c] of rows) console.log(`  ${k.padEnd(w)}  ${c}`);
  if (Object.keys(rep.ruleWindows).length) {
    console.log('\nSpecial-rule coverage:');
    const unmeasurable = new Set(rep.unmeasurableRules ?? []);
    for (const [n, c] of Object.entries(rep.ruleWindows)) {
      const note = unmeasurable.has(n)
        ? '  <-- not mechanically measurable (whenState is prose, not an expression)'
        : (c < 3 ? '  <-- WARNING: <3 windows' : '');
      console.log(`  ${n.padEnd(w)}  ${unmeasurable.has(n) ? '—' : c}${note}`);
    }
  }
  if (rep.problems.length) {
    console.log('\nProblems:');
    for (const p of rep.problems) console.log(`  ! ${p}`);
  } else {
    console.log('\nNo chaining/terminal problems found.');
  }
}

// CLI
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [, , contractPath, tracePath] = process.argv;
  if (!contractPath || !tracePath) {
    console.error('usage: node validate_corpus.mjs <contract.json> <traces-dir-or-file>');
    process.exit(2);
  }
  const contract = JSON.parse(readFileSync(contractPath, 'utf-8'));
  const rep = validateCorpus(contract, tracePath);
  printReport(rep);
  // Under-covered special rules are a warning, not a hard failure; chain/terminal
  // breaks are a hard failure (the corpus is not trustworthy).
  process.exit(rep.problems.length ? 1 : 0);
}
