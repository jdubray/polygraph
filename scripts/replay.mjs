// Replay helper: run one spec file against a window list via tv.mjs, returning
// per-window statuses. Shared by verify.mjs and the self-test.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TV = join(HERE, 'tv.mjs');

/** Load and flatten an NDJSON trace corpus (a dir of *.ndjson or a single file). */
export function loadWindows(tracePath) {
  const files = [];
  let stat;
  try {
    stat = readdirSync(tracePath);
  } catch {
    stat = null;
  }
  if (stat) {
    for (const f of stat.sort()) if (f.endsWith('.ndjson')) files.push(join(tracePath, f));
  } else {
    files.push(tracePath);
  }
  const windows = [];
  for (const f of files) {
    const scenario = f.replace(/^.*[\\/]/, '');
    const lines = readFileSync(f, 'utf-8').split('\n').filter((l) => l.trim());
    lines.forEach((line, i) => {
      const w = JSON.parse(line);
      windows.push({ scenario, index: i, action: w.action, data: w.data, pre: w.pre, post: w.post });
    });
  }
  return windows;
}

/** Replay a single spec file. Returns ['pass'|'fail'|'unscoreable', ...] aligned to windows. */
export function replaySpec(specPath, windows) {
  const request = {
    specPath: resolve(specPath).replaceAll('\\', '/'),
    windows: windows.map((w) => ({ action: w.action, data: w.data, preState: w.pre, postState: w.post })),
  };
  const proc = spawnSync('node', [TV], { input: JSON.stringify(request), encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
  let resp;
  try {
    resp = JSON.parse(proc.stdout);
  } catch {
    return windows.map(() => 'unscoreable');
  }
  if (!resp.ok) return windows.map(() => 'unscoreable');
  return resp.results.map((r) => r.status);
}
