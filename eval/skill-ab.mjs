// Skill A/B eval: does Polygraph (model + the tool) beat the model ALONE at
// locating a source-vs-behavior divergence? Two arms per machine, N runs each,
// auto-scored against ground-truth. Flags any machine where the tool does WORSE
// than baseline (the "skills can hurt" check from the skill-eval literature).
//
//   baseline arm  — one model call on the source alone; parse its JSON verdict.
//   polygraph arm — the real loop: derive N specs from the source, replay them
//                   against the machine's traces, and DERIVE the verdict from
//                   the tool's output (a code-finding window ⇒ buggy).
//
// Run:  ANTHROPIC_API_KEY=... node eval/skill-ab.mjs --model <id> --n 3
// Dry:  node eval/skill-ab.mjs --dry-run     (mocked fetch; validates scoring)
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { buildPrompt } from '../scripts/build_prompt.mjs';
import { generateSpecs } from '../scripts/generate.mjs';
import { resolveModel } from '../scripts/models.mjs';
import { loadWindows, replaySpec } from '../scripts/replay.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MACHINES_DIR = join(HERE, 'machines');
const RESULTS = join(HERE, 'results');

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const k = argv[i].slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? (i++, argv[i]) : true;
      a[k] = v;
    }
  }
  return a;
}
const args = parseArgs(process.argv.slice(2));
const DRY = !!args['dry-run'];
const N = Number(args.n || 3);
const MODEL = args.model || 'fable-5';
const MAX_TOKENS = Number(args['max-tokens'] || 32000);

/** classify one window's statuses across all specs (mirrors verify.mjs). */
function classify(statuses) {
  const passes = statuses.filter((s) => s === 'pass').length;
  const n = statuses.length;
  if (passes === n) return 'consistent';
  if (statuses.every((s) => s === 'unscoreable')) return 'unscoreable-all';
  if (passes === 0) return 'code-finding';
  return 'spec-error';
}

/** Parse a FLAT verdict {"buggy":bool,"action":str|null,"state":str|null}. */
function parseVerdict(text) {
  const matches = [...String(text).matchAll(/\{[^{}]*"buggy"[^{}]*\}/g)];
  if (!matches.length) return { buggy: null, action: null, state: null };
  try {
    const v = JSON.parse(matches[matches.length - 1][0]);
    return { buggy: v.buggy === true, action: v.action ?? null, state: v.state ?? null };
  } catch { return { buggy: null, action: null, state: null }; }
}

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
async function callAnthropic(prompt, fetchImpl, apiKey) {
  const body = { model: resolveModel(MODEL).id, max_tokens: MAX_TOKENS, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }] };
  const resp = await fetchImpl(ANTHROPIC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  });
  const data = await resp.json();
  return (data.content || []).map((b) => b.text || '').join('');
}

/** BASELINE arm: model alone on the source. */
async function baselineArm(source, fetchImpl, apiKey) {
  const prompt =
    `Here is a JavaScript state machine implemented as a pure transition function.\n\n` +
    `\`\`\`javascript\n${source}\n\`\`\`\n\n` +
    `Determine whether this state machine's observable behavior matches what its own ` +
    `source implies. If a transition does something a faithful reader of the source ` +
    `would NOT predict, locate it. Reply with a one-line JSON verdict at the end, ` +
    `flat (no nesting):\n{"buggy": true|false, "action": "ACTION_NAME"|null, "state": "PRE_STATE"|null}`;
  const text = await callAnthropic(prompt, fetchImpl, apiKey);
  return parseVerdict(text);
}

/** POLYGRAPH arm: derive N specs, replay, derive the verdict mechanically. */
async function polygraphArm(dir, source, contract, fetchImpl, apiKey) {
  const prompt = buildPrompt(contract, source, { filePath: join(dir, 'source.cjs'), lang: 'javascript' });
  const gens = await generateSpecs({ prompt, model: MODEL, n: N, apiKey, fetchImpl, maxTokens: MAX_TOKENS });
  const specDir = join(dir, '.ab-specs');
  rmSync(specDir, { recursive: true, force: true });
  mkdirSync(specDir, { recursive: true });
  const specPaths = [];
  gens.forEach((g) => { if (g.ok) { const p = join(specDir, `spec_${g.index}.js`); writeFileSync(p, g.spec, 'utf-8'); specPaths.push(p); } });
  if (!specPaths.length) return { buggy: false, action: null, state: null, note: 'no specs' };

  const windows = loadWindows(join(dir, 'traces'));
  const matrix = specPaths.map((p) => replaySpec(p, windows));
  const primaryKey = (typeof contract.stateKeys[0] === 'string' ? contract.stateKeys[0] : contract.stateKeys[0].name);
  const finding = windows
    .map((w, wi) => ({ w, verdict: classify(matrix.map((row) => row[wi])) }))
    .find((x) => x.verdict === 'code-finding');
  rmSync(specDir, { recursive: true, force: true });
  if (finding) return { buggy: true, action: finding.w.action, state: String(finding.w.pre[primaryKey]) };
  return { buggy: false, action: null, state: null };
}

/** Score a verdict against ground truth. Returns 1 (correct) or 0. */
function score(v, gt) {
  if (gt.seeded) return (v.buggy === true && v.action === gt.defect.action) ? 1 : 0;
  return v.buggy === true ? 0 : 1; // clean / out-of-scope: correct iff NOT flagged
}

// ── Dry-run mocks ─────────────────────────────────────────────────────────
function mockFetches(dir) {
  // polygraph generate: return the apparent-intent reference as every spec, so
  // the seeded window becomes a code-finding and clean/oos stay consistent.
  const ref = readFileSync(join(dir, 'reference.cjs'), 'utf-8');
  const genFetch = async () => ({ ok: true, json: async () => ({ content: [{ type: 'text', text: '```javascript\n' + ref + '\n```' }], stop_reason: 'end_turn', usage: {} }) });
  // baseline: a weak model that never spots the divergence (misses all seeded,
  // no false alarms) — a plausible "without" arm to make the delta visible.
  const baseFetch = async () => ({ ok: true, json: async () => ({ content: [{ type: 'text', text: 'Looks internally consistent.\n{"buggy": false, "action": null, "state": null}' }], stop_reason: 'end_turn' }) });
  return { genFetch, baseFetch };
}

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!DRY && !apiKey) { console.error('ANTHROPIC_API_KEY not set (or pass --dry-run).'); process.exit(2); }
  if (!DRY && !args.model) { console.error('--model is required (or pass --dry-run).'); process.exit(2); }

  const machines = readdirSync(MACHINES_DIR).filter((d) => /^m\d/.test(d)).sort();
  const perMachine = [];

  for (const name of machines) {
    const dir = join(MACHINES_DIR, name);
    const gt = JSON.parse(readFileSync(join(dir, 'ground-truth.json'), 'utf-8'));
    const cls = gt.outOfScope ? 'out-of-scope' : gt.seeded ? 'seeded' : 'clean';
    const source = readFileSync(join(dir, 'source.cjs'), 'utf-8');
    const contract = JSON.parse(readFileSync(join(dir, 'contract.json'), 'utf-8'));
    (await import(pathToFileURL(join(dir, 'gen-traces.mjs')).href)).run(); // ensure traces exist

    const { genFetch, baseFetch } = DRY ? mockFetches(dir) : {};
    const baseScores = [], polyScores = [];
    let baseFlag = 0, polyFlag = 0;
    for (let r = 0; r < N; r++) {
      const bv = await baselineArm(source, DRY ? baseFetch : fetch, apiKey);
      const pv = await polygraphArm(dir, source, contract, DRY ? genFetch : fetch, apiKey);
      baseScores.push(score(bv, gt)); polyScores.push(score(pv, gt));
      if (bv.buggy === true) baseFlag++; if (pv.buggy === true) polyFlag++;
    }
    const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
    perMachine.push({
      name, cls,
      baseline: mean(baseScores), polygraph: mean(polyScores),
      delta: mean(polyScores) - mean(baseScores),
      baseFlagRate: baseFlag / N, polyFlagRate: polyFlag / N,
      regression: mean(polyScores) < mean(baseScores),
    });
  }

  // Aggregate.
  const seeded = perMachine.filter((m) => m.cls === 'seeded');
  const notSeeded = perMachine.filter((m) => m.cls !== 'seeded');
  const agg = (arm) => ({
    detection: seeded.length ? seeded.reduce((s, m) => s + m[arm], 0) / seeded.length : 0,
    falseAlarm: notSeeded.length ? notSeeded.reduce((s, m) => s + (arm === 'baseline' ? m.baseFlagRate : m.polyFlagRate), 0) / notSeeded.length : 0,
    accuracy: perMachine.reduce((s, m) => s + m[arm], 0) / perMachine.length,
  });
  const baseAgg = agg('baseline'), polyAgg = agg('polygraph');
  const regressions = perMachine.filter((m) => m.regression);

  mkdirSync(RESULTS, { recursive: true });
  const out = {
    config: { model: MODEL, n: N, dryRun: DRY, machines: machines.length },
    perMachine, baseline: baseAgg, polygraph: polyAgg,
    delta: { detection: polyAgg.detection - baseAgg.detection, accuracy: polyAgg.accuracy - baseAgg.accuracy },
    regressions: regressions.map((m) => m.name),
  };
  writeFileSync(join(RESULTS, 'scorecard.json'), JSON.stringify(out, null, 2), 'utf-8');

  const md = [];
  md.push(`# Polygraph skill A/B scorecard\n`);
  md.push(`${DRY ? '**DRY RUN** (mocked fetch — validates scoring, not real efficacy)\n' : ''}`);
  md.push(`- model: \`${MODEL}\` · N=${N} runs/arm · ${machines.length} machines\n`);
  md.push(`| machine | class | baseline | polygraph | delta | note |`);
  md.push(`|---|---|---|---|---|---|`);
  for (const m of perMachine) {
    md.push(`| ${m.name} | ${m.cls} | ${m.baseline.toFixed(2)} | ${m.polygraph.toFixed(2)} | ${m.delta >= 0 ? '+' : ''}${m.delta.toFixed(2)} | ${m.regression ? '⚠️ REGRESSION' : ''} |`);
  }
  md.push(`\n## Aggregate\n`);
  md.push(`| arm | detection (seeded) | false-alarm (clean+oos) | accuracy (all) |`);
  md.push(`|---|---|---|---|`);
  md.push(`| model alone | ${(baseAgg.detection * 100).toFixed(0)}% | ${(baseAgg.falseAlarm * 100).toFixed(0)}% | ${(baseAgg.accuracy * 100).toFixed(0)}% |`);
  md.push(`| + Polygraph | ${(polyAgg.detection * 100).toFixed(0)}% | ${(polyAgg.falseAlarm * 100).toFixed(0)}% | ${(polyAgg.accuracy * 100).toFixed(0)}% |`);
  md.push(`\n**Detection delta: ${(out.delta.detection * 100) >= 0 ? '+' : ''}${(out.delta.detection * 100).toFixed(0)} points. Accuracy delta: ${(out.delta.accuracy * 100) >= 0 ? '+' : ''}${(out.delta.accuracy * 100).toFixed(0)} points.**`);
  md.push(regressions.length
    ? `\n⚠️ **Per-task regressions (Polygraph worse than baseline): ${regressions.map((m) => m.name).join(', ')}** — do not claim the skill helps until these are understood.`
    : `\n✅ No per-task regression: Polygraph is ≥ baseline on every machine.`);
  md.push(`\n> Interpretation rule (per the skill-eval literature): accept the skill only if the delta is positive AND no task regresses.`);
  writeFileSync(join(RESULTS, 'scorecard.md'), md.join('\n'), 'utf-8');

  console.log(md.join('\n'));
  console.log(`\nwrote ${join(RESULTS, 'scorecard.md')} + scorecard.json`);
}

main();
