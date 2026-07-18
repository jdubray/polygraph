// Regression tests for the M0–M2 adversarial-review fixes (2026-07-18).
// node:test, deterministic, no API key.
// Run: node --test polynv/test/review-fixes.test.mjs
'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { loadArtifacts } from '../../polyvers/src/artifacts.mjs';
import { enumerateGraph, graphSound } from '../src/consequences.mjs';
import { precheckRecord } from '../src/precheck.mjs';
import { applyDisposition, mergeCandidates, oracleHashOf, loadLedger } from '../src/ledger.mjs';
import { mineStateProperties, vacuousOverGraph } from '../src/miners.mjs';
import { runGrade } from '../src/grade.mjs';
import { buildReport, renderReport } from '../../polyvers/src/report.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'bin', 'polynv.mjs');
const orderV1 = join(here, '..', '..', 'examples', 'polyvers-oms', 'order-v1');
const DATE = '2026-07-18T00:00:00.000Z';

const artifacts = await loadArtifacts(orderV1);
const graph = enumerateGraph(artifacts);

// A tiny legacy machine whose next() THROWS on one reachable step — the
// machine-problem fixture for attribution and graph-completeness tests.
const throwingContract = {
  stateKeys: [{ name: 'st', type: "enum: 'a' | 'b'" }, { name: 'n', type: 'integer >= 0' }],
  initState: { st: 'a', n: 0 },
  actions: { GO: { dataFields: {} }, BOOM: { dataFields: {} } },
  dataDomain: { GO: {}, BOOM: {} },
  terminalKey: 'st',
  terminalStates: ['b'],
};
const throwingModule = {
  init: () => ({ st: 'a', n: 0 }),
  next: (s, a) => {
    if (a === 'BOOM' && s.st === 'a') throw new Error('kaboom');
    if (a === 'GO' && s.st === 'a') return { st: 'b', n: s.n + 1 };
    return s;
  },
};
const throwingArtifacts = { module: throwingModule, contract: throwingContract };

// ── finding 1: enumerateGraph surfaces throws/nondeterminism ────────────────

test('enumerateGraph: throwing steps are surfaced, not silently dropped', () => {
  const g = enumerateGraph(throwingArtifacts);
  assert.equal(g.error, null);
  assert.ok(g.throws.length >= 1, 'throw violations must surface on the graph');
  assert.match(g.throws[0].invariant, /BOOM/);
  assert.equal(graphSound(g), false);
  // the healthy OMS graph is sound
  assert.equal(graphSound(graph), true);
});

// ── finding 2: machine problems land as ERROR, never as the candidate's FAILS

test('precheck: a machine throw is ERROR (machine problem), not candidate FAILS', () => {
  const record = {
    id: 'nonneg:n', source: 'template', target: 'state', question: 'q', evidence: null,
    status: 'open', assign: null,
    versions: [{ nf: { kind: 'nonneg', field: 'n' }, js: '(s) => s.n >= 0', date: DATE, author: 'harvest' }],
    precheck: null, events: [],
  };
  const r = precheckRecord(record, throwingArtifacts, { date: DATE });
  assert.equal(r.verdict, 'ERROR');
  assert.match(r.detail, /machine problem, not this candidate/);
  assert.match(r.detail, /BOOM/);
});

// ── finding 3 cluster: temporal modify is structured; confirm requires the check

test('temporal: modify takes a structured precedence revision and re-checks; free-form js is refused', () => {
  const ledger = { format: 'polynv-ledger/1', records: [] };
  mergeCandidates(ledger, [{
    id: 'mined:precedence:AMEND->CHARGE_SUCCEEDED', source: 'mined', target: 'temporal',
    nf: { kind: 'precedence', first: 'AMEND', then: 'CHARGE_SUCCEEDED' }, js: null,
    question: 'q', evidence: null,
  }], { date: DATE });
  const rec = ledger.records[0];

  // free-form js revision is pushed back with guidance
  assert.throws(() => applyDisposition(ledger, { id: rec.id, disposition: 'modify', author: 'jj', js: '(pre) => true' }, { date: DATE }), /structured precedence rule/);

  // confirm without a graph-checked pre-check is refused
  assert.throws(() => applyDisposition(ledger, { id: rec.id, disposition: 'confirm', author: 'jj' }, { date: DATE }), /not been graph-checked/);

  // structured revision lands as a real precedence nf and re-checks over the graph
  applyDisposition(ledger, { id: rec.id, disposition: 'modify', author: 'jj', js: '{"kind":"precedence","first":"CHARGE_SUCCEEDED","then":"SHIPMENT_COMPLETED"}' }, { date: DATE });
  assert.equal(rec.versions[rec.versions.length - 1].nf.kind, 'precedence');
  const r = precheckRecord(rec, artifacts, { date: DATE, graph });
  assert.equal(r.verdict, 'HOLDS');
  applyDisposition(ledger, { id: rec.id, disposition: 'confirm', author: 'jj' }, { date: DATE });
  assert.equal(rec.status, 'confirmed');
});

// ── finding: state-arity pushback and --target on survivor answers ──────────

test('modify: a 4-parameter predicate cannot be recorded as a state rule; survivors choose their shape', () => {
  const ledger = { format: 'polynv-ledger/1', records: [] };
  mergeCandidates(ledger, [
    { id: 'mutation-survivor:freeze:txId', source: 'mutation-survivor', target: 'transition', nf: null, js: null, question: 'q', evidence: null },
    { id: 'range:n', source: 'template', target: 'state', nf: { kind: 'range', field: 'n', min: 0, max: 2 }, js: '(s) => s.n >= 0 && s.n <= 2', question: 'q', evidence: null },
  ], { date: DATE });
  // a survivor (no predicate yet) can pick target 'state' with its answer
  const surv = applyDisposition(ledger, { id: 'mutation-survivor:freeze:txId', disposition: 'modify', author: 'jj', target: 'state', js: '(s) => s.txId !== "x"' }, { date: DATE });
  assert.equal(surv.target, 'state');
  // a state rule with transition arity is pushed back
  assert.throws(() => applyDisposition(ledger, { id: 'range:n', disposition: 'modify', author: 'jj', js: '(pre, action, data, post) => true' }, { date: DATE }), /state predicate takes \(s\)/);
  // a record WITH a predicate shape cannot be re-targeted
  assert.throws(() => applyDisposition(ledger, { id: 'range:n', disposition: 'modify', author: 'jj', target: 'transition', js: '(pre) => true' }, { date: DATE }), /already has a predicate shape/);
});

// ── finding: miners tolerate old-shape snapshots ────────────────────────────

test('miners: a snapshot missing a declared key excludes the field with a note, never crashes', () => {
  const base = graph.states.map(({ state }) => state);
  const corpus = [...base, ...base, ...base, ...base].map((s) => ({ ...s }));
  delete corpus[3].cancelReason; // one old-shape snapshot
  const { candidates, notes } = mineStateProperties(artifacts.contract, corpus, {});
  assert.ok(notes.some((n) => n.includes("'cancelReason' is missing")));
  assert.ok(!candidates.some((c) => c.id.includes('cancelReason')), 'partially-present field must not be mined');
  assert.ok(candidates.length > 0, 'other fields still mine');
});

// ── finding: vacuity generalizes beyond implications ────────────────────────

test('vacuousOverGraph: unreachable terminal-absorbing and reject-in-state guards are vacuous', () => {
  const stateKeys = ['orderState'];
  assert.equal(vacuousOverGraph({ kind: 'terminal-absorbing', key: 'orderState', value: 'no-such-terminal', stateKeys }, graph), true);
  assert.equal(vacuousOverGraph({ kind: 'terminal-absorbing', key: 'orderState', value: 'completed', stateKeys }, graph), false);
  assert.equal(vacuousOverGraph({ kind: 'reject-in-state', actions: ['CANCEL'], key: 'orderState', value: 'no-such-state', stateKeys }, graph), true);
  assert.equal(vacuousOverGraph({ kind: 'set-once', field: 'txId', empty: '' }, graph), false); // txId IS set on some path
});

// ── finding: grade refuses unfit machines; stamps its oracle ────────────────

test('grade: a throwing machine is refused; the grade carries the oracle hash', () => {
  const empty = { format: 'polynv-ledger/1', records: [] };
  assert.throws(() => runGrade(throwingArtifacts, empty, {}), /throws on .* explored step/);

  const g = runGrade(artifacts, { format: 'polynv-ledger/1', records: [] }, { maxMutants: 8 });
  assert.ok(g.ledgerOracleHash, 'grade must stamp the oracle it measured');
  assert.equal(g.ledgerOracleHash, oracleHashOf({ records: [] }));
});

// ── finding: stale/unreadable adequacy disclosed as such in the compat-report

test('compat-report: STALE and UNREADABLE adequacy variants render distinctly', () => {
  const classification = { changeId: 'c1', oldVersion: 'a', newVersion: 'b', lanes: ['semantic'], deferred: [], diffs: { vocabulary: { changed: false }, shape: { changed: false }, intent: { changed: false } } };
  const base = { classification, corpusInfo: { source: 'test', count: 1 }, gateResults: [{ gate: 'g', ok: true, summary: 's', failures: [] }] };
  assert.match(renderReport(buildReport({ ...base, adequacy: { measured: false, stale: true } })), /STALE — the invariants changed after the last/);
  assert.match(renderReport(buildReport({ ...base, adequacy: { measured: false, unreadable: 'Unexpected token' } })), /UNREADABLE — an intent-ledger\.json is present but could not be parsed/);
});

// ── M3: intent-diff provenance annotation in the compat-report ──────────────

test('compat-report: intent diff annotates elicitation provenance when a ledger exists', () => {
  const classification = {
    changeId: 'c1', oldVersion: 'a', newVersion: 'b', lanes: ['intent'], deferred: [],
    diffs: { vocabulary: { changed: false }, shape: { changed: false }, intent: { changed: true, added: ['terminal-absorbing:completed', 'hand-added-rule'], removed: [], renamed: [], edited: false } },
  };
  const base = { classification, corpusInfo: { source: 'test', count: 1 }, gateResults: [{ gate: 'g', ok: true, summary: 's', failures: [] }] };
  const intentProvenance = { 'terminal-absorbing:completed': { status: 'confirmed', by: 'jj' } };

  const withLedger = renderReport(buildReport({ ...base, intentProvenance }));
  assert.match(withLedger, /terminal-absorbing:completed \(elicited: confirmed by jj\)/);
  assert.match(withLedger, /hand-added-rule \(no ledger record — unelicited\)/);

  // no ledger → no annotation (absence of a ledger is not evidence)
  const withoutLedger = renderReport(buildReport(base));
  assert.match(withoutLedger, /invariants added: terminal-absorbing:completed, hand-added-rule\n/);
});

// ── findings via CLI: stale-file cleanup, flag guard ────────────────────────

test('cli: reopening the last confirmed rule REMOVES the generated invariants.mjs; a value-less flag errors instead of swallowing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'polynv-rf-'));
  cpSync(orderV1, dir, { recursive: true });
  const run = (...a) => execFileSync(process.execPath, [cli, ...a], { encoding: 'utf-8' });

  run('harvest', '--artifacts', dir);
  const out = join(dir, 'inv.polynv.mjs');
  run('record', '--artifacts', dir, '--id', 'terminal-absorbing:completed', '--disposition', 'confirm', '--author', 'jj', '--out', out);
  assert.ok(existsSync(out));

  // modify reopens the ONLY confirmed rule → the generated file must go, not linger
  const mod = run('record', '--artifacts', dir, '--id', 'terminal-absorbing:completed', '--disposition', 'modify', '--author', 'jj',
    '--js', '(pre, action, data, post) => pre.orderState !== "completed" || post.orderState === "completed"', '--out', out);
  assert.match(mod, /removed .*inv\.polynv\.mjs/);
  assert.ok(!existsSync(out), 'stale generated invariants must not keep enforcing retracted rules');

  // a forgotten flag value must not consume the next flag as its value
  let failed = false;
  try { run('record', '--artifacts', dir, '--id', 'set-once:txId', '--disposition', 'confirm', '--author', '--concern', 'note'); }
  catch (e) { failed = true; assert.match(String(e.stderr), /--author is required/); }
  assert.ok(failed, 'value-less --author must error, not attribute the disposition to "--concern"');
  const ledger = loadLedger(join(dir, 'intent-ledger.json'));
  assert.ok(!ledger.records.some((r) => r.events.some((e) => e.author === '--concern')));

  rmSync(dir, { recursive: true, force: true });
});
