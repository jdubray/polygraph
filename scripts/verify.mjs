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
    const prompt = buildPrompt(contract, source, { filePath: opts.source, lang, mode });
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
    return entry;
  });

  const summary = {
    specs: specPaths.length,
    liveSpecs: liveIdx.length,
    deadSpecs,
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
  };
  const findings = perWindow.filter((w) => w.verdict !== 'consistent');

  // ── Second half: model-check each spec against invariants (the bug-finder) ──
  // Replay only catches bugs where the spec DISAGREES with the code; a faithful
  // spec does not. Iterating the spec against invariants REACHES bad states a
  // faithful spec still contains. Runs only when invariants are provided.
  let invReport = null;
  const invPath = resolveInvariantsPath(opts, contract);
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
        const r = check({ specModule: loadSpec(p), contract, invariants, windows, legacyBareNext: mode === 'legacy', ...(maxStates ? { maxStates } : {}) });
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
    invReport = {
      specs: specPaths.length,
      checkedSpecs: ran.length,
      statesExplored: Math.max(0, ...ran.map((r) => r.statesExplored)),
      capHit: ran.some((r) => r.capHit),
      errors,
      domainNotes,
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
  L.push(`- consistent (pass in all live specs): **${summary.consistent}**`);
  L.push(`- likely spec-error (some specs miss it): **${summary.specError}**`);
  L.push(`- likely code-finding / contract-error (all specs disagree): **${summary.codeFinding}**`);
  L.push(`- unscoreable in all specs (specs didn't load): **${summary.unscoreableAll}**`);
  if (summary.unhandledWindows) {
    L.push(`- ⚠️ windows where a spec neither acted nor REJECTED (\`unhandled\`): **${summary.unhandledWindows}** — unexplained silence; a faithful spec should either transition or reject(reason).`);
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
  L.push('| scenario | # | action | verdict | per-spec | step classification (per live spec) |');
  L.push('|---|---|---|---|---|---|');
  for (const f of findings) {
    const cls = (f.classifications || []).map((c) => c ?? '—').join(', ') || '—';
    L.push(`| ${f.scenario} | ${f.index} | ${f.action} | ${f.verdict} | ${f.statuses.join(', ')} | ${cls} |`);
  }
  L.push('\n**Reading the verdicts**');
  L.push('- *code-finding / contract-error*: every spec disagrees with the trace here. Either the code does something you did not expect (a defect) or your observable-state contract omits a field that drives this transition. Investigate the source at this (pre-state, action).');
  L.push('- *spec-error*: some generations pass, some fail. Usually one generation missed a rule; check the majority. The missed rules are typically special cases living outside the main state table.');
  L.push('- *unscoreable in all specs*: the generated modules did not load or export next(). Fix generation, not the code.');
  L.push('\n**Reading the step classifications** (v2 SAM artifact only)');
  L.push('- *rejected(reason)* and *identity-by-mutation* are the two GOOD no-op classes: the spec explicitly declined or explicitly re-committed the same state.');
  L.push('- *unhandled* on a failing window is itself a finding: the spec neither acted nor rejected — usually a missing acceptor case (spec-error) or a rule the code has that the contract does not.');
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
  if (!invReport.violations.length) {
    const qualified = (invReport.domainNotes || []).length
      ? `\nNo invariant violations reachable over the EXPLORED alphabet (${invReport.domainNotes.length} action/field(s) skipped — see warnings). (Bounded exploration; not a proof.)`
      : '\nNo invariant violations reachable. (Bounded exploration; not a proof.)';
    L.push(qualified);
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
    console.error('usage: verify.mjs --contract <c.json> --traces <dir> (--source <f> --model <id> [--n 5] [--max-tokens 32000] | --specs <dir>) [--invariants <inv.mjs>] [--max-states N] [--out <dir>] [--legacy-bare-next] [--tla [--tla-bound N] [--tla-timeout <s>]]');
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
