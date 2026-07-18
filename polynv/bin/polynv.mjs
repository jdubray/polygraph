#!/usr/bin/env node
// polynv CLI (M0): elicit invariants — harvest template candidates, rank the
// open questions, record dispositions, report convergence.
//
//   polynv harvest   --artifacts <dir> [--ledger <path>] [--max-states N]
//                    [--traces <path>] [--snapshots <path>] [--min-obs N] [--min-cond N]
//                    [--llm --model <id> [--intent <file>] [--max-tokens N]]
//   polynv questions --artifacts <dir> [--ledger <path>] [--next] [--for <name>] [--json]
//   polynv add       --artifacts <dir> --id <id> --target state|transition --question "…"
//                    --js "(s) => …" --author <name> [--source domain-prior|designer]
//                    [--domain <d> --norm "…" --model <id>] [--ledger <path>] [--max-states N]
//   polynv record    --artifacts <dir> --id <id>
//                    --disposition confirm|reject|abandon|defer|modify --author <name>
//                    [--js "…"] [--concern "…"] [--assign <name>]
//                    [--target state|transition]   (modify, records without a predicate yet)
//                    [--out <invariants path>] [--force] [--ledger <path>] [--max-states N]
//                    (temporal modify takes --js '{"kind":"precedence","first":"A","then":"B"}')
//   polynv grade     --artifacts <dir> [--ledger <path>] [--max-mutants N] [--max-states N]
//   polynv report    --artifacts <dir> [--ledger <path>] [--log] [--json]
//
// The ledger defaults to <artifacts>/intent-ledger.json — the system of
// record (append-only at the event level; abandoned records are kept and
// never re-proposed). Everything here is pure local execution — no API key.
// The dialog itself lives in the polynv SKILL; this CLI is its mechanical arm.
'use strict';

import { writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadArtifacts, findModulePath } from '../../polyvers/src/artifacts.mjs';
import { loadCorpus } from '../../polyvers/src/corpus.mjs';
import { loadWindows } from '../../scripts/replay.mjs';
import { HELPERS_SRC, compile } from '../src/nf.mjs';
import { harvestTemplates } from '../src/templates.mjs';
import { mineStateProperties, mineTemporal, pruneCandidates, vacuousOverGraph } from '../src/miners.mjs';
import { enumerateGraph, graphSound, violationsOf, consequenceDiff, renderItems } from '../src/consequences.mjs';
import { harvestLlm } from '../src/llm.mjs';
import { runGrade, survivorCandidates, renderGrade } from '../src/grade.mjs';
import {
  loadLedger, saveLedger, mergeCandidates, addCandidate, applyDisposition,
  generateInvariants, findRecord, GENERATED_MARKER,
} from '../src/ledger.mjs';
import { precheckRecord } from '../src/precheck.mjs';
import { openQuestions, questionPayload, renderQuestion } from '../src/questions.mjs';
import { buildStatus, renderStatus, renderLog } from '../src/report.mjs';

const args = process.argv.slice(2);
const command = args[0];
// A '--'-prefixed next token means the flag's VALUE was forgotten — treat as
// absent rather than silently consuming the next flag (which would, e.g.,
// permanently attribute a ledger disposition to the author '--concern').
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = args[i + 1];
  return v === undefined || v.startsWith('--') ? undefined : v;
};
const has = (name) => args.includes(`--${name}`);
const numFlag = (name, { min = 1 } = {}) => {
  const raw = flag(name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) { console.error(`invalid --${name} '${raw}'`); process.exit(2); }
  return n;
};

const usage = () => {
  console.error('usage: polynv <harvest|questions|add|record|grade|report> --artifacts <dir> [options] — see the header of polynv/bin/polynv.mjs');
  process.exit(2);
};

const artifactsDir = flag('artifacts');
if (!['harvest', 'questions', 'add', 'record', 'grade', 'report'].includes(command) || !artifactsDir) usage();
const ledgerPath = flag('ledger') ?? join(artifactsDir, 'intent-ledger.json');
const now = () => new Date().toISOString();

try {
  const ledger = loadLedger(ledgerPath);

  if (command === 'harvest') {
    const artifacts = await loadArtifacts(artifactsDir);
    const date = now();
    const notes = [];
    let candidates = [];

    // source 3 — contract-structure templates
    const t = harvestTemplates(artifacts.contract, artifacts.manifest ?? null);
    candidates.push(...t.candidates);
    notes.push(...t.notes);

    // sources 1–2 — the miners (state properties over observed states,
    // precedence over per-scenario sequences); substrates are explicit
    const minerOpts = { minObs: numFlag('min-obs'), minCond: numFlag('min-cond') };
    let observedStates = [];
    if (flag('traces')) {
      const windows = loadWindows(flag('traces'));
      observedStates.push(...windows.map((w) => w.pre), ...windows.map((w) => w.post));
      const tm = mineTemporal(windows, {});
      candidates.push(...tm.candidates);
      notes.push(...tm.notes.map((n) => `temporal: ${n}`));
    }
    if (flag('snapshots')) observedStates.push(...loadCorpus(flag('snapshots')).map((e) => e.state));
    if (observedStates.length) {
      const sm = mineStateProperties(artifacts.contract, observedStates, minerOpts);
      candidates.push(...sm.candidates);
      notes.push(...sm.notes.map((n) => `mining: ${n}`));
    }

    // sources 5–6 headless — model-drafted candidates, labeled by source.
    // A failed model call must not discard the mechanical sources computed
    // above: catch, note, save what we have, and exit nonzero.
    let llmFailed = null;
    if (has('llm')) {
      try {
        let moduleSource = null;
        try { moduleSource = readFileSync(findModulePath(artifactsDir), 'utf-8'); }
        catch (e) { notes.push(`llm: machine module not located for code-reading (${e.message}) — domain priors only`); }
        const { candidates: llmCands, notes: llmNotes } = await harvestLlm({
          contract: artifacts.contract,
          moduleSource,
          intent: flag('intent') ? readFileSync(flag('intent'), 'utf-8') : null,
          model: flag('model'),
          apiKey: process.env.ANTHROPIC_API_KEY,
          maxTokens: numFlag('max-tokens'),
        });
        candidates.push(...llmCands);
        notes.push(...llmNotes.map((n) => `llm: ${n}`));
      } catch (e) {
        llmFailed = String(e && e.message);
        notes.push(`llm harvest FAILED: ${llmFailed} — the template/miner candidates below are saved; re-run with --llm after fixing`);
      }
    }

    // question economy: prune implied/duplicate candidates against the union
    // of the existing ledger and this harvest, then drop vacuously-guarded
    // candidates against the reachable graph — but ONLY when the graph is
    // sound: a truncated or incomplete graph proves nothing unreachable.
    const graph = enumerateGraph(artifacts, { maxStates: numFlag('max-states') ?? 100000 });
    const sound = graphSound(graph);
    if (!graph.error && !sound) {
      notes.push(`graph is ${graph.capHit ? 'TRUNCATED (raise --max-states)' : graph.nondeterministic ? 'NONDETERMINISTIC' : `incomplete (machine throws on ${graph.throws.length} step(s))`} — vacuity filtering skipped; verdicts below cover the explored portion only`);
    }
    const { kept, pruned } = pruneCandidates(candidates, ledger.records);
    const askable = [];
    for (const c of kept) {
      if (sound && vacuousOverGraph(c.nf, graph)) {
        notes.push(`vacuous over the reachable graph (guard never fires): ${c.id} — not asked; if that state/value was expected reachable, THAT is a finding`);
        continue;
      }
      askable.push(c);
    }
    const { added, skipped } = mergeCandidates(ledger, askable, { date });
    const verdicts = {};
    for (const record of added) {
      const r = precheckRecord(record, artifacts, { maxStates: numFlag('max-states'), date, graph });
      verdicts[r.verdict] = (verdicts[r.verdict] ?? 0) + 1;
    }
    saveLedger(ledgerPath, ledger);
    console.log(`polynv harvest — ${added.length} candidate(s) added, ${skipped.length} already in the ledger (never re-proposed), ${pruned.length} pruned`);
    if (added.length) console.log(`  pre-check: ${Object.entries(verdicts).map(([k, v]) => `${v} ${k}`).join(', ')}`);
    for (const p of pruned) console.log(`  pruned: ${p.id} — ${p.reason}`);
    for (const n of notes) console.log(`  NOTE: ${n}`);
    console.log(`  ledger: ${ledgerPath}`);
    console.log('  next: `polynv questions --next` — the dialog (see the polynv skill) takes it from here');
    if (llmFailed) process.exitCode = 1; // the requested source did not run — never a silent pass
  } else if (command === 'questions') {
    const open = openQuestions(ledger, { assignee: flag('for') });
    if (has('next')) {
      if (!open.length) { console.log(has('json') ? 'null' : 'no open questions — run `polynv report` for the convergence verdict'); }
      else console.log(has('json') ? JSON.stringify(questionPayload(open[0]), null, 2) : renderQuestion(open[0]));
    } else if (has('json')) {
      console.log(JSON.stringify(open.map(questionPayload), null, 2));
    } else {
      console.log(`polynv questions — ${open.length} open${flag('for') ? ` (deferred to ${flag('for')})` : ''}`);
      for (const r of open) { console.log(''); console.log(renderQuestion(r)); }
    }
  } else if (command === 'add') {
    const [id, target, question, js, author] = [flag('id'), flag('target'), flag('question'), flag('js'), flag('author')];
    if (!id || !['state', 'transition'].includes(target) || !question || !js || !author) {
      console.error('add needs --id, --target state|transition, --question, --js, --author'); process.exit(2);
    }
    const artifacts = await loadArtifacts(artifactsDir);
    const date = now();
    const source = flag('source') ?? 'designer';
    const provenance = source === 'domain-prior'
      ? { domain: flag('domain') ?? null, norm: flag('norm') ?? null, model: flag('model') ?? null, date }
      : undefined;
    const record = addCandidate(ledger, { id, source, target, question, js, author, provenance }, { date });
    precheckRecord(record, artifacts, { maxStates: numFlag('max-states'), date });
    saveLedger(ledgerPath, ledger);
    console.log(renderQuestion(record));
  } else if (command === 'record') {
    const date = now();
    const disposition = flag('disposition');
    // Snapshot the predicate BEFORE a modify appends the revision — the
    // consequence diff below compares against it.
    const before = findRecord(ledger, flag('id'));
    const priorVersion = before?.versions?.length ? before.versions[before.versions.length - 1] : null;
    const record = applyDisposition(ledger, {
      id: flag('id'), disposition, author: flag('author'),
      js: flag('js'), concern: flag('concern'), assign: flag('assign'), target: flag('target'),
    }, { date });
    // The equivalence-query move (plan §3): confirm and modify answer with
    // CONSEQUENCES over the reachable graph, not just a verdict. One BFS —
    // also computed for a temporal modify, whose precedence re-check runs
    // over the same graph (a revised rule must be re-checked immediately).
    const wantsConsequences = ['confirm', 'modify'].includes(disposition) && ['state', 'transition'].includes(record.target);
    const needsGraph = wantsConsequences || (disposition === 'modify' && record.target === 'temporal');
    let artifacts = null, graph = null;
    if (disposition === 'modify' || wantsConsequences) artifacts = await loadArtifacts(artifactsDir);
    if (needsGraph) graph = enumerateGraph(artifacts, { maxStates: numFlag('max-states') ?? 100000 });
    if (disposition === 'modify') {
      // A revised predicate is re-checked immediately — a revision that the
      // machine reachably violates is surfaced with its counterexample here,
      // and stays open (it must earn its own confirmation).
      precheckRecord(record, artifacts, { maxStates: numFlag('max-states'), date, graph });
    }
    saveLedger(ledgerPath, ledger);
    console.log(`recorded: ${record.id} → ${record.status}${record.assign ? ` (deferred to ${record.assign})` : ''}`);
    if (record.status === 'open' && record.precheck) console.log(renderQuestion(record));
    if (record.status === 'confirmed' && record.precheck?.verdict === 'FAILS') {
      console.log('  ⚠ this confirmed rule is reachably VIOLATED by the machine — a live finding; the counterexample on the record is the repro');
    }
    if (graph && !graph.error) {
      const cur = record.versions[record.versions.length - 1];
      const compiled = compile(cur.nf);
      if (disposition === 'confirm') {
        const v = violationsOf(compiled, graph) ?? [];
        if (v.length === 0) {
          console.log(`  consequences: forbids 0 currently-reachable ${record.target === 'state' ? 'states' : 'transitions'} — the rule constrains future versions, not today's behavior`);
        } else {
          console.log(`  consequences: forbids ${v.length} currently-reachable ${record.target === 'state' ? 'state(s)' : 'transition(s)'}:`);
          for (const line of renderItems(v)) console.log(`    ${line}`);
        }
      } else if (priorVersion) {
        const diff = consequenceDiff(compile(priorVersion.nf), compiled, graph);
        if (diff) {
          console.log(`  consequence diff vs the prior predicate: ${diff.newlyForbidden.length} newly forbidden, ${diff.newlyAllowed.length} newly allowed`);
          if (diff.newlyForbidden.length) { console.log('    newly forbidden (scrutinize these):'); for (const line of renderItems(diff.newlyForbidden)) console.log(`      ${line}`); }
          if (diff.newlyAllowed.length) { console.log('    newly allowed (this revision WEAKENS the rule here):'); for (const line of renderItems(diff.newlyAllowed)) console.log(`      ${line}`); }
        }
      }
      if (graph.capHit) console.log('  (consequences computed over a TRUNCATED graph — raise --max-states for the full set)');
      if (graph.throws.length) console.log(`  ⚠ the graph omits ${graph.throws.length} THROWING step(s) (machine bug: ${graph.throws[0].invariant}) — consequence counts cover the non-throwing behavior only`);
      if (graph.nondeterministic) console.log('  ⚠ the machine is NONDETERMINISTIC — the graph (and these consequences) merge two differing runs');
    } else if (needsGraph && graph?.error) {
      // never let a failed consequence computation look like a healthy one
      console.log(`  ⚠ consequences NOT computed — the reachable graph could not be built: ${graph.error}`);
    }

    // Regenerate invariants.mjs from the confirmed records. Overwrite guard:
    // only a file polynv itself generated (marker on line 1) is replaced —
    // a hand-written invariants.mjs is never clobbered without --force.
    // When the confirmed set drops to ZERO compilable rules, a previously
    // generated file is REMOVED (never left enforcing retracted predicates,
    // and never rewritten empty — polyvers refuses empty intent artifacts).
    const { code, count, emissionOnly, temporalOnly } = generateInvariants(ledger, { helpersSrc: HELPERS_SRC });
    {
      const outPath = flag('out') ?? join(artifactsDir, 'invariants.mjs');
      const isGenerated = existsSync(outPath) && readFileSync(outPath, 'utf-8').startsWith(GENERATED_MARKER);
      const guarded = existsSync(outPath) && !isGenerated && !has('force');
      if (count > 0) {
        if (guarded) {
          console.log(`  invariants NOT written: ${outPath} exists and is not polynv-generated — pass --out <path> to write elsewhere, or --force after reconciling by hand`);
        } else {
          writeFileSync(outPath, code);
          console.log(`  wrote ${outPath} (${count} confirmed rule(s))`);
        }
      } else if (isGenerated) {
        rmSync(outPath);
        console.log(`  removed ${outPath} — no confirmed compilable rules remain (the previous file would have kept enforcing retracted predicates)`);
      }
      if (emissionOnly.length) console.log(`  ${emissionOnly.length} confirmed emission rule(s) not compiled (check-effects territory) — listed in \`polynv report\``);
      if (temporalOnly.length) console.log(`  ${temporalOnly.length} confirmed temporal rule(s) not compiled (graph-checked at elicitation) — listed in \`polynv report\``);
    }
  } else if (command === 'grade') {
    const artifacts = await loadArtifacts(artifactsDir);
    const date = now();
    // --include-invariants: grade the artifact dir's EXISTING invariants.mjs
    // alongside the ledger's confirmed rules — the adoption path for a
    // machine whose invariants were written by hand before polynv existed.
    const extraOracle = has('include-invariants')
      ? [
          ...(artifacts.invariants ?? []).map((inv) => ({ id: `invariants.mjs:state:${inv.name}`, target: 'state', pred: inv.pred })),
          ...(artifacts.transitionInvariants ?? []).map((inv) => ({ id: `invariants.mjs:transition:${inv.name}`, target: 'transition', pred: inv.pred })),
        ]
      : [];
    const grade = runGrade(artifacts, ledger, { maxMutants: numFlag('max-mutants'), maxStates: numFlag('max-states'), extraOracle });
    grade.date = date;
    // staleness stamp for the file-based oracle half: lets polyvers detect
    // an invariants.mjs edited after grading and refuse the stale disclosure
    if (has('include-invariants') && artifacts.invariantsHash) grade.invariantsFileHash = artifacts.invariantsHash;
    // survivors become dialog questions (never re-proposed if already settled)
    const { added } = mergeCandidates(ledger, survivorCandidates(grade), { date });
    for (const record of added) {
      record.precheck = { verdict: 'NOT-RUN', note: 'no predicate yet — supply the rule via `record --disposition modify`, or abandon as out-of-intent', date };
      record.events.push({ type: 'precheck', verdict: 'NOT-RUN', date });
    }
    saveLedger(ledgerPath, ledger);
    console.log(renderGrade(grade));
    if (added.length) console.log(`  ${added.length} survivor question(s) added to the ledger — \`polynv questions --next\``);
  } else { // report
    const status = buildStatus(ledger);
    if (has('json')) console.log(JSON.stringify(status, null, 2));
    else console.log(renderStatus(status));
    if (has('log')) {
      const logPath = join(artifactsDir, 'INTENT-LOG.md');
      writeFileSync(logPath, renderLog(ledger));
      console.error(`wrote ${logPath}`);
    }
    if (status.verdict !== 'CONVERGED') process.exitCode = 1;
  }
} catch (err) {
  console.error(String(err && err.message));
  process.exitCode = 1;
}
