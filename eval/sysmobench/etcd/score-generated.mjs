// SysMoBench etcd — score generated specs against both phases.
//
//   node score-generated.mjs [--specs gen] [--corpus corpus] [--max-states 4000]
//
// The measurement the corpus was built to enable: take specifications a model
// wrote from etcd's source, and score each against
//
//   PHASE 3 — conformance replay over windows captured from a real cluster;
//   PHASE 2/4 — bounded exploration over the declared domains, checking the
//               expert invariants.
//
// mutate.mjs established what these two phases can discriminate: on injected
// defects, replay caught two of eight and the explorer caught eight of eight.
// So a spec passing replay alone is not established as faithful, and this
// reports the phases separately rather than collapsing them into one score.
//
// GENERATION PROTOCOL, for anyone reading the numbers. Each spec was written by
// a model in a FRESH context given exactly one input: a prompt containing the
// contract and etcd's own raft.go. It could not read the reference
// specification, the invariant file, or any captured trace, and it was
// instructed not to run any checker against its own output. That makes this a
// ONE-SHOT measurement, which is the regime the prior 0-of-20 figure describes.
'use strict';

import { readdirSync, existsSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWindows, replaySpecResults } from '../../../scripts/replay.mjs';
import { classifyCheck } from './check-verdict.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const SPECS = resolve(flag('specs', join(here, 'gen')));
const CORPUS = resolve(flag('corpus', join(here, 'corpus')));
const MAX_STATES = Number(flag('max-states', 4000));

const ROOT = join(here, '..', '..', '..');
const CONTRACT = resolve(join(here, 'gen', 'contract.json'));
const INVARIANTS = resolve(join(ROOT, 'examples', 'etcd-raft-v2', 'invariants.mjs'));
const CHECK = resolve(join(ROOT, 'scripts', 'check.mjs'));
const REFERENCE = resolve(join(ROOT, 'examples', 'etcd-raft-v2', 'spec.cjs'));

/**
 * Bounded exploration + invariants. Returns one of:
 *   'clean'    — explored to exhaustion, no violation
 *   'bounded'  — no violation found, but the cap was hit: INCONCLUSIVE
 *   'violated' — a reachable violation exists (definitive)
 *   'error'    — the spec could not be explored at all
 * The asymmetry is doctrine: a clean result over a truncated space is not a pass.
 */
function explore(specPath) {
  let out = '';
  try {
    out = execFileSync(process.execPath,
      [CHECK, '--spec', specPath, '--contract', CONTRACT, '--invariants', INVARIANTS,
        '--max-states', String(MAX_STATES)],
      { encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 });
  } catch (err) {
    out = String(err.stdout ?? '') + String(err.stderr ?? '');
  }
  const verdict = classifyCheck(out);
  if (verdict === 'violated') {
    const m = /✗\s+([A-Za-z][A-Za-z0-9_]*)/.exec(out);
    return { verdict, detail: m ? m[1] : 'invariant violated' };
  }
  return { verdict, detail: '' };
}

const windows = loadWindows(CORPUS);
if (!windows.length) { console.error(`no windows in ${CORPUS} — run map-traces.mjs first`); process.exit(2); }

const files = existsSync(SPECS)
  ? readdirSync(SPECS).filter((f) => /^spec-\d+\.cjs$/.test(f)).sort()
  : [];
if (!files.length) { console.error(`no spec-N.cjs files in ${SPECS}`); process.exit(2); }

const rows = [];
// The reference is scored first and on identical terms, so the generated
// numbers are read against a known ceiling rather than in the abstract.
for (const { id, path } of [{ id: 'reference', path: REFERENCE },
  ...files.map((f) => ({ id: f.replace(/\.cjs$/, ''), path: join(SPECS, f) }))]) {
  const r = replaySpecResults(path, windows, 'sam');
  if (!r.ok) {
    rows.push({ id, loads: false, pass: 0, total: windows.length, explore: { verdict: 'n/a', detail: '' }, err: (r.error || '').slice(0, 120) });
    continue;
  }
  const pass = r.results.filter((x) => x.status === 'pass').length;
  const classes = {};
  for (const x of r.results) if (x.status !== 'pass') classes[x.classification || x.status] = (classes[x.classification || x.status] ?? 0) + 1;
  rows.push({ id, loads: true, pass, total: windows.length, classes, explore: explore(path) });
}

const EX = { clean: 'clean', bounded: 'inconclusive (BOUNDED)', violated: '**violated**', error: 'error', 'n/a': '—' };
console.log(`\n| spec | loads | phase 3 conformance | phase 2/4 explorer (≤${MAX_STATES}) |`);
console.log('|---|---|---|---|');
for (const r of rows) {
  const conf = r.loads ? `${r.pass}/${r.total}${r.pass < r.total ? ` (${Object.entries(r.classes).map(([k, v]) => `${k}:${v}`).join(', ')})` : ''}` : '—';
  console.log(`| ${r.id} | ${r.loads ? 'yes' : '**NO**'} | ${conf} | ${EX[r.explore.verdict]}${r.explore.detail ? ` — ${r.explore.detail}` : ''} |`);
}

const gen = rows.filter((r) => r.id !== 'reference');
const loaded = gen.filter((r) => r.loads);
const conformed = loaded.filter((r) => r.pass === r.total);
// "Passes both" requires conformance AND an explorer result that is not a
// violation and not merely bounded — the same bar the reference clears.
const bothClean = loaded.filter((r) => r.pass === r.total && r.explore.verdict === 'clean');
const survivedBounded = loaded.filter((r) => r.pass === r.total && r.explore.verdict === 'bounded');

console.log(`\ngenerated specs:            ${gen.length}`);
console.log(`  load at all:              ${loaded.length}/${gen.length}`);
console.log(`  conform on all windows:   ${conformed.length}/${gen.length}`);
console.log(`  + explorer clean:         ${bothClean.length}/${gen.length}`);
if (survivedBounded.length) console.log(`  + explorer BOUNDED:       ${survivedBounded.length}/${gen.length}  (inconclusive, not a pass)`);

writeFileSync(join(here, 'gen', 'results.json'), JSON.stringify({
  corpusWindows: windows.length, maxStates: MAX_STATES, rows,
}, null, 2) + '\n');
console.log(`\nwrote gen/results.json`);
