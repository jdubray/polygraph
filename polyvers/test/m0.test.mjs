// polyvers M0 tests — node:test, deterministic, no API key.
// Run: node --test polyvers/test/m0.test.mjs
'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { loadArtifacts, invariantsOf } from '../src/artifacts.mjs';
import { classify } from '../src/classify.mjs';
import { loadCorpus, synthesizeCorpus } from '../src/corpus.mjs';
import { loadGate, shapeRoundtripGate, vocabularyGate, invariantDiffGate, invariantsPointwiseGate, semanticModelCheckGate, migrateGate, stimuliGate } from '../src/gates.mjs';
import { buildReport, renderReport } from '../src/report.mjs';
import { runMatrix, discoverSpawns } from '../src/matrix.mjs';
import { check } from '../../scripts/check.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fix = (name) => join(here, 'fixtures', name);
const cli = join(here, '..', 'bin', 'polyvers.mjs');

const load = async (name) => loadArtifacts(fix(name));

// A scratch copy of a fixture dir the test can mutate.
const scratchCopy = (name) => {
  const dir = mkdtempSync(join(tmpdir(), 'polyvers-fix-'));
  cpSync(fix(name), dir, { recursive: true });
  return dir;
};

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
  assert.ok(c.gates.includes('semantic-model-check')); // live as of M1, no longer deferred
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
  assert.deepEqual(c.diffs.intent.added, ['state:total-positive']);
  assert.equal(c.diffs.moduleChanged, false);
});

test('classify: changeId is deterministic', async () => {
  const c1 = classify(await load('order-v1'), await load('order-v2-rules'));
  const c2 = classify(await load('order-v1'), await load('order-v2-rules'));
  assert.equal(c1.changeId, c2.changeId);
});

test('classify: reformatting contract.json fires no lane (stable comparison)', async () => {
  const dir = scratchCopy('order-v1');
  try {
    // Reorder keys + reformat — semantically identical contract.
    const c = JSON.parse(readFileSync(join(dir, 'contract.json'), 'utf-8'));
    const reordered = Object.fromEntries(Object.entries(c).reverse());
    writeFileSync(join(dir, 'contract.json'), JSON.stringify(reordered));
    const cls = classify(await load('order-v1'), await loadArtifacts(dir));
    assert.equal(cls.identical, false); // bytes differ
    assert.deepEqual(cls.lanes, []);    // but nothing semantic changed
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('classify: removing a terminal state fires the vocabulary lane and fails the gate', async () => {
  const dir = scratchCopy('order-v1');
  try {
    const c = JSON.parse(readFileSync(join(dir, 'contract.json'), 'utf-8'));
    c.terminalStates = c.terminalStates.filter((s) => s !== 'cancelled');
    writeFileSync(join(dir, 'contract.json'), JSON.stringify(c, null, 2));
    const oldA = await load('order-v1');
    const newA = await loadArtifacts(dir);
    const cls = classify(oldA, newA);
    assert.ok(cls.lanes.includes('vocabulary'));
    assert.deepEqual(cls.diffs.vocabulary.terminal.removed, ['cancelled']);
    const g = vocabularyGate(oldA, newA, cls.diffs);
    assert.ok(g.failures.some((f) => f.message.includes("'cancelled'") && f.message.includes('no longer terminal')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('classify: invariant rename (identical predicate) is a rename, not a weakening', async () => {
  const dir = scratchCopy('order-v1');
  try {
    const src = readFileSync(join(dir, 'invariants.mjs'), 'utf-8');
    writeFileSync(join(dir, 'invariants.mjs'), src.replace("name: 'total-nonnegative'", "name: 'total-nonneg'"));
    const cls = classify(await load('order-v1'), await loadArtifacts(dir));
    assert.deepEqual(cls.lanes, ['intent']);
    assert.deepEqual(cls.diffs.intent.renamed, [{ from: 'state:total-nonnegative', to: 'state:total-nonneg' }]);
    assert.deepEqual(cls.diffs.intent.removed, []);
    const g = invariantDiffGate(cls.diffs);
    assert.equal(g.ok, true); // a rename must not FAIL as 'weakening'
    assert.ok(g.summary.includes('renamed'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('classify: deleting a transition invariant is a removal, never a mere edit', async () => {
  const dir = scratchCopy('order-v1');
  try {
    const src = readFileSync(join(dir, 'invariants.mjs'), 'utf-8');
    writeFileSync(join(dir, 'invariants.mjs'), src.slice(0, src.indexOf('export const transitionInvariants')));
    const cls = classify(await load('order-v1'), await loadArtifacts(dir));
    assert.deepEqual(cls.diffs.intent.removed, ['transition:total-never-decreases']);
    const g = invariantDiffGate(cls.diffs);
    assert.equal(g.ok, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('classify: gates demanded by several lanes are deduped', async () => {
  // module + invariants change → semantic AND intent lanes; both demand
  // semantic-model-check, the classification must list it once.
  const dir = scratchCopy('order-v2-rules');
  try {
    cpSync(fix('order-v2-stricter/invariants.mjs'), join(dir, 'invariants.mjs'));
    const cls = classify(await load('order-v1'), await loadArtifacts(dir));
    assert.deepEqual(cls.lanes.sort(), ['intent', 'semantic']);
    assert.equal(cls.gates.filter((g) => g === 'semantic-model-check').length, 1);
    assert.deepEqual(cls.deferred, []); // nothing deferred for these lanes as of M1
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── artifacts ───────────────────────────────────────────────────────────────

test('artifacts: an invariants.mjs exporting no invariants is refused, never vacuous', async () => {
  const dir = scratchCopy('order-v1');
  try {
    writeFileSync(join(dir, 'invariants.mjs'), 'export default [];\n');
    await assert.rejects(() => loadArtifacts(dir), /exports no invariants/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('artifacts: transition invariants are loaded alongside state invariants', async () => {
  const a = await load('order-v1');
  assert.equal(a.invariants.length, 2);
  assert.equal(a.transitionInvariants.length, 1);
});

// ── corpus ──────────────────────────────────────────────────────────────────

test('synthesize: BFS over the old machine yields its full reachable set', async () => {
  const a = await load('order-v1');
  const { entries, truncated } = synthesizeCorpus(a.module);
  // pending, charging, fulfilling, completed, cancelled(from pending),
  // cancelled(from charging, totalCents 2500) — 6 distinct states.
  assert.equal(entries.length, 6);
  assert.equal(truncated, false);
  assert.ok(entries.every((e) => e.source === 'synthesized' && typeof e.key === 'string'));
});

test('synthesize: cap reports truncation instead of passing silently', async () => {
  const a = await load('order-v1');
  const { entries, truncated } = synthesizeCorpus(a.module, { maxStates: 2 });
  assert.equal(truncated, true);
  assert.ok(entries.length <= 2);
});

test('synthesize: a throwing action narrows the corpus with a note, never aborts', async () => {
  const dir = scratchCopy('order-v1');
  try {
    const src = readFileSync(join(dir, 'next.cjs'), 'utf-8');
    writeFileSync(join(dir, 'next.cjs'), src.replace(
      "if (model.orderState !== 'fulfilling') return reject('not-fulfilling');",
      "throw new Error('SHIP handler defect');"));
    const a = await loadArtifacts(dir);
    const { entries, notes } = synthesizeCorpus(a.module);
    assert.ok(entries.length >= 4); // exploration continued past the throwing action
    assert.ok(notes.some((n) => n.includes('SHIP') && n.includes('threw')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('loadCorpus: polyrun archive ndjson, bare ndjson, json array — deduped, relative ids', () => {
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
    // ids are RELATIVE (no machine-local absolute paths in reports)
    assert.ok(corpus.every((e) => !e.id.includes(tmpdir())));
    assert.ok(corpus.some((e) => e.id === 'a.ndjson#archived:i-1'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadCorpus: a bare state dump with a truthy `archived` field is not misrouted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'polyvers-corpus2-'));
  try {
    writeFileSync(join(dir, 'dump.ndjson'), [
      JSON.stringify({ docState: 'filed', archived: true }),
      JSON.stringify({ docState: 'open', archived: false }),
    ].join('\n'));
    const corpus = loadCorpus(dir);
    assert.equal(corpus.length, 2); // both bare states survive, none parsed as archive header
    assert.ok(corpus.every((e) => e.state.docState !== undefined));
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
  assert.ok(fail.stdout.includes('stimuli | **FAIL**')); // the live M2 gate catches the removed action too
});

test('cli: --out writes compat-report.json and .md under the changeId', () => {
  const dir = mkdtempSync(join(tmpdir(), 'polyvers-out-'));
  try {
    const r = runCli(['check', '--old', fix('order-v1'), '--new', fix('order-v2-rules'), '--synthesize', '--out', dir, '--json']);
    assert.equal(r.code, 0);
    const report = JSON.parse(r.stdout);
    const j = JSON.parse(readFileSync(join(dir, report.changeId, 'compat-report.json'), 'utf-8'));
    assert.equal(j.verdict, 'PASS');
    assert.equal(j.milestone, 'M3'); // the ONE milestone constant, not prose
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

test('cli: a cosmetic contract edit reports "no lane fired", never a PASS over zero gates', () => {
  const dir = scratchCopy('order-v1');
  try {
    const c = JSON.parse(readFileSync(join(dir, 'contract.json'), 'utf-8'));
    writeFileSync(join(dir, 'contract.json'), JSON.stringify(Object.fromEntries(Object.entries(c).reverse())));
    const r = runCli(['check', '--old', fix('order-v1'), '--new', dir]);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes('no lane fired'));
    assert.ok(!r.stdout.includes('Verdict'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── M1: the semantic gate (model check from fleet snapshots) ────────────────

test('m1: rule-only change passes the semantic gate over the old fleet', async () => {
  const [oldA, newA] = [await load('order-v1'), await load('order-v2-rules')];
  const corpus = synthesizeCorpus(oldA.module).entries;
  const g = semanticModelCheckGate(newA, corpus);
  assert.equal(g.ok, true);
  assert.ok(g.summary.includes('fleet snapshot'));
});

test('m1: THE LANDMINE — pointwise passes, from-init check passes, only the seeded check catches it', async () => {
  const newA = await load('order-v2-landmine');
  const corpus = loadCorpus(fix('landmine-fleet.json'));

  // The old-fleet snapshot {charging, totalCents: 500} satisfies every
  // invariant pointwise (it is not fulfilling)...
  assert.equal(invariantsPointwiseGate(newA, corpus).ok, true);

  // ...and the NEW machine is clean when explored from init() alone — SUBMIT
  // now floors totals at 1000, so no low-total state is init-reachable...
  const fromInit = check({ specModule: newA.module, contract: newA.contract, invariants: invariantsOf(newA) });
  assert.equal(fromInit.ok, true);

  // ...but seeding the fleet states finds CHARGE_OK driving the old
  // charging-500 snapshot into 'fulfilling' below the new minimum.
  const g = semanticModelCheckGate(newA, corpus);
  assert.equal(g.ok, false);
  const f = g.failures.find((x) => x.message.includes("'fulfilling-total-minimum'"));
  assert.ok(f, 'the strengthened rule must be the violation');
  assert.ok(f.message.includes('CHARGE_OK'), 'counterexample names the driving action');
  assert.ok(f.id.includes('landmine-fleet.json#0'), 'failure names the seeding snapshot');
});

test('m1: BOUNDED exploration is a failure unless explicitly accepted', async () => {
  const [oldA, newA] = [await load('order-v1'), await load('order-v2-rules')];
  // One mid-flight snapshot as the whole corpus: the machine's remaining
  // reachable space must be DISCOVERED, and a cap of 2 truncates that
  // discovery (seeds themselves are cap-exempt).
  const corpus = synthesizeCorpus(oldA.module).entries.slice(1, 2);
  const bounded = semanticModelCheckGate(newA, corpus, { maxStates: 2 });
  assert.equal(bounded.ok, false);
  assert.ok(bounded.failures.some((f) => f.message.includes('BOUNDED')));
  const accepted = semanticModelCheckGate(newA, corpus, { maxStates: 2, allowBounded: true });
  assert.equal(accepted.ok, true); // no violations in the truncated space, and the operator accepted the bound
});

test('m1: seeds do not consume the exploration cap — a fleet at the cap still explores', async () => {
  const [oldA, newA] = [await load('order-v1'), await load('order-v2-rules')];
  const corpus = synthesizeCorpus(oldA.module).entries; // 6 snapshots
  // A cap far below the fleet size: before the fix this was a guaranteed
  // BOUNDED failure with ZERO transitions tried; now the cap bounds only
  // what the BFS discovers beyond the seeds.
  const g = semanticModelCheckGate(newA, corpus, { maxStates: 2 });
  assert.equal(g.ok, true);
  assert.ok(!g.failures.some((f) => f.message.includes('BOUNDED')));
});

test('m1: counterexamples carry the data payloads', async () => {
  const newA = await load('order-v2-landmine');
  const corpus = loadCorpus(fix('landmine-fleet.json'));
  const g = semanticModelCheckGate(newA, corpus);
  const f = g.failures.find((x) => x.message.includes("'fulfilling-total-minimum'"));
  assert.ok(f.message.includes('CHARGE_OK({'), 'steps render as action(data), not bare action names');
});

test('m1: a nondeterministic new machine fails with the real finding, not a fabricated counterexample', async () => {
  const dir = scratchCopy('order-v2-rules');
  try {
    const src = readFileSync(join(dir, 'next.cjs'), 'utf-8');
    writeFileSync(join(dir, 'next.cjs'), src.replace(
      "model.txId = String(p.txId || '');",
      'model.txId = String(Math.random());'));
    const oldA = await load('order-v1');
    const newA = await loadArtifacts(dir);
    const corpus = synthesizeCorpus(oldA.module).entries;
    const g = semanticModelCheckGate(newA, corpus);
    assert.equal(g.ok, false);
    const f = g.failures.find((x) => x.message.includes('deterministic-exploration'));
    assert.ok(f, 'the nondeterminism finding is reported');
    assert.ok(!f.message.includes('counterexample'), 'no fabricated root-state counterexample');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('m1: a version with no invariants at all is refused by the intent gates, never vacuous', async () => {
  const dir = scratchCopy('order-v2-rules');
  try {
    rmSync(join(dir, 'invariants.mjs'));
    const oldA = await load('order-v1');
    const newA = await loadArtifacts(dir);
    const corpus = synthesizeCorpus(oldA.module).entries;
    const sem = semanticModelCheckGate(newA, corpus);
    assert.equal(sem.ok, false);
    assert.ok(sem.failures[0].message.includes('no invariants'));
    const pw = invariantsPointwiseGate(newA, corpus);
    assert.equal(pw.ok, false);
    assert.ok(pw.failures[0].message.includes('no invariants'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('m1: check.mjs --initial-states rejects malformed input as a usage error, not machine findings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'polyvers-seeds-'));
  try {
    writeFileSync(join(dir, 'bad.json'), '["charging", 42]'); // state NAMES, not state objects
    const checkCli = join(here, '..', '..', 'scripts', 'check.mjs');
    const v1 = fix('order-v1');
    let code = 0, stderr = '';
    try {
      execFileSync(process.execPath, [checkCli,
        '--spec', join(v1, 'next.cjs'), '--contract', join(v1, 'contract.json'),
        '--initial-states', join(dir, 'bad.json')], { encoding: 'utf-8' });
    } catch (err) { code = err.status; stderr = String(err.stderr ?? ''); }
    assert.equal(code, 2);
    assert.ok(stderr.includes('not a state object'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('m1: cli end-to-end — the landmine pair fails check with the semantic gate', () => {
  const r = runCli(['check', '--old', fix('order-v1'), '--new', fix('order-v2-landmine'), '--snapshots', fix('landmine-fleet.json')]);
  assert.equal(r.code, 1);
  assert.ok(r.stdout.includes('semantic-model-check | **FAIL**'));
  assert.ok(r.stdout.includes('fulfilling-total-minimum'));
  assert.ok(!r.stdout.includes('NOT RUN (M1)')); // the gate is live, not deferred
});

// ── M2: the migration lane + the stimuli gate ───────────────────────────────

test('m2: a shape change without migrate.cjs fails the migrate gate with the scaffold hint', async () => {
  const [oldA, newA] = [await load('order-v1'), await load('order-v2-shape')];
  const corpus = synthesizeCorpus(oldA.module).entries;
  const g = migrateGate(newA, corpus);
  assert.equal(g.ok, false);
  assert.ok(g.failures[0].message.includes('polyvers migrate scaffold'));
  assert.equal(g.migratedCorpus, null);
});

test('m2: a valid migration validates and yields the migrated corpus', async () => {
  const [oldA, newA] = [await load('order-v1'), await load('order-v2-shape-migrated')];
  const corpus = synthesizeCorpus(oldA.module).entries;
  const g = migrateGate(newA, corpus);
  assert.equal(g.ok, true);
  assert.equal(g.migratedCorpus.length, corpus.length);
  assert.ok(g.migratedCorpus.every((e) => e.state.trackingId === ''));
  // ...and the migrated fleet passes the gates the raw fleet failed:
  assert.equal(shapeRoundtripGate(newA, g.migratedCorpus).ok, true);
  assert.equal(shapeRoundtripGate(newA, corpus).ok, false);
});

// The migrate gate has two failure kinds and they must NOT share a fate.
// Until 2026-07 both returned migratedCorpus:null, so a migration that was
// pure, accepted and projection-equal — but whose output violated a new rule —
// suppressed every downstream corpus gate and told the operator the corpus was
// "unmigrated old-shape" when it was neither. That is the archetypal fleet
// case (a narrowed domain the live fleet already violates), and it is exactly
// when the pointwise population and the reachability answer are most needed.
test('m2: a well-formed migration whose OUTPUT violates a rule still yields the migrated corpus', async () => {
  const [oldA, newA] = [await load('order-v1'), await load('order-v2-shape-migrated')];
  const corpus = synthesizeCorpus(oldA.module).entries;
  const unhappy = { ...newA, invariants: [{ name: 'never-holds', pred: () => false }] };
  const g = migrateGate(unhappy, corpus);
  assert.equal(g.ok, false, 'the violated rule must still fail the gate');
  assert.ok(g.failures.every((f) => f.message.includes('never-holds')));
  // ...but the corpus is complete and usable, so downstream gates can run.
  assert.ok(g.migratedCorpus, 'an invariant failure must not withhold the corpus');
  assert.equal(g.migratedCorpus.length, corpus.length);
  assert.ok(g.summary.includes('the migration is not the defect'));
});

test('m2: a STRUCTURAL migration failure withholds the corpus', async () => {
  const [oldA, newA] = [await load('order-v1'), await load('order-v2-shape-migrated')];
  const corpus = synthesizeCorpus(oldA.module).entries;
  const broken = { ...newA, migrate: () => { throw new Error('boom'); } };
  const g = migrateGate(broken, corpus);
  assert.equal(g.ok, false);
  assert.equal(g.migratedCorpus, null, 'a throwing migration leaves the corpus unmigrated');
  assert.ok(g.summary.includes('FAILED STRUCTURALLY'));
  // Nondeterminism is structural too — the fleet would migrate irreproducibly.
  let n = 0;
  const flaky = { ...newA, migrate: (s) => ({ ...s, trackingId: String(n++) }) };
  assert.equal(migrateGate(flaky, corpus).migratedCorpus, null);
});

test('m2: cli end-to-end — shape change + migration passes the full pipeline over migrated states', () => {
  const r = runCli(['check', '--old', fix('order-v1'), '--new', fix('order-v2-shape-migrated'), '--synthesize']);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes('Verdict: PASS'));
  assert.ok(r.stdout.includes('migrate | PASS'));
  assert.ok(r.stdout.includes('migrated through the new version'));
  assert.ok(!r.stdout.includes('NOT RUN')); // every lane's gates are live as of M2
});

test('m2: scaffold generates a working migration for a pure-addition shape change', async () => {
  const dir = scratchCopy('order-v2-shape'); // no migrate.cjs yet
  try {
    const r = runCli(['migrate', 'scaffold', '--old', fix('order-v1'), '--new', dir]);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes('scaffold is complete'));
    assert.ok(readFileSync(join(dir, 'migrate.cjs'), 'utf-8').includes('"trackingId"'));
    assert.ok(readFileSync(join(dir, 'MIGRATION-NOTE.md'), 'utf-8').includes('MIGRATION-NOTE'));
    // The scaffolded migration must itself pass the migrate gate.
    const [oldA, newA] = [await load('order-v1'), await loadArtifacts(dir)];
    const corpus = synthesizeCorpus(oldA.module).entries;
    assert.equal(migrateGate(newA, corpus).ok, true);
    // Refuse silent overwrite.
    const again = runCli(['migrate', 'scaffold', '--old', fix('order-v1'), '--new', dir]);
    assert.equal(again.code, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('m2: scaffold refuses when there is no shape difference', () => {
  const r = runCli(['migrate', 'scaffold', '--old', fix('order-v1'), '--new', fix('order-v2-rules')]);
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes('no shape difference'));
});

test('m2: stimuli gate — old-version stimuli land as verified behavior on a rule-only change', async () => {
  const [oldA, newA] = [await load('order-v1'), await load('order-v2-rules')];
  const corpus = synthesizeCorpus(oldA.module).entries;
  const g = stimuliGate(oldA, newA, corpus);
  assert.equal(g.ok, true); // every delivery is accepted or a NAMED reject
});

test('m2: stimuli gate — a removed action is undefined behavior, one witness per failure class', async () => {
  const [oldA, newA] = [await load('order-v1'), await load('order-v2-renamed')];
  const corpus = synthesizeCorpus(oldA.module).entries;
  const g = stimuliGate(oldA, newA, corpus);
  assert.equal(g.ok, false);
  const shipFailures = g.failures.filter((f) => f.message.includes("'SHIP'"));
  assert.equal(shipFailures.length, 1); // deduped: one witness, not corpus × domain entries
  assert.ok(shipFailures[0].message.includes('action surface'));
});

test('m2-review: scaffolding into a custom-named-machine dir does not brick it', async () => {
  const dir = scratchCopy('order-v1');
  try {
    // machine at a custom name (valid via the single-.cjs fallback)…
    cpSync(join(dir, 'next.cjs'), join(dir, 'order.cjs'));
    rmSync(join(dir, 'next.cjs'));
    await loadArtifacts(dir); // loads via fallback
    // …then a migration lands beside it — the dir must STAY loadable.
    writeFileSync(join(dir, 'migrate.cjs'), "'use strict';\nmodule.exports.migrate = (s) => ({ ...s });\n");
    const a = await loadArtifacts(dir);
    assert.equal(typeof a.migrate, 'function');
    assert.equal(typeof a.module.init, 'function'); // order.cjs, not migrate.cjs
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('m2-review: a migrate.cjs-only change fires the migration lane, never "cosmetic"', async () => {
  const dir = scratchCopy('order-v2-shape-migrated');
  try {
    const src = readFileSync(join(dir, 'migrate.cjs'), 'utf-8');
    writeFileSync(join(dir, 'migrate.cjs'), src.replace("trackingId: '',", "trackingId: 'MIGRATED',"));
    const cls = classify(await load('order-v2-shape-migrated'), await loadArtifacts(dir));
    assert.deepEqual(cls.lanes, ['migration']);
    assert.ok(cls.gates.includes('migrate'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('m2-review: the migration transition is checked against transition invariants', async () => {
  const dir = scratchCopy('order-v2-shape-migrated');
  try {
    // A migration that halves totals performs exactly the transition
    // 'total-never-decreases' forbids — every state invariant still holds.
    writeFileSync(join(dir, 'migrate.cjs'), [
      "'use strict';",
      'module.exports.migrate = function migrate(oldState) {',
      '  return { orderState: oldState.orderState, totalCents: Math.floor(oldState.totalCents / 2), txId: oldState.txId, trackingId: "" };',
      '};',
    ].join('\n'));
    const oldA = await load('order-v1');
    const newA = await loadArtifacts(dir);
    const corpus = synthesizeCorpus(oldA.module).entries;
    const g = migrateGate(newA, corpus);
    assert.equal(g.ok, false);
    assert.ok(g.failures.some((f) => f.message.includes("'total-never-decreases'") && f.message.includes('migration transition')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('m2-review: many-to-one migrations dedup the migrated corpus, first id wins', async () => {
  const dir = scratchCopy('order-v2-shape-migrated');
  try {
    // Collapse totals upward: the two distinct cancelled states (totals 0 and
    // 2500) migrate to one state — no invariant is violated (totals only rise).
    writeFileSync(join(dir, 'migrate.cjs'), [
      "'use strict';",
      'module.exports.migrate = function migrate(oldState) {',
      '  return { orderState: oldState.orderState, totalCents: Math.max(oldState.totalCents, 2500), txId: oldState.txId, trackingId: "" };',
      '};',
    ].join('\n'));
    const oldA = await load('order-v1');
    const newA = await loadArtifacts(dir);
    const corpus = synthesizeCorpus(oldA.module).entries;
    const g = migrateGate(newA, corpus);
    assert.equal(g.ok, true);
    assert.ok(g.migratedCorpus.length < corpus.length, 'duplicates collapsed');
    const keys = g.migratedCorpus.map((e) => e.key);
    assert.equal(new Set(keys).size, keys.length, 'no duplicate keys survive');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('m2-review: stimuli gate catches mutate-then-reject (production poison class)', async () => {
  const dir = scratchCopy('order-v2-rules');
  try {
    const src = readFileSync(join(dir, 'next.cjs'), 'utf-8');
    writeFileSync(join(dir, 'next.cjs'), src.replace(
      "if (model.orderState !== 'pending') return reject('not-cancellable');",
      "if (model.orderState !== 'pending') { model.totalCents = 1; return reject('not-cancellable'); }"));
    const oldA = await load('order-v1');
    const newA = await loadArtifacts(dir);
    const corpus = synthesizeCorpus(oldA.module).entries;
    const g = stimuliGate(oldA, newA, corpus);
    assert.equal(g.ok, false);
    assert.ok(g.failures.some((f) => f.message.includes('mutates the observable model and then rejects')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('m2-review: scaffold works contracts-only (new module need not exist yet)', () => {
  const dir = scratchCopy('order-v2-shape');
  try {
    rmSync(join(dir, 'next.cjs')); // contract-first authoring: no module yet
    const r = runCli(['migrate', 'scaffold', '--old', fix('order-v1'), '--new', dir]);
    assert.equal(r.code, 0);
    assert.ok(readFileSync(join(dir, 'migrate.cjs'), 'utf-8').includes('"trackingId"'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('m2-review: when migration fails, downstream corpus gates are refused, not noisy', () => {
  const dir = scratchCopy('order-v2-shape');
  try {
    // shape + vocabulary lanes together (rename SHIP too), still no migrate.cjs:
    for (const f of ['contract.json', 'next.cjs']) {
      writeFileSync(join(dir, f), readFileSync(join(dir, f), 'utf-8').replaceAll('SHIP', 'DISPATCH'));
    }
    const r = runCli(['check', '--old', fix('order-v1'), '--new', dir, '--synthesize']);
    assert.equal(r.code, 1);
    assert.ok(r.stdout.includes('polyvers migrate scaffold')); // the real cause, front and center
    assert.ok(r.stdout.includes('refused: the corpus could not be migrated'));
    assert.ok(!r.stdout.includes('could not deliver')); // no per-action setup noise
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── M3: the cross-machine version matrix + the composition lane ─────────────

test('m3: matrix — same versions everywhere, all four pairings pass', async () => {
  const [po, ship] = [await load('po-v1'), await load('ship-v1')];
  const result = runMatrix({ parentOld: po, parentNew: po, childOld: ship, childNew: ship, childMachineId: 'shipment' });
  assert.equal(result.ok, true);
  assert.equal(result.cells.length, 4);
  assert.ok(result.cells.every((c) => c.ok));
});

test('m3: matrix — a renamed child cancel action fails exactly the child-new pairings', async () => {
  const [po, shipOld, shipNew] = [await load('po-v1'), await load('ship-v1'), await load('ship-v2-renamed')];
  const result = runMatrix({ parentOld: po, parentNew: po, childOld: shipOld, childNew: shipNew, childMachineId: 'shipment' });
  assert.equal(result.ok, false);
  const verdicts = Object.fromEntries(result.cells.map((c) => [c.pairing, c.ok]));
  assert.equal(verdicts['parent-old × child-old'], true);
  assert.equal(verdicts['parent-new × child-old'], true);
  assert.equal(verdicts['parent-old × child-new'], false);
  assert.equal(verdicts['parent-new × child-new'], false);
  const failing = result.cells.find((c) => !c.ok);
  assert.ok(failing.failures.some((f) => f.message.includes("onParentTerminal 'CANCEL_SHIPMENT'") && f.message.includes('poison the child')));
});

test('m3: matrix — a wrong child id is refused, never a vacuous PASS', async () => {
  const [po, ship] = [await load('po-v1'), await load('ship-v1')];
  const result = runMatrix({ parentOld: po, parentNew: po, childOld: ship, childNew: ship, childMachineId: 'nope' });
  assert.equal(result.ok, false);
  assert.ok(result.cells.every((c) => c.failures.some((f) => f.message.includes('refusing'))));
});

test('m3: cli matrix — exit code is the verdict', () => {
  const pass = runCli(['matrix', '--parent-old', fix('po-v1'), '--parent-new', fix('po-v1'),
    '--child-old', fix('ship-v1'), '--child-new', fix('ship-v1'), '--child-id', 'shipment']);
  assert.equal(pass.code, 0);
  assert.ok(pass.stdout.includes('Verdict: PASS'));
  assert.ok(pass.stdout.includes('PROTOCOL and DELIVERY matrix')); // the honest scope note is part of every matrix report
  const fail = runCli(['matrix', '--parent-old', fix('po-v1'), '--parent-new', fix('po-v1'),
    '--child-old', fix('ship-v1'), '--child-new', fix('ship-v2-renamed'), '--child-id', 'shipment']);
  assert.equal(fail.code, 1);
  assert.ok(fail.stdout.includes('parent-old × child-new | **FAIL**'));
});

test('m3-review: a spawn without a childKey is a defect in every cell (kernel poisons on it)', async () => {
  const dir = scratchCopy('po-v1');
  try {
    const src = readFileSync(join(dir, 'effects.cjs'), 'utf-8');
    writeFileSync(join(dir, 'effects.cjs'), src.replace("childKey: 'c1',\n", ''));
    const po = await loadArtifacts(dir);
    const ship = await load('ship-v1');
    const result = runMatrix({ parentOld: po, parentNew: po, childOld: ship, childNew: ship, childMachineId: 'shipment' });
    assert.equal(result.ok, false);
    assert.ok(result.cells.every((c) => c.failures.some((f) => f.message.includes('without a childKey'))));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('m3-review: spawns emitted on identity-accepted steps are discovered (kernel parity)', async () => {
  const dir = scratchCopy('po-v1');
  try {
    // PING: accepted but state-identical; the mapper spawns on the ACTION —
    // the kernel runs the mapper on every accepted step, so must the walk.
    let mod = readFileSync(join(dir, 'next.cjs'), 'utf-8');
    mod = mod.replace(
      "START: { action: (d = {}) => ({ ...d }), schema: {}, domain: [{}] },",
      "START: { action: (d = {}) => ({ ...d }), schema: {}, domain: [{}] },\n      PING: { action: (d = {}) => ({ ...d }), schema: {}, domain: [{}] },");
    mod = mod.replace(
      "START: (model) => (p, { reject }) => {",
      "PING: (model) => (p, { reject }) => { model.poState = model.poState; },\n      START: (model) => (p, { reject }) => {");
    writeFileSync(join(dir, 'next.cjs'), mod);
    let fx = readFileSync(join(dir, 'effects.cjs'), 'utf-8');
    fx = fx.replace(
      "const out = [];",
      "const out = [];\n  if (action === 'PING') out.push({ kind: 'spawnChild', machineId: 'pinger', childKey: 'p1', onComplete: 'CHILD_DONE' });");
    writeFileSync(join(dir, 'effects.cjs'), fx);
    const po = await loadArtifacts(dir);
    const { spawns } = discoverSpawns(po);
    assert.ok(spawns.some((s) => s.machineId === 'pinger'), 'identity-accept spawn discovered');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('m3-review: a truncated matrix is BOUNDED — failing unless explicitly accepted', async () => {
  const [po, ship] = [await load('po-v1'), await load('ship-v1')];
  const bounded = runMatrix({ parentOld: po, parentNew: po, childOld: ship, childNew: ship, childMachineId: 'shipment', maxStates: 3 });
  assert.equal(bounded.bounded, true);
  assert.equal(bounded.ok, false); // cells may pass, but a truncated space is not a pass
  const accepted = runMatrix({ parentOld: po, parentNew: po, childOld: ship, childNew: ship, childMachineId: 'shipment', maxStates: 3, allowBounded: true });
  assert.equal(accepted.ok, true);
});

test('m3-review: missing terminal metadata is a metadata refusal, not a livelock diagnosis', async () => {
  const dir = scratchCopy('ship-v1');
  try {
    const c = JSON.parse(readFileSync(join(dir, 'contract.json'), 'utf-8'));
    delete c.terminalStates;
    writeFileSync(join(dir, 'contract.json'), JSON.stringify(c, null, 2));
    const po = await load('po-v1');
    const ship = await loadArtifacts(dir);
    const result = runMatrix({ parentOld: po, parentNew: po, childOld: ship, childNew: ship, childMachineId: 'shipment' });
    assert.equal(result.ok, false);
    const f = result.cells[0].failures.find((x) => x.message.includes('declares no terminalStates'));
    assert.ok(f, 'refusal names the missing metadata');
    assert.ok(!f.message.includes('await them forever'), 'no phantom livelock diagnosis');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('m3-review: completion delivery carries the DISCOVERED childKey', async () => {
  const [po, ship] = [await load('po-v1'), await load('ship-v1')];
  const { spawns } = discoverSpawns(po);
  assert.equal(spawns[0].childKey, 'c1'); // and checkPairing delivers {childKey: 'c1', ...} — asserted via the all-pass matrix
  const result = runMatrix({ parentOld: po, parentNew: po, childOld: ship, childNew: ship, childMachineId: 'shipment' });
  assert.equal(result.ok, true);
});

test('m3: an effects.cjs-only change fires the composition lane with an honest NOT RUN row', async () => {
  const dir = scratchCopy('po-v1');
  try {
    const src = readFileSync(join(dir, 'effects.cjs'), 'utf-8');
    writeFileSync(join(dir, 'effects.cjs'), src.replace("childKey: 'c1'", "childKey: 'c-1'"));
    const cls = classify(await load('po-v1'), await loadArtifacts(dir));
    assert.deepEqual(cls.lanes, ['composition']);
    // The check run: the load gate needs no corpus, and the report must
    // disclose that the composition's real gate lives in polyrun.
    const r = runCli(['check', '--old', fix('po-v1'), '--new', dir]);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes('not required by these lanes')); // corpus-not-needed path, alive again
    assert.ok(r.stdout.includes('NOT RUN (polyrun)'));           // deferred rendering, alive again
    assert.ok(r.stdout.includes('check-effects'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('cli: a vocabulary-only change needs no corpus... unless the live stimuli gate demands one', () => {
  const dir = scratchCopy('order-v1');
  try {
    // dataDomain tweak: vocabulary lane only (no module/invariant edit).
    const c = JSON.parse(readFileSync(join(dir, 'contract.json'), 'utf-8'));
    c.dataDomain.SUBMIT.totalCents = [2500, 9900];
    writeFileSync(join(dir, 'contract.json'), JSON.stringify(c, null, 2));
    // As of M2 the vocabulary lane includes the stimuli gate, which replays
    // old stimuli over fleet states — a corpus IS required now.
    const r = runCli(['check', '--old', fix('order-v1'), '--new', dir, '--synthesize']);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes('stimuli | PASS'));
    assert.ok(r.stdout.includes('Verdict: PASS'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
