// polynv M1 tests — node:test, deterministic, no API key.
// Run: node --test polynv/test/m1.test.mjs
//
// Covers the two M0 retrofits (consequence machinery, grammar kinds), the
// two miners with confidence thresholds, pruning/vacuity, the temporal
// pre-check, and the LLM prompt/parser (parser only — no network).
'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { loadArtifacts } from '../../polyvers/src/artifacts.mjs';
import { compile, renderJs, canon } from '../src/nf.mjs';
import { enumerateGraph, violationsOf, consequenceDiff, checkPrecedence } from '../src/consequences.mjs';
import { mineStateProperties, mineTemporal, pruneCandidates, vacuousOverGraph } from '../src/miners.mjs';
import { precheckRecord } from '../src/precheck.mjs';
import { buildPrompt, parseCandidates } from '../src/llm.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'bin', 'polynv.mjs');
const orderV1 = join(here, '..', '..', 'examples', 'polyvers-oms', 'order-v1');

const artifacts = await loadArtifacts(orderV1);
const graph = enumerateGraph(artifacts);

// ── retrofit A: the reachable graph and consequence machinery ───────────────

test('enumerateGraph: states and edges, init first, no error', () => {
  assert.equal(graph.error, null);
  assert.ok(graph.states.length >= 5, `only ${graph.states.length} states`);
  assert.ok(graph.edges.length > graph.states.length);
  const init = graph.states.find((s) => s.key === graph.initKey);
  assert.equal(init.state.orderState, 'pending');
  // identity edges (rejects) are present but marked unchanged
  assert.ok(graph.edges.some((e) => !e.changed));
  assert.ok(graph.edges.some((e) => e.changed));
});

test('violationsOf + consequenceDiff: a tightening reports newly-forbidden states', () => {
  // range 0..2 holds everywhere; tightening to 0..1 newly forbids the
  // fulfillments=2 states — exactly what the designer must scrutinize
  const loose = compile({ kind: 'range', field: 'fulfillments', min: 0, max: 2 });
  const tight = compile({ kind: 'range', field: 'fulfillments', min: 0, max: 1 });
  assert.equal(violationsOf(loose, graph).length, 0);
  const diff = consequenceDiff(loose, tight, graph);
  assert.ok(diff.newlyForbidden.length > 0);
  assert.equal(diff.newlyAllowed.length, 0);
  assert.ok(diff.newlyForbidden.every((v) => v.state.fulfillments === 2));
  // and the reverse revision reports the weakening
  const back = consequenceDiff(tight, loose, graph);
  assert.equal(back.newlyForbidden.length, 0);
  assert.ok(back.newlyAllowed.length > 0);
});

// ── retrofit B: grammar kinds compile/render in agreement ───────────────────

test('grammar: implication, in-domain, ordering compile and render consistently', () => {
  const kinds = [
    { kind: 'implication', when: { field: 'orderState', value: 'fulfilling' }, then: { field: 'txId', op: 'nonempty', value: null } },
    { kind: 'in-domain', field: 'cancelReason', values: ['', 'customer-request', 'suspicious'] },
    { kind: 'ordering', a: 'shipmentsDelivered', op: 'le', b: 'fulfillments' },
  ];
  for (const nf of kinds) {
    const { target, pred } = compile(nf);
    assert.equal(target, 'state');
    // rendered source must agree with the compiled predicate on every reachable state
    const rendered = new Function('canon', `return (${renderJs(nf)})`)(canon);
    for (const { state } of graph.states) assert.equal(rendered(state), pred(state), `${nf.kind} disagrees on ${JSON.stringify(state)}`);
  }
  // the hand-written 'fulfilling-implies-txid' is expressible in the grammar and HOLDS
  const impl = compile(kinds[0]);
  assert.equal(violationsOf(impl, graph).length, 0);
});

// ── miner 1: state properties with confidence thresholds ────────────────────

// Deterministic corpus: the reachable graph's own states, replicated to
// clear the confidence threshold without changing the property set.
const observed = graph.states.map(({ state }) => state);
const corpus = [...observed, ...observed, ...observed, ...observed];

test('mineStateProperties: SAM-tuned grammar over observations', () => {
  const { candidates } = mineStateProperties(artifacts.contract, corpus, {});
  const ids = candidates.map((c) => c.id);
  // the ordering the hand-written set encodes as rollup-counters-bounded
  assert.ok(ids.includes('mined:ordering:shipmentsDelivered<=fulfillments'), ids.join(', '));
  // the control-key implication the hand-written set encodes as fulfilling-implies-txid
  assert.ok(ids.includes('mined:implication:orderState=fulfilling:txId-set'), ids.join(', '));
  // observed numeric ranges
  assert.ok(ids.includes('mined:range:fulfillments'));
  // every mined candidate must carry observation counts as evidence
  for (const c of candidates) assert.ok(c.evidence.observations > 0, c.id);
  // and every compilable one must pre-check HOLDS against its own source graph
  for (const c of candidates) {
    const { pred, target } = compile(c.nf);
    assert.equal(target, 'state');
    for (const s of corpus) { let ok; try { ok = pred(s); } catch { ok = false; } assert.ok(ok, `${c.id} fails on its own corpus`); }
  }
});

test('mineStateProperties: below-threshold corpora propose nothing', () => {
  const small = observed.slice(0, 3);
  const { candidates, notes } = mineStateProperties(artifacts.contract, small, {});
  assert.equal(candidates.length, 0);
  assert.match(notes[0], /below the confidence threshold/);
});

// ── miner 2: temporal precedence + the graph pre-check ──────────────────────

const mkWindow = (scenario, action, pre, post) => ({ scenario, action, data: {}, pre, post });
const s = (orderState, extra = {}) => ({ orderState, fulfillments: 1, shipmentsDelivered: 0, shipmentsFailed: 0, totalCents: 2500, txId: '', cancelReason: '', ...extra });

test('mineTemporal: precedence mined from sequences; rejects are not occurrences', () => {
  const windows = [];
  for (const sc of ['s1', 's2', 's3']) {
    windows.push(mkWindow(sc, 'SUBMIT', s('pending'), s('fraudCheck')));
    windows.push(mkWindow(sc, 'CHARGE_SUCCEEDED', s('charging'), s('fulfilling', { txId: 'tx-1' })));
    // a rejected (identity) SHIPMENT_COMPLETED before the charge must NOT
    // count as an occurrence — same doctrine as the strict profile
    windows.push(mkWindow(sc, 'SHIPMENT_COMPLETED', s('fraudCheck'), s('fraudCheck')));
  }
  const { candidates } = mineTemporal(windows, { minScenarios: 3 });
  const ids = candidates.map((c) => c.id);
  assert.ok(ids.includes('mined:precedence:SUBMIT->CHARGE_SUCCEEDED'));
  assert.ok(!ids.some((id) => id.includes('SHIPMENT_COMPLETED')), 'identity windows must not mine');
});

test('mineTemporal: below-threshold patterns become notes, not questions', () => {
  const windows = [mkWindow('s1', 'SUBMIT', s('pending'), s('fraudCheck')), mkWindow('s1', 'CANCEL', s('fraudCheck'), s('cancelled'))];
  const { candidates, notes } = mineTemporal(windows, { minScenarios: 3 });
  assert.equal(candidates.length, 0);
  assert.ok(notes.some((n) => n.includes('below threshold')));
});

test('checkPrecedence: true precedence HOLDS, corpus-only precedence FAILS with a path', () => {
  // the machine genuinely cannot ship before charging
  assert.equal(checkPrecedence({ kind: 'precedence', first: 'CHARGE_SUCCEEDED', then: 'SHIPMENT_COMPLETED' }, graph).verdict, 'HOLDS');
  // a biased corpus might mine "AMEND precedes CHARGE_SUCCEEDED" — the
  // machine can charge without ever amending; the check must refute it
  const r = checkPrecedence({ kind: 'precedence', first: 'AMEND', then: 'CHARGE_SUCCEEDED' }, graph);
  assert.equal(r.verdict, 'FAILS');
  assert.equal(r.path[r.path.length - 1].action, 'CHARGE_SUCCEEDED');
  assert.ok(!r.path.some((step) => step.action === 'AMEND'));
});

test('precheckRecord: temporal target routes through the graph', () => {
  const record = {
    id: 'mined:precedence:AMEND->CHARGE_SUCCEEDED', source: 'mined', target: 'temporal',
    question: 'q', evidence: null, status: 'open', assign: null,
    versions: [{ nf: { kind: 'precedence', first: 'AMEND', then: 'CHARGE_SUCCEEDED' }, js: null, date: 'd', author: 'harvest' }],
    precheck: null, events: [],
  };
  const r = precheckRecord(record, artifacts, { date: 'd', graph });
  assert.equal(r.verdict, 'FAILS');
  assert.ok(record.precheck.counterexample.length > 0);
  // and without a graph the verdict is an explicit NOT-RUN, never a silent pass
  record.precheck = null;
  const r2 = precheckRecord(record, artifacts, { date: 'd' });
  assert.equal(r2.verdict, 'NOT-RUN');
});

// ── pruning and vacuity ─────────────────────────────────────────────────────

test('pruneCandidates: implication table and duplicate predicates', () => {
  const existing = [{ versions: [{ nf: { kind: 'range', field: 'fulfillments', min: 0, max: 2 }, js: renderJs({ kind: 'range', field: 'fulfillments', min: 0, max: 2 }) }] }];
  const cands = [
    { id: 'mined:nonneg:fulfillments', nf: { kind: 'nonneg', field: 'fulfillments' }, js: renderJs({ kind: 'nonneg', field: 'fulfillments' }) },       // implied by range min>=0
    { id: 'mined:range:fulfillments', nf: { kind: 'range', field: 'fulfillments', min: 0, max: 2 }, js: 'dup-differs' },                               // not tighter
    { id: 'mined:range2:fulfillments', nf: { kind: 'range', field: 'fulfillments', min: 1, max: 2 }, js: renderJs({ kind: 'range', field: 'fulfillments', min: 1, max: 2 }) }, // tighter — kept
  ];
  const { kept, pruned } = pruneCandidates(cands, existing);
  assert.deepEqual(kept.map((c) => c.id), ['mined:range2:fulfillments']);
  assert.equal(pruned.length, 2);
  assert.ok(pruned.every((p) => p.reason.length > 0));
});

test('vacuousOverGraph: unreachable antecedents are flagged', () => {
  assert.equal(vacuousOverGraph({ kind: 'implication', when: { field: 'orderState', value: 'no-such-state' }, then: { field: 'txId', op: 'nonempty', value: null } }, graph), true);
  assert.equal(vacuousOverGraph({ kind: 'implication', when: { field: 'orderState', value: 'fulfilling' }, then: { field: 'txId', op: 'nonempty', value: null } }, graph), false);
});

// ── LLM path: prompt and strict parser (no network) ─────────────────────────

test('llm: prompt names both tasks; parser drops malformed elements with notes', () => {
  const prompt = buildPrompt(artifacts.contract, { intent: 'an order machine' });
  assert.match(prompt, /DOMAIN PRIORS/);
  assert.match(prompt, /CODE READING/);
  assert.match(prompt, /ONLY a JSON array/);

  const reply = JSON.stringify([
    { id: 'prior:txid-immutable', kind: 'domain-prior', target: 'transition', question: 'q1', js: '(pre, a, d, post) => pre.txId === "" || post.txId === pre.txId', domain: 'payments', norm: 'a settled transaction id never changes' },
    { id: 'llm:bad-js', kind: 'code-reading', target: 'state', question: 'q2', js: 'not a function at all (' },
    { id: 'llm:bad-kind', kind: 'mystery', target: 'state', question: 'q3', js: '(s) => true' },
    { question: 'no id', js: '(s) => true', target: 'state', kind: 'code-reading' },
  ]);
  const { candidates, notes } = parseCandidates(reply, { model: 'test-model', date: 'd' });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].source, 'domain-prior');
  assert.equal(candidates[0].provenance.domain, 'payments');
  assert.equal(notes.length, 3);
  assert.throws(() => parseCandidates('nonsense', { model: 'm', date: 'd' }), /not a JSON array/);
});

// ── CLI: miners + consequence diff end-to-end ───────────────────────────────

test('cli: harvest --traces mines; record confirm/modify report consequences', () => {
  const dir = mkdtempSync(join(tmpdir(), 'polynv-m1-'));
  cpSync(orderV1, dir, { recursive: true });
  const run = (...a) => execFileSync(process.execPath, [cli, ...a], { encoding: 'utf-8' });

  // build a small trace dir from graph edges (deterministic corpus): every
  // changed edge once per scenario file, repeated to clear thresholds
  const tracesDir = join(dir, 'traces');
  mkdirSync(tracesDir);
  const stateByKey = new Map(graph.states.map(({ key, state }) => [key, state]));
  const changed = graph.edges.filter((e) => e.changed);
  for (let i = 0; i < 4; i++) {
    writeFileSync(join(tracesDir, `s${i}.ndjson`),
      changed.map((e) => JSON.stringify({ action: e.action, data: e.data, pre: stateByKey.get(e.preKey), post: stateByKey.get(e.postKey) })).join('\n') + '\n');
  }

  const h = run('harvest', '--artifacts', dir, '--traces', tracesDir);
  assert.match(h, /candidate\(s\) added/);
  assert.match(h, /pruned:/); // mined ranges vs template ranges overlap somewhere

  // confirm a template rule → consequences reported
  const rec = run('record', '--artifacts', dir, '--id', 'terminal-absorbing:completed', '--disposition', 'confirm', '--author', 'jj', '--out', join(dir, 'inv.polynv.mjs'));
  assert.match(rec, /consequences: forbids 0 currently-reachable/);

  // modify a range to a tighter bound → the diff names newly-forbidden states
  const mod = run('record', '--artifacts', dir, '--id', 'range:fulfillments', '--disposition', 'modify', '--author', 'jj',
    '--js', '(s) => typeof s.fulfillments === "number" && s.fulfillments >= 0 && s.fulfillments <= 1');
  assert.match(mod, /consequence diff vs the prior predicate/);
  assert.match(mod, /newly forbidden/);

  rmSync(dir, { recursive: true, force: true });
});
