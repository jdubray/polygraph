// Validate a trace corpus BEFORE using it: chaining, terminal states, no-op
// windows, and a (pre-state x action) coverage table with a warning for any
// special rule under-covered. The corpus is ground truth — this catches capture
// bugs, not modeling bugs.
//
// Usage: node validate_corpus.mjs <contract.json> <traces-dir-or-file>
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const norm = (v) => (v === undefined ? null : v);
const eq = (a, b) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));

/** The primary state field = the first declared key (the control state). */
function stateField(contract) {
  const k = contract.stateKeys[0];
  return typeof k === 'string' ? k : k.name;
}

export function validateCorpus(contract, tracePath) {
  const sf = stateField(contract);
  const terminals = new Set(contract.terminalStates || []);
  const declaredActions = new Set(Object.keys(contract.actions || {}));
  const ruleWindows = {}; // ruleName -> count, via specialRules[].matches (optional)
  for (const r of contract.specialRules || []) ruleWindows[r.name] = 0;

  const problems = [];
  const coverage = {}; // `${pre}|${action}` -> count
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
        const stateOk = !r.whenState || r.whenState === pre;
        const actionOk = !r.whenAction || r.whenAction === w.action;
        if (stateOk && actionOk) ruleWindows[r.name]++;
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

  const underCovered = Object.entries(ruleWindows).filter(([, c]) => c < 3).map(([n, c]) => ({ rule: n, windows: c }));

  return { total, noops, coverage, ruleWindows, underCovered, problems };
}

function printReport(rep) {
  console.log(`Windows: ${rep.total} (${rep.noops} no-op)`);
  console.log('\nCoverage (pre-state x action):');
  const rows = Object.entries(rep.coverage).sort();
  const w = Math.max(...rows.map(([k]) => k.length), 8);
  for (const [k, c] of rows) console.log(`  ${k.padEnd(w)}  ${c}`);
  if (Object.keys(rep.ruleWindows).length) {
    console.log('\nSpecial-rule coverage:');
    for (const [n, c] of Object.entries(rep.ruleWindows)) {
      console.log(`  ${n.padEnd(w)}  ${c}${c < 3 ? '  <-- WARNING: <3 windows' : ''}`);
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
