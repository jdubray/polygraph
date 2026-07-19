// Tier 1 runner — the seeded control (docs/fleet-study-plan.md §4).
//
// Runs every catalogue case through the REAL CLI (not the library) so the
// numbers describe the path a user actually takes, including exit codes and
// --json output. Each `check` case runs against BOTH corpus tiers:
//
//   archive     — a fleet snapshot corpus, which may contain states the old
//                 machine cannot reach (v0 residue, hot patches, manual edits)
//   synthesized — BFS-reachable states of the OLD machine, the weakest tier
//
// Reporting the two separately is the point: it quantifies the paper's claim
// that synthesis cannot see a landmine, instead of merely asserting it.
//
// Deterministic, no API key. Usage:
//   node eval/fleet-study/tier1/run.mjs [--json <out>] [--md <out>]
'use strict';

import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { CASES, COMPOSITION_CASES } from './cases.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..', '..');
const FIX = join(repo, 'polyvers', 'test', 'fixtures');
const CLI = join(repo, 'polyvers', 'bin', 'polyvers.mjs');
const fix = (p) => join(FIX, p);

/** Run the CLI, capture {json, exitCode, ms}. A gate failure exits 1 — that
 *  is a verdict, not an error, so a nonzero exit is captured, never thrown. */
function runCli(args) {
  const t0 = process.hrtime.bigint();
  let stdout = '', code = 0;
  try {
    stdout = execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    stdout = String(err.stdout ?? '');
    code = err.status ?? 1;
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  let json = null;
  try { json = JSON.parse(stdout); } catch { /* non-JSON path */ }
  return { json, code, ms };
}

const failedGates = (report) => (report?.gates ?? []).filter((g) => !g.ok).map((g) => g.gate);

/** Score one `check` run against the case's declared expectation. */
function score(c, report, tier) {
  if (!report) return { outcome: 'ERROR', detail: 'no JSON report' };
  const failed = failedGates(report);
  const flagged = report.verdict !== 'PASS';
  if (c.positive) {
    if (!flagged) return { outcome: 'MISSED', failed };
    if (c.expect.caughtBy && !failed.includes(c.expect.caughtBy)) {
      return { outcome: 'CAUGHT_BY_OTHER', failed, expected: c.expect.caughtBy };
    }
    return { outcome: 'CAUGHT', failed };
  }
  return flagged ? { outcome: 'FALSE_ALARM', failed } : { outcome: 'CLEAN', failed };
}

const results = { generatedBy: 'eval/fleet-study/tier1/run.mjs', check: [], composition: [] };

// ---- check cases × both corpus tiers ---------------------------------------
for (const c of CASES) {
  for (const tier of ['archive', 'synthesized']) {
    const corpusArgs = tier === 'archive' ? ['--snapshots', fix(c.fleet)] : ['--synthesize'];
    const { json, code, ms } = runCli(['check', '--old', fix(c.old), '--new', fix(c.new), ...corpusArgs, '--json']);
    const s = score(c, json, tier);
    const predicted = c.expectByTier?.[tier] ?? null;
    results.check.push({
      id: c.id, lane: c.lane, positive: c.positive, taxonomy: c.taxonomy ?? null, tier,
      outcome: s.outcome, expectedGate: c.expect.caughtBy ?? null, failedGates: s.failed ?? [],
      predictedByTier: predicted,
      predictionHeld: predicted === null ? null : predicted === s.outcome,
      verdict: json?.verdict ?? null, exitCode: code,
      corpus: json?.corpus?.count ?? null, ms: Math.round(ms),
    });
  }
}

// ---- composition cases: matrix must pass where product fails ---------------
for (const c of COMPOSITION_CASES) {
  const base = ['--parent-old', fix(c.parentOld), '--parent-new', fix(c.parentNew),
                '--child-old', fix(c.childOld), '--child-new', fix(c.childNew), '--child-id', c.childId];
  const m = runCli(['matrix', ...base]);
  const p = runCli(['product', ...base, '--parent-id', c.parentId, '--invariants', fix(c.invariants), '--json']);
  const matrixVerdict = m.code === 0 ? 'PASS' : 'FAIL';
  const productVerdict = p.json ? (p.json.ok ? 'PASS' : 'FAIL') : (p.code === 0 ? 'PASS' : 'FAIL');
  results.composition.push({
    id: c.id, lane: c.lane, positive: c.positive,
    matrix: matrixVerdict, product: productVerdict,
    matrixHeld: matrixVerdict === c.expect.matrix,
    productHeld: productVerdict === c.expect.product,
    msMatrix: Math.round(m.ms), msProduct: Math.round(p.ms),
  });
}

// ---- aggregate --------------------------------------------------------------
const byTier = (tier) => results.check.filter((r) => r.tier === tier);
const summary = {};
for (const tier of ['archive', 'synthesized']) {
  const rows = byTier(tier);
  const pos = rows.filter((r) => r.positive), neg = rows.filter((r) => !r.positive);
  const caught = pos.filter((r) => r.outcome === 'CAUGHT').length;
  summary[tier] = {
    positives: pos.length,
    caught,
    caughtByOtherGate: pos.filter((r) => r.outcome === 'CAUGHT_BY_OTHER').length,
    missed: pos.filter((r) => r.outcome === 'MISSED').length,
    recall: pos.length ? +(caught / pos.length).toFixed(3) : null,
    negatives: neg.length,
    falseAlarms: neg.filter((r) => r.outcome === 'FALSE_ALARM').length,
    totalMs: rows.reduce((a, r) => a + r.ms, 0),
  };
}
summary.predictionsHeld = results.check.filter((r) => r.predictionHeld === true).length;
summary.predictionsBroken = results.check.filter((r) => r.predictionHeld === false).length;
summary.compositionHeld = results.composition.every((r) => r.matrixHeld && r.productHeld);
results.summary = summary;

// ---- render -----------------------------------------------------------------
const L = [];
L.push('# Fleet study · Tier 1 — seeded control', '');
L.push('Generated by `eval/fleet-study/tier1/run.mjs`. Every expectation in');
L.push('`cases.mjs` was declared before the run; a broken prediction is a finding,');
L.push('not something to re-fit.', '');
L.push('## Recall and false alarms, per corpus tier', '');
L.push('| corpus tier | positives | caught | caught by another gate | missed | recall | negatives | false alarms |');
L.push('|---|---|---|---|---|---|---|---|');
for (const tier of ['archive', 'synthesized']) {
  const s = summary[tier];
  L.push(`| ${tier} | ${s.positives} | ${s.caught} | ${s.caughtByOtherGate} | ${s.missed} | ${s.recall} | ${s.negatives} | ${s.falseAlarms} |`);
}
L.push('');
L.push('## Per case', '');
L.push('| case | lane | kind | corpus | outcome | expected gate | gates that fired | corpus states | ms |');
L.push('|---|---|---|---|---|---|---|---|---|');
for (const r of results.check) {
  L.push(`| ${r.id} | ${r.lane} | ${r.positive ? 'positive' : 'negative'} | ${r.tier} | **${r.outcome}** | ${r.expectedGate ?? '—'} | ${r.failedGates.join(', ') || '—'} | ${r.corpus ?? '—'} | ${r.ms} |`);
}
L.push('');
L.push('## Composition (matrix vs product)', '');
L.push('| case | kind | matrix | product | held? | ms (matrix / product) |');
L.push('|---|---|---|---|---|---|');
for (const r of results.composition) {
  L.push(`| ${r.id} | ${r.positive ? 'positive' : 'negative'} | ${r.matrix} | ${r.product} | ${r.matrixHeld && r.productHeld ? 'yes' : '**NO**'} | ${r.msMatrix} / ${r.msProduct} |`);
}
L.push('');
L.push(`Pre-registered per-tier predictions held: ${summary.predictionsHeld}, broken: ${summary.predictionsBroken}.`);
L.push('');
L.push('> Cost note: every number above is local, deterministic, and needs **no API key**.');
const md = L.join('\n');

const outDir = here;
mkdirSync(outDir, { recursive: true });
const jsonPath = join(outDir, 'results.json');
const mdPath = join(outDir, 'results.md');
writeFileSync(jsonPath, JSON.stringify(results, null, 2) + '\n');
writeFileSync(mdPath, md + '\n');
console.log(md);
console.error(`\nwrote ${jsonPath} and ${mdPath}`);

// A broken pre-registered prediction fails the run: the control is only
// meaningful if its own claims are checked.
if (summary.predictionsBroken > 0 || !summary.compositionHeld) process.exitCode = 1;
