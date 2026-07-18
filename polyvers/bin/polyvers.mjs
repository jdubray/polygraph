#!/usr/bin/env node
// polyvers CLI (M0–M2): classify a machine change and run the gates its
// lanes require.
//
//   polyvers classify         --old <dir> --new <dir> [--json]
//   polyvers check            --old <dir> --new <dir> [--snapshots <path> | --synthesize]
//                             [--max-states N] [--allow-bounded] [--out <dir>] [--json]
//   polyvers migrate scaffold --old <dir> --new <dir> [--force]
//
// An artifact dir holds contract.json + the machine module (next.cjs /
// machine.cjs / the only .cjs) + optional invariants.mjs +
// effects.manifest.json + optional migrate.cjs.
//
// Everything here is pure local execution — no API key.
'use strict';

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { loadArtifacts, loadContractOnly } from '../src/artifacts.mjs';
import { classify } from '../src/classify.mjs';
import { loadCorpus, synthesizeCorpus } from '../src/corpus.mjs';
import { GATE_RUNNERS, NEEDS_CORPUS } from '../src/gates.mjs';
import { scaffoldMigrate, migrationNoteTemplate } from '../src/scaffold.mjs';
import { runMatrix, renderMatrix } from '../src/matrix.mjs';
import { buildReport, renderReport } from '../src/report.mjs';

const args = process.argv.slice(2);
const command = args[0] === 'migrate' ? `migrate-${args[1]}` : args[0];
const flag = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const has = (name) => args.includes(`--${name}`);

const usage = () => {
  console.error('usage: polyvers <classify|check|migrate scaffold> --old <dir> --new <dir> [--snapshots <path> | --synthesize] [--max-states N] [--allow-bounded] [--force] [--out <dir>] [--json]');
  console.error('       polyvers matrix --parent-old <dir> --parent-new <dir> --child-old <dir> --child-new <dir> --child-id <machineId> [--max-states N]');
  process.exit(2);
};

const oldDir = flag('old');
const newDir = flag('new');
// Validate the command BEFORE any I/O — loading an artifact dir executes the
// machine module's top-level code, which a typo'd command must never trigger.
if (command === 'matrix') {
  if (!flag('parent-old') || !flag('parent-new') || !flag('child-old') || !flag('child-new') || !flag('child-id')) usage();
} else if (!oldDir || !newDir || !['classify', 'check', 'migrate-scaffold'].includes(command)) {
  usage();
}

try {
  if (command === 'matrix') {
    // The rollout-window product check: parent {old,new} × child {old,new}
    // over the spawn/completion protocol and its delivery. See src/matrix.mjs
    // for the honest scope (protocol/delivery, not joint interleavings).
    const rawMax = flag('max-states');
    const maxStates = rawMax === undefined ? undefined : Number(rawMax);
    if (rawMax !== undefined && (!Number.isFinite(maxStates) || maxStates < 1)) { console.error(`invalid --max-states '${rawMax}'`); process.exit(2); }
    // Deliberately sequential — same loader-state rationale as check's loads.
    const parentOld = await loadArtifacts(flag('parent-old'));
    const parentNew = await loadArtifacts(flag('parent-new'));
    const childOld = await loadArtifacts(flag('child-old'));
    const childNew = await loadArtifacts(flag('child-new'));
    const result = runMatrix({ parentOld, parentNew, childOld, childNew, childMachineId: flag('child-id'), maxStates });
    console.log(renderMatrix(result));
    if (!result.ok) process.exitCode = 1;
  } else if (command === 'migrate-scaffold') {
    // Contracts-only: the scaffold runs BEFORE the new module exists
    // (contract-first authoring) — it must not execute machine code, demand
    // invariants, or require a loadable module.
    const oldC = loadContractOnly(oldDir);
    const newC = loadContractOnly(newDir);
    const migratePath = join(newDir, 'migrate.cjs');
    const notePath = join(newDir, 'MIGRATION-NOTE.md');
    if (existsSync(migratePath) && !has('force')) {
      console.error(`${migratePath} already exists — refusing to overwrite (use --force after reading it)`);
      process.exit(2);
    }
    const scaffold = scaffoldMigrate(oldC, newC);
    writeFileSync(migratePath, scaffold.code);
    writeFileSync(notePath, migrationNoteTemplate(oldC, newC, scaffold));
    console.log(`scaffolded ${migratePath} (+ MIGRATION-NOTE.md)`);
    console.log(`  added: ${scaffold.added.join(', ') || '(none)'} · removed: ${scaffold.removed.join(', ') || '(none)'} · retyped: ${scaffold.retyped.join(', ') || '(none)'}`);
    for (const n of scaffold.notes) console.log(`  TODO: ${n}`);
    if (!scaffold.notes.length) console.log('  scaffold is complete (pure addition) — validate it with `polyvers check`; `polyrun migrate` (dry run, then --apply) remains the apply-time gate over live snapshots');
  } else {

  // Deliberately sequential (not Promise.all): both loads compile modules and
  // touch the ESM/CJS loader state; interleaving buys nothing in a CLI.
  const oldA = await loadArtifacts(oldDir);
  const newA = await loadArtifacts(newDir);
  const classification = classify(oldA, newA);

  if (command === 'classify') {
    if (has('json')) {
      console.log(JSON.stringify(classification, null, 2));
    } else {
      console.log(`polyvers classify — change ${classification.changeId}`);
      console.log(`  old ${classification.oldVersion} → new ${classification.newVersion}`);
      if (classification.identical) console.log('  identical artifacts — nothing to gate');
      else if (classification.lanes.length === 0) console.log('  no lane fired — the artifacts differ, but only in ways no compatibility lane classifies (cosmetic edit)');
      else {
        console.log(`  lanes: ${classification.lanes.join(', ')}`);
        console.log(`  gates required: ${classification.gates.join(', ')}`);
        for (const d of classification.deferred) console.log(`  deferred (${d.milestone}): ${d.gate} — ${d.why}`);
      }
    }
  } else {
    if (classification.identical) {
      console.log('polyvers check: identical artifacts — nothing to gate');
    } else if (classification.lanes.length === 0) {
      // Not identical, but no lane fired: a cosmetic artifact edit
      // (reformat, description text). Say so explicitly — never render a
      // PASS verdict over an empty gate table.
      console.log('polyvers check: no lane fired — the artifacts differ, but only in ways no compatibility lane classifies (cosmetic edit); zero gates apply');
    } else {
      const wanted = classification.gates;
      const rawMax = flag('max-states');
      const maxStates = rawMax === undefined ? undefined : Number(rawMax);
      if (rawMax !== undefined && (!Number.isFinite(maxStates) || maxStates < 1)) { console.error(`invalid --max-states '${rawMax}'`); process.exit(2); }

      // ── corpus (only if a wanted gate consumes one) ──
      const needsCorpus = wanted.some((g) => NEEDS_CORPUS.has(g));
      let corpus = [];
      let corpusInfo = { source: 'not required by these lanes', count: 0 };
      if (needsCorpus) {
        const snapshotsPath = flag('snapshots');
        if (snapshotsPath) {
          corpus = loadCorpus(snapshotsPath);
          // basename, not the raw CLI path: report bytes must not depend on
          // the machine or working directory the check ran from.
          corpusInfo = { source: `archive (${basename(snapshotsPath)})`, count: corpus.length };
        } else if (has('synthesize')) {
          const { entries, truncated, notes } = synthesizeCorpus(oldA.module, { maxStates: maxStates ?? 20000 });
          corpus = entries;
          corpusInfo = { source: 'synthesized (BFS-reachable states of the OLD machine — the weakest tier; prefer live or archived snapshots)', count: corpus.length, truncated, notes };
        } else {
          console.error(`check needs a corpus for the ${wanted.filter((g) => NEEDS_CORPUS.has(g)).join('/')} gate(s): --snapshots <path> or --synthesize`);
          process.exit(2);
        }
        if (corpus.length === 0) {
          console.error('corpus is empty — every pointwise gate would pass vacuously; refusing to report PASS over nothing');
          process.exit(1);
        }
      }

      // ── gates: iterate the classification's demands over the registry —
      // a wanted gate with no runner is a failing result, never a silent
      // omission the verdict overlooks. ──
      // maxStates: undefined lets each consumer apply its own default
      // (synthesis 20000, checker 100000) — seeds no longer consume the
      // checker's budget, so one knob for both bounds is safe.
      const ctx = {
        oldA, newA, corpus, diffs: classification.diffs,
        opts: { maxStates, allowBounded: has('allow-bounded') },
      };
      // Ordering is enforced STRUCTURALLY, not by lane-array convention:
      // non-corpus gates first, then 'migrate' (whose validated output
      // redefines the corpus), then every other corpus consumer. A future
      // lane reorder cannot break the swap-before-consume invariant.
      const ordered = [
        ...wanted.filter((g) => !NEEDS_CORPUS.has(g)),
        ...wanted.filter((g) => g === 'migrate'),
        ...wanted.filter((g) => NEEDS_CORPUS.has(g) && g !== 'migrate'),
      ];
      const gateResults = [];
      let migrateFailed = false;
      for (const name of ordered) {
        const run = GATE_RUNNERS[name];
        if (!run) {
          gateResults.push({ gate: name, ok: false, summary: 'required by the classified lanes but NOT IMPLEMENTED in this build', failures: [{ message: `no runner registered for gate '${name}' — the verdict below cannot be trusted until it runs` }] });
          continue;
        }
        // When the migration failed, the corpus is still in the OLD shape —
        // running the remaining corpus gates over it would bury the real
        // cause under per-snapshot noise (a strict module rejecting
        // old-shape states). Refuse them explicitly instead.
        if (migrateFailed && NEEDS_CORPUS.has(name)) {
          gateResults.push({ gate: name, ok: false, summary: 'refused: the corpus could not be migrated (migrate gate failed)', failures: [{ message: 'not run — fix the migration first; results over an unmigrated old-shape corpus would misdiagnose the failure' }] });
          continue;
        }
        const result = run(ctx);
        gateResults.push(result);
        if (name === 'migrate') {
          if (result.migratedCorpus) {
            // A fully-validated migration redefines the fleet: every later
            // corpus gate (round-trip, stimuli, pointwise, seeded model
            // check) runs over the states production will hold AFTER the
            // migration applies.
            ctx.corpus = result.migratedCorpus;
            corpusInfo = { ...corpusInfo, migrated: true, migratedCount: result.migratedCorpus.length };
          } else {
            migrateFailed = true;
          }
        }
      }

      const report = buildReport({ classification, corpusInfo, gateResults });
      if (has('json')) console.log(JSON.stringify(report, null, 2));
      else console.log(renderReport(report));

      const outDir = flag('out');
      if (outDir) {
        const dir = join(outDir, report.changeId);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'compat-report.json'), JSON.stringify(report, null, 2) + '\n');
        writeFileSync(join(dir, 'compat-report.md'), renderReport(report));
        console.error(`wrote ${join(dir, 'compat-report.{json,md}')}`);
      }
      if (report.verdict !== 'PASS') process.exitCode = 1;
    }
  }
  }
} catch (err) {
  console.error(String(err && err.message));
  process.exitCode = 1;
}
// No process.exit() here: a large --json report piped downstream must flush
// before the process ends (exit() would truncate pending async stdout writes).
