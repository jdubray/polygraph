#!/usr/bin/env node
// Artifact A/B eval (P8 ship gate for the v2 switch): run every machine in
// BOTH artifact arms with the same model and N —
//
//   legacy — bare next(state, action, data) module (--legacy-bare-next path)
//   v2     — SAM strict-profile module (the new default)
//
// and record, per machine per arm:
//   * seeded-bug detection, split by mechanism:
//       replay  — a code-finding-or-contract window at the ground-truth action
//       check   — an invariant violation reachable by the model checker
//   * dead-spec count (generated spec failed to load/replay)
// plus the two assertions only the v2 artifact can make:
//   * at least one rejection-reason classification appears in replay results
//   * the determinism double-pass ran (check() reports `nondeterministic`)
//
// Ship criteria (plan P8): v2 detection parity or better vs legacy, and v2
// dead-spec rate at or below legacy.
//
// Run:  ANTHROPIC_API_KEY=... node eval/ab-v2.mjs --model haiku-4.5 [--n 3]
//       [--machines m01,m02 | m01-m04]  [--arms legacy,v2]
// Results stream to eval/results/ab-v2-scorecard.json after every machine, so
// a run killed mid-way (expired key) keeps its partial results.
//
// Degraded mode (no API key / key expired): --reference replays each
// machine's checked-in reference spec instead of generating. reference.cjs is
// a bare-next artifact, so only the LEGACY arm can run this way; the v2 arm
// is recorded as BLOCKED (no v2 reference specs exist per machine). The two
// v2-only pipeline assertions are then demonstrated on the repo's v2
// reference specs (examples/turnstile-v2, examples/etcd-raft-v2) instead.
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { buildPrompt } from '../scripts/build_prompt.mjs';
import { generateSpecs } from '../scripts/generate.mjs';
import { loadWindows, replaySpecResults } from '../scripts/replay.mjs';
import { classify } from '../scripts/verify.mjs';
import { check, loadSpec } from '../scripts/check.mjs';
import { resolveModel } from '../scripts/models.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MACHINES_DIR = join(HERE, 'machines');
const RESULTS = join(HERE, 'results');
const SPEC_KEEP = join(RESULTS, 'ab-v2-specs');

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const k = argv[i].slice(2);
      a[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? (i++, argv[i]) : true;
    }
  }
  return a;
}
const args = parseArgs(process.argv.slice(2));
const N = Number(args.n || 3); // harness default (same as skill-ab.mjs)
const MAX_TOKENS = Number(args['max-tokens'] || 32000);

/** Expand --machines: 'm01,m03' or a range 'm01-m04'; default = all. */
function selectMachines(all, sel) {
  if (!sel || sel === true) return all;
  const range = String(sel).match(/^m(\d+)-m(\d+)$/);
  if (range) {
    const lo = Number(range[1]), hi = Number(range[2]);
    return all.filter((d) => { const m = d.match(/^m(\d+)/); return m && Number(m[1]) >= lo && Number(m[1]) <= hi; });
  }
  const wanted = String(sel).split(',').map((s) => s.trim());
  return all.filter((d) => wanted.some((w) => d === w || d.startsWith(w + '-') || d.startsWith(w)));
}

async function loadInvariants(dir) {
  const p = join(dir, 'invariants.mjs');
  if (!existsSync(p)) return null;
  const m = await import(pathToFileURL(p).href);
  return {
    stateInvariants: m.stateInvariants || (m.default || {}).stateInvariants || [],
    transitionInvariants: m.transitionInvariants || (m.default || {}).transitionInvariants || [],
  };
}

/** Run one (machine, arm) cell. Never throws; failures land in the record. */
async function runArm({ name, dir, arm, contract, source, gt, invariants, apiKey }) {
  const mode = arm === 'legacy' ? 'legacy' : 'sam';
  const rec = {
    machine: name, arm, n: N,
    specsGenerated: 0, deadSpecs: 0,
    replayDetected: false, checkDetected: false,
    flaggedReplay: false, flaggedCheck: false,
    rejectionReasonSeen: false, determinismRan: false, nondeterministicSpecs: 0,
    checkerErrors: [],
  };
  let specPaths = [];
  if (args.reference) {
    // Replay-only degraded mode: the machine's reference spec stands in for a
    // generation. It is a bare-next artifact — only valid for the legacy arm.
    rec.generative = 'blocked';
    if (mode !== 'legacy') { rec.error = 'BLOCKED: no v2 reference spec exists for this machine; the v2 arm needs generation (API)'; return rec; }
    const ref = join(dir, 'reference.cjs');
    if (!existsSync(ref)) { rec.error = 'no reference.cjs for this machine'; return rec; }
    specPaths = [ref];
    rec.specsGenerated = 1;
  } else {
    let prompt;
    try {
      prompt = buildPrompt(contract, source, { filePath: join(dir, 'source.cjs'), lang: 'javascript', mode });
    } catch (e) { rec.error = `buildPrompt: ${e.message}`; return rec; }

    const gens = await generateSpecs({ prompt, model: MODEL_ID, n: N, apiKey, maxTokens: MAX_TOKENS });
    const specDir = join(SPEC_KEEP, name, arm);
    rmSync(specDir, { recursive: true, force: true });
    mkdirSync(specDir, { recursive: true });
    const genErrors = [];
    gens.forEach((g) => {
      if (g.ok) { const p = join(specDir, `spec_${g.index}.js`); writeFileSync(p, g.spec, 'utf-8'); specPaths.push(p); }
      else genErrors.push(g.error);
    });
    rec.specsGenerated = specPaths.length;
    if (genErrors.length) rec.genErrors = genErrors;
    if (!specPaths.length) { rec.error = `no specs generated: ${genErrors.join('; ')}`; return rec; }
  }

  // ── replay half ──
  const windows = loadWindows(join(dir, 'traces'));
  const detail = specPaths.map((p) => replaySpecResults(p, windows, mode));
  const matrix = detail.map((resp) => (resp.ok ? resp.results.map((r) => r.status) : windows.map(() => 'unscoreable')));
  const deadIdx = matrix.map((row, i) => (row.every((s) => s === 'unscoreable') ? i : -1)).filter((i) => i >= 0);
  rec.deadSpecs = deadIdx.length;
  const liveIdx = specPaths.map((_, i) => i).filter((i) => !deadIdx.includes(i));
  const findings = windows
    .map((w, wi) => ({ w, verdict: classify(liveIdx.map((si) => matrix[si][wi])) }))
    .filter((x) => x.verdict === 'code-finding-or-contract');
  rec.flaggedReplay = findings.length > 0;
  if (gt.seeded) rec.replayDetected = findings.some((x) => x.w.action === gt.defect.action);
  // v2-only assertion 1: a rejection-reason classification appears in results.
  rec.rejectionReasonSeen = detail.some((resp) => resp.ok && resp.results.some(
    (r) => r.classification === 'rejected' && r.rejectionReason !== undefined));

  // ── model-check half ──
  if (invariants) {
    let violations = 0;
    for (const p of specPaths) {
      try {
        const r = check({ specModule: loadSpec(p), contract, invariants, windows, legacyBareNext: mode === 'legacy' });
        if (r.error) { rec.checkerErrors.push(`${p.replace(/^.*[\\/]/, '')}: ${r.error}`); continue; }
        // v2-only assertion 2: the determinism double-pass ran (check() always
        // reports the flag when it completes; count flagged specs).
        if (Object.prototype.hasOwnProperty.call(r, 'nondeterministic')) rec.determinismRan = true;
        if (r.nondeterministic) rec.nondeterministicSpecs++;
        if (r.violations.length) violations++;
      } catch (e) { rec.checkerErrors.push(`${p.replace(/^.*[\\/]/, '')}: ${e.message}`); }
    }
    rec.flaggedCheck = violations > 0;
    if (gt.seeded) rec.checkDetected = violations > 0;
  }
  return rec;
}

let MODEL_ID = null;

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!args.reference) {
    if (!apiKey) { console.error('ANTHROPIC_API_KEY not set (or pass --reference for replay-only degraded mode).'); process.exit(2); }
    if (!args.model) { console.error('--model is required (no default model, repo rule).'); process.exit(2); }
  }
  MODEL_ID = args.reference ? 'reference-replay-only' : resolveModel(args.model).id;
  const arms = args.arms && args.arms !== true ? String(args.arms).split(',') : ['legacy', 'v2'];

  const all = readdirSync(MACHINES_DIR).filter((d) => /^m\d/.test(d)).sort();
  const machines = selectMachines(all, args.machines);
  mkdirSync(RESULTS, { recursive: true });
  const outPath = join(RESULTS, 'ab-v2-scorecard.json');
  // Resume-friendly: merge over an existing scorecard so a second invocation
  // (e.g. m05-m08 after m01-m04) extends rather than clobbers.
  let records = [];
  if (existsSync(outPath)) {
    try { records = JSON.parse(readFileSync(outPath, 'utf-8')).records || []; } catch { records = []; }
  }
  const upsert = (rec) => {
    records = records.filter((r) => !(r.machine === rec.machine && r.arm === rec.arm));
    records.push(rec);
    writeFileSync(outPath, JSON.stringify({ config: { model: MODEL_ID, n: N }, records }, null, 2), 'utf-8');
  };

  for (const name of machines) {
    const dir = join(MACHINES_DIR, name);
    const gt = JSON.parse(readFileSync(join(dir, 'ground-truth.json'), 'utf-8'));
    const contract = JSON.parse(readFileSync(join(dir, 'contract.json'), 'utf-8'));
    const source = readFileSync(join(dir, 'source.cjs'), 'utf-8');
    (await import(pathToFileURL(join(dir, 'gen-traces.mjs')).href)).run(); // ensure traces exist
    const invariants = await loadInvariants(dir);
    for (const arm of arms) {
      const t0 = Date.now();
      const rec = await runArm({ name, dir, arm, contract, source, gt, invariants, apiKey });
      rec.cls = gt.outOfScope ? 'out-of-scope' : gt.seeded ? 'seeded' : 'clean';
      rec.ms = Date.now() - t0;
      upsert(rec);
      console.log(`[ab-v2] ${name} ${arm}: gen=${rec.specsGenerated}/${N} dead=${rec.deadSpecs} ` +
        `replay=${rec.replayDetected ? 'DET' : (rec.flaggedReplay ? 'flag' : '-')} check=${rec.checkDetected ? 'DET' : (rec.flaggedCheck ? 'flag' : '-')} ` +
        `rej=${rec.rejectionReasonSeen ? 'y' : 'n'} det-run=${rec.determinismRan ? 'y' : 'n'}` +
        (rec.error ? ` ERROR: ${rec.error}` : '') + ` (${(rec.ms / 1000).toFixed(0)}s)`);
    }
  }
  console.log(`\nwrote ${outPath} — render the table with your own eyes or eval/AB-V2-RESULTS.md`);
}

main().catch((e) => { console.error('[ab-v2] ' + (e && e.stack || e)); process.exit(1); });
