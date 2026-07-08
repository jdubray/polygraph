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
import { loadWindows, replaySpec } from './replay.mjs';
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

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { a[argv[i].slice(2)] = argv[i + 1]; i++; }
  }
  return a;
}

/** Classify one window given its status across all specs. */
function classify(statuses) {
  const passes = statuses.filter((s) => s === 'pass').length;
  const n = statuses.length;
  if (passes === n) return 'consistent';
  if (statuses.every((s) => s === 'unscoreable')) return 'unscoreable-all';
  if (passes === 0) return 'code-finding-or-contract';
  return 'spec-error';
}

export async function verify(opts) {
  const contract = JSON.parse(readFileSync(opts.contract, 'utf-8'));
  const windows = loadWindows(opts.traces);
  const outDir = opts.out || 'out';
  mkdirSync(outDir, { recursive: true });

  // Obtain spec file paths.
  let specPaths = [];
  if (opts.specs) {
    specPaths = readdirSync(opts.specs).filter((f) => f.endsWith('.js')).sort().map((f) => join(opts.specs, f));
  } else {
    if (!opts.model) throw new Error('--model is required in generation mode (or use --specs)');
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set (or use --specs to replay saved specs)');
    const source = readFileSync(opts.source, 'utf-8');
    const lang = contract.lang || (String(opts.source).endsWith('.ts') ? 'typescript' : 'javascript');
    const prompt = buildPrompt(contract, source, { filePath: opts.source, lang });
    const maxTokens = opts['max-tokens'] ? Number(opts['max-tokens']) : undefined;
    const gens = await generateSpecs({ prompt, model: opts.model, n: Number(opts.n || 5), apiKey, maxTokens });
    const specDir = join(outDir, 'specs');
    mkdirSync(specDir, { recursive: true });
    gens.forEach((g) => {
      if (g.ok) { const p = join(specDir, `spec_${g.index}.js`); writeFileSync(p, g.spec, 'utf-8'); specPaths.push(p); }
      else console.error(`[verify] generation ${g.index} failed: ${g.error}`);
    });
    if (!specPaths.length) throw new Error('no specs generated');
  }

  // Replay every spec; build a per-window status matrix.
  const matrix = specPaths.map((p) => replaySpec(p, windows)); // matrix[spec][window]
  const perWindow = windows.map((w, wi) => {
    const statuses = matrix.map((row) => row[wi]);
    return { scenario: w.scenario, index: w.index, action: w.action, statuses, verdict: classify(statuses) };
  });

  const summary = {
    specs: specPaths.length,
    windows: windows.length,
    consistent: perWindow.filter((w) => w.verdict === 'consistent').length,
    specError: perWindow.filter((w) => w.verdict === 'spec-error').length,
    codeFinding: perWindow.filter((w) => w.verdict === 'code-finding-or-contract').length,
    unscoreableAll: perWindow.filter((w) => w.verdict === 'unscoreable-all').length,
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
    const perSpec = specPaths.map((p) => { try { return check({ specModule: loadSpec(p), contract, invariants, windows }); } catch (e) { return { ok: true, statesExplored: 0, capHit: false, violations: [], error: String(e && e.message) }; } });
    // An invariant violated by ALL specs is a strong finding; by some is spec-dependent.
    const byName = new Map();
    perSpec.forEach((r, si) => r.violations.forEach((v) => {
      const e = byName.get(v.invariant) || { invariant: v.invariant, kind: v.kind, specs: 0, example: v };
      e.specs++; byName.set(v.invariant, e);
    }));
    const violations = [...byName.values()].map((e) => ({ ...e, strength: e.specs === specPaths.length ? 'all-specs' : 'some-specs' }));
    invReport = { specs: specPaths.length, statesExplored: Math.max(0, ...perSpec.map((r) => r.statesExplored)), violations };
  }

  writeFileSync(join(outDir, 'findings.json'), JSON.stringify({ summary, findings, perWindow, invReport }, null, 2), 'utf-8');
  writeFileSync(join(outDir, 'findings.md'), renderMarkdown(summary, findings, invReport), 'utf-8');
  return { summary, findings, invReport, outDir };
}

function renderMarkdown(summary, findings, invReport) {
  const L = [];
  L.push('# Polygraph — verification findings\n');
  L.push('> Consistency check, not a proof. Every finding is a lead to investigate by hand.\n');
  L.push('## Part 1 — trace conformance (replay)\n');
  L.push(`- specs replayed: **${summary.specs}**`);
  L.push(`- windows: **${summary.windows}**`);
  L.push(`- consistent (pass in all specs): **${summary.consistent}**`);
  L.push(`- likely spec-error (some specs miss it): **${summary.specError}**`);
  L.push(`- likely code-finding / contract-error (all specs disagree): **${summary.codeFinding}**`);
  L.push(`- unscoreable in all specs (specs didn't load): **${summary.unscoreableAll}**\n`);
  if (!findings.length) {
    L.push('All windows consistent across all specs — the derived spec reproduces the code.');
    L.push('_Note: a faithful spec reproduces bugs too, so a clean Part 1 is not a clean bill of');
    L.push('health. The bug-finding is Part 2._\n');
    renderInvSection(L, invReport);
    return L.join('\n');
  }
  L.push('## Windows to review\n');
  L.push('| scenario | # | action | verdict | per-spec |');
  L.push('|---|---|---|---|---|');
  for (const f of findings) {
    L.push(`| ${f.scenario} | ${f.index} | ${f.action} | ${f.verdict} | ${f.statuses.join(', ')} |`);
  }
  L.push('\n**Reading the verdicts**');
  L.push('- *code-finding / contract-error*: every spec disagrees with the trace here. Either the code does something you did not expect (a defect) or your observable-state contract omits a field that drives this transition. Investigate the source at this (pre-state, action).');
  L.push('- *spec-error*: some generations pass, some fail. Usually one generation missed a rule; check the majority. The missed rules are typically special cases living outside the main state table.');
  L.push('- *unscoreable in all specs*: the generated modules did not load or export next(). Fix generation, not the code.');
  renderInvSection(L, invReport);
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
  L.push(`- states explored: **${invReport.statesExplored}** · specs checked: **${invReport.specs}**`);
  if (!invReport.violations.length) { L.push('\nNo invariant violations reachable. (Bounded exploration; not a proof.)'); return; }
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

// CLI
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const a = parseArgs(process.argv.slice(2));
  if (!a.contract || !a.traces) {
    console.error('usage: verify.mjs --contract <c.json> --traces <dir> (--source <f> --model <id> [--n 5] [--max-tokens 32000] | --specs <dir>) [--invariants <inv.mjs>] [--out <dir>]');
    process.exit(2);
  }
  verify(a).then((r) => {
    console.log(`\n${r.summary.consistent}/${r.summary.windows} windows consistent across ${r.summary.specs} spec(s).`);
    console.log(`findings: ${r.summary.specError} spec-error, ${r.summary.codeFinding} code-finding/contract, ${r.summary.unscoreableAll} unscoreable-all`);
    console.log(`report: ${join(r.outDir, 'findings.md')}`);
  }).catch((e) => { console.error('[verify] ' + e.message); process.exit(1); });
}
