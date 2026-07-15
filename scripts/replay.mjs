// Replay helper: run one spec file against a window list via tv.mjs, returning
// per-window statuses. Shared by verify.mjs and the self-test.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TV = join(HERE, 'tv.mjs'); // legacy bare-next() replayer
const SAM_TV = join(HERE, 'sam-tv.mjs'); // v2 SAM strict-profile replayer (default)

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

/**
 * Replay a single spec file against the windows, returning the replayer's full
 * per-window results. `mode` selects the artifact contract:
 *   'sam'    (default) — v2 SAM strict-profile module via sam-tv.mjs; results
 *            additionally carry { classification, deep, rejectionReason?, error? }.
 *   'legacy' — bare next(state, action, data) module via tv.mjs.
 * Returns { ok, results:[{ status, ... }], error? }; ok:false means the spec
 * did not load / lacks the expected surface (caller scores all windows unscoreable).
 */
// A spec that retains a live handle (setInterval, an open socket — LLM output
// routinely appends demo scaffolding) would keep the child's event loop alive
// forever and hang the whole pipeline. Bounded, generous, overridable — read
// per call so a caller (or test) can adjust it at runtime.
const replayTimeoutMs = () => Number(process.env.POLYGRAPH_REPLAY_TIMEOUT_MS || 120000);

export function replaySpecResults(specPath, windows, mode = 'sam') {
  const runner = mode === 'legacy' ? TV : SAM_TV;
  const request = {
    specPath: resolve(specPath).replaceAll('\\', '/'),
    windows: windows.map((w) => ({ action: w.action, data: w.data, preState: w.pre, postState: w.post })),
  };
  // Scale with corpus size: the base covers spec startup + pathological
  // windows; large corpora get proportional headroom so an honest slow replay
  // of 50k windows is not killed by a bound sized for 50.
  const timeout = replayTimeoutMs() + windows.length * 10;
  const proc = spawnSync('node', [runner], {
    input: JSON.stringify(request), encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024,
    timeout, killSignal: 'SIGKILL',
  });
  try {
    // The protocol JSON is the LAST non-empty stdout line. Both replayers
    // redirect spec console output to stderr, but parse defensively anyway so
    // stray stdout writes (a spec calling process.stdout.write directly) can't
    // make a correct spec unscoreable. A timed-out child that already printed
    // its protocol line merely lingered on a live handle — its results are
    // real and are used.
    const lines = String(proc.stdout || '').split('\n').filter((l) => l.trim());
    const parsed = JSON.parse(lines[lines.length - 1]);
    // Shape check: a stray JSON-looking stdout line from the spec (the loader
    // shadows console, not process.stdout.write) must not masquerade as the
    // protocol result.
    if (!parsed || typeof parsed.ok !== 'boolean') throw new Error('not a protocol line');
    return parsed;
  } catch {
    if (proc.error && proc.error.code === 'ETIMEDOUT') {
      // Unscoreable-with-reason is the honest verdict: nothing was measured.
      return { ok: false, error: `replayer timed out after ${timeout}ms with no result (the spec likely blocks or retains a live handle; POLYGRAPH_REPLAY_TIMEOUT_MS overrides the base)` };
    }
    return { ok: false, error: 'replayer produced no parseable output' };
  }
}

/** Replay a single spec file. Returns ['pass'|'fail'|'unscoreable', ...] aligned to windows. */
export function replaySpec(specPath, windows, mode = 'sam') {
  const resp = replaySpecResults(specPath, windows, mode);
  if (!resp.ok) return windows.map(() => 'unscoreable');
  return resp.results.map((r) => r.status);
}
