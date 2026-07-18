// polynv M0 tests — node:test, deterministic, no API key.
// Run: node --test polynv/test/m0.test.mjs
//
// Fixture: the polyvers OMS order machine (examples/polyvers-oms/order-v1),
// copied to a scratch dir per test group so ledger writes never dirty the
// example. This doubles as the M0 worked example: how many of the
// hand-written invariants does the template harvest reach unaided?
'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, cpSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

import { loadArtifacts } from '../../polyvers/src/artifacts.mjs';
import { check } from '../../scripts/check.mjs';
import { compile, renderJs, HELPERS_SRC } from '../src/nf.mjs';
import { harvestTemplates } from '../src/templates.mjs';
import {
  loadLedger, mergeCandidates, applyDisposition,
  generateInvariants, findRecord, GENERATED_MARKER,
} from '../src/ledger.mjs';
import { precheckRecord } from '../src/precheck.mjs';
import { openQuestions, questionPayload } from '../src/questions.mjs';
import { buildStatus, renderLog } from '../src/report.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'bin', 'polynv.mjs');
const orderV1 = join(here, '..', '..', 'examples', 'polyvers-oms', 'order-v1');

const scratchCopy = () => {
  const dir = mkdtempSync(join(tmpdir(), 'polynv-fix-'));
  cpSync(orderV1, dir, { recursive: true });
  return dir;
};

const DATE = '2026-07-18T00:00:00.000Z';

// One harvested + pre-checked ledger over the order machine, shared by the
// read-only tests below (pre-checking ~20 candidates runs ~20 small BFSes).
const artifacts = await loadArtifacts(orderV1);
const harvested = harvestTemplates(artifacts.contract, artifacts.manifest);
const sharedLedger = { format: 'polynv-ledger/1', records: [] };
mergeCandidates(sharedLedger, harvested.candidates, { date: DATE });
for (const r of sharedLedger.records) precheckRecord(r, artifacts, { date: DATE });

// ── harvest: the vocabulary generates the expected checklist ────────────────

test('harvest: templates cover terminals, typed fields, reject rules, effects', () => {
  const ids = harvested.candidates.map((c) => c.id);
  // one absorbing question per declared terminal state
  for (const t of ['completed', 'partiallyDelivered', 'rejected', 'paymentFailed', 'cancelled']) {
    assert.ok(ids.includes(`terminal-absorbing:${t}`), `missing terminal-absorbing:${t}`);
  }
  // typed prose that parses mechanically
  assert.ok(ids.includes('range:fulfillments'));
  assert.ok(ids.includes('nonneg:totalCents'));
  assert.ok(ids.includes('set-once:txId'));
  assert.ok(ids.includes('monotone:totalCents'));
  // reject-describing special rules — and ONLY those (rollup describes
  // increments, not a rejection; templating it would misread the contract)
  assert.ok(ids.includes('reject-in-state:cancel-blocked-while-charging'));
  assert.ok(ids.includes('reject-in-state:fulfillment-in-progress'));
  assert.ok(!ids.includes('reject-in-state:rollup'));
  // the unparseable reject rule is a NOTE, never a silent skip
  assert.ok(harvested.notes.some((n) => n.includes('stale-completions-reject')));
  // effect vocabulary → emission questions
  assert.ok(ids.includes('emission-at-most-once:chargeCard'));
  assert.ok(ids.includes('emission-at-most-once:fraudCheck'));
});

test('nf: compile and renderJs agree for every harvested candidate', () => {
  for (const c of harvested.candidates) {
    if (c.target === 'emission') { assert.equal(renderJs(c.nf), null); continue; }
    const { target, pred } = compile(c.nf);
    assert.equal(target, c.target, c.id);
    assert.equal(typeof pred, 'function', c.id);
    // the rendered JS must itself compile to a function of the same arity
    const rendered = new Function(`return (${c.js})`)();
    assert.equal(typeof rendered, 'function', c.id);
    assert.equal(rendered.length, pred.length, c.id);
  }
});

// ── pre-check: verdicts carry the dialog ────────────────────────────────────

test('precheck: terminal-absorbing holds; monotone totals fail with a counterexample', () => {
  const holds = findRecord(sharedLedger, 'terminal-absorbing:completed');
  assert.equal(holds.precheck.verdict, 'HOLDS');
  assert.ok(holds.precheck.statesExplored > 0);

  // AMEND legitimately lowers totalCents (2500 → 1900) and fulfillments —
  // the monotone template must FAIL with the concrete story attached.
  for (const id of ['monotone:totalCents', 'monotone:fulfillments']) {
    const fails = findRecord(sharedLedger, id);
    assert.equal(fails.precheck.verdict, 'FAILS', id);
    assert.ok(fails.precheck.counterexample.length > 0, `${id} has no counterexample`);
  }

  // contract-anchored reject rules are real machine behavior
  assert.equal(findRecord(sharedLedger, 'reject-in-state:cancel-blocked-while-charging').precheck.verdict, 'HOLDS');
  // emission candidates cannot be pre-checked at M0 — explicit NOT-RUN
  assert.equal(findRecord(sharedLedger, 'emission-at-most-once:chargeCard').precheck.verdict, 'NOT-RUN');
});

test('questions: counterexamples rank first; payload carries the story', () => {
  const open = openQuestions(sharedLedger);
  assert.ok(open.length >= 10);
  assert.equal(open[0].precheck.verdict, 'FAILS', 'highest-information question first');
  const lastRanks = open.map((r) => r.precheck?.verdict ?? 'NOT-RUN');
  assert.equal(lastRanks[lastRanks.length - 1], 'NOT-RUN', 'unpre-checkable emission questions last');
  const p = questionPayload(open[0]);
  assert.ok(Array.isArray(p.counterexample) && p.counterexample[0].startsWith('init'));
});

// ── dispositions and the ledger lifecycle ───────────────────────────────────

test('ledger: confirm/reject/defer/modify lifecycle, append-only events', () => {
  const ledger = structuredClone(sharedLedger);

  // confirm a HOLDS record
  applyDisposition(ledger, { id: 'terminal-absorbing:completed', disposition: 'confirm', author: 'jj' }, { date: DATE });
  assert.equal(findRecord(ledger, 'terminal-absorbing:completed').status, 'confirmed');

  // reject a FAILS record (the behavior — an amend lowering the total — is intended)
  applyDisposition(ledger, { id: 'monotone:totalCents', disposition: 'reject', author: 'jj', concern: 'AMEND may lower the total; the reset is deliberate' }, { date: DATE });
  assert.equal(findRecord(ledger, 'monotone:totalCents').status, 'rejected');

  // defer with an assignee; questions --for filters to them
  applyDisposition(ledger, { id: 'emission-at-most-once:chargeCard', disposition: 'defer', author: 'jj', assign: 'payments-lead', concern: 'needs the payments owner' }, { date: DATE });
  const forPayments = openQuestions(ledger, { assignee: 'payments-lead' });
  assert.deepEqual(forPayments.map((r) => r.id), ['emission-at-most-once:chargeCard']);

  // modify reopens and versions; the old precheck is dropped with the old predicate
  const rec = applyDisposition(ledger, { id: 'monotone:totalCents', disposition: 'modify', author: 'kd', js: '(pre, action, data, post) => post.totalCents >= 0' }, { date: DATE });
  assert.equal(rec.status, 'open');
  assert.equal(rec.versions.length, 2);
  assert.equal(rec.precheck, null);

  // terminal-status guards: confirm on a rejected record is refused
  assert.throws(() => applyDisposition(ledger, { id: 'terminal-absorbing:completed', disposition: 'reject', author: 'jj' }, { date: DATE }), /not open/);
  // attribution is mandatory
  assert.throws(() => applyDisposition(ledger, { id: 'set-once:txId', disposition: 'confirm' }, { date: DATE }), /--author/);
  // a non-parsing revision is pushed back, not recorded
  assert.throws(() => applyDisposition(ledger, { id: 'set-once:txId', disposition: 'modify', author: 'jj', js: 'not a function' }, { date: DATE }), /parse/);
});

test('ledger: re-harvest never re-proposes any record, whatever its status', () => {
  const ledger = structuredClone(sharedLedger);
  applyDisposition(ledger, { id: 'monotone:totalCents', disposition: 'abandon', author: 'jj' }, { date: DATE });
  const { added, skipped } = mergeCandidates(ledger, harvested.candidates, { date: DATE });
  assert.equal(added.length, 0);
  assert.equal(skipped.length, harvested.candidates.length);
});

// ── generated invariants: consumable by the checker ─────────────────────────

test('generateInvariants: confirmed rules compile and re-check clean', async () => {
  const ledger = structuredClone(sharedLedger);
  for (const id of ['terminal-absorbing:completed', 'set-once:txId', 'range:fulfillments', 'reject-in-state:cancel-blocked-while-charging']) {
    applyDisposition(ledger, { id, disposition: 'confirm', author: 'jj' }, { date: DATE });
  }
  applyDisposition(ledger, { id: 'emission-at-most-once:chargeCard', disposition: 'confirm', author: 'jj' }, { date: DATE });

  const { code, count, emissionOnly } = generateInvariants(ledger, { helpersSrc: HELPERS_SRC });
  assert.equal(count, 4);
  assert.deepEqual(emissionOnly.map((r) => r.id), ['emission-at-most-once:chargeCard']);
  assert.ok(code.startsWith(GENERATED_MARKER));

  const dir = mkdtempSync(join(tmpdir(), 'polynv-gen-'));
  const path = join(dir, 'invariants.mjs');
  writeFileSync(path, code);
  const mod = await import(pathToFileURL(path).href);
  assert.equal(mod.stateInvariants.length, 1);
  assert.equal(mod.transitionInvariants.length, 3);
  const result = check({ specModule: artifacts.module, contract: artifacts.contract, invariants: mod });
  assert.equal(result.ok, true, JSON.stringify(result.violations));
  rmSync(dir, { recursive: true, force: true });
});

// ── report: convergence is a verdict over the ledger ────────────────────────

test('report: PARTIAL with open records, CONVERGED when all terminal; findings named', () => {
  const ledger = structuredClone(sharedLedger);
  let s = buildStatus(ledger);
  assert.equal(s.verdict, 'PARTIAL');
  assert.ok(s.adequacyGrade.includes('NOT MEASURED'));

  for (const r of ledger.records.filter((x) => x.status === 'open')) {
    applyDisposition(ledger, { id: r.id, disposition: r.id === 'monotone:totalCents' ? 'confirm' : 'abandon', author: 'jj' }, { date: DATE });
  }
  // M2 semantics: all-dispositioned but ungraded is still PARTIAL —
  // convergence requires the adequacy grade (plan §3)
  s = buildStatus(ledger);
  assert.equal(s.verdict, 'PARTIAL');
  assert.ok(s.adequacyGrade.includes('NOT MEASURED'));
  ledger.grade = { killed: 1, distinct: 1, survivors: [], dropped: 0 };
  s = buildStatus(ledger);
  assert.equal(s.verdict, 'CONVERGED');
  // a confirmed-but-FAILS record is a named finding
  assert.deepEqual(s.findings, ['monotone:totalCents']);
  // the empty ledger is PARTIAL, never a vacuous CONVERGED
  assert.equal(buildStatus({ format: 'polynv-ledger/1', records: [] }).verdict, 'PARTIAL');

  const log = renderLog(ledger);
  assert.ok(log.includes('## monotone:totalCents — **confirmed**'));
  assert.ok(log.includes('system of record'));
});

// ── CLI end-to-end on a scratch copy ────────────────────────────────────────

test('cli: harvest → questions → record → report round-trip; hand-written invariants guarded', () => {
  const dir = scratchCopy();
  const run = (...a) => execFileSync(process.execPath, [cli, ...a], { encoding: 'utf-8' });

  const h = run('harvest', '--artifacts', dir);
  assert.match(h, /candidate\(s\) added/);
  assert.ok(existsSync(join(dir, 'intent-ledger.json')));

  const next = JSON.parse(run('questions', '--artifacts', dir, '--next', '--json'));
  assert.equal(next.precheck, 'FAILS');

  // confirming must NOT clobber the fixture's hand-written invariants.mjs
  const before = readFileSync(join(dir, 'invariants.mjs'), 'utf-8');
  const rec = run('record', '--artifacts', dir, '--id', 'terminal-absorbing:completed', '--disposition', 'confirm', '--author', 'jj');
  assert.match(rec, /confirmed/);
  assert.match(rec, /NOT written/);
  assert.equal(readFileSync(join(dir, 'invariants.mjs'), 'utf-8'), before);

  // --out writes the generated artifact elsewhere
  const out = join(dir, 'invariants.polynv.mjs');
  run('record', '--artifacts', dir, '--id', 'set-once:txId', '--disposition', 'confirm', '--author', 'jj', '--out', out);
  assert.ok(readFileSync(out, 'utf-8').startsWith(GENERATED_MARKER));

  // add a domain prior in-session, with provenance
  const added = run('add', '--artifacts', dir, '--id', 'prior:no-charge-without-fraud-pass', '--target', 'transition',
    '--question', 'Payments norm: can a charge ever be recorded without the fraud check having passed?',
    '--js', '(pre, action, data, post) => !(action === "CHARGE_SUCCEEDED" && post.txId !== pre.txId) || pre.orderState === "charging"',
    '--author', 'claude', '--source', 'domain-prior', '--domain', 'payments', '--norm', 'no capture without authorization', '--model', 'claude-fable-5');
  assert.match(added, /prior:no-charge-without-fraud-pass/);
  const ledger = loadLedger(join(dir, 'intent-ledger.json'));
  const prior = findRecord(ledger, 'prior:no-charge-without-fraud-pass');
  assert.equal(prior.provenance.domain, 'payments');
  assert.equal(prior.precheck.verdict, 'HOLDS');

  // report: PARTIAL (open records remain) → exit 1; --log renders the view
  let failed = false;
  try { execFileSync(process.execPath, [cli, 'report', '--artifacts', dir, '--log'], { encoding: 'utf-8' }); }
  catch (e) { failed = true; assert.match(String(e.stdout), /PARTIAL/); }
  assert.ok(failed, 'PARTIAL report must exit nonzero (no-silent-clean)');
  assert.ok(existsSync(join(dir, 'INTENT-LOG.md')));

  rmSync(dir, { recursive: true, force: true });
});
