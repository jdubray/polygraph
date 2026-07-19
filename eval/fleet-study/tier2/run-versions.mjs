// Tier 2 runner — three version changes against a captured fleet
// (docs/fleet-study-plan.md §5, FS-M3).
//
//   node eval/fleet-study/tier2/run-versions.mjs [--corpus <dir>] [--seed 11]
//
// Reads a capture produced by examples/fleet-study-stripe/capture/capture.mjs
// and runs v1 → each of three version changes of increasing severity against
// it, collecting the cost columns the plan specifies and emitting an
// adjudication worksheet for a human to fill in.
//
// ADMISSIBILITY. The capture's manifest says whether its corpus is real
// Stripe state (--live) or machine-generated (--offline). An offline corpus
// is CIRCULAR as evidence — the v1 machine produced it — so this runner
// stamps every result `admissible: false` and refuses to present the numbers
// as Tier 2 findings. It still runs, because exercising the pipeline without
// a key is the whole point of having an offline mode.
'use strict';

import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, mkdirSync, cpSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..', '..');
const CLI = join(repo, 'polyvers', 'bin', 'polyvers.mjs');
const MACHINES = join(repo, 'examples', 'fleet-study-stripe', 'machines');

const args = process.argv.slice(2);
// A flag given without a value is an ERROR, never the default. `--seed` alone
// used to yield undefined → NaN → mulberry32's `a |= 0` coerced it to 0, so
// the worksheet was shuffled with seed 0 while results.json recorded
// `"seed": null`. Blind adjudication requires that the recorded seed
// reproduce the ordering that was actually used.
const flag = (n, d) => {
  const i = args.indexOf(`--${n}`);
  if (i < 0) return d;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) {
    console.error(`--${n} needs a value`);
    process.exit(2);
  }
  return v;
};
const CORPUS_DIR = resolve(flag('corpus', join(repo, 'examples', 'fleet-study-stripe', 'out')));
const SEED = Number(flag('seed', 11));
if (!Number.isFinite(SEED)) { console.error('--seed must be a number'); process.exit(2); }

const manifestPath = join(CORPUS_DIR, 'manifest.json');
const fleetPath = join(CORPUS_DIR, 'fleet.json');
if (!existsSync(manifestPath) || !existsSync(fleetPath)) {
  console.error(`no capture at ${CORPUS_DIR} — run examples/fleet-study-stripe/capture/capture.mjs first`);
  process.exit(2);
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
const ADMISSIBLE = manifest.admissibleAsTier2 === true;

/**
 * The three changes, in increasing severity, with the verdict predicted
 * BEFORE the run. A broken prediction is a finding about the tool or about
 * the prediction — never something to quietly re-fit.
 */
const CHANGES = [
  {
    id: 'v2-addition', dir: 'subscription-v2-addition',
    change: 'pure addition: a REFUND_ISSUED action; nothing removed, no existing transition or invariant altered',
    expect: 'PASS',
    why: 'adding vocabulary cannot strand a live state: no fleet record carries the new action, and every existing transition is untouched',
  },
  {
    id: 'v2-dunning', dir: 'subscription-v2-dunning',
    change: 'rules + intent: the retry budget drops from 3 to 2, and the invariants tighten with it',
    expect: 'FAIL',
    // A verdict alone is too weak a prediction: FAIL for the wrong reason
    // would score as held. It already did once — before the migrate gate was
    // fixed this change failed because the gate SUPPRESSED invariants-pointwise,
    // and the runner still printed "held: yes". Naming the gate is what makes
    // the prediction falsifiable.
    expectGate: 'invariants-pointwise',
    why: 'the fleet already holds records mid-dunning, and no migration can make them legal without making a billing decision — so the failure should SURVIVE a correct migration, and it must surface as the pointwise gate naming live violators. This is the archetypal fleet event and the one the study exists to exhibit',
  },
  {
    id: 'v2-shape', dir: 'subscription-v2-shape',
    change: 'shape: `cents` splits into `amountCents` + `currency`',
    expect: 'PASS',
    // The pre-migration run must fail at `migrate` specifically — a shape
    // change caught by some other gate would mean the lane is mis-routed.
    expectGatePre: 'migrate',
    why: 'the old shape cannot round-trip unmigrated, but the rename is faithful and total — so a correct migration should CLEAR it. A shape change that stayed red after a correct migration would mean the gate was measuring something other than shape',
  },
];

/**
 * Run the CLI with --json and return its parsed report.
 *
 * A CRASH MUST NOT LOOK LIKE A VERDICT. If the CLI dies before emitting a
 * report — bad path, load error, unhandled throw, OOM — it exits nonzero with
 * no parseable stdout, which is byte-for-byte how a legitimate FAIL exits
 * apart from the report itself. Deriving a verdict from the exit code alone
 * would score a crashed run as a clean FAIL with zero findings, and since two
 * of the three changes PREDICT failure, that reads as a held prediction. The
 * runner's whole anti-re-fitting discipline rests on predictions being
 * falsifiable, so the one failure mode that can falsify nothing has to be
 * named rather than absorbed.
 */
function runCli(cliArgs) {
  const t0 = process.hrtime.bigint();
  let stdout = '', stderr = '', code = 0;
  try {
    stdout = execFileSync(process.execPath, [CLI, ...cliArgs], {
      encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    stdout = String(err.stdout ?? '');
    stderr = String(err.stderr ?? '');
    code = err.status ?? 1;
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  let json = null; try { json = JSON.parse(stdout); } catch { /* crash or prose path */ }
  return { json, code, ms, stdout, stderr, crashed: json === null };
}

const results = { corpus: CORPUS_DIR, manifest, admissible: ADMISSIBLE, seed: SEED, changes: [] };
const findings = [];

/**
 * Collapse a failure to the defect it is about: the witness state plus the
 * named rule. Gate messages quote the rule name ('exhausted-dunning-is-unpaid'),
 * so the same violation seen by migrate, invariants-pointwise and
 * semantic-model-check keys identically. A failure that names no rule (the
 * missing-migration refusal, say) falls back to gate + message, which never
 * over-collapses — two distinct defects can never merge, only fail to merge.
 */
function defectKeyOf(f, gate) {
  const rule = /'([^']+)'/.exec(f.message ?? '');
  return rule ? `${f.id ?? '—'}::${rule[1]}` : `${gate}::${f.message}`;
}

/**
 * Summarise one `check --json` report into the columns the plan wants, and
 * push its failures onto the shared adjudication list.
 */
function summarise(run, c, phase) {
  const { json: report, code } = run;
  // No report means no verdict. CRASH is a distinct outcome that matches no
  // prediction, so it can never be scored as held.
  if (run.crashed) {
    return {
      verdict: 'CRASH', crashed: true, exitCode: code,
      stderr: run.stderr.split('\n').filter(Boolean).slice(-5).join('\n'),
      failedGates: [], findingCount: 0, skippedGates: [],
      corpusStates: null, adequacy: null,
    };
  }
  const gates = report?.gates ?? [];
  const failed = gates.filter((g) => !g.ok);
  const before = findings.length;
  for (const g of failed) {
    // A gate the CLI skipped because an upstream gate failed structurally
    // reports a control-flow fact, not a claim about the fleet. Adjudicating
    // "not run" as TP/TI/FP is meaningless and would pad the denominator of
    // every rate the study reports. A gate that refused for its OWN
    // substantive reason ("no migrate.cjs") is a real finding and stays.
    if (g.skipped) continue;
    for (const f of g.failures ?? []) {
      findings.push({
        findingId: `${c.id}::${phase}::${g.gate}::${findings.length}`,
        change: c.id, phase, gate: g.gate,
        witness: f.id ?? null,
        message: f.message,
        // The gates are deliberately overlapping views, so ONE defect can
        // surface as three rows (migrate produced it, pointwise holds it,
        // the model check reaches it). Counting rows would inflate the
        // denominator of every rate the study reports — and the migrate-gate
        // fix that lets downstream gates run makes the overlap larger, not
        // smaller. Key a defect by its witness + the rule it names, which is
        // what a human adjudicator would collapse on.
        defectKey: defectKeyOf(f, g.gate),
        // filled in by a human, blind to the prediction (see adjudication.md)
        bucket: null,
      });
    }
  }
  return {
    verdict: report?.verdict ?? (code === 0 ? 'PASS' : 'FAIL'),
    crashed: false,
    failedGates: failed.map((g) => g.gate),
    // Both counts are reported because they answer different questions:
    // rows measure operator noise, distinct defects measure detection power.
    // Any TP/FP rate must be computed over the latter.
    findingCount: findings.length - before,
    distinctDefects: new Set(findings.slice(before).map((f) => f.defectKey)).size,
    skippedGates: failed.filter((g) => g.skipped).map((g) => g.gate),
    corpusStates: report?.corpus?.count ?? null,
    adequacy: report?.adequacy ?? null,
    exitCode: code,
  };
}

/**
 * The plan's sequence is classify → check → migrate scaffold → check, and
 * BOTH checks are results: the first says a migration is required, the second
 * says whether the authored migration actually holds against the fleet.
 *
 * The authored migrate.cjs is already on disk (an operator wrote it), so
 * phase 1 is reproduced by checking against a COPY of the version directory
 * with migrate.cjs withheld. Copying rather than moving keeps the run
 * non-destructive — a crashed runner must never leave a half-migrated
 * version directory behind.
 */
function withoutMigration(newDir) {
  const tmp = mkdtempSync(join(tmpdir(), 'fs-m3-'));
  const dest = join(tmp, 'version');
  cpSync(newDir, dest, { recursive: true });
  for (const f of ['migrate.cjs', 'MIGRATION-NOTE.md']) {
    try { rmSync(join(dest, f)); } catch { /* absent is fine */ }
  }
  return { dest, cleanup: () => { try { rmSync(tmp, { recursive: true, force: true }); } catch {} } };
}

for (const c of CHANGES) {
  const oldDir = join(MACHINES, 'subscription-v1');
  const newDir = join(MACHINES, c.dir);
  const hasMigration = existsSync(join(newDir, 'migrate.cjs'));

  const cls = runCli(['classify', '--old', oldDir, '--new', newDir, '--json']);

  // phase 1 — before any migration exists
  const bare = hasMigration ? withoutMigration(newDir) : null;
  const pre = runCli(['check', '--old', oldDir, '--new', bare ? bare.dest : newDir, '--snapshots', fleetPath, '--json']);
  const preSum = summarise(pre, c, 'pre-migration');
  bare?.cleanup();

  // phase 2 — with the authored migration in place
  const post = hasMigration
    ? runCli(['check', '--old', oldDir, '--new', newDir, '--snapshots', fleetPath, '--json'])
    : null;
  const postSum = post ? summarise(post, c, 'post-migration') : null;

  // The verdict the study reports is the FINAL one — after the operator has
  // done the work the tool asked for. A change that needs a migration and
  // gets a correct one is not thereby "incompatible".
  const final = postSum ?? preSum;
  const verdict = final.verdict;

  // A prediction is held only when the verdict matches AND the gate that was
  // predicted to fire actually fired. Verdict-only scoring accepts a failure
  // for entirely the wrong reason as confirmation.
  const gateMissed = [];
  if (c.expectGate && !final.failedGates.includes(c.expectGate)) gateMissed.push(`final: expected '${c.expectGate}' to fire, fired [${final.failedGates.join(', ') || 'none'}]`);
  if (c.expectGatePre && !preSum.failedGates.includes(c.expectGatePre)) gateMissed.push(`pre-migration: expected '${c.expectGatePre}' to fire, fired [${preSum.failedGates.join(', ') || 'none'}]`);
  const crashed = preSum.crashed || postSum?.crashed || cls.crashed;

  results.changes.push({
    id: c.id, change: c.change, expect: c.expect, expectGate: c.expectGate ?? null, why: c.why,
    lanes: cls.json?.lanes ?? [], gatesDemanded: cls.json?.gates ?? [],
    classifyCrashed: cls.crashed,
    migrationRequired: hasMigration || preSum.failedGates.includes('migrate'),
    migrationAuthored: hasMigration,
    verdict,
    // A crash matches no prediction, and a right verdict for the wrong reason
    // is not a held prediction.
    predictionHeld: !crashed && verdict === c.expect && gateMissed.length === 0,
    gateMissed, crashed,
    pre: preSum, post: postSum,
    corpusStates: (postSum ?? preSum).corpusStates,
    corpusSource: (post?.json ?? pre.json)?.corpus?.source ?? null,
    msClassify: Math.round(cls.ms),
    msCheck: Math.round(pre.ms + (post?.ms ?? 0)),
  });
}

// ---- adjudication worksheet: shuffled, no predictions shown ----------------
const rng = ((a) => () => {
  a |= 0; a = (a + 0x6D2B79F5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
})(SEED);
const shuffled = [...findings];
for (let i = shuffled.length - 1; i > 0; i--) {
  const j = Math.floor(rng() * (i + 1));
  [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
}

const W = [];
W.push('# Fleet study · Tier 2 — adjudication worksheet', '');
W.push(`Corpus: \`${CORPUS_DIR}\` · provenance: ${manifest.provenance}`);
W.push(`**Admissible as Tier 2 evidence: ${ADMISSIBLE ? 'YES' : 'NO'}**`, '');
if (!ADMISSIBLE) {
  W.push('> This corpus was generated by the v1 machine itself, so it is circular');
  W.push('> as evidence about that machine. The worksheet below exercises the');
  W.push('> adjudication pipeline; its buckets must NOT be reported as Tier 2');
  W.push('> results. Re-run against a `--live` capture for admissible numbers.', '');
}
W.push('## How to fill this in', '');
W.push('Findings are listed in **shuffled order with no predicted verdict shown**, so a');
W.push('judgment is made on the finding itself rather than on what the tool expected.');
W.push('For each row write one bucket in the `bucket` column of `results.json`');
W.push('(or here, then re-run with `--adjudicated`):', '');
W.push('| bucket | meaning |');
W.push('|---|---|');
W.push('| **TP** | a true incompatibility: the new version genuinely mishandles a state the fleet holds |');
W.push('| **TI** | true but intended: the finding is correct and the behaviour is deliberate (e.g. a strengthened invariant naming live violators). The human decides what those instances mean |');
W.push('| **FP** | spurious: tool error — bad domain inference, an over-conservative superset, a BOUNDED run misread, a gate misfiring on a cosmetic change |', '');
W.push('Record the judge, and resolve disagreements with a third reader; the count of');
W.push('disagreements is part of the result.', '');
W.push('**`defectKey` collapses gate views, NOT causal chains.** Two rows naming');
W.push('different rules on the same witness are counted as two defects, but one may');
W.push('be reachable only from the state the other condemns — remediating the first');
W.push('would erase the second. This is not hypothetical: it is exactly what happened');
W.push('with `exhausted-dunning-is-unpaid` and `dunning-within-budget` on this corpus.');
W.push('Before reporting a defect count, re-run the check against a corpus with the');
W.push('root violation remediated and see which findings survive.', '');
W.push('**One defect can appear as several rows.** The gates are deliberately');
W.push('overlapping views — a violating state is seen by `migrate` as an output it');
W.push('produced, by `invariants-pointwise` as a state the fleet holds, and by');
W.push('`semantic-model-check` as a root or a reachable state. Judge each row on its');
W.push('own, then note which rows you consider the same underlying defect; the study');
W.push('reports both counts, because per-gate volume and distinct-defect count answer');
W.push('different questions (operator noise vs. detection power).', '');
W.push('## Findings', '');
W.push('| # | finding | witness | bucket (fill in) | note |');
W.push('|---|---|---|---|---|');
shuffled.forEach((f, i) => {
  W.push(`| ${i + 1} | ${f.message.replace(/\|/g, '\\|')} | ${f.witness ?? '—'} |  |  |`);
});
W.push('');
W.push('_The mapping from row number back to gate and change lives in `results.json`,');
W.push('so it can be consulted after judging rather than before._');

// ---- results table ---------------------------------------------------------
const R = [];
R.push('# Fleet study · Tier 2 — three version changes against a captured fleet', '');
R.push(`Corpus: \`${CORPUS_DIR}\``);
R.push(`Provenance: ${manifest.provenance}`);
R.push(`Fleet: ${manifest.subscriptions} subscriptions · ${manifest.distinctStates} distinct states · ${manifest.windows} trace windows`);
R.push(`**Admissible as Tier 2 evidence: ${ADMISSIBLE ? 'YES' : 'NO'}**`, '');
R.push('Each change is run twice: once before any migration exists, and once with the');
R.push('migration an operator authored from the scaffold. Both are results — the first');
R.push('says what the tool demanded, the second says whether the work satisfied it.', '');
R.push('| change | lanes fired | migration | pre-migration | post-migration | final | predicted | held? | rows | defects | ms (classify / checks) |');
R.push('|---|---|---|---|---|---|---|---|---|---|---|');
for (const r of results.changes) {
  const f = (s) => (s ? `${s.verdict}${s.findingCount ? ` (${s.findingCount})` : ''}` : 'n/a');
  const rows = r.pre.findingCount + (r.post?.findingCount ?? 0);
  const defects = new Set(findings.filter((x) => x.change === r.id).map((x) => x.defectKey)).size;
  R.push(`| ${r.id} | ${r.lanes.join(', ') || '—'} | ${r.migrationRequired ? (r.migrationAuthored ? 'authored' : 'REQUIRED, absent') : 'none needed'} | ${f(r.pre)} | ${f(r.post)} | **${r.verdict}** | ${r.expect}${r.expectGate ? ` via ${r.expectGate}` : ''} | ${r.predictionHeld ? 'yes' : '**NO**'} | ${rows} | ${defects} | ${r.msClassify} / ${r.msCheck} |`);
}
R.push('');
R.push(`Corpus: ${results.changes[0]?.corpusStates ?? '—'} distinct fleet states.`, '');
R.push('**rows** counts gate findings; **defects** collapses the overlapping gate views');
R.push('onto (witness, rule). The gates are deliberately redundant — one violation is');
R.push('seen by `migrate` as output it produced, by `invariants-pointwise` as a state');
R.push('the fleet holds, and by `semantic-model-check` as a root or reachable state.');
R.push('Any TP/FP rate must be computed over **defects**; rows measure operator noise.', '');
const anyCrash = results.changes.filter((r) => r.crashed);
if (anyCrash.length) {
  R.push('> **A RUN CRASHED — these numbers are not results.**');
  for (const r of anyCrash) R.push(`> \`${r.id}\`: ${(r.post ?? r.pre).stderr || `exit ${(r.post ?? r.pre).exitCode}`}`);
  R.push('');
}
const anyMissed = results.changes.filter((r) => r.gateMissed.length);
if (anyMissed.length) {
  R.push('> **A PREDICTED GATE DID NOT FIRE.** The verdict may be right for the wrong');
  R.push('> reason, which is not a held prediction.');
  for (const r of anyMissed) for (const m of r.gateMissed) R.push(`> \`${r.id}\` — ${m}`);
  R.push('');
}
R.push('## What each change is', '');
for (const r of results.changes) {
  R.push(`- **${r.id}** — ${r.change}.`);
  R.push(`  Predicted ${r.expect}: ${r.why}`);
  if (r.post) R.push(`  Gates still red after migration: ${r.post.failedGates.join(', ') || 'none'}.`);
}
R.push('');
R.push('> Cost: every run above is local and deterministic and needs **no API key**.');
R.push('> The only human cost is authoring the migrations, which is recorded in each');
R.push('> `migrate.cjs` — both were scaffolded by the tool and both needed a hand edit,');
R.push('> one a rename the scaffold could not infer, one a policy decision it correctly');
R.push('> refused to make.');
R.push('> Findings are unadjudicated here; see `adjudication.md`.');

mkdirSync(here, { recursive: true });
results.findings = findings;
writeFileSync(join(here, 'results.json'), JSON.stringify(results, null, 2) + '\n');
writeFileSync(join(here, 'results.md'), R.join('\n') + '\n');
writeFileSync(join(here, 'adjudication.md'), W.join('\n') + '\n');
console.log(R.join('\n'));
const distinct = new Set(findings.map((f) => f.defectKey)).size;
console.error(`\nwrote results.json, results.md, adjudication.md (${findings.length} rows / ${distinct} distinct defects to adjudicate)`);
if (!ADMISSIBLE) console.error('NOTE: corpus is not admissible as Tier 2 evidence — pipeline exercise only.');

// A crash is louder than a broken prediction: it means the study produced no
// evidence at all, rather than evidence against a prediction.
const crashed = results.changes.filter((r) => r.crashed);
if (crashed.length) {
  console.error(`\nRUN CRASHED for: ${crashed.map((r) => r.id).join(', ')} — no verdict was produced; these are NOT results.`);
  for (const r of crashed) console.error((r.post ?? r.pre).stderr || `  exit ${(r.post ?? r.pre).exitCode}`);
  process.exitCode = 2;
}
const broken = results.changes.filter((r) => !r.crashed && !r.predictionHeld);
if (broken.length) {
  for (const r of broken) {
    const why = r.gateMissed.length ? r.gateMissed.join('; ') : `verdict ${r.verdict}, predicted ${r.expect}`;
    console.error(`\nPREDICTION BROKEN for ${r.id}: ${why} — explain it, do not re-fit it.`);
  }
  process.exitCode ||= 1;
}
