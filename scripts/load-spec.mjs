// Shared spec-loading + canonical-state helpers.
//
// ONE loader and ONE canonical stringify for the whole pipeline, so the replay
// half (tv.mjs / sam-tv.mjs) and the model-checking half (check.mjs) can never
// disagree about which specs load or which states are equal. tv.mjs and
// sam-tv.mjs (standalone child processes) import the loader from here — the
// former internal copy in tv.mjs was consolidated away.
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { Console } from 'node:console';
import vm from 'node:vm';
import { SAM_LIB_PATH, SAM_LIB_SPECIFIERS } from './sam-lib.mjs';

// Specs may console.log (LLM output often appends demo logging). Any stdout
// write from a spec would corrupt tv.mjs's stdout JSON protocol, so the loader
// shadows `console` with a stderr-backed one via a compileFunction parameter —
// this covers module top-level logging AND calls inside init()/next(), because
// the parameter shadows the global for all code in the module.
export const stderrConsole = new Console({ stdout: process.stderr, stderr: process.stderr });

/**
 * Load a spec as a CommonJS module (module.exports = { init, next }) regardless
 * of the surrounding package's "type" field or the file extension (.js/.cjs).
 * Wraps the file in the standard CJS parameter list via vm.compileFunction —
 * the same mechanism Node's own CJS loader uses. ESM specs (.mjs / export
 * syntax) are NOT supported by this loader and will throw at compile time.
 */
export function loadSpec(specPath) {
  const abs = resolve(specPath);
  const code = readFileSync(abs, 'utf-8');
  const module = { exports: {} };
  const baseRequire = createRequire(abs);
  // Require-patch: a spec's require of the SAM library resolves to the VENDORED
  // 2.0.0-alpha bundle (scripts/vendor/sam-pattern.cjs), never to whatever
  // version happens to be installed near the spec — the v2 strict surface the
  // pipeline depends on is pinned by construction. All other specifiers pass
  // through untouched. (v2 is backward compatible, so legacy SAM specs loaded
  // through this loader keep working.)
  const require = Object.assign(
    (id) => (SAM_LIB_SPECIFIERS.includes(id) ? baseRequire(SAM_LIB_PATH) : baseRequire(id)),
    baseRequire
  );
  const compiled = vm.compileFunction(
    code,
    ['module', 'exports', 'require', '__filename', '__dirname', 'console'],
    { filename: abs }
  );
  compiled(module, module.exports, require, abs, dirname(abs), stderrConsole);
  return module.exports;
}

/**
 * Canonical stringify: key-order-insensitive. THE state-equality definition
 * for the whole pipeline (replay diff and checker visited-set alike) — two
 * states are equal iff stable(a) === stable(b).
 *
 * undefined, NaN and ±Infinity render as DISTINCT non-JSON sentinels, never
 * as 'null': trace windows come from JSON.parse and can only contain null,
 * so a spec that DROPPED a field (undefined) or computed NaN must NOT compare
 * equal to a trace value of null — that would score a failing window as a
 * pass.
 */
export function stable(v) {
  if (v === undefined) return 'undefined';
  if (typeof v === 'number' && !Number.isFinite(v)) return String(v); // NaN / Infinity / -Infinity
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
}

/**
 * The action's declared data fields. Contracts in the wild use both
 * `dataFields:` (the schema's key) and `data:` — every consumer (prompt
 * builder, domain builder) MUST read them through this one accessor so the
 * prompt and the explored domain can never diverge.
 */
export function dataFieldsOf(actionSpec) {
  return actionSpec && actionSpec.dataFields ? actionSpec.dataFields : (actionSpec && actionSpec.data) || {};
}
