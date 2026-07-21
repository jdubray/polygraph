#!/usr/bin/env node
// polyviz CLI (spec §3.5). Deterministic, artifact-derived diagram renderer.
//
//   polyviz render --in <file.polyviz.json> --diagram <all|invariants|...>
//                  --out <dir> [--format svg[,png]] [--theme dark|light] [--tokens f.json]
//   polyviz hash   --in <file.polyviz.json> --diagram <...>
//   polyviz schema
//
// No model call at render time. No network. Missing/invalid input → loud error.

import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { resolve, join, dirname, relative, sep } from 'node:path';
import { SCHEMA } from '../src/model/schema.mjs';
import { validate } from '../src/model/validate.mjs';
import { loadTheme } from '../src/render/theme.mjs';
import { sha256 } from '../src/hash.mjs';
import { adaptDir } from '../src/adapters/index.mjs';
import { renderPng } from '../src/raster/png.mjs';
import { injectReport, buildManifest } from '../src/report.mjs';
import { DIAGRAMS, DIAGRAM_IDS, availableFor } from '../src/diagrams/index.mjs';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) { args[key] = true; }
      else { args[key] = next; i++; }
    }
  }
  return args;
}

function die(msg) {
  process.stderr.write(`polyviz: ${msg}\n`);
  process.exit(1);
}

async function loadModel(inPath) {
  if (!inPath) die('missing --in <file.polyviz.json>');
  const p = resolve(inPath);
  let st;
  try { st = statSync(p); } catch { die(`--in not found: ${inPath}`); }
  let model;
  if (st.isDirectory()) {
    try { model = await adaptDir(p, { log: (m) => process.stderr.write(`${m}\n`) }); }
    catch (e) { die(e.message); }
  } else {
    try { model = JSON.parse(readFileSync(p, 'utf8')); }
    catch (e) { die(`could not parse ${inPath}: ${e.message}`); }
  }
  try { validate(model); }
  catch (e) { die(e.message); }
  return model;
}

function selectDiagrams(model, diagramArg) {
  const avail = availableFor(model);
  if (!diagramArg || diagramArg === 'all') {
    if (!avail.length) die('this viz-model has no renderable sections');
    return avail;
  }
  const requested = String(diagramArg).split(',').map((s) => s.trim());
  for (const id of requested) {
    if (!DIAGRAM_IDS.includes(id)) {
      die(`unknown diagram "${id}" (known: ${DIAGRAM_IDS.join(', ')})`);
    }
    if (!avail.includes(id)) {
      die(`diagram "${id}" needs a section this viz-model does not have`);
    }
  }
  return requested;
}

function resolveTokens(model, { theme, tokensFile }) {
  const override = tokensFile ? JSON.parse(readFileSync(resolve(tokensFile), 'utf8')) : null;
  const themeName = theme || model.meta?.theme || 'dark';
  return loadTheme(themeName, override);
}

async function render(model, ids, opts) {
  const tokens = resolveTokens(model, opts);
  const log = (m) => process.stderr.write(`${m}\n`);
  return Promise.all(ids.map((id) => Promise.resolve(DIAGRAMS[id](model, { tokens, log }))));
}

async function cmdRender(args) {
  const model = await loadModel(args.in);
  const ids = selectDiagrams(model, args.diagram);
  const formats = String(args.format || 'svg').split(',').map((s) => s.trim());
  const known = new Set(['svg', 'png']);
  const unsupported = formats.filter((f) => !known.has(f));
  if (unsupported.length) die(`unknown format(s): ${unsupported.join(', ')} (expected svg, png)`);

  const out = args.out ? resolve(args.out) : die('missing --out <dir>');
  mkdirSync(out, { recursive: true });
  const tokens = resolveTokens(model, { theme: args.theme, tokensFile: args.tokens });
  const scale = args.scale ? Number(args.scale) : 2;
  const results = await render(model, ids, { theme: args.theme, tokensFile: args.tokens });
  for (const r of results) {
    if (formats.includes('svg')) {
      const file = join(out, `${r.id}.svg`);
      writeFileSync(file, r.svg);
      process.stdout.write(`wrote ${file}  (${r.width}x${r.height}, sha256 ${sha256(r.svg).slice(0, 12)})\n`);
    }
    if (formats.includes('png')) {
      const file = join(out, `${r.id}.png`);
      const png = await renderPng(r.svg, { scale, background: tokens.bg });
      writeFileSync(file, png);
      process.stdout.write(`wrote ${file}  (${r.width * scale}x${r.height * scale}, ${png.length} bytes)\n`);
    }
  }
}

async function cmdHash(args) {
  const model = await loadModel(args.in);
  const ids = selectDiagrams(model, args.diagram);
  const results = await render(model, ids, { theme: args.theme, tokensFile: args.tokens });
  for (const r of results) process.stdout.write(`${sha256(r.svg)}  ${r.id}\n`);
}

function cmdSchema() {
  process.stdout.write(JSON.stringify(SCHEMA, null, 2) + '\n');
}

async function cmdReport(args) {
  const model = await loadModel(args.in);
  const ids = selectDiagrams(model, args.diagram);
  const formats = String(args.format || 'svg').split(',').map((s) => s.trim());
  const imgDir = args.img ? resolve(args.img) : die('missing --img <dir>');
  mkdirSync(imgDir, { recursive: true });
  const tokens = resolveTokens(model, { theme: args.theme, tokensFile: args.tokens });
  const scale = args.scale ? Number(args.scale) : 2;
  const results = await render(model, ids, { theme: args.theme, tokensFile: args.tokens });

  const enriched = [];
  for (const r of results) {
    if (formats.includes('svg')) writeFileSync(join(imgDir, `${r.id}.svg`), r.svg);
    if (formats.includes('png')) writeFileSync(join(imgDir, `${r.id}.png`), await renderPng(r.svg, { scale, background: tokens.bg }));
    enriched.push({ ...r, sha256: sha256(r.svg) });
    process.stdout.write(`rendered ${r.id}\n`);
  }

  const manifest = buildManifest(enriched, { svg: formats.includes('svg'), png: formats.includes('png') });
  const manifestPath = join(imgDir, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  process.stdout.write(`wrote ${manifestPath}\n`);

  if (args.report) {
    const reportPath = resolve(args.report);
    let md;
    try { md = readFileSync(reportPath, 'utf8'); } catch { die(`--report not found: ${args.report}`); }
    const ext = formats.includes('svg') ? 'svg' : 'png';
    const relImg = relative(dirname(reportPath), imgDir).split(sep).join('/');
    const figures = enriched.map((r) => ({ id: r.id, ref: `${relImg ? `${relImg}/` : ''}${r.id}.${ext}` }));
    const { markdown, injected, missing } = injectReport(md, figures);
    writeFileSync(reportPath, markdown);
    process.stdout.write(`injected ${injected.length} figure(s) into ${reportPath}${injected.length ? `: ${injected.join(', ')}` : ''}\n`);
    if (missing.length) process.stderr.write(`polyviz: report has markers with no figure: ${missing.join(', ')}\n`);
  }
}

const [, , cmd, ...rest] = process.argv;
const args = parseArgs(rest);
switch (cmd) {
  case 'render': cmdRender(args).catch((e) => die(e.message)); break;
  case 'hash': cmdHash(args).catch((e) => die(e.message)); break;
  case 'report': cmdReport(args).catch((e) => die(e.message)); break;
  case 'schema': cmdSchema(); break;
  default:
    process.stderr.write('usage: polyviz <render|hash|report|schema> [--in f] [--diagram id] [--out dir] [--img dir] [--report REPORT.md] [--format svg,png] [--theme dark|light] [--tokens f] [--scale N]\n');
    process.exit(cmd ? 1 : 0);
}
