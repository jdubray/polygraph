// polygen: write NEW verifiable code out of the box, instead of auditing
// existing code. Reuses the SAME verification core as verify.mjs — check.mjs
// (model-checking), validate_corpus.mjs (corpus hygiene), replay.mjs (an
// independent, separate-process replay) — so a fix to that core benefits both
// modes. What's new here is generative: draft a contract, author a machine
// against it, propose invariants, self-repair against reachable violations
// BEFORE anything ships, then synthesize a demo/regression trace corpus by
// actually driving the final code.
//
// Artifact modes (Option A full switch, mirroring verify.mjs):
//   'sam'    (default) — the authored artifact is a SAM v2 strict-profile
//            module ({ instance, init, actions, getState, setState }). Every
//            authored/repaired module must pass a strict validate() gate
//            (instance({}).validate()) at the stage boundary — schema/shape
//            errors are stage-blocking, never report lines. Unloadable or
//            truncated rewrites get ONE retry with the load error appended.
//   'legacy' — the bare next(state, action, data) module (--legacy-bare-next),
//            preserved byte-for-byte as the previous release behaved.
//
// v1 is scoped to JS/TS: the generated machine is directly usable only in a
// JS/TS codebase. Porting a verified machine to another language is a real,
// separate problem (the port itself would need a differential check against
// the JS original) and is out of scope here.
//
// Usage (module): polygen({ intent, contractPath?, lang, model, apiKey, out, repairMax, maxTokens, legacyBareNext })
// Usage (CLI):     node polygen.mjs --intent "<text>" --model <id> [--contract <c.json>] [--lang javascript] [--out out/] [--repair-max 3] [--max-tokens 32000] [--legacy-bare-next]
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { callMessages, extractSpec, DEFAULT_MAX_TOKENS } from './generate.mjs';
import { resolveModel } from './models.mjs';
import { check, buildDomain } from './check.mjs';
import { loadSpec } from './load-spec.mjs';
import { loadWindows, replaySpec, replaySpecResults } from './replay.mjs';
import { validateCorpus } from './validate_corpus.mjs';
import samAdapter from './sam-adapter.cjs';
import {
  buildContractDraftPrompt,
  buildAuthorPrompt,
  buildInvariantsPrompt,
  buildRepairPrompt,
  buildDomainGapRepairPrompt,
  buildScenariosPrompt,
  buildSyntaxFixPrompt,
} from './polygen_prompts.mjs';

const { isSamV2Module } = samAdapter;

/**
 * Cross-check: every dataDomain value the contract declares should be
 * referenced verbatim somewhere in the authored code. The contract and the
 * code come from two INDEPENDENT model calls, so nothing else guarantees they
 * agree on enum spelling — a mismatch means the model checker can never
 * explore whatever transition that value should gate (a coverage collapse
 * that can look like a clean "no violations found" for the wrong reason).
 * Heuristic (string presence, not a real reference analysis) — flags
 * likely gaps, not a proof either way.
 */
export function findDataDomainRefGaps(contract, code) {
  const gaps = [];
  // Strings: quoted-literal presence. Numbers/booleans: standalone-token
  // match — bare `code.includes(String(v))` made these UNFALSIFIABLE
  // (any digit in a comment matched `3`; every module contains `true`
  // in `strict: true`). Token matching still can't tell `true` the
  // domain value from `true` the option flag — booleans stay a weak
  // signal; the checker's manifest-driven exploration + coverage notes
  // carry the real guarantee for those.
  const scalarFound = (v) => {
    const token = String(v).replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
    return typeof v === 'string'
      ? code.includes(`'${v}'`) || code.includes(`"${v}"`)
      : new RegExp(`(?<![\\w.$])${token}(?![\\w.$])`).test(code);
  };
  // OBJECT-valued domain entries (e.g. childState = {shipState:'delivered'})
  // are never referenced "verbatim" — code reads their LEAVES
  // (`childState.shipState === 'delivered'`). Checking the whole object as a
  // string made such entries permanently-unsatisfiable false positives that
  // burned real repair iterations (see examples/polyrun-oms REPAIR-NOTE).
  // So: recurse and require each scalar LEAF to be referenced, reporting the
  // leaf path on a miss.
  const leaves = (v, path) => {
    if (v !== null && typeof v === 'object') {
      const entries = Array.isArray(v) ? v.map((x, i) => [i, x]) : Object.entries(v);
      return entries.flatMap(([k, x]) => leaves(x, `${path}.${k}`));
    }
    return [[path, v]];
  };
  for (const [action, fields] of Object.entries(contract.dataDomain || {})) {
    for (const [field, values] of Object.entries(fields)) {
      for (const v of values) {
        for (const [path, leaf] of leaves(v, `${action}.${field}`)) {
          if (leaf === null || !scalarFound(leaf)) {
            if (leaf === null) continue; // null carries no referenceable token
            gaps.push(`${path} = ${JSON.stringify(leaf)} (declared in dataDomain, never referenced in the code — the transition it should gate may be unreachable)`);
          }
        }
      }
    }
  }
  return gaps;
}

/** Extract the first fenced block of ANY (or no) language tag — for JSON blocks extractSpec (js/ts-only tags) won't match. */
function extractFenced(text) {
  const m = text.match(/```(?:\w+)?\s*\n([\s\S]*?)\n```/);
  if (!m) throw new Error('no fenced code block found in model response');
  return m[1];
}

async function callOrThrow(stage, { prompt, model, maxTokens, apiKey }) {
  const r = await callMessages({ prompt, model, maxTokens, apiKey });
  if (!r.ok) throw new Error(`[polygen] ${stage} failed: ${r.error}`);
  return r.text;
}

/**
 * v2 stage gate: the module must export the v2 SAM strict surface AND pass
 * the library's own strict validate() (instance({}).validate() throws a
 * SamValidationError listing missing obligations — the strict analog of TLC
 * refusing to run without CONSTANTS). Called at every author/repair stage
 * boundary so a schema/shape defect is STAGE-BLOCKING, never a report line.
 * Returns the module for loader chaining.
 */
export function validateV2Module(mod) {
  if (!isSamV2Module(mod)) {
    const hint = mod && typeof mod.next === 'function' ? ' (it exports next() — a legacy bare-next module; use --legacy-bare-next for that artifact)' : '';
    throw new Error(`generated module does not export the v2 SAM surface { instance, init, actions, getState, setState }${hint}`);
  }
  const accessor = mod.instance({});
  if (typeof accessor.validate === 'function') {
    // In strict mode validate() THROWS on missing obligations; in non-strict
    // mode it RETURNS the problems array instead. The gate exists because
    // model output can't be trusted to obey the prompt's `strict: true` — so
    // a returned non-empty array (the non-strict tell) must fail just as
    // loudly, or the whole gate is vacuous for a disobedient module.
    const problems = accessor.validate();
    if (Array.isArray(problems) && problems.length) {
      throw new Error(`generated module fails strict validate() (and was built NON-STRICT — the profile requires strict: true): ${problems.join('; ')}`);
    }
  }
  // Dead-at-init gate: at least ONE declared domain step must be ACCEPTED
  // from the initial state, or the whole machine is unreachable and every
  // downstream stage silently checks nothing (the checker reports "1 state
  // explored, no violations" — technically true, entirely vacuous). The
  // known generator failure this catches: emitting `name:` on the SAM
  // component, which binds acceptors to a LOCAL component state tree — every
  // guard reads undefined and rejects, while validate() stays green.
  {
    const { makeSamAdapter, domainFromManifest } = samAdapter;
    const adapter = makeSamAdapter(mod);
    const { steps } = domainFromManifest(mod);
    if (steps.length > 0) {
      const initState = adapter.init();
      const initKey = JSON.stringify(initState);
      let live = false;
      for (const step of steps.slice(0, 200)) {
        try {
          if (JSON.stringify(adapter.next(initState, step.action, step.data)) !== initKey) { live = true; break; }
        } catch { /* a throwing step is not an accepting step; keep probing */ }
      }
      if (!live) {
        throw new Error('generated module is DEAD AT INIT: every declared domain action is rejected from the initial state. '
          + 'Most common cause: the component declares `name:`, which binds acceptors to a LOCAL state tree so every guard reads undefined — '
          + 'the component must be anonymous (no `name:` key) so acceptors operate on the shared instance state.');
      }
    }
  }
  return mod;
}

/**
 * v2 authoring/repair transport: call the model with `prompt`, extract and
 * write the module, and LOAD-CHECK IT BEFORE SCORING. On an unloadable or
 * truncated rewrite, retry ONCE with the original prompt plus an appended
 * "your previous rewrite was truncated/unloadable" line (re-prompting the
 * TASK, not a syntax-fix of a half-module — a truncated module has no syntax
 * to fix). A second failure throws loudly. `call(stage, prompt)` and `loadFn`
 * are injected so the retry logic is unit-testable without any API.
 * Returns { source, loaded, retried }.
 */
export async function requestLoadableModule({ label, prompt, call, path, loadFn = loadSpec, maxAttempts = 2 }) {
  let currentPrompt = prompt;
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const text = await call(attempt === 1 ? label : `${label}-reload-${attempt - 1}`, currentPrompt);
    const source = extractSpec(text);
    writeFileSync(path, source, 'utf-8');
    try {
      const loaded = await loadFn(path);
      return { source, loaded, retried: attempt > 1 };
    } catch (e) {
      lastError = e;
      currentPrompt = `${prompt}\n\nYour previous rewrite was truncated/unloadable: ${String(e && e.message)}. Emit the COMPLETE module.`;
    }
  }
  throw new Error(`[polygen] ${label}: rewrite still truncated/unloadable after ${maxAttempts} attempt(s): ${String(lastError && lastError.message)}`);
}

/**
 * Legacy transport (kept byte-compatible for --legacy-bare-next): write
 * `source` to `path` and attempt `loadFn(path)`. On a load failure, feed the
 * error back via a SYNTAX-FIX prompt and retry up to `maxAttempts` total
 * attempts before giving up loudly. Returns { source, loaded }.
 */
async function writeAndLoadWithSyntaxRetry({ label, source, path, loadFn, call, lang, maxAttempts = 2 }) {
  let current = source;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    writeFileSync(path, current, 'utf-8');
    try {
      const loaded = await loadFn(path);
      return { source: current, loaded };
    } catch (e) {
      if (attempt === maxAttempts) {
        throw new Error(`[polygen] ${label}: still fails to load after ${maxAttempts} attempt(s): ${e && e.message}`);
      }
      const fixText = await call(`${label}-syntax-fix-${attempt}`, buildSyntaxFixPrompt(current, String(e && e.message), { lang }));
      current = extractSpec(fixText);
    }
  }
}

export async function polygen(opts) {
  const {
    intent, contractPath, lang = 'javascript', model, apiKey,
    out = 'out', repairMax = 3, maxTokens = DEFAULT_MAX_TOKENS, maxStates = 100000,
    legacyBareNext = false,
  } = opts;
  if (!intent) throw new Error('intent is required');
  // callImpl is the injectable model transport (tests); the API path needs
  // credentials, an injected stub does not — same seam as generate.mjs's
  // fetchImpl.
  if (!opts.callImpl) {
    if (!model) throw new Error('--model is required (no default — see models.mjs)');
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  }
  const mode = legacyBareNext ? 'legacy' : 'sam';
  mkdirSync(out, { recursive: true });
  const call = opts.callImpl
    ? (stage, prompt) => Promise.resolve(opts.callImpl(stage, prompt))
    : (stage, prompt) => callOrThrow(stage, { prompt, model, maxTokens, apiKey });
  // Stage-boundary loader: v2 modules must load AND pass the strict
  // validate() gate; legacy modules only need to load.
  const gatedLoad = mode === 'sam' ? (p) => validateV2Module(loadSpec(p)) : (p) => loadSpec(p);
  // Author/repair transport per mode: v2 re-prompts the task on an unloadable
  // rewrite; legacy keeps the syntax-fix loop.
  const obtainModule = ({ label, prompt, path }) => mode === 'sam'
    ? requestLoadableModule({ label, prompt, call, path, loadFn: gatedLoad })
    : call(label, prompt).then((text) => writeAndLoadWithSyntaxRetry({ label, source: extractSpec(text), path, loadFn: gatedLoad, call, lang }));

  // ── Stage 0: contract (drafted by the model, or supplied by the caller) ───
  let contract, contractDrafted;
  if (contractPath) {
    contract = JSON.parse(readFileSync(contractPath, 'utf-8'));
    contractDrafted = false;
  } else {
    const text = await call('draft-contract', buildContractDraftPrompt(intent, { lang }));
    try { contract = JSON.parse(extractFenced(text)); }
    catch (e) { throw new Error(`[polygen] drafted contract was not parseable JSON: ${e && e.message}`); }
    contractDrafted = true;
  }
  writeFileSync(join(out, 'contract.json'), JSON.stringify(contract, null, 2), 'utf-8');
  // Domain coverage gaps (an action's data field with no dataDomain entry and
  // no traces yet to infer from) make that action invisible to the model
  // checker below — surface this now, not as a silent reduction in coverage.
  // In sam mode this is a HARD gate one line later: buildAuthorPrompt renders
  // the contract's domains into the module's declared intent domains and
  // throws on any action field without one.
  const domainNotes = buildDomain(contract, []).notes;

  // ── Stage 1: author the machine against the contract ──────────────────────
  const codePath = resolve(join(out, 'next.cjs'));
  let { source: code } = await obtainModule({
    label: 'author', prompt: buildAuthorPrompt(contract, intent, { lang, mode }), path: codePath,
  });

  // ── Stage 2: propose invariants ────────────────────────────────────────────
  const invText = await call('invariants', buildInvariantsPrompt(contract, code, intent, { lang, mode }));
  const invPath = resolve(join(out, 'invariants.mjs'));
  const { source: invSource, loaded: invMod } = await writeAndLoadWithSyntaxRetry({
    label: 'invariants', source: extractSpec(invText), path: invPath,
    loadFn: (p) => import(pathToFileURL(p).href + `?t=${Date.now()}`), call, lang,
  });
  // Unwrap a default export (check.mjs's own CLI does the same) and REFUSE an
  // empty invariant set: zero predicates would make the model check below
  // trivially "clean" — a vacuous run misreported as verified.
  const invExports = invMod.default || invMod;
  const invariants = { stateInvariants: invExports.stateInvariants || [], transitionInvariants: invExports.transitionInvariants || [] };
  if (invariants.stateInvariants.length + invariants.transitionInvariants.length === 0) {
    throw new Error('[polygen] the invariants module exports NO stateInvariants/transitionInvariants — the model check would pass vacuously (check the export names/shape in invariants.mjs)');
  }

  // ── Stage 3: self-repair loop ───────────────────────────────────────────────
  // Two DIFFERENT classes of defect, checked in order every round:
  //   (a) domain-ref gaps: a dataDomain value the contract declares but the
  //       code never references — fix these FIRST, because until they're
  //       fixed the model checker below may never even reach the transitions
  //       an invariant is meant to guard (a coverage collapse, not a clean
  //       result).
  //   (b) invariant violations: a reachable state that breaks a stated rule —
  //       the code is wrong, not the invariant. In sam mode the repair prompt
  //       additionally carries the determinism double-pass flag, so a
  //       nondeterminism finding is repaired AS nondeterminism, not as a
  //       generic violation.
  // Capped at repairMax total rounds (either kind of repair spends budget);
  // a non-converging loop is reported plainly, never silently presented as
  // clean.
  const repairHistory = [];
  let lastResult = null;
  let lastGaps = [];
  // Exploration-coverage notes from the checker (an intent with no usable
  // manifest domain, a domain generator that threw, a contract action absent
  // from the manifest) mean part of the machine was never explored. They are
  // (a) REPAIRABLE — the fix is a module edit, same as a domain-ref gap, so
  // they spend repair budget through the same domain-gap prompt — and
  // (b) convergence-blocking: a coverage collapse must never present as clean.
  const coverageNotes = () => (lastResult && lastResult.domainNotes) || [];
  for (let i = 0; i <= repairMax; i++) {
    const specModule = gatedLoad(codePath); // already gate-validated by obtainModule above/below
    lastGaps = findDataDomainRefGaps(contract, code);
    lastResult = check({ specModule, contract, invariants, windows: [], maxStates, legacyBareNext: mode === 'legacy' });
    if (lastResult.error) throw new Error(`[polygen] checker could not run the authored module: ${lastResult.error}`);
    repairHistory.push({
      iteration: i,
      statesExplored: lastResult.statesExplored,
      capHit: lastResult.capHit,
      nondeterministic: !!lastResult.nondeterministic,
      domainGaps: lastGaps,
      coverageNotes: coverageNotes(),
      violationCount: lastResult.violations.length,
      violations: lastResult.violations.map((v) => v.invariant),
    });
    const gapsAndNotes = [...lastGaps, ...coverageNotes()];
    if (gapsAndNotes.length === 0 && lastResult.violations.length === 0) break;
    if (i === repairMax) break; // out of budget — do not call the model again
    const triage = mode === 'sam' ? { nondeterministic: !!lastResult.nondeterministic } : null;
    const repairPrompt = gapsAndNotes.length
      ? buildDomainGapRepairPrompt(contract, code, gapsAndNotes, { lang, mode })
      : buildRepairPrompt(contract, code, lastResult.violations[0], { lang, mode, triage });
    ({ source: code } = await obtainModule({
      label: gapsAndNotes.length ? `repair-${i}-domain-gap` : `repair-${i}-violation`,
      prompt: repairPrompt, path: codePath,
    }));
  }
  let converged = lastGaps.length === 0 && lastResult.violations.length === 0 && coverageNotes().length === 0;

  // ── Stage 4: synthesize a demo/regression trace corpus from the FINAL code ─
  // The model proposes scenarios (action sequences); polygen drives them
  // locally against the code's own machine to produce ground truth — the
  // model never writes the driver, so there is no second place for a capture
  // bug to hide.
  const tracesDir = join(out, 'traces');
  mkdirSync(tracesDir, { recursive: true });
  let corpusReport = await synthesizeCorpus({ contract, code, codePath, tracesDir, call, lang, mode, loadFn: gatedLoad });
  if (corpusReport.validation.problems.length) {
    // one feedback retry, citing the validator's own complaints
    corpusReport = await synthesizeCorpus({
      contract, code, codePath, tracesDir, call, lang, mode, loadFn: gatedLoad,
      feedback: corpusReport.validation.problems,
    });
  }

  // ── Stage 5: independent replay sanity check (separate process) ───────────
  // Should be a formality (the traces were driven from this exact code), but
  // this is a REAL, separate-process replay through the mode's replayer
  // (sam-tv.mjs by default, tv.mjs with --legacy-bare-next), not a
  // restatement of stage 4 — it catches nondeterminism (e.g. an accidental
  // Date.now()/Math.random() that stage 4's in-process run didn't happen to
  // expose). In sam mode each window additionally carries the lastStep()
  // classification, so a failure says WHY the machine did nothing.
  const summarizeReplay = (resp, windows) => {
    if (!resp.ok) return { fails: windows.length, unhandled: 0, failing: [], error: resp.error };
    const annotated = resp.results.map((r, i) => ({ ...r, scenario: windows[i].scenario, index: windows[i].index }));
    return {
      fails: annotated.filter((r) => r.status !== 'pass').length,
      unhandled: annotated.filter((r) => r.classification === 'unhandled').length,
      failing: annotated.filter((r) => r.status !== 'pass'),
      error: null,
    };
  };
  let windows = loadWindows(tracesDir);
  let replaySummary = windows.length
    ? summarizeReplay(replaySpecResults(codePath, windows, mode), windows)
    : { fails: 0, unhandled: 0, failing: [], error: null };

  // Conformance repair (sam mode, one round): a replay failure here means the
  // machine disagrees with its OWN corpus across processes. Feed the failing
  // windows' sam-tv classifications (rejected/unhandled + reasons) and the
  // determinism flag into ONE repair round, then re-synthesize and re-replay.
  let conformanceRepair = null;
  if (mode === 'sam' && replaySummary.fails > 0) {
    const violation = {
      invariant: 'trace-conformance',
      kind: 'replay',
      detail: `${replaySummary.fails} window(s) of the code's OWN generated corpus fail independent replay — the module behaves differently across processes (nondeterminism or hidden state), or its acceptors reject/ignore steps the corpus driver performed`,
      path: [],
    };
    const triage = { nondeterministic: !!lastResult.nondeterministic, replay: replaySummary.failing };
    ({ source: code } = await obtainModule({
      label: 'repair-conformance',
      prompt: buildRepairPrompt(contract, code, violation, { lang, mode, triage }),
      path: codePath,
    }));
    // The rewrite produced NEW code — the stage-3 verdict no longer applies
    // to it. Re-run the model check and the domain-ref cross-check on the
    // rewritten module and recompute convergence: a conformance repair that
    // reintroduces a violation or a domain gap must flip the run to NOT
    // converged, never ship under the pre-rewrite verdict.
    const recheckModule = gatedLoad(codePath);
    lastGaps = findDataDomainRefGaps(contract, code);
    lastResult = check({ specModule: recheckModule, contract, invariants, windows: [], maxStates, legacyBareNext: mode === 'legacy' });
    if (lastResult.error) throw new Error(`[polygen] checker could not run the conformance-repaired module: ${lastResult.error}`);
    repairHistory.push({
      iteration: 'conformance-recheck',
      statesExplored: lastResult.statesExplored,
      capHit: lastResult.capHit,
      nondeterministic: !!lastResult.nondeterministic,
      domainGaps: lastGaps,
      violationCount: lastResult.violations.length,
      violations: lastResult.violations.map((v) => v.invariant),
    });
    converged = lastGaps.length === 0 && lastResult.violations.length === 0 && coverageNotes().length === 0;
    corpusReport = await synthesizeCorpus({ contract, code, codePath, tracesDir, call, lang, mode, loadFn: gatedLoad });
    windows = loadWindows(tracesDir);
    const after = windows.length
      ? summarizeReplay(replaySpecResults(codePath, windows, mode), windows)
      : { fails: 0, unhandled: 0, failing: [], error: null };
    conformanceRepair = { before: replaySummary.fails, after: after.fails };
    replaySummary = after;
  }

  const result = {
    out, mode, contractDrafted, contract, domainNotes,
    code, codePath,
    invariants: invSource, invPath,
    repairHistory, converged, finalCheck: lastResult, finalDomainGaps: lastGaps,
    coverageNotes: coverageNotes(),
    corpus: corpusReport,
    replay: { windows: windows.length, fails: replaySummary.fails, unhandled: replaySummary.unhandled, error: replaySummary.error },
    conformanceRepair,
  };
  writeFileSync(join(out, 'polygen-report.md'), renderReport(result), 'utf-8');
  return result;
}

/** Drive the model-proposed scenarios against the final code; write NDJSON; validate. */
async function synthesizeCorpus({ contract, code, codePath, tracesDir, call, lang, mode = 'legacy', loadFn = loadSpec, feedback }) {
  let prompt = buildScenariosPrompt(contract, code, { lang, mode });
  if (feedback && feedback.length) {
    prompt += `\n\n## Your previous attempt had these problems — fix them\n\n${feedback.map((p) => `- ${p}`).join('\n')}`;
  }
  const text = await call('scenarios', prompt);
  let scenarios;
  try { scenarios = JSON.parse(extractFenced(text)); }
  catch (e) { throw new Error(`[polygen] scenarios response was not parseable JSON: ${e && e.message}`); }
  const specModule = loadFn(codePath);
  // ONE driver semantics for both artifacts: the v2 module is driven through
  // setState/actions/getState; a rejected step is recorded as a no-op window
  // (post == pre), exactly what the replayer will observe.
  const step = mode === 'sam'
    ? (pre, action, data) => {
        specModule.setState(structuredClone(pre));
        const handler = specModule.actions[action];
        if (typeof handler !== 'function') throw new Error(`action '${action}' is not exported by the machine`);
        handler(data);
        return specModule.getState();
      }
    : (pre, action, data) => specModule.next(JSON.parse(JSON.stringify(pre)), action, data);
  // Start from a CLEAN directory: stale .ndjson from a previous synthesis
  // round (or a previous run into the same --out) encodes a different
  // machine's behavior and would be validated and replayed as if it were this
  // code's corpus.
  try {
    for (const f of readdirSync(tracesDir)) if (f.endsWith('.ndjson')) rmSync(join(tracesDir, f));
  } catch { /* tracesDir is created by the caller; nothing to clean */ }
  const runProblems = [];
  const usedNames = new Set();
  for (const [name, steps] of Object.entries(scenarios)) {
    let state = mode === 'sam' ? (specModule.init(), specModule.getState()) : specModule.init();
    const lines = [];
    for (const [action, data] of steps) {
      const pre = state;
      let post;
      try { post = step(pre, action, data || {}); }
      catch (e) { runProblems.push(`${name}: ${action} threw: ${e && e.message}`); break; }
      lines.push(JSON.stringify({ pre, action, data: data || {}, post }));
      state = post;
    }
    // Model-chosen scenario names are used as file names: sanitize (a path
    // separator would write OUTSIDE tracesDir, or produce a file loadWindows
    // never reads back) and de-collide.
    let safe = name.replace(/[^A-Za-z0-9._-]/g, '_') || 'scenario';
    for (let n = 2; usedNames.has(safe); n++) safe = `${safe.replace(/_\d+$/, '')}_${n}`;
    usedNames.add(safe);
    writeFileSync(join(tracesDir, `${safe}.ndjson`), lines.join('\n') + (lines.length ? '\n' : ''), 'utf-8');
  }
  const validation = validateCorpus(contract, tracesDir);
  return { scenarios: Object.keys(scenarios).length, windows: validation.total, runProblems, validation };
}

function renderReport(r) {
  const L = [];
  L.push('# polygen — authored spec report\n');
  L.push('> Consistency check, not a proof. This code has been model-checked against');
  L.push('> its own stated invariants and its demo corpus has been independently');
  L.push('> replayed — that is not the same as being correct. Review the contract and');
  L.push('> invariants below before trusting either.\n');
  L.push(r.mode === 'sam'
    ? '- artifact: **SAM v2 strict-profile module** (`{ instance, init, actions, getState, setState }`, vendored sam-lib 2.0.0-alpha; strict validate() gate at every stage boundary)\n'
    : '- artifact: **legacy bare-next module** (`{ init, next }`, --legacy-bare-next)\n');

  L.push('## Contract\n');
  if (r.contractDrafted) L.push('⚠️ **Model-drafted, not extracted from existing code — review before use.**\n');
  if (r.domainNotes.length) {
    L.push('⚠️ **Domain coverage gaps — these action/field combinations are EXCLUDED from');
    L.push('the model checker below (silently, unless you read this):**');
    for (const n of r.domainNotes) L.push(`  - ${n}`);
    L.push('');
  }
  L.push('```json');
  L.push(JSON.stringify(r.contract, null, 2));
  L.push('```\n');

  L.push(`## Code (\`${r.codePath}\`)\n`);
  L.push('```javascript');
  L.push(r.code);
  L.push('```\n');

  L.push('⚠️ **Proposed invariants — review before trusting; these encode the model\'s');
  L.push('reading of intent, not a verified spec.**\n');
  L.push('```javascript');
  L.push(r.invariants);
  L.push('```\n');

  L.push('## Self-repair loop\n');
  L.push('Two defect classes are checked every round, in order: domain-ref gaps (a');
  L.push('`dataDomain` value the contract declares but the code never handles — these');
  L.push('are fixed FIRST, since until they\'re gone the checker may never even reach');
  L.push('what an invariant is meant to guard) and invariant violations.\n');
  L.push('| iteration | states explored | cap hit | nondeterministic | domain gaps | violations |');
  L.push('|---|---|---|---|---|---|');
  for (const it of r.repairHistory) {
    L.push(`| ${it.iteration} | ${it.statesExplored} | ${it.capHit ? 'yes' : 'no'} | ${it.nondeterministic ? '⚠️ yes' : 'no'} | ${it.domainGaps.length ? it.domainGaps.length : '—'} | ${it.violationCount ? it.violations.join(', ') : '—'} |`);
  }
  for (const it of r.repairHistory) {
    if (it.domainGaps.length) {
      L.push(`\n**Iteration ${it.iteration} domain-ref gaps (what got fixed before the next round):**`);
      for (const g of it.domainGaps) L.push(`  - ${g}`);
    }
  }
  const coverageNotes = r.coverageNotes || [];
  if (coverageNotes.length) {
    L.push('\n⚠️ **Exploration-coverage gaps in the FINAL code — these parts of the machine');
    L.push('were NEVER explored by the checker (the verdict below covers only the rest):**');
    for (const n of coverageNotes) L.push(`  - ${n}`);
  }
  if (r.converged) {
    L.push('\n**Converged — no domain-ref gaps and no invariant violations reachable in the');
    L.push('final code**, over the explored (bounded) state space. Not a proof.\n');
  } else {
    L.push('\n⚠️ **DID NOT CONVERGE within the repair budget.**');
    if (r.finalDomainGaps.length) {
      L.push(`\nUnresolved domain-ref gaps (the checker\'s exploration may be understating what`);
      L.push(`it actually examined):`);
      for (const g of r.finalDomainGaps) L.push(`  - ${g}`);
    }
    if (coverageNotes.length) {
      L.push('\nExploration-coverage gaps blocked convergence (see the list above): a machine');
      L.push('whose intents are only partially explorable cannot be presented as checked.');
    }
    if (r.finalCheck.violations.length) {
      L.push(`\nThe final code still reaches: ${r.finalCheck.violations.map((v) => v.invariant).join(', ')}.`);
    }
    L.push('\nDo NOT treat this as clean — fix by hand or re-run with a higher --repair-max.\n');
  }

  L.push('## Demo / regression trace corpus\n');
  L.push(`- scenarios: **${r.corpus.scenarios}** · windows: **${r.corpus.windows}**`);
  if (r.corpus.runProblems.length) {
    for (const p of r.corpus.runProblems) L.push(`- ⚠️ ${p}`);
  }
  if (r.corpus.validation.problems.length) {
    L.push(`- ⚠️ **${r.corpus.validation.problems.length} corpus problem(s) survived the feedback retry:**`);
    for (const p of r.corpus.validation.problems) L.push(`  - ${p}`);
  } else {
    L.push('- corpus validated clean: no chaining/terminal problems.');
  }
  for (const u of r.corpus.validation.underCovered || []) {
    L.push(`- ⚠️ special rule '${u.rule}' is exercised by only ${u.windows} window(s) (< 3) — thin regression coverage for that rule`);
  }

  L.push('\n## Independent replay sanity check\n');
  L.push(`- windows replayed (separate process): **${r.replay.windows}** · non-pass: **${r.replay.fails}**`);
  if (r.mode === 'sam' && r.replay.unhandled) {
    L.push(`- ⚠️ **${r.replay.unhandled} window(s) classified 'unhandled'** — the machine neither`);
    L.push('  acted nor rejected; every ignored action must be an observable `reject(reason)`.');
  }
  if (r.conformanceRepair) {
    L.push(`- conformance repair round ran (sam-tv triage fed back): non-pass ${r.conformanceRepair.before} → ${r.conformanceRepair.after}`);
  }
  if (r.replay.error) L.push(`- ⚠️ replay error: ${r.replay.error}`);
  if (r.replay.fails) {
    L.push('- ⚠️ **This should not happen** for code driving its own generated traces —');
    L.push('  investigate nondeterminism (e.g. a stray clock/random read) before shipping.');
  }

  L.push('\n## Next steps\n');
  L.push('1. Review the contract and invariants above — both are the model\'s reading of');
  L.push('   your intent, not ground truth.');
  L.push(r.mode === 'sam'
    ? '2. Wire the machine into the real handler/reducer via its exported `actions` —\n   call the intents, do not reimplement the transition logic inline.'
    : '2. Wire `next()` into the real handler/reducer — call it, do not reimplement\n   the transition logic inline.');
  L.push('3. After integration, run `/polygraph:verify` against REAL captured traces to');
  L.push('   catch drift between this pure model and the glue code around it.');
  return L.join('\n');
}

// CLI
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const usage = (msg) => {
    if (msg) console.error(`[polygen] ${msg}`);
    console.error('usage: node polygen.mjs --intent "<text>" --model <id> [--contract <c.json>] [--lang javascript] [--out out/] [--repair-max 3] [--max-tokens 32000] [--legacy-bare-next]');
    process.exit(2);
  };
  // Only --legacy-bare-next is boolean; every other flag takes a value. A
  // flag-shaped "value" means the real one was forgotten (`--repair-max
  // --legacy-bare-next` used to silently mean repair-max=1 via Number(true)).
  const BOOLEAN_FLAGS = new Set(['legacy-bare-next']);
  const a = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) usage(`unexpected argument '${argv[i]}'`);
    const key = argv[i].slice(2);
    if (BOOLEAN_FLAGS.has(key)) { a[key] = true; continue; }
    const nxt = argv[i + 1];
    if (nxt === undefined || nxt.startsWith('--')) usage(`missing value for --${key}`);
    a[key] = nxt;
    i++;
  }
  if (!a.intent || !a.model) usage();
  const intOpt = (v, name, def, min) => {
    if (v === undefined) return def;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min) usage(`--${name} must be an integer >= ${min} (got '${v}')`);
    return n;
  };
  const { id, resolved } = resolveModel(a.model);
  console.error(`[polygen] model=${a.model}${resolved ? ` -> ${id}` : ' (verbatim)'}${a['legacy-bare-next'] ? ' artifact=legacy bare-next' : ' artifact=sam-v2'}`);
  polygen({
    intent: a.intent,
    contractPath: a.contract,
    lang: a.lang || 'javascript',
    model: a.model,
    apiKey: process.env.ANTHROPIC_API_KEY,
    out: a.out || 'out',
    repairMax: intOpt(a['repair-max'], 'repair-max', 3, 0),
    maxTokens: intOpt(a['max-tokens'], 'max-tokens', undefined, 1),
    legacyBareNext: a['legacy-bare-next'] === true,
  }).then((r) => {
    console.log(`\nconverged: ${r.converged} · states explored: ${r.finalCheck.statesExplored} · corpus windows: ${r.corpus.windows} · replay fails: ${r.replay.fails}`);
    console.log(`report: ${join(r.out, 'polygen-report.md')}`);
    // The exit code is the machine-readable outcome — EVERY unclean signal
    // must fail it, not just non-convergence: surviving replay failures, a
    // replayer protocol error (nothing was independently verified), corpus
    // drive problems, and validation problems all mean "do not ship as-is".
    const unclean = [];
    if (!r.converged) unclean.push('did not converge');
    if (r.replay.fails > 0) unclean.push(`${r.replay.fails} replay failure(s)`);
    if (r.replay.error) unclean.push(`replay error: ${r.replay.error}`);
    if (r.corpus.runProblems.length) unclean.push(`${r.corpus.runProblems.length} corpus drive problem(s)`);
    if (r.corpus.validation.problems.length) unclean.push(`${r.corpus.validation.problems.length} corpus validation problem(s)`);
    if (unclean.length) {
      console.error(`[polygen] NOT CLEAN: ${unclean.join(' · ')}`);
      process.exitCode = 1;
    }
  }).catch((e) => { console.error('[polygen] ' + e.message); process.exit(1); });
}
