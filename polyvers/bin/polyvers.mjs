#!/usr/bin/env node
// polyvers CLI (M0): classify a machine change and run the gates its lanes
// require.
//
//   polyvers classify --old <dir> --new <dir> [--json]
//   polyvers check    --old <dir> --new <dir> [--snapshots <path> | --synthesize]
//                     [--max-states N] [--out <dir>] [--json]
//
// An artifact dir holds contract.json + the machine module (next.cjs /
// machine.cjs / the only .cjs) + optional invariants.mjs +
// effects.manifest.json.
//
// Everything here is pure local execution — no API key.
'use strict';

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { loadArtifacts } from '../src/artifacts.mjs';
import { classify } from '../src/classify.mjs';
import { loadCorpus, synthesizeCorpus } from '../src/corpus.mjs';
import { GATE_RUNNERS, NEEDS_CORPUS } from '../src/gates.mjs';
import { buildReport, renderReport } from '../src/report.mjs';

const args = process.argv.slice(2);
const command = args[0];
const flag = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const has = (name) => args.includes(`--${name}`);

const usage = () => {
  console.error('usage: polyvers <classify|check> --old <dir> --new <dir> [--snapshots <path> | --synthesize] [--max-states N] [--allow-bounded] [--out <dir>] [--json]');
  process.exit(2);
};

const oldDir = flag('old');
const newDir = flag('new');
// Validate the command BEFORE any I/O — loading an artifact dir executes the
// machine module's top-level code, which a typo'd command must never trigger.
if (!oldDir || !newDir || !['classify', 'check'].includes(command)) usage();

try {
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
      const ctx = {
        oldA, newA, corpus, diffs: classification.diffs,
        opts: { ...(maxStates !== undefined ? { maxStates } : {}), allowBounded: has('allow-bounded') },
      };
      const gateResults = wanted.map((name) => {
        const run = GATE_RUNNERS[name];
        if (!run) return { gate: name, ok: false, summary: 'required by the classified lanes but NOT IMPLEMENTED in this build', failures: [{ message: `no runner registered for gate '${name}' — the verdict below cannot be trusted until it runs` }] };
        return run(ctx);
      });

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
} catch (err) {
  console.error(String(err && err.message));
  process.exitCode = 1;
}
// No process.exit() here: a large --json report piped downstream must flush
// before the process ends (exit() would truncate pending async stdout writes).
