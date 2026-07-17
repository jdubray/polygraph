// polyvers M0 tests — node:test, deterministic, no API key.
// Run: node --test polyvers/test/m0.test.mjs
'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { loadArtifacts } from '../src/artifacts.mjs';
import { classify } from '../src/classify.mjs';
import { loadCorpus, synthesizeCorpus } from '../src/corpus.mjs';
import { loadGate, shapeRoundtripGate, vocabularyGate, invariantsPointwiseGate } from '../src/gates.mjs';
import { buildReport, renderReport } from '../src/report.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fix = (name) => join(here, 'fixtures', name);
const cli = join(here, '..', 'bin', 'polyvers.mjs');

const load = async (name) => loadArtifacts(fix(name));

// ── classification ──────────────────────────────────────────────────────────

test('classify: identical dirs are identical, no lanes', async () => {
  const a = await load('order-v1');
  const b = await load('order-v1');
  const c = classify(a, b);
  assert.equal(c.identical, true);
  assert.deepEqual(c.lanes, []);
});

test('classify: rule-only module edit → semantic lane only', async () => {
  const c = classify(await load('order-v1'), await load('order-v2-rules'));
  assert.deepEqual(c.lanes, ['semantic']);
  assert.ok(c.gates.includes('shape-roundtrip'));
  assert.ok(c.deferred.some((d) => d.gate === 'semantic-model-check' && d.milestone === 'M1'));
});

test('classify: renamed action → vocabulary + semantic, rename flagged', async () => {
  const c = classify(await load('order-v1'), await load('order-v2-renamed'));
  assert.deepEqual(c.lanes.sort(), ['semantic', 'vocabulary']);
  assert.deepEqual(c.diffs.vocabulary.actions.removed, ['SHIP']);
  assert.deepEqual(c.diffs.vocabulary.actions.added, ['DISPATCH']);
  assert.equal(c.diffs.vocabulary.actions.possibleRenames.length, 1);
});

test('classify: new state key → shape + semantic', async () => {
  const c = classify(await load('order-v1'), await load('order-v2-shape'));
  assert.deepEqual(c.lanes.sort(), ['semantic', 'shape']);
  assert.deepEqual(c.diffs.shape.added, ['trackingId']);
});

test('classify: invariants-only change → intent lane only', async () => {
  const c = classify(await load('order-v1'), await load('order-v2-stricter'));
  assert.deepEqual(c.lanes, ['intent']);
  assert.deepEqual(c.diffs.intent.added, ['total-positive']);
  assert.equal(c.diffs.moduleChanged, false);
});

test('classify: changeId is deterministic', async () => {
  const c1 = classify(await load('order-v1'), await load('order-v2-rules'));
  const c2 = classify(await load('order-v1'), await load('order-v2-rules'));
  assert.equal(c1.changeId, c2.changeId);
});

// ── corpus ──────────────────────────────────────────────────────────────────

test('synthesize: BFS over the old machine yields its full reachable set', async () => {
  const a = await load('order-v1');
  const { entries, truncated } = synthesizeCorpus(a.module);
  // pending, charging, fulfilling, completed, cancelled(from pending),
  // cancelled(from charging, totalCents 2500) — 6 distinct states.
  assert.equal(entries.length, 6);
  assert.equal(truncated, false);
  assert.ok(entries.every((e) => e.source === 'synthesized'));
});

test('synthesize: cap reports truncation instead of passing silently', async () => {
  const a = await load('order-v1');
  const { entries, truncated } = synthesizeCorpus(a.module, { maxStates: 2 });
  assert.equal(truncated, true);
  assert.ok(entries.length <= 2);
});

test('loadCorpus: polyrun archive ndjson, bare ndjson, json array — deduped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'polyvers-corpus-'));
  try {
    // polyrun archive shape: header {archived}, then journal rows
    writeFileSync(join(dir, 'a.ndjson'), [
      JSON.stringify({ archived: { instance_id: 'i-1', state: { orderState: 'completed', totalCents: 2500, txId: 'tx-1' } } }),
      JSON.stringify({ seq: 1, step_kind: 'accepted', post: { orderState: 'charging', totalCents: 2500, txId: '' } }),
      JSON.stringify({ seq: 2, step_kind: 'rejected', post: { orderState: 'charging', totalCents: 2500, txId: '' } }), // rejected → skipped
    ].join('\n'));
    // bare states, one a duplicate of the archive's journal row
    writeFileSync(join(dir, 'b.ndjson'),
      JSON.stringify({ totalCents: 2500, orderState: 'charging', txId: '' }) + '\n'); // key order differs — still a dup
    writeFileSync(join(dir, 'c.json'),
      JSON.stringify([{ orderState: 'pending', totalCents: 0, txId: '' }]));
    const corpus = loadCorpus(dir);
    assert.equal(corpus.length, 3); // completed, charging, pending — dup collapsed
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── gates ───────────────────────────────────────────────────────────────────

test('gates: rule-only change passes shape + invariants over the old fleet', async () => {
  const [oldA, newA] = [await load('order-v1'), await load('order-v2-rules')];
  const corpus = synthesizeCorpus(oldA.module).entries;
  assert.equal(loadGate(newA).ok, true);
  assert.equal(shapeRoundtripGate(newA, corpus).ok, true);
  assert.equal(invariantsPointwiseGate(newA, corpus).ok, true);
});

test('gates: removed action fails the vocabulary gate with the deprecation move', async () => {
  const [oldA, newA] = [await load('order-v1'), await load('order-v2-renamed')];
  const c = classify(oldA, newA);
  const g = vocabularyGate(oldA, newA, c.diffs);
  assert.equal(g.ok, false);
  assert.ok(g.failures.some((f) => f.message.includes("'SHIP'") && f.message.includes('deprecate')));
});

test('gates: old-manifest wiring into a dropped action fails the vocabulary gate', async () => {
  const [oldA, newA] = [await load('order-v1'), await load('order-v2-renamed')];
  // Simulate: the OLD manifest wires a completion into an action the new
  // module no longer exports.
  const oldWithWiring = { ...oldA, manifest: { effects: { ship: { onSuccess: { action: 'SHIP' } } } } };
  const c = classify(oldA, newA);
  const g = vocabularyGate(oldWithWiring, newA, c.diffs);
  assert.ok(g.failures.some((f) => f.message.includes("effect 'ship'") && f.message.includes('poison')));
});

test('gates: shape change fails round-trip on every old snapshot', async () => {
  const [oldA, newA] = [await load('order-v1'), await load('order-v2-shape')];
  const corpus = synthesizeCorpus(oldA.module).entries;
  const g = shapeRoundtripGate(newA, corpus);
  assert.equal(g.ok, false);
  assert.equal(g.failures.length, corpus.length); // every v1 snapshot lacks trackingId
});

test('gates: strengthened invariant names the fleet states it condemns', async () => {
  const [oldA, newA] = [await load('order-v1'), await load('order-v2-stricter')];
  const corpus = synthesizeCorpus(oldA.module).entries;
  const g = invariantsPointwiseGate(newA, corpus);
  assert.equal(g.ok, false);
  // init (totalCents 0) and cancelled-from-pending (totalCents 0)
  assert.equal(g.failures.length, 2);
  assert.ok(g.failures.every((f) => f.message.includes("'total-positive'")));
});

// ── report + CLI ────────────────────────────────────────────────────────────

test('report: deterministic — same inputs, byte-identical output', async () => {
  const [oldA, newA] = [await load('order-v1'), await load('order-v2-stricter')];
  const make = () => {
    const c = classify(oldA, newA);
    const corpus = synthesizeCorpus(oldA.module).entries;
    const gates = [loadGate(newA), invariantsPointwiseGate(newA, corpus)];
    const r = buildReport({ classification: c, corpusInfo: { source: 'synthesized', count: corpus.length }, gateResults: gates });
    return JSON.stringify(r) + renderReport(r);
  };
  assert.equal(make(), make());
});

const runCli = (cliArgs) => {
  try {
    return { stdout: execFileSync(process.execPath, [cli, ...cliArgs], { encoding: 'utf-8' }), code: 0 };
  } catch (err) {
    return { stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? ''), code: err.status };
  }
};

test('cli: check passes the semantic fixture (exit 0) and fails the renamed one (exit 1)', () => {
  const pass = runCli(['check', '--old', fix('order-v1'), '--new', fix('order-v2-rules'), '--synthesize']);
  assert.equal(pass.code, 0);
  assert.ok(pass.stdout.includes('Verdict: PASS'));
  const fail = runCli(['check', '--old', fix('order-v1'), '--new', fix('order-v2-renamed'), '--synthesize']);
  assert.equal(fail.code, 1);
  assert.ok(fail.stdout.includes('Verdict: FAIL'));
  assert.ok(fail.stdout.includes('NOT RUN (M2)')); // deferred gates are disclosed
});

test('cli: --out writes compat-report.json and .md under the changeId', () => {
  const dir = mkdtempSync(join(tmpdir(), 'polyvers-out-'));
  try {
    const r = runCli(['check', '--old', fix('order-v1'), '--new', fix('order-v2-rules'), '--synthesize', '--out', dir, '--json']);
    assert.equal(r.code, 0);
    const report = JSON.parse(r.stdout);
    const j = JSON.parse(readFileSync(join(dir, report.changeId, 'compat-report.json'), 'utf-8'));
    assert.equal(j.verdict, 'PASS');
    assert.ok(readFileSync(join(dir, report.changeId, 'compat-report.md'), 'utf-8').includes('# polyvers compat-report'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cli: an empty corpus is refused, never a vacuous PASS', () => {
  const dir = mkdtempSync(join(tmpdir(), 'polyvers-empty-'));
  try {
    writeFileSync(join(dir, 'states.json'), '[]');
    const r = runCli(['check', '--old', fix('order-v1'), '--new', fix('order-v2-rules'), '--snapshots', join(dir, 'states.json')]);
    assert.equal(r.code, 1);
    assert.ok(r.stderr.includes('vacuous'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
