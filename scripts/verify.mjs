#!/usr/bin/env node
// Orchestrate the bare-next() verification loop non-interactively.
//
//   verify.mjs --contract c.json --source src.js --traces traces/ \
//              --model <id> --n 5 --out out/
//   verify.mjs --contract c.json --traces traces/ --specs specdir/ --out out/
//
// Two modes:
//   * generation mode (default): builds the prompt, generates N specs via the
//     Anthropic API, replays each. Needs ANTHROPIC_API_KEY and --model.
//   * --specs <dir>: skip generation, replay every *.js in <dir> (used by the
//     self-test and for re-scoring saved specs; no API key needed).
//
// Emits out/findings.json and out/findings.md. Per-window classification:
//   pass in ALL specs             -> consistent
//   fail/unscoreable in SOME only -> likely SPEC-ERROR (a generation missed it)
//   fail in ALL specs             -> likely CODE-FINDING or CONTRACT-ERROR
//   unscoreable in ALL specs      -> specs didn't load / no next() (fix specs)
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadWindows, replaySpecResults } from './replay.mjs';
import { buildPrompt } from './build_prompt.mjs';
import { generateSpecs } from './generate.mjs';
import { check, loadSpec } from './check.mjs';
import { stable } from './load-spec.mjs';

/** Resolve an invariants module path from --invariants, contract.invariants, or a sibling file. */
function resolveInvariantsPath(opts, contract) {
  if (opts.invariants) return resolve(opts.invariants);
  if (contract.invariants) return resolve(dirname(resolve(opts.contract)), contract.invariants);
  const sibling = join(dirname(resolve(opts.contract)), 'invariants.mjs');
  return existsSync(sibling) ? sibling : null;
}

// The flags that ARE boolean. Every other flag takes a value — inferring
// "boolean" from the next token being a flag turned `--n --tla` into
// `n: true` (and `Number(true) === 1`), silently gutting the N-way vote.
const BOOLEAN_FLAGS = new Set(['legacy-bare-next', 'tla']);

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) throw new Error(`unexpected argument '${argv[i]}'`);
    const key = argv[i].slice(2);
    if (BOOLEAN_FLAGS.has(key)) { a[key] = true; continue; }
    const nxt = argv[i + 1];
    if (nxt === undefined || nxt.startsWith('--')) throw new Error(`missing value for --${key}`);
    a[key] = nxt;
    i++;
  }
  return a;
}

/** Positive-integer option, or its default. Rejects anything else loudly. */
function posInt(v, name, def) {
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`--${name} must be a positive integer (got '${v}')`);
  return n;
}

/**
 * Classify one window given its status across specs. Exported: this is THE
 * canonical verdict vocabulary ('consistent' | 'unscoreable-all' |
 * 'code-finding-or-contract' | 'spec-error') — consumers (eval/skill-ab.mjs)
 * import it rather than forking a copy that can drift.
 */
export function classify(statuses) {
  const n = statuses.length;
  if (n === 0) return 'unscoreable-all'; // zero specs is NOT evidence of consistency
  const passes = statuses.filter((s) => s === 'pass').length;
  if (passes === n) return 'consistent';
  if (statuses.every((s) => s === 'unscoreable')) return 'unscoreable-all';
  // The strong class claims "EVERY spec disagrees with the trace here" — it
  // requires every spec to have actually failed. A fail+unscoreable mix has
  // less evidence (some specs measured nothing) and classifies as the weaker
  // investigate-the-spec verdict rather than overstating the finding.
  if (statuses.every((s) => s === 'fail')) return 'code-finding-or-contract';
  return 'spec-error';
}

export async function verify(opts) {
  const contract = JSON.parse(readFileSync(opts.contract, 'utf-8'));
  const windows = loadWindows(opts.traces);
  // A verification that examined nothing must never report a clean bill:
  // zero windows would make every per-window check vacuously pass.
  if (!windows.length) throw new Error(`no trace windows found in ${opts.traces} (looked for *.ndjson with at least one window)`);
  const outDir = opts.out || 'out';
  mkdirSync(outDir, { recursive: true });
  // Artifact mode (Option A full switch): the default artifact is a v2 SAM
  // strict-profile module; --legacy-bare-next selects the bare next() contract
  // end-to-end (replayer, checker domain source, and — once wired — prompts).
  const mode = opts['legacy-bare-next'] || opts.legacyBareNext ? 'legacy' : 'sam';

  // Obtain spec file paths.
  let specPaths = [];
  if (opts.specs && (opts.model || opts.source)) {
    // Replaying saved specs while silently ignoring --model/--source would
    // let a user believe they re-generated against new source.
    throw new Error('--specs replays SAVED specs and cannot be combined with --model/--source (drop --specs to generate, or drop the generation flags to replay)');
  }
  if (opts.specs) {
    // Accept .js and .cjs (the CJS loader executes both). .mjs is ESM, which
    // the loader cannot execute — skip it LOUDLY rather than silently.
    const entries = readdirSync(opts.specs).sort();
    const skippedMjs = entries.filter((f) => f.endsWith('.mjs'));
    for (const f of skippedMjs) console.error(`[verify] skipping ${f}: .mjs (ESM) specs are not supported — use .js or .cjs (CommonJS)`);
    specPaths = entries.filter((f) => f.endsWith('.js') || f.endsWith('.cjs')).map((f) => join(opts.specs, f));
    // A verification that examined nothing must never report a clean bill.
    if (!specPaths.length) throw new Error(`no specs found in ${opts.specs} (looked for *.js / *.cjs)`);
  } else {
    if (!opts.model) throw new Error('--model is required in generation mode (or use --specs)');
    if (!opts.source) throw new Error('--source is required in generation mode (the file the specs are derived from)');
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set (or use --specs to replay saved specs)');
    const source = readFileSync(opts.source, 'utf-8');
    const lang = contract.lang || (String(opts.source).endsWith('.ts') ? 'typescript' : 'javascript');
    // Prompt selection follows the artifact mode end-to-end: 'sam' (default)
    // builds the v2 strict-profile prompt (prompt_template_v2.txt — modelShape
    // / intent schemas / domains / reject() rules rendered from the contract);
    // 'legacy' builds the bare-next prompt_template.txt. Note the v2 path
    // hard-requires a dataDomain entry for every declared data field
    // (buildPrompt throws otherwise — the domain is also the exploration and
    // transpilation domain, so a gap must block generation loudly).
    // windows threads the real corpus into the v2 renderers: union-typed
    // state keys (observed as more than one runtime type across pre/post)
    // render as untyped `{}` instead of trapping every generation with a
    // single-type declaration the strict checker throws on.
    const prompt = buildPrompt(contract, source, { filePath: opts.source, lang, mode, windows });
    const maxTokens = posInt(opts['max-tokens'], 'max-tokens', undefined);
    const gens = await generateSpecs({ prompt, model: opts.model, n: posInt(opts.n, 'n', 5), apiKey, maxTokens });
    const specDir = join(outDir, 'specs');
    mkdirSync(specDir, { recursive: true });
    gens.forEach((g) => {
      if (g.ok) { const p = join(specDir, `spec_${g.index}.js`); writeFileSync(p, g.spec, 'utf-8'); specPaths.push(p); }
      else console.error(`[verify] generation ${g.index} failed: ${g.error}`);
    });
    if (!specPaths.length) throw new Error('no specs generated');
  }

  // Replay every spec; build a per-window status matrix. In 'sam' mode each
  // result additionally carries the step classification from lastStep()
  // ('mutated' | 'rejected' | 'identity-by-mutation' | 'unhandled', plus
  // rejectionReason) — new triage evidence: a failing no-op window now says
  // WHY the spec did nothing.
  const detail = specPaths.map((p) => replaySpecResults(p, windows, mode)); // detail[spec]
  const matrix = detail.map((resp) =>
    resp.ok ? resp.results.map((r) => r.status) : windows.map(() => 'unscoreable')); // matrix[spec][window]

  // Partition specs into LIVE and DEAD. A dead spec (failed to load/replay) is
  // unscoreable on EVERY window; classifying over it would flood every window
  // as 'spec-error' and drown real signal. Windows are classified over live
  // specs only; dead specs are reported separately, never silently.
  const deadIdx = matrix.map((row, i) => (row.every((s) => s === 'unscoreable') ? i : -1)).filter((i) => i >= 0);
  const liveIdx = specPaths.map((_, i) => i).filter((i) => !deadIdx.includes(i));
  const deadSpecs = deadIdx.map((i) => specPaths[i].replace(/^.*[\\/]/, ''));
  // ── Spec-vs-spec agreement (M3) ───────────────────────────────────────────
  // The spec-vs-TRACE verdict below is blind to the structure of a
  // disagreement among the specs themselves. The raft field study's key
  // signal — 4 of 5 independent generations making the IDENTICAL mistake,
  // with the lone dissenter agreeing with the hand control — was only found
  // by reading the generated code (eval/FINDING-raft-field-study.md,
  // lesson 3). Computed over LIVE specs only; a lopsided split is evidence
  // of a legibility trap in the source, NOT evidence the majority is right —
  // in the raft case the majority was wrong.
  const liveNames = liveIdx.map((si) => specPaths[si].replace(/^.*[\\/]/, ''));
  let agreement = null;
  const windowSplits = windows.map(() => null); // per window: '4-vs-1 (minority: …)' when a strict majority exists
  if (liveIdx.length >= 2) {
    // A window unscoreable in EVERY live spec measured nothing — the statuses
    // are identical by construction and would inflate consensus. Excluded
    // from the agreement denominator (they already classify unscoreable-all).
    const measured = windows.map((_, wi) => !liveIdx.every((si) => matrix[si][wi] === 'unscoreable'));
    let agree = 0, total = 0;
    for (let a = 0; a < liveIdx.length; a++) {
      for (let b = a + 1; b < liveIdx.length; b++) {
        for (let wi = 0; wi < windows.length; wi++) {
          if (!measured[wi]) continue;
          total++;
          if (matrix[liveIdx[a]][wi] === matrix[liveIdx[b]][wi]) agree++;
        }
      }
    }
    const deviations = liveIdx.map(() => 0);
    let majorityWindows = 0; // windows where a strict majority exists (the deviation denominator)
    let noMajority = 0;      // disagreement windows with NO strict majority (even splits — nobody is "the outlier")
    windows.forEach((_, wi) => {
      if (!measured[wi]) return;
      const counts = new Map();
      liveIdx.forEach((si) => { const s = matrix[si][wi]; counts.set(s, (counts.get(s) || 0) + 1); });
      let top = null, topN = 0;
      for (const [s, c] of counts) if (c > topN) { top = s; topN = c; }
      if (topN * 2 <= liveIdx.length) { if (counts.size > 1) noMajority++; return; }
      majorityWindows++;
      const minority = [];
      liveIdx.forEach((si, li) => { if (matrix[si][wi] !== top) { deviations[li]++; minority.push(liveNames[li]); } });
      if (minority.length) windowSplits[wi] = `${topN}-vs-${minority.length} (minority: ${minority.join(', ')})`;
    });
    const outliers = liveNames
      .map((name, li) => ({ spec: name, deviations: deviations[li] }))
      .filter((o) => o.deviations > 0)
      .sort((a, b) => b.deviations - a.deviations);
    agreement = {
      liveSpecs: liveIdx.length,
      measuredWindows: measured.filter(Boolean).length,
      pairwisePct: total ? Math.round((agree / total) * 100) : null,
      majorityWindows,
      noMajority,
      outliers,
    };
  }

  const perWindow = windows.map((w, wi) => {
    const statuses = liveIdx.map((si) => matrix[si][wi]);
    // Per-live-spec step classifications ('sam' mode; legacy tv.mjs has none).
    // 'rejected' and 'identity-by-mutation' are the two GOOD no-op classes;
    // 'unhandled' on a failing window is a first-class finding — the spec
    // neither acted nor rejected.
    const classifications = liveIdx.map((si) => {
      const r = detail[si].ok ? detail[si].results[wi] : null;
      if (!r || r.classification === undefined) return null;
      return r.rejectionReason !== undefined ? `${r.classification}(${r.rejectionReason})` : r.classification;
    });
    const entry = { scenario: w.scenario, index: w.index, action: w.action, statuses, verdict: classify(statuses) };
    if (classifications.some((c) => c !== null)) entry.classifications = classifications;
    if (windowSplits[wi]) entry.split = windowSplits[wi];
    // Reject-as-annotation signature (hatchet field study,
    // eval/FINDING-hatchet-reject-annotation.md): a spec REJECTED a window
    // whose trace shows the code ACTED. One such window is an ordinary
    // spec-error; a uniform pattern is the structural trap where a
    // generation computes the correct next.* writes and then appends
    // reject(reason) as a label, discarding the work. "ACTED" uses the SAME
    // projection basis as the replayer's pass rule (only keys present in the
    // trace post-state count): a delta-shaped corpus whose post is a key
    // subset of pre would otherwise flag every correctly-rejected no-op.
    if (entry.verdict !== 'consistent'
        && Object.keys(w.post || {}).some((k) => stable(w.pre?.[k]) !== stable(w.post[k]))
        && classifications.some((c) => typeof c === 'string' && c.startsWith('rejected'))) {
      entry.rejectedButCodeActed = true;
    }
    return entry;
  });

  const summary = {
    specs: specPaths.length,
    liveSpecs: liveIdx.length,
    deadSpecs,
    agreement,
    windows: windows.length,
    consistent: perWindow.filter((w) => w.verdict === 'consistent').length,
    specError: perWindow.filter((w) => w.verdict === 'spec-error').length,
    codeFinding: perWindow.filter((w) => w.verdict === 'code-finding-or-contract').length,
    unscoreableAll: perWindow.filter((w) => w.verdict === 'unscoreable-all').length,
    // Non-consistent windows where some live spec classified 'unhandled': the
    // spec neither acted nor rejected — unexplained silence, a finding class
    // only the v2 artifact can surface.
    unhandledWindows: perWindow.filter((w) =>
      w.verdict !== 'consistent' && (w.classifications || []).some((c) => c === 'unhandled')).length,
    // Failing windows where a spec rejected while the trace shows the code
    // acted — the reject-as-annotation trap's signature when uniform.
    rejectedActedWindows: perWindow.filter((w) => w.rejectedButCodeActed).length,
  };
  const findings = perWindow.filter((w) => w.verdict !== 'consistent');

  // ── Second half: model-check each spec against invariants (the bug-finder) ──
  // Replay only catches bugs where the spec DISAGREES with the code; a faithful
  // spec does not. Iterating the spec against invariants REACHES bad states a
  // faithful spec still contains. Runs only when invariants are provided.
  let invReport = null;
  const invPath = resolveInvariantsPath(opts, contract);
  // --initial-states: a JSON array of state objects seeded into every per-spec
  // model check alongside init() — the remedy findings.md prescribes for a
  // FROZEN STATE KEY must be actionable in the SAME tool that prints the
  // warning. Malformed input is a usage error, never 'machine bug' findings;
  // silently ignoring the flag when the model check does not run would let a
  // user believe they unfroze the key.
  let initialStates = [];
  const initialStatesArg = opts['initial-states'] || opts.initialStates;
  if (initialStatesArg) {
    try { initialStates = JSON.parse(readFileSync(initialStatesArg, 'utf-8')); }
    catch (e) { throw new Error(`--initial-states '${initialStatesArg}': ${e && e.message}`); }
    if (!Array.isArray(initialStates)) throw new Error(`--initial-states '${initialStatesArg}' must be a JSON array of states`);
    const bad = initialStates.findIndex((s) => !s || typeof s !== 'object' || Array.isArray(s));
    if (bad >= 0) throw new Error(`--initial-states '${initialStatesArg}': element ${bad} is not a state object`);
    if (!invPath) throw new Error('--initial-states only affects the invariant model check, which needs an invariants module (add --invariants, a contract.invariants entry, or a sibling invariants.mjs)');
  }
  if (invPath) {
    const invMod = await import(pathToFileURL(invPath).href);
    const invariants = { stateInvariants: invMod.stateInvariants || (invMod.default || {}).stateInvariants || [], transitionInvariants: invMod.transitionInvariants || (invMod.default || {}).transitionInvariants || [] };
    // A spec the checker could not run (load throw, or missing init()/next())
    // must surface as an ERROR, never as a silent zero-violation result: it
    // would otherwise dilute the strength of a violation every live spec
    // reaches, and a clean-looking report would hide that the check never ran.
    const maxStates = posInt(opts['max-states'], 'max-states', undefined);
    const perSpec = specPaths.map((p, i) => {
      const name = p.replace(/^.*[\\/]/, '');
      try {
        // mode threads through: 'legacy' forces the bare-next engine +
        // buildDomain(); 'sam' lets check() auto-detect a v2 module and drive
        // it through the adapter with manifest() domains.
        const r = check({ specModule: loadSpec(p), contract, invariants, windows, legacyBareNext: mode === 'legacy', initialStates, ...(maxStates ? { maxStates } : {}) });
        return r.error ? { name, error: r.error } : { name, ...r };
      } catch (e) { return { name, error: String(e && e.message) }; }
    });
    const ran = perSpec.filter((r) => !r.error);
    const errors = perSpec.filter((r) => r.error).map((r) => `checker could not run ${r.name}: ${r.error}`);
    // Strength denominator = specs the checker actually ran, not all specs.
    const byName = new Map();
    ran.forEach((r) => r.violations.forEach((v) => {
      const e = byName.get(v.invariant) || { invariant: v.invariant, kind: v.kind, specs: 0, example: v };
      e.specs++; byName.set(v.invariant, e);
    }));
    const violations = [...byName.values()].map((e) => ({ ...e, strength: ran.length > 0 && e.specs === ran.length ? 'all-specs' : 'some-specs' }));
    const domainNotes = [...new Set(ran.flatMap((r) => r.domainNotes || []))];
    const driftWarnings = [...new Set(ran.flatMap((r) => r.driftWarnings || []))];
    // Frozen-key aggregation mirrors the violation strength rule: the claim
    // "the check is structurally blind behind this key" is strongest when
    // EVERY checked spec froze it; a key only some specs freeze is itself a
    // spec disagreement worth a look, so it is reported too, with its count.
    const frozenByKey = new Map();
    ran.forEach((r) => (r.frozenKeys || []).forEach((f) => {
      const e = frozenByKey.get(f.key) || { key: f.key, values: [], valueSet: new Set(), specs: 0 };
      // Distinct frozen VALUES are tracked, not just presence: two specs
      // freezing the same key at different constants disagree on the machine's
      // configuration — asserting the first spec's value for all of them would
      // paper over exactly the disagreement worth surfacing.
      const vk = stable(f.value);
      if (!e.valueSet.has(vk)) { e.valueSet.add(vk); e.values.push(f.value); }
      e.specs++; frozenByKey.set(f.key, e);
    }));
    const frozenKeys = [...frozenByKey.values()].map(({ valueSet, ...e }) => ({ ...e, strength: ran.length > 0 && e.specs === ran.length ? 'all-specs' : 'some-specs' }));
    invReport = {
      specs: specPaths.length,
      checkedSpecs: ran.length,
      statesExplored: Math.max(0, ...ran.map((r) => r.statesExplored)),
      capHit: ran.some((r) => r.capHit),
      errors,
      domainNotes,
      driftWarnings,
      frozenKeys,
      violations,
    };
  }

  // ── TLC escalation tier (--tla): transpile the winning live spec to TLA+
  // and run TLC when the toolchain is available. Turns Part 2 from "bounded
  // exploration says" into "TLC says". Opt-in; a missing toolchain is a NOTE
  // in the report, never an error — but a transpiler refusal or a TLC-level
  // failure is reported loudly.
  let tlaReport = null;
  if (opts.tla) {
    tlaReport = await tlaEscalation({ specPaths, liveIdx, matrix, mode, outDir, invPath, contractPath: resolve(opts.contract), opts });
  }

  writeFileSync(join(outDir, 'findings.json'), JSON.stringify({ summary, findings, perWindow, invReport, tlaReport }, null, 2), 'utf-8');
  writeFileSync(join(outDir, 'findings.md'), renderMarkdown(summary, findings, invReport, tlaReport), 'utf-8');
  return { summary, findings, invReport, tlaReport, outDir };
}

/**
 * Run the TLC escalation tier: pick the winning live spec (most windows
 * passed; tie -> first), transpile it via to-tla.mjs, run TLC via
 * tla-check.mjs. Never throws: every outcome is folded into the returned
 * report object ({ skipped } | { spec, transpileError } | { spec,
 * toolchainNote, ... } | the full TLC result).
 */
async function tlaEscalation({ specPaths, liveIdx, matrix, mode, outDir, invPath, contractPath, opts }) {
  if (mode === 'legacy') {
    return { skipped: 'TLC escalation requires the v2 SAM artifact — not available with --legacy-bare-next' };
  }
  if (!liveIdx.length) {
    return { skipped: 'no live specs to escalate (every spec failed to load/replay)' };
  }
  // Winner = live spec with the most passing windows; ties go to the first.
  let winner = liveIdx[0], best = -1;
  for (const si of liveIdx) {
    const passes = matrix[si].filter((s) => s === 'pass').length;
    if (passes > best) { best = passes; winner = si; }
  }
  const specPath = specPaths[winner];
  const specName = specPath.replace(/^.*[\\/]/, '');
  // TLA+ module name = output basename; must be alphanumeric and match the file.
  let moduleName = specName.replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9_]/g, '_');
  if (!/^[A-Za-z]/.test(moduleName)) moduleName = 'M' + moduleName;
  const tlaDir = join(outDir, 'tla');
  mkdirSync(tlaDir, { recursive: true });

  const report = { spec: specName, windowsPassed: best, windowsTotal: matrix[winner].length };
  let transpiled;
  try {
    const { transpile } = await import('./to-tla.mjs');
    transpiled = await transpile(specPath, {
      outPath: join(tlaDir, `${moduleName}.tla`),
      bound: posInt(opts['tla-bound'], 'tla-bound', undefined),
      invariantsPath: invPath || null,
      contractPath,
    });
  } catch (e) {
    // Transpiler refusal (construct outside the transpilable subset) — a
    // checkable property of the spec, reported loudly, not a crash.
    return { ...report, transpileError: String(e && e.message) };
  }
  report.tlaPath = transpiled.tlaPath;
  report.cfgPath = transpiled.cfgPath;
  report.actions = transpiled.actions;
  report.invariants = transpiled.invariants;
  report.skippedInvariants = transpiled.skippedInvariants;

  try {
    const { runTlc, TlcNotAvailableError } = await import('./tla-check.mjs');
    try {
      const timeoutMs = opts['tla-timeout'] ? posInt(opts['tla-timeout'], 'tla-timeout', undefined) * 1000 : undefined;
      const r = runTlc(transpiled.tlaPath, { cfgPath: transpiled.cfgPath, ...(timeoutMs ? { timeoutMs } : {}) });
      report.tlc = {
        status: r.status,
        statesGenerated: r.statesGenerated,
        distinctStates: r.distinctStates,
        violatedInvariants: r.violatedInvariants,
        counterexample: r.counterexample,
        durationMs: r.durationMs,
      };
      if (r.status === 'error') report.tlc.output = r.output;
    } catch (e) {
      if (e instanceof TlcNotAvailableError) {
        // Toolchain missing = a note, not an error: the .tla/.cfg artifacts
        // are still on disk for the user to run elsewhere.
        report.toolchainNote = String(e.message);
      } else {
        report.tlc = { status: 'error', error: String(e && e.message) };
      }
    }
  } catch (e) {
    report.tlc = { status: 'error', error: String(e && e.message) };
  }
  return report;
}

function renderMarkdown(summary, findings, invReport, tlaReport) {
  const L = [];
  L.push('# Polygraph — verification findings\n');
  L.push('> Consistency check, not a proof. Every finding is a lead to investigate by hand.\n');
  L.push('## Part 1 — trace conformance (replay)\n');
  L.push(`- specs replayed: **${summary.specs}** (live: **${summary.liveSpecs}**)`);
  if (summary.deadSpecs && summary.deadSpecs.length) {
    L.push(`- ⚠️ **${summary.deadSpecs.length} spec(s) failed to load/replay and were EXCLUDED from window verdicts: ${summary.deadSpecs.join(', ')}** — fix generation for these; the verdicts below cover the live specs only.`);
  }
  L.push(`- windows: **${summary.windows}**`);
  if (summary.agreement) {
    const a = summary.agreement;
    const excluded = summary.windows - a.measuredWindows;
    const suffix = excluded ? ` (${excluded} unscoreable-everywhere window(s) excluded from the measure)` : '';
    if (a.pairwisePct === null) {
      L.push(`- spec agreement: NOTHING MEASURED — every window was unscoreable in every live spec.`);
    } else if (a.pairwisePct === 100 && !a.outliers.length && !a.noMajority) {
      // The quiet line requires FULL agreement — not merely "no nameable
      // outlier": an even split (1-vs-1, 2-vs-2) has no strict majority and
      // must never render as consensus.
      L.push(`- spec agreement: pairwise **100%** — all ${a.liveSpecs} live specs agree on every measured window${suffix}`);
    } else {
      const parts = [];
      if (a.outliers.length) parts.push(a.outliers.map((o) => `**${o.spec}** deviates from the majority on ${o.deviations}/${a.majorityWindows} majority-bearing windows`).join('; '));
      if (a.noMajority) parts.push(`**${a.noMajority} window(s) split with NO majority** (even disagreement — nobody is "the outlier"; read those windows spec by spec)`);
      L.push(`- spec agreement: pairwise **${a.pairwisePct}%**; ${parts.join('; ')} — review before trusting the vote: a lopsided split marks a spot where the source is easy to misread, and the majority is NOT automatically right (the minority may be the one that read it correctly — check it against the source, not the vote count). Shared failures are counted as agreement WITHOUT comparing outputs — the matrix cannot distinguish an identical mistake from different ones.${suffix}`);
    }
  }
  L.push(`- consistent (pass in all live specs): **${summary.consistent}**`);
  L.push(`- likely spec-error (some specs miss it): **${summary.specError}**`);
  L.push(`- likely code-finding / contract-error (all specs disagree): **${summary.codeFinding}**`);
  L.push(`- unscoreable in all specs (specs didn't load): **${summary.unscoreableAll}**`);
  if (summary.unhandledWindows) {
    L.push(`- ⚠️ windows where a spec neither acted nor REJECTED (\`unhandled\`): **${summary.unhandledWindows}** — unexplained silence; a faithful spec should either transition or reject(reason).`);
  }
  if (summary.rejectedActedWindows) {
    L.push(`- ⚠️ windows where a spec REJECTED while the code ACTED (trace post ≠ pre): **${summary.rejectedActedWindows}** — if this is uniform across specs and windows, suspect the reject-as-annotation trap: \`reject(reason)\` is a terminal DECLINE that discards every \`next.*\` write in the branch; a generation that computes the right transition and then appends reject(reason) as a label throws its own work away. Look for a trailing \`reject(...)\` after \`next.*\` assignments in the specs before reading these as code findings.`);
  }
  L.push('');
  if (!findings.length) {
    L.push('All windows consistent across all specs — the derived spec reproduces the code.');
    L.push('_Note: a faithful spec reproduces bugs too, so a clean Part 1 is not a clean bill of');
    L.push('health. The bug-finding is Part 2._\n');
    renderInvSection(L, invReport);
    renderTlaSection(L, tlaReport);
    return L.join('\n');
  }
  L.push('## Windows to review\n');
  L.push('| scenario | # | action | verdict | per-spec | split | step classification (per live spec) |');
  L.push('|---|---|---|---|---|---|---|');
  for (const f of findings) {
    const cls = (f.classifications || []).map((c) => c ?? '—').join(', ') || '—';
    L.push(`| ${f.scenario} | ${f.index} | ${f.action} | ${f.verdict} | ${f.statuses.join(', ')} | ${f.split || '—'} | ${cls} |`);
  }
  L.push('\n**Reading the verdicts**');
  L.push('- *code-finding / contract-error*: every spec disagrees with the trace here. Either the code does something you did not expect (a defect) or your observable-state contract omits a field that drives this transition. Investigate the source at this (pre-state, action).');
  L.push('- *spec-error*: some generations pass, some fail. Usually one generation missed a rule — but a LOPSIDED split (see the split column) cuts both ways: several specs sharing a failure looks the same as one spec missing a rule, and the status matrix does not compare their outputs (a shared failure may or may not be the same mistake). Check the minority against the source before siding with the vote count; the missed rules are typically special cases living outside the main state table.');
  L.push('- *unscoreable in all specs*: the generated modules did not load or export next(). Fix generation, not the code.');
  L.push('\n**Reading the step classifications** (v2 SAM artifact only)');
  L.push('- *rejected(reason)* and *identity-by-mutation* are the two GOOD no-op classes: the spec explicitly declined or explicitly re-committed the same state.');
  L.push('- *unhandled* on a failing window is itself a finding: the spec neither acted nor rejected — usually a missing acceptor case (spec-error) or a rule the code has that the contract does not.');
  L.push('- *rejected(reason)* on a window where the TRACE changed state (post ≠ pre) means the spec declined a transition the code performed. Uniform across specs and windows, this is the reject-as-annotation trap (reject discards the `next` draft; it never tags a success) — inspect the specs for a trailing reject after `next.*` writes.');
  renderInvSection(L, invReport);
  renderTlaSection(L, tlaReport);
  return L.join('\n');
}

function renderInvSection(L, invReport) {
  L.push('\n## Part 2 — invariant violations (model checking)\n');
  if (!invReport) {
    L.push('_No invariants provided, so the bug-finding half did not run._ Replay alone only');
    L.push('catches bugs where the derived spec DISAGREES with the code — a faithful spec does');
    L.push('not, so it misses bugs on legible code. Add an `invariants.mjs` (rules encoding what');
    L.push('the code *should* do) and re-run: the checker iterates the spec exhaustively and');
    L.push('reports any reachable state that breaks a rule, with a counterexample path.');
    return;
  }
  // Failures and truncation must be VISIBLE: a model check that did not run,
  // only partially ran, or explored a bounded/pruned graph must never read as
  // an unqualified clean result.
  for (const e of invReport.errors || []) L.push(`- ⚠️ ${e}`);
  if (invReport.checkedSpecs === 0) {
    L.push('\n⚠️ **Model check DID NOT RUN — the checker could not load/run any spec.** The');
    L.push('errors above are generation/loading problems, not evidence about the code.');
    return;
  }
  L.push(`- states explored: **${invReport.statesExplored}** · specs checked: **${invReport.checkedSpecs}/${invReport.specs}**${invReport.capHit ? ' · ⚠️ **CAP HIT — exploration bounded, not exhaustive**' : ''}`);
  for (const n of invReport.domainNotes || []) L.push(`- ⚠️ WARNING: ${n}`);
  // Likely-unbounded keys: the cap, not the machine, decided where exploration
  // stopped — a clean verdict below covers an arbitrary prefix of the space.
  for (const d of invReport.driftWarnings || []) L.push(`- ⚠️ WARNING: ${d}`);
  for (const f of invReport.frozenKeys || []) {
    const who = f.strength === 'all-specs' ? `every checked spec (${f.specs}/${invReport.checkedSpecs})` : `${f.specs}/${invReport.checkedSpecs} checked spec(s) — the others vary it, a spec disagreement worth a look`;
    // Two honesty qualifiers: (a) specs that froze the key at DIFFERENT
    // constants disagree on the machine's configuration — say so instead of
    // asserting the first spec's value for all of them; (b) under CAP HIT
    // "frozen" is only established over the truncated graph, and the right
    // first remedy is a bigger exploration, not seeding.
    const at = f.values.length === 1
      ? `stays ${JSON.stringify(f.values[0])}`
      : `is frozen at DIFFERING constants (${f.values.map((v) => JSON.stringify(v)).join(', ')}) — the specs disagree on this configuration value; review that split first`;
    const scope = invReport.capHit
      ? 'in every EXPLORED state (exploration was bounded — raise `--max-states` before concluding it is frozen)'
      : 'in every state reachable';
    L.push(`- ⚠️ FROZEN STATE KEY: \`${f.key}\` ${at} ${scope} by ${who}. If it gates behavior, this model check is structurally blind to that behavior — seed \`--initial-states\` (or capture traces) with a non-default value.`);
  }
  if (!invReport.violations.length) {
    const qualified = (invReport.domainNotes || []).length
      ? `\nNo invariant violations reachable over the EXPLORED alphabet (${invReport.domainNotes.length} action/field(s) skipped — see warnings). (Bounded exploration; not a proof.)`
      : '\nNo invariant violations reachable. (Bounded exploration; not a proof.)';
    L.push((invReport.frozenKeys || []).length
      ? `${qualified} ${invReport.frozenKeys.length} frozen state key(s) — see warnings above — bound what "reachable" covers.`
      : qualified);
    return;
  }
  L.push(`\n**${invReport.violations.length} invariant violation(s) reachable — these are bugs, with counterexamples:**\n`);
  L.push('| invariant | kind | strength | counterexample (init → …) |');
  L.push('|---|---|---|---|');
  for (const v of invReport.violations) {
    const ex = v.example.path.map((s, i) => i === 0 ? 'init' : `${s.action}(${JSON.stringify(s.data)})`).join(' → ');
    L.push(`| ${v.invariant} | ${v.kind} | ${v.strength} | ${ex} |`);
  }
  L.push('\nAn *all-specs* violation means every independently derived model reaches the bad');
  L.push('state — a strong signal. Follow the counterexample path in the source.');
}

/** Render the TLC escalation subsection (only when --tla was requested). */
function renderTlaSection(L, tlaReport) {
  if (!tlaReport) return;
  L.push('\n### TLC escalation (`--tla`)\n');
  if (tlaReport.skipped) {
    L.push(`_Skipped: ${tlaReport.skipped}_`);
    return;
  }
  L.push(`Winning spec escalated to TLA+: **${tlaReport.spec}** (${tlaReport.windowsPassed}/${tlaReport.windowsTotal} windows passed).`);
  if (tlaReport.transpileError) {
    L.push('\n⚠️ **Transpiler refused this spec** — it uses a construct outside the mechanically');
    L.push('transpilable subset (transpilability is a checkable property, not a best-effort guess):');
    L.push('```');
    L.push(tlaReport.transpileError);
    L.push('```');
    L.push('The bounded JS exploration in Part 2 above still stands; only the TLC tier is unavailable for this spec.');
    return;
  }
  L.push(`- artifacts: \`${tlaReport.tlaPath}\` + \`${tlaReport.cfgPath}\``);
  L.push(`- actions transpiled: ${tlaReport.actions.map((a) => `${a.name}(${a.payloadCount})`).join(', ')}`);
  L.push(`- invariants translated to TLA+: ${tlaReport.invariants.length ? tlaReport.invariants.map((n) => `\`${n}\``).join(', ') : '(none)'}`);
  for (const s of tlaReport.skippedInvariants || []) {
    L.push(`- ⚠️ invariant NOT carried into TLC — \`${s.name}\` (${s.kind}): ${s.reason}`);
  }
  if (tlaReport.toolchainNote) {
    L.push(`\n_TLC did not run (toolchain unavailable): ${tlaReport.toolchainNote}_`);
    L.push('_The .tla/.cfg artifacts above are complete — run TLC on them wherever Java is available._');
    return;
  }
  const t = tlaReport.tlc;
  if (!t) return;
  if (t.error) {
    L.push(`\n⚠️ TLC failed to run: ${t.error}`);
    return;
  }
  if (t.status === 'pass' && tlaReport.invariants.length === 0) {
    // A "PASS" with zero translated invariants would dress a vacuous run as
    // evidence — TLC only explored and deadlock-checked.
    L.push(`\n**TLC: EXPLORED ONLY (no invariants translated — nothing was checked)** — ${t.statesGenerated} states generated, ${t.distinctStates} distinct. The run proves reachability only; every invariant was skipped (see the list above).`);
  } else if (t.status === 'pass') {
    L.push(`\n**TLC: PASS** — ${t.statesGenerated} states generated, ${t.distinctStates} distinct; no translated invariant is violated in the FULL bounded state space (exhaustive within the payload domains and bound, not a proof beyond them).`);
  } else if (t.status === 'invariant-violation') {
    L.push(`\n**TLC: INVARIANT VIOLATION** — ${t.violatedInvariants.map((n) => `\`${n}\``).join(', ')} (${t.statesGenerated} states generated, ${t.distinctStates} distinct).`);
  } else {
    L.push(`\n⚠️ **TLC: ${t.status.toUpperCase()}**${t.statesGenerated != null ? ` — ${t.statesGenerated} states generated` : ''}. See \`findings.json\` (tlaReport.tlc) for the raw output.`);
  }
  if (tlaReport.invariants.length) {
    L.push('\n| invariant | TLC verdict |');
    L.push('|---|---|');
    for (const n of tlaReport.invariants) {
      const violated = t.violatedInvariants && t.violatedInvariants.includes(n);
      // TLC stops at the first violation, so co-checked invariants that are
      // not the violated one are NOT thereby established.
      const verdict = violated ? '❌ violated'
        : t.status === 'pass' ? '✅ holds (full bounded space)'
        : '❓ not established (run stopped early)';
      L.push(`| ${n} | ${verdict} |`);
    }
  }
  if (t.counterexample && t.counterexample.length) {
    L.push('\n**Counterexample (TLC behavior trace):**\n');
    L.push('```');
    for (const s of t.counterexample) {
      L.push(`State ${s.num}: ${s.action}`);
      if (s.vars) L.push(s.vars.split('\n').map((l) => '  ' + l).join('\n'));
    }
    L.push('```');
  }
}

// CLI
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let a;
  try { a = parseArgs(process.argv.slice(2)); }
  catch (e) { console.error('[verify] ' + e.message); process.exit(2); }
  if (!a.contract || !a.traces) {
    console.error('usage: verify.mjs --contract <c.json> --traces <dir> (--source <f> --model <id> [--n 5] [--max-tokens 32000] | --specs <dir>) [--invariants <inv.mjs>] [--initial-states <states.json>] [--max-states N] [--out <dir>] [--legacy-bare-next] [--tla [--tla-bound N] [--tla-timeout <s>]]');
    process.exit(2);
  }
  verify(a).then((r) => {
    console.log(`\n${r.summary.consistent}/${r.summary.windows} windows consistent across ${r.summary.specs} spec(s).`);
    console.log(`findings: ${r.summary.specError} spec-error, ${r.summary.codeFinding} code-finding/contract, ${r.summary.unscoreableAll} unscoreable-all`);
    if (r.tlaReport) {
      const t = r.tlaReport;
      if (t.skipped) console.log(`tla: skipped — ${t.skipped}`);
      else if (t.transpileError) console.log(`tla: transpiler refused ${t.spec} (see report)`);
      else if (t.toolchainNote) console.log(`tla: transpiled ${t.spec} -> ${t.tlaPath}; TLC not run (toolchain unavailable)`);
      else if (t.tlc) console.log(`tla: ${t.spec} -> TLC ${t.tlc.status}${t.tlc.statesGenerated != null ? ` (${t.tlc.statesGenerated} states)` : ''}`);
    }
    console.log(`report: ${join(r.outDir, 'findings.md')}`);
  }).catch((e) => { console.error('[verify] ' + e.message); process.exit(1); });
}
