#!/usr/bin/env node
// polyvers CLI (M0): classify a machine change and run the gates its lanes
// require.
//
//   polyvers classify --old <dir> --new <dir> [--json]
//   polyvers check    --old <dir> --new <dir> (--snapshots <path> | --synthesize)
//                     [--max-states N] [--out <dir>] [--json]
//
// An artifact dir holds contract.json + the machine module (next.cjs /
// machine.cjs / the only .cjs) + optional invariants.mjs +
// effects.manifest.json.
//
// Everything here is pure local execution — no API key.
'use strict';

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadArtifacts } from '../src/artifacts.mjs';
import { classify } from '../src/classify.mjs';
import { loadCorpus, synthesizeCorpus } from '../src/corpus.mjs';
import { loadGate, shapeRoundtripGate, vocabularyGate, invariantDiffGate, invariantsPointwiseGate } from '../src/gates.mjs';
import { buildReport, renderReport } from '../src/report.mjs';

const args = process.argv.slice(2);
const command = args[0];
const flag = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const has = (name) => args.includes(`--${name}`);

const usage = () => {
  console.error('usage: polyvers <classify|check> --old <dir> --new <dir> [--snapshots <path> | --synthesize] [--max-states N] [--out <dir>] [--json]');
  process.exit(2);
};

const oldDir = flag('old');
const newDir = flag('new');
if (!command || !oldDir || !newDir) usage();

let exitCode = 0;
try {
  const [oldA, newA] = [await loadArtifacts(oldDir), await loadArtifacts(newDir)];
  const classification = classify(oldA, newA);

  if (command === 'classify') {
    if (has('json')) {
      console.log(JSON.stringify(classification, null, 2));
    } else {
      console.log(`polyvers classify — change ${classification.changeId}`);
      console.log(`  old ${classification.oldVersion} → new ${classification.newVersion}`);
      if (classification.identical) console.log('  identical artifacts — nothing to gate');
      else {
        console.log(`  lanes: ${classification.lanes.join(', ') || '(none)'}`);
        console.log(`  gates required: ${classification.gates.join(', ') || '(none)'}`);
        for (const d of classification.deferred) console.log(`  deferred (${d.milestone}): ${d.gate} — ${d.why}`);
      }
    }
  } else if (command === 'check') {
    if (classification.identical) {
      console.log('polyvers check: identical artifacts — nothing to gate');
      process.exit(0);
    }
    // ── corpus ──
    const snapshotsPath = flag('snapshots');
    let corpus, corpusInfo;
    if (snapshotsPath) {
      corpus = loadCorpus(snapshotsPath);
      corpusInfo = { source: `archive (${snapshotsPath})`, count: corpus.length };
    } else if (has('synthesize')) {
      const maxStates = Number(flag('max-states') ?? 20000);
      if (!Number.isFinite(maxStates) || maxStates < 1) { console.error(`invalid --max-states`); process.exit(2); }
      const { entries, truncated } = synthesizeCorpus(oldA.module, { maxStates });
      corpus = entries;
      corpusInfo = { source: 'synthesized (BFS-reachable states of the OLD machine — the weakest tier; prefer live or archived snapshots)', count: corpus.length, truncated };
    } else {
      console.error('check needs a corpus: --snapshots <path> or --synthesize');
      process.exit(2);
    }
    if (corpus.length === 0) {
      console.error('corpus is empty — every pointwise gate would pass vacuously; refusing to report PASS over nothing');
      process.exit(1);
    }

    // ── gates (only what the lanes require) ──
    const wanted = new Set(classification.gates);
    const gateResults = [];
    if (wanted.has('load')) gateResults.push(loadGate(newA));
    if (wanted.has('shape-roundtrip')) gateResults.push(shapeRoundtripGate(newA, corpus));
    if (wanted.has('vocabulary')) gateResults.push(vocabularyGate(oldA, newA, classification.diffs));
    if (wanted.has('invariant-diff')) gateResults.push(invariantDiffGate(classification.diffs));
    if (wanted.has('invariants-pointwise')) gateResults.push(invariantsPointwiseGate(newA, corpus));

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
    if (report.verdict !== 'PASS') exitCode = 1;
  } else {
    usage();
  }
} catch (err) {
  console.error(String(err && err.message));
  exitCode = 1;
}
process.exit(exitCode);
