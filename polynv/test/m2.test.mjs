// polynv M2 tests — the mutation adequacy grade. node:test, deterministic,
// no API key. Run: node --test polynv/test/m2.test.mjs
//
// The worked example doubles as operator calibration (decision §10.4): the
// OMS order machine with its KNOWN-GOOD hand-written invariants must kill a
// solid majority of behaviorally distinct mutants; an empty invariant set
// must kill none.
'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { loadArtifacts } from '../../polyvers/src/artifacts.mjs';
import { enumerateGraph } from '../src/consequences.mjs';
import { adaptedOf, generateMutants, runGrade, survivorCandidates } from '../src/grade.mjs';
import { mergeCandidates, applyDisposition } from '../src/ledger.mjs';
import { harvestTemplates } from '../src/templates.mjs';
import { precheckRecord } from '../src/precheck.mjs';
import { openQuestions } from '../src/questions.mjs';
import { buildStatus } from '../src/report.mjs';
import { buildReport, renderReport } from '../../polyvers/src/report.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'bin', 'polynv.mjs');
const orderV1 = join(here, '..', '..', 'examples', 'polyvers-oms', 'order-v1');

const artifacts = await loadArtifacts(orderV1);
const adapted = adaptedOf(artifacts.module);
const baseline = enumerateGraph({ module: adapted, contract: artifacts.contract });

const DATE = '2026-07-18T00:00:00.000Z';

// The fixture's hand-written invariants as a LIVE oracle (closures intact —
// a toString round-trip would strip `same`/`TERMINAL`/`AWAITS` and kill
// every mutant spuriously). This is the known-good set for calibration.
const handWrittenOracle = () => [
  ...artifacts.invariants.map((inv) => ({ id: `hand:state:${inv.name}`, target: 'state', pred: inv.pred })),
  ...artifacts.transitionInvariants.map((inv) => ({ id: `hand:trans:${inv.name}`, target: 'transition', pred: inv.pred })),
];
const emptyLedger = () => ({ format: 'polynv-ledger/1', records: [] });

// ── operators ───────────────────────────────────────────────────────────────

test('generateMutants: all four operator families, stable ids, honest cap', () => {
  const { mutants, dropped } = generateMutants(artifacts.contract, baseline, { maxMutants: 1000 });
  const fams = new Set(mutants.map((m) => m.id.split(':')[0]));
  assert.deepEqual([...fams].sort(), ['drop', 'freeze', 'retarget', 'widen']);
  assert.equal(dropped, 0);
  const capped = generateMutants(artifacts.contract, baseline, { maxMutants: 5 });
  assert.equal(capped.mutants.length, 5);
  assert.equal(capped.dropped, mutants.length - 5);
});

// ── the grade: calibration against the known-good oracle ────────────────────

test('runGrade: hand-written invariants kill a solid majority; empty set kills none', () => {
  const g = runGrade(artifacts, emptyLedger(), { maxMutants: 1000, extraOracle: handWrittenOracle() });
  assert.ok(g.distinct >= 10, `only ${g.distinct} distinct mutants`);
  assert.ok(g.killed / g.distinct >= 0.6, `known-good invariants kill only ${g.killed}/${g.distinct} — operator set or oracle wiring is off`);
  assert.equal(g.killed + g.survivors.length, g.distinct);
  // survivors carry concrete witnesses
  for (const s of g.survivors) assert.ok(s.witness && s.witness.action, s.id);

  const g0 = runGrade(artifacts, emptyLedger(), { maxMutants: 1000 });
  assert.equal(g0.killed, 0, 'an empty invariant set must kill nothing');
  assert.equal(g0.distinct, g.distinct, 'the denominator must not depend on the oracle');
});

test('runGrade: equivalent mutants are discarded by graph comparison', () => {
  const g = runGrade(artifacts, emptyLedger(), { maxMutants: 1000 });
  // freeze on a field some action updates is distinct; equivalents (if any)
  // never inflate the denominator: distinct + equivalent + harness = total
  assert.equal(g.distinct + g.equivalent + g.harnessKilled, g.total);
});

// ── the dialog integration: profiles, survivors, ranking, convergence ───────

test('grade profiles open candidates and ranks hypothesis-splitters first', () => {
  const ledger = emptyLedger();
  // add open template candidates and pre-check them (the M0 flow)
  const { candidates } = harvestTemplates(artifacts.contract, artifacts.manifest);
  mergeCandidates(ledger, candidates, { date: DATE });
  const graph = enumerateGraph(artifacts);
  for (const r of ledger.records.filter((x) => x.status === 'open')) precheckRecord(r, artifacts, { date: DATE, graph });

  const g = runGrade(artifacts, ledger, { maxMutants: 1000, extraOracle: handWrittenOracle() });
  const open = ledger.records.filter((r) => r.status === 'open');
  assert.ok(open.some((r) => r.grade), 'open candidates must be profiled');

  // survivor questions merge into the ledger and rank at the top tier
  mergeCandidates(ledger, survivorCandidates(g), { date: DATE });
  for (const r of ledger.records.filter((x) => x.source === 'mutation-survivor')) {
    r.precheck = { verdict: 'NOT-RUN', note: 'no predicate yet', date: DATE };
  }
  const ranked = openQuestions(ledger);
  const firstSurvivor = ranked.findIndex((r) => r.source === 'mutation-survivor' || r.grade?.newKills > 0);
  const firstPlainHolds = ranked.findIndex((r) => r.precheck?.verdict === 'HOLDS' && !(r.grade?.newKills > 0));
  if (firstSurvivor >= 0 && firstPlainHolds >= 0) assert.ok(firstSurvivor < firstPlainHolds, 'hypothesis-splitting questions must precede plain HOLDS questions');

  // a survivor question cannot be confirmed without a predicate — modify first
  const surv = ledger.records.find((r) => r.source === 'mutation-survivor');
  if (surv) {
    assert.throws(() => applyDisposition(ledger, { id: surv.id, disposition: 'confirm', author: 'jj' }, { date: DATE }), /no predicate/);
    applyDisposition(ledger, { id: surv.id, disposition: 'abandon', author: 'jj', concern: 'out of intent for this machine' }, { date: DATE });
    assert.equal(ledger.records.find((r) => r.id === surv.id).status, 'abandoned');
  }

  // convergence now sees the grade
  const s = buildStatus(ledger);
  assert.ok(s.graded);
  assert.match(s.adequacyGrade, /kills \d+\/\d+/);
});

// ── polyvers integration: the disclosed trust tier ──────────────────────────

test('compat-report carries the adequacy line, measured or not', () => {
  const classification = { changeId: 'c1', oldVersion: 'a', newVersion: 'b', lanes: ['semantic'], deferred: [], diffs: { vocabulary: { changed: false }, shape: { changed: false }, intent: { changed: false } } };
  const base = { classification, corpusInfo: { source: 'test', count: 1 }, gateResults: [{ gate: 'g', ok: true, summary: 's', failures: [] }] };

  const unmeasured = renderReport(buildReport(base));
  assert.match(unmeasured, /Invariant adequacy:\*\* NOT MEASURED/);

  const measured = renderReport(buildReport({ ...base, adequacy: { measured: true, killed: 14, distinct: 20, survivors: 6 } }));
  assert.match(measured, /kills 14\/20 behaviorally distinct machine mutant\(s\)/);
  assert.match(measured, /6 unconstrained behavior class\(es\) open/);
});

// ── CLI end-to-end ──────────────────────────────────────────────────────────

test('cli: grade writes the ledger grade, adds survivor questions, report converges only after', () => {
  const dir = mkdtempSync(join(tmpdir(), 'polynv-m2-'));
  cpSync(orderV1, dir, { recursive: true });
  const run = (...a) => execFileSync(process.execPath, [cli, ...a], { encoding: 'utf-8' });

  run('harvest', '--artifacts', dir);
  const g = run('grade', '--artifacts', dir);
  assert.match(g, /kills \d+\/\d+ behaviorally distinct/);
  const ledger = JSON.parse(readFileSync(join(dir, 'intent-ledger.json'), 'utf-8'));
  assert.ok(ledger.grade);
  assert.ok(ledger.grade.distinct > 0);
  // with zero confirmed rules, every distinct mutant survives and becomes a question
  assert.equal(ledger.grade.killed, 0);
  assert.ok(ledger.records.some((r) => r.source === 'mutation-survivor'));

  rmSync(dir, { recursive: true, force: true });
});
