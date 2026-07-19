// SysMoBench etcd — does the trace corpus DISCRIMINATE?
//
//   node mutate.mjs [--corpus corpus] [--spec ../../../examples/etcd-raft-v2/spec.cjs]
//
// The reference spec conforms on 44 of 44 windows. That number says nothing
// about whether the corpus could catch a spec that is WRONG, and a corpus that
// passes everything is worth nothing. This injects known defects into the
// reference spec and reports which ones the corpus catches.
//
// This is the trace-corpus analogue of a mutation score, and it is the
// prerequisite for the experiment the corpus exists to enable: if a generated
// spec is to be judged by replay, replay has to be able to fail.
//
// The mutations are not arbitrary. Each is a defect a model plausibly writes,
// and the first is the one the project's own prior work singles out: a heartbeat
// handler that omits the defensive clamp on the advertised commit index, which
// under the plain contract was dropped in four of five generations.
'use strict';

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWindows, replaySpecResults } from '../../../scripts/replay.mjs';
import { classifyCheck } from './check-verdict.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const SPEC = resolve(flag('spec', join(here, '..', '..', '..', 'examples', 'etcd-raft-v2', 'spec.cjs')));
const CORPUS = resolve(flag('corpus', join(here, 'corpus')));

/**
 * Each mutation is an exact, unique string replacement on the reference spec.
 * `find` must occur exactly once, so a mutation can never silently no-op and
 * be scored as "missed" when it was never applied.
 */
const MUTANTS = [
  {
    id: 'heartbeat-no-clamp',
    why: "the paper's own example: a heartbeat handler that omits the defensive clamp on the advertised commit index, on the reasoning that a correct leader never advertises past a follower's log",
    find: 'up.commit = Math.max(up.commit, Math.min(p.commit, up.log));',
    repl: 'up.commit = Math.max(up.commit, p.commit);',
  },
  {
    id: 'append-no-clamp',
    why: 'the same omission on the append path, where the clamp is against the last new index rather than the log',
    find: 'up.commit = Math.max(up.commit, Math.min(p.commit, lastNew));',
    repl: 'up.commit = Math.max(up.commit, p.commit);',
  },
  {
    id: 'vote-not-reset-on-new-term',
    why: 'a new term must clear the previous vote; forgetting it lets a node vote twice in one term',
    find: "          up.term = p.term;\n          up.role = 'follower';\n          up.vote = '0';",
    repl: "          up.term = p.term;\n          up.role = 'follower';",
  },
  {
    id: 'no-stale-vote-guard',
    why: 'accepting a vote request from an older term, the classic missing-guard defect',
    find: "        if (p.term < n.term) return reject('stale campaign: lower term');",
    repl: '',
  },
  {
    id: 'election-no-self-vote',
    why: 'a candidate must record its own vote; omitting it is invisible to most invariants',
    find: "const up = { ...n, term: n.term + 1, role: 'candidate', vote: String(p.node) };",
    repl: "const up = { ...n, term: n.term + 1, role: 'candidate' };",
  },
  {
    id: 'proposal-any-role',
    why: 'dropping the leader check lets any node append to its own log',
    find: "        if (n.role !== 'leader') return reject('only a leader appends');",
    repl: '',
  },
  {
    id: 'append-no-step-down',
    why: 'receiving an append must make the node a follower; omitting it leaves two leaders in a term',
    find: "        up.role = 'follower';\n        if (p.index <= up.log) {",
    repl: '        if (p.index <= up.log) {',
  },
  {
    id: 'uptodate-off-by-one',
    why: 'an off-by-one in the log-recency comparison, the boundary a reader is least likely to check',
    find: 'const isUpToDate = p.index >= up.log;',
    repl: 'const isUpToDate = p.index > up.log;',
  },
];

const src = readFileSync(SPEC, 'utf-8');
const windows = loadWindows(CORPUS);
if (!windows.length) { console.error(`no windows in ${CORPUS} — run map-traces.mjs first`); process.exit(2); }

// Baseline. If the reference spec does not pass, nothing below means anything.
const base = replaySpecResults(SPEC, windows, 'sam');
if (!base.ok) { console.error('reference spec did not load:', base.error); process.exit(1); }
const basePass = base.results.filter((r) => r.status === 'pass').length;
console.log(`reference: ${basePass}/${windows.length} windows pass`);
if (basePass !== windows.length) {
  console.error('reference spec does not conform — fix that before scoring mutants');
  process.exit(1);
}

const CONTRACT = resolve(join(here, '..', '..', '..', 'examples', 'etcd-raft-v2', 'contract.json'));
const INVARIANTS = resolve(join(here, '..', '..', '..', 'examples', 'etcd-raft-v2', 'invariants.mjs'));
const CHECK = resolve(join(here, '..', '..', '..', 'scripts', 'check.mjs'));

/**
 * The complement of replay: bounded exploration over the DECLARED DOMAINS,
 * checking the expert invariants. Where replay asks "does this spec match what
 * the system did", this asks "can this spec be driven into a state the rules
 * forbid" — including by payloads a correct system would never send.
 */
const MAX_STATES = Number(flag('max-states', 4000));

/**
 * Returns 'caught' | 'bounded' | 'clean' | 'error'.
 *
 * THE ASYMMETRY IS THE POINT, and it is this project's own doctrine: a
 * violation found is definitive — a real counterexample exists — but a clean
 * result over a TRUNCATED space is not a pass. This spec's declared domains
 * are large: 20,000 states takes a minute and still hits the cap. So a mutant
 * the explorer does not catch under this bound is reported as INCONCLUSIVE,
 * never as one the explorer cannot catch.
 */
function modelCheckCatches(specPath) {
  let out = '';
  try {
    out = execFileSync(process.execPath,
      [CHECK, '--spec', specPath, '--contract', CONTRACT, '--invariants', INVARIANTS,
        '--max-states', String(MAX_STATES)],
      { encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 });
  } catch (err) {
    out = String(err.stdout ?? '') + String(err.stderr ?? '');
  }
  return classifyCheck(out);
}

const dir = mkdtempSync(join(tmpdir(), 'etcd-mutants-'));
const rows = [];
try {
  for (const m of MUTANTS) {
    const hits = src.split(m.find).length - 1;
    if (hits !== 1) {
      // A mutation that did not apply must never be reported as "missed" —
      // that would credit the corpus for catching nothing.
      rows.push({ id: m.id, applied: false, hits, caught: null, failed: 0, why: m.why });
      continue;
    }
    const mutantPath = join(dir, `${m.id}.cjs`);
    writeFileSync(mutantPath, src.replace(m.find, m.repl));
    const r = replaySpecResults(mutantPath, windows, 'sam');
    if (!r.ok) {
      // A mutant that will not even load is caught, but for the wrong reason;
      // record it distinctly rather than counting it as a conformance catch.
      rows.push({ id: m.id, applied: true, caught: 'load-error', failed: 0, why: m.why });
      continue;
    }
    const failed = r.results.filter((x) => x.status !== 'pass').length;
    rows.push({ id: m.id, applied: true, caught: failed > 0, failed, mc: modelCheckCatches(mutantPath), why: m.why });
  }
} finally { rmSync(dir, { recursive: true, force: true }); }

const replayMark = (v) => (v === true ? '**yes**' : v === false ? '**NO**' : 'load error');
const mcMark = { violated: '**yes**', bounded: 'inconclusive (BOUNDED)', clean: '**NO**', error: 'error' };
console.log(`\n| mutant | replay (${windows.length} windows) | windows failing | explorer + invariants (≤${MAX_STATES} states) |`);
console.log(`|---|---|---|---|`);
for (const r of rows) {
  if (!r.applied) { console.log(`| ${r.id} | NOT APPLIED (${r.hits} matches) | — | — |`); continue; }
  console.log(`| ${r.id} | ${replayMark(r.caught)} | ${r.failed} | ${mcMark[r.mc] ?? r.mc} |`);
}

const applied = rows.filter((r) => r.applied);
const byReplay = applied.filter((r) => r.caught === true || r.caught === 'load-error');
const byMC = applied.filter((r) => r.mc === 'violated');
const byEither = applied.filter((r) => r.caught === true || r.caught === 'load-error' || r.mc === 'violated');
const missedByReplay = applied.filter((r) => r.caught === false);
const openCases = applied.filter((r) => r.caught === false && r.mc !== 'caught');

console.log(`\nreplay alone:            ${byReplay.length}/${applied.length}`);
console.log(`explorer + invariants:   ${byMC.length}/${applied.length}`);
console.log(`either phase:            ${byEither.length}/${applied.length}`);

if (missedByReplay.length) {
  console.log('\nMissed by REPLAY — a correct system never drives these branches:');
  for (const r of missedByReplay) {
    const rescue = r.mc === 'violated' ? '   -> caught by the explorer' : r.mc === 'bounded' ? '   -> explorer INCONCLUSIVE at this bound' : '';
    console.log(`  ${r.id}${rescue}\n      ${r.why}`);
  }
}
if (openCases.length) {
  console.log('\nOPEN — not caught by replay, and not caught by the explorer at this bound.');
  console.log('A bounded clean result is not a pass, so these are unresolved, not safe:');
  for (const r of openCases) console.log(`  ${r.id}  [explorer: ${r.mc}]`);
}
if (rows.some((r) => !r.applied)) {
  console.error('\nsome mutations did not apply — the spec text has drifted; fix the anchors');
  process.exitCode = 1;
}
