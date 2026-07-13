// Mechanism eval (deterministic, NO API): proves the seeded suite actually
// exhibits the property bare-next() relies on. For each machine it regenerates
// the trace corpus from source.js, then replays the apparent-intent reference.cjs
// against those traces:
//   - seeded machine   -> the seeded window(s) FAIL, everything else passes
//   - clean machine    -> all windows pass (no false alarm)
//   - out-of-scope     -> all windows pass (the self-consistent bug is invisible)
// If any of these do not hold, the machine is mis-constructed and the A/B eval
// built on top of it would be meaningless. Run: npm run eval:mechanism
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { loadWindows, replaySpec } from '../scripts/replay.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MACHINES_DIR = join(HERE, 'machines');

const machines = readdirSync(MACHINES_DIR).filter((d) => /^m\d/.test(d)).sort();
const rows = [];
let allValid = true;

for (const name of machines) {
  const dir = join(MACHINES_DIR, name);
  const gt = JSON.parse(readFileSync(join(dir, 'ground-truth.json'), 'utf-8'));
  const cls = gt.outOfScope ? 'out-of-scope' : gt.seeded ? 'seeded' : 'clean';

  // Regenerate traces deterministically from source.js.
  const gen = await import(pathToFileURL(join(dir, 'gen-traces.mjs')).href);
  gen.run();

  const windows = loadWindows(join(dir, 'traces'));
  const statuses = replaySpec(join(dir, 'reference.cjs'), windows, 'legacy'); // eval machines are bare-next artifacts
  const fails = windows
    .map((w, i) => ({ scenario: w.scenario, action: w.action, pre: w.pre, st: statuses[i] }))
    .filter((x) => x.st !== 'pass');

  let valid, detail;
  if (cls === 'seeded') {
    const wrongAction = fails.find((f) => f.action !== gt.defect.action);
    valid = fails.length >= 1 && !wrongAction;
    detail = valid
      ? `detects: ${fails.length} window(s) at ${gt.defect.action} (${gt.defect.preState})`
      : (fails.length === 0
        ? 'MISCONSTRUCTED: divergence not detectable (0 fails)'
        : `MISCONSTRUCTED: unexpected fail at ${wrongAction.action}`);
  } else {
    valid = fails.length === 0;
    detail = valid
      ? (cls === 'out-of-scope' ? 'correctly invisible (0 findings)' : 'no false alarm (0 findings)')
      : `MISCONSTRUCTED: ${fails.length} false-alarm window(s) (${fails.map((f) => f.action).join(',')})`;
  }
  if (!valid) allValid = false;
  rows.push({ name, cls, windows: windows.length, fails: fails.length, valid, detail });
}

// Print table.
const pad = (s, n) => String(s).padEnd(n);
console.log('\nMechanism eval — does the suite exhibit detectable divergences?\n');
console.log(pad('machine', 26), pad('class', 14), pad('win', 4), pad('fail', 5), pad('valid', 6), 'detail');
console.log('-'.repeat(120));
for (const r of rows) {
  console.log(
    pad(r.name, 26), pad(r.cls, 14), pad(r.windows, 4), pad(r.fails, 5),
    pad(r.valid ? 'OK' : 'BAD', 6), r.detail,
  );
}
const seeded = rows.filter((r) => r.cls === 'seeded');
const clean = rows.filter((r) => r.cls === 'clean');
const oos = rows.filter((r) => r.cls === 'out-of-scope');
console.log('-'.repeat(120));
console.log(`\n${seeded.filter((r) => r.valid).length}/${seeded.length} seeded machines expose a detectable divergence`);
console.log(`${clean.filter((r) => r.valid).length}/${clean.length} clean machines produce no false alarm`);
console.log(`${oos.filter((r) => r.valid).length}/${oos.length} out-of-scope machines correctly invisible`);
console.log(allValid ? '\nEVAL VALID — every machine behaves as its ground truth claims.' : '\nEVAL INVALID — fix the flagged machines.');
process.exit(allValid ? 0 : 1);
