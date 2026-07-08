// eval:check — deterministic (no API). Demonstrates the SECOND half of the
// method: model-check the FAITHFUL model of each machine (its own source, the
// same model the replay found "consistent") against invariants encoding intent.
//
// The point this proves: a seeded bug that replay MISSED (because the derived
// spec faithfully reproduced it) IS reached by exhaustive iteration against the
// intent-invariant, with a shortest counterexample. Clean machines produce no
// violation; the out-of-scope machine correctly produces none (its hazard is
// not expressible over observable state).
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { check, loadSpec, render } from '../scripts/check.mjs';
import { loadWindows } from '../scripts/replay.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MACH = join(HERE, 'machines');
const dirs = readdirSync(MACH).filter((d) => /^m\d+/.test(d)).sort();

const rows = [];
let allValid = true;
for (const d of dirs) {
  const base = join(MACH, d);
  const gt = JSON.parse(readFileSync(join(base, 'ground-truth.json'), 'utf-8'));
  const contract = JSON.parse(readFileSync(join(base, 'contract.json'), 'utf-8'));
  const specModule = loadSpec(join(base, 'source.cjs'));
  const invMod = await import(pathToFileURL(join(base, 'invariants.mjs')).href);
  const invariants = { stateInvariants: invMod.stateInvariants || [], transitionInvariants: invMod.transitionInvariants || [] };
  let windows = [];
  try { windows = loadWindows(join(base, 'traces')); } catch { /* none */ }

  const res = check({ specModule, contract, invariants, windows, maxStates: 20000 });
  const cls = gt.outOfScope ? 'out-of-scope' : gt.seeded ? 'seeded' : 'clean';
  const found = res.violations.length > 0;
  const expectViolation = cls === 'seeded';
  const valid = found === expectViolation; // seeded must violate; clean & oos must not
  if (!valid) allValid = false;

  let detail;
  if (cls === 'seeded') detail = found ? `FOUND: ${res.violations[0].invariant} (path len ${res.violations[0].path.length - 1})` : 'MISSED — bug not reached!';
  else if (cls === 'clean') detail = found ? `FALSE ALARM: ${res.violations[0].invariant}` : 'clean (no violation)';
  else detail = found ? `flagged (unexpected)` : 'correctly invisible (needs external probe)';

  rows.push({ name: d, cls, states: res.statesExplored, cap: res.capHit, found, valid, detail, res });
}

const w = Math.max(...rows.map((r) => r.name.length));
console.log('\n' + '-'.repeat(108));
console.log(`${'machine'.padEnd(w)}  ${'class'.padEnd(13)} ${'states'.padStart(7)} ${'found'.padStart(6)} ${'valid'.padStart(6)}  detail`);
console.log('-'.repeat(108));
for (const r of rows) {
  console.log(`${r.name.padEnd(w)}  ${r.cls.padEnd(13)} ${String(r.states).padStart(7)} ${(r.found ? 'yes' : 'no').padStart(6)} ${(r.valid ? 'OK' : 'BAD').padStart(6)}  ${r.detail}`);
}
console.log('-'.repeat(108));
const seeded = rows.filter((r) => r.cls === 'seeded');
const clean = rows.filter((r) => r.cls === 'clean');
const oos = rows.filter((r) => r.cls === 'out-of-scope');
console.log(`\n${seeded.filter((r) => r.found).length}/${seeded.length} seeded bugs FOUND by model checking (replay found 0/${seeded.length})`);
console.log(`${clean.filter((r) => !r.found).length}/${clean.length} clean machines produce no false alarm`);
console.log(`${oos.filter((r) => !r.found).length}/${oos.length} out-of-scope correctly invisible`);
console.log(allValid ? '\nEVAL VALID — model checking finds the seeded bugs the replay missed.' : '\nEVAL INVALID — see BAD rows above.');

// Show one counterexample in full (the exemplar, m01) for illustration.
const ex = rows.find((r) => r.name.startsWith('m01') && r.found);
if (ex) { console.log('\nExample counterexample — ' + ex.name + ':\n'); console.log(render(ex.res)); }

process.exit(allValid ? 0 : 1);
