// polynv completion tests — the recorded follow-ups closed at project
// completion: the shared-graph pre-check fast path (verdict parity with the
// full checker), the emission pre-check through check-effects, and the
// `drift` command (the version-bump re-interview diff, plan §10.6).
// node:test, deterministic, no API key. Run: node --test polynv/test/completion.test.mjs
'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, cpSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { loadArtifacts } from '../../polyvers/src/artifacts.mjs';
import { enumerateGraph } from '../src/consequences.mjs';
import { harvestTemplates } from '../src/templates.mjs';
import { applyDisposition, loadLedger } from '../src/ledger.mjs';
import { precheckRecord, precheckEmissionRecord } from '../src/precheck.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'bin', 'polynv.mjs');
const orderV1 = join(here, '..', '..', 'examples', 'polyvers-oms', 'order-v1');
const DATE = '2026-07-18T00:00:00.000Z';

const artifacts = await loadArtifacts(orderV1);
const graph = enumerateGraph(artifacts);

// ── fast path: verdict parity with the full checker ─────────────────────────

test('precheck fast path: graph verdicts match full-check verdicts for every template candidate', () => {
  const { candidates } = harvestTemplates(artifacts.contract, artifacts.manifest);
  for (const c of candidates.filter((x) => ['state', 'transition'].includes(x.target))) {
    const mk = () => ({
      id: c.id, source: c.source, target: c.target, question: c.question, evidence: null,
      status: 'open', assign: null,
      versions: [{ nf: c.nf, js: c.js, date: DATE, author: 'harvest' }],
      precheck: null, events: [],
    });
    const slow = mk(); precheckRecord(slow, artifacts, { date: DATE });          // full check()
    const fast = mk(); precheckRecord(fast, artifacts, { date: DATE, graph });   // shared graph
    assert.equal(fast.precheck.verdict, slow.precheck.verdict, c.id);
    if (slow.precheck.verdict === 'FAILS') {
      // shortest counterexamples: same length (paths may differ), same shape
      assert.equal(fast.precheck.counterexample.length, slow.precheck.counterexample.length, `${c.id} counterexample length`);
      assert.equal(fast.precheck.counterexample[0].action, null, c.id);
    }
  }
});

// ── emission pre-check through check-effects ────────────────────────────────

test('emission pre-check: runs the composition when the dir has one; NOT-RUN otherwise', async () => {
  const mk = (effect) => ({
    id: `emission-at-most-once:${effect}`, source: 'template', target: 'emission', question: 'q', evidence: null,
    status: 'open', assign: null,
    versions: [{ nf: { kind: 'emission-at-most-once', effect }, js: null, date: DATE, author: 'harvest' }],
    precheck: null, events: [],
  });
  // order-v1 ships effects.cjs + manifest — the check runs for real; any of
  // HOLDS/BOUNDED/FAILS is a REAL verdict (bounded exploration is disclosed,
  // not conflated) — the point is it is no longer NOT-RUN.
  const r = await precheckEmissionRecord(mk('chargeCard'), orderV1, { date: DATE });
  assert.ok(['HOLDS', 'BOUNDED', 'FAILS'].includes(r.verdict), `got ${r.verdict}: ${r.detail ?? r.note}`);
  assert.notEqual(r.verdict, 'NOT-RUN');

  // a dir without the composition keeps the explicit NOT-RUN
  const bare = mkdtempSync(join(tmpdir(), 'polynv-bare-'));
  cpSync(join(orderV1, 'contract.json'), join(bare, 'contract.json'));
  cpSync(join(orderV1, 'next.cjs'), join(bare, 'next.cjs'));
  const r2 = await precheckEmissionRecord(mk('chargeCard'), bare, { date: DATE });
  assert.equal(r2.verdict, 'NOT-RUN');
  rmSync(bare, { recursive: true, force: true });
});

// ── drift: the re-interview diff ────────────────────────────────────────────

test('cli drift: reports changed verdicts, reopens judged answers, keeps confirmed findings confirmed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'polynv-drift-'));
  cpSync(orderV1, dir, { recursive: true });
  const run = (a, opts = {}) => execFileSync(process.execPath, [cli, ...a], { encoding: 'utf-8', ...opts });

  run(['harvest', '--artifacts', dir]);
  // settle two records with FAKED stored verdicts so the machine "drifted":
  const lp = join(dir, 'intent-ledger.json');
  const ledger = loadLedger(lp);
  // terminal-absorbing:completed truly HOLDS — fake its stored verdict as FAILS
  const conf = ledger.records.find((r) => r.id === 'terminal-absorbing:completed');
  applyDisposition(ledger, { id: conf.id, disposition: 'confirm', author: 'jj' }, { date: DATE });
  conf.precheck = { verdict: 'FAILS', date: DATE };
  // monotone:totalCents truly FAILS — fake as HOLDS and reject it
  const rej = ledger.records.find((r) => r.id === 'monotone:totalCents');
  applyDisposition(ledger, { id: rej.id, disposition: 'reject', author: 'jj' }, { date: DATE });
  rej.precheck = { verdict: 'HOLDS', date: DATE };
  writeFileSync(lp, JSON.stringify(ledger, null, 2) + '\n');

  // report-only: names both changes, exits 1, writes nothing
  let out = '';
  try { run(['drift', '--artifacts', dir]); assert.fail('drift with changes must exit 1'); }
  catch (e) { out = String(e.stdout); }
  assert.match(out, /terminal-absorbing:completed \[confirmed\]: FAILS → HOLDS/);
  assert.match(out, /monotone:totalCents \[rejected\]: HOLDS → FAILS/);
  assert.equal(loadLedger(lp).records.find((r) => r.id === rej.id).status, 'rejected', 'report-only must not write');

  // --reopen: refreshes pre-checks, reopens the rejected record, keeps the confirmed one confirmed
  try { run(['drift', '--artifacts', dir, '--reopen', '--author', 'jj']); }
  catch (e) { out = String(e.stdout); }
  const after = loadLedger(lp);
  assert.equal(after.records.find((r) => r.id === rej.id).status, 'open', 'a judged answer whose behavior drifted is re-asked');
  assert.equal(after.records.find((r) => r.id === conf.id).status, 'confirmed', 'a confirmed rule stays confirmed');
  assert.equal(after.records.find((r) => r.id === conf.id).precheck.verdict, 'HOLDS', 'pre-check refreshed');
  assert.ok(after.records.find((r) => r.id === rej.id).events.some((e) => e.type === 'drift'));

  // steady state: no drift → exit 0
  const clean = run(['drift', '--artifacts', dir]);
  assert.match(clean, /no verdict changed/);

  rmSync(dir, { recursive: true, force: true });
});

// ── harvest end-to-end still green with the fast path + emission checks ─────

test('cli harvest: emission candidates now carry real verdicts on the OMS dir', () => {
  const dir = mkdtempSync(join(tmpdir(), 'polynv-fast-'));
  cpSync(orderV1, dir, { recursive: true });
  const out = execFileSync(process.execPath, [cli, 'harvest', '--artifacts', dir], { encoding: 'utf-8' });
  assert.match(out, /candidate\(s\) added/);
  const ledger = JSON.parse(readFileSync(join(dir, 'intent-ledger.json'), 'utf-8'));
  const emis = ledger.records.find((r) => r.id === 'emission-at-most-once:chargeCard');
  assert.notEqual(emis.precheck.verdict, 'NOT-RUN', `emission verdict: ${emis.precheck.verdict}`);
  rmSync(dir, { recursive: true, force: true });
});
