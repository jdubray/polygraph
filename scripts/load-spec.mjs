// Shared spec-loading + canonical-state helpers.
//
// ONE loader and ONE canonical stringify for the whole pipeline, so the replay
// half (tv.mjs) and the model-checking half (check.mjs) can never disagree
// about which specs load or which states are equal. tv.mjs keeps an internal
// copy of the loader (it is invoked standalone as a child process and stays
// close to the original SysMoBench runner) — see the keep-in-sync comments in
// both files.
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { Console } from 'node:console';
import vm from 'node:vm';

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
  const require = createRequire(abs);
  const compiled = vm.compileFunction(
    code,
    ['module', 'exports', 'require', '__filename', '__dirname', 'console'],
    { filename: abs }
  );
  compiled(module, module.exports, require, abs, dirname(abs), stderrConsole);
  return module.exports;
}

/**
 * Canonical JSON stringify: key-order-insensitive, undefined normalized to
 * null. THE state-equality definition for the whole pipeline (replay diff and
 * checker visited-set alike) — two states are equal iff stable(a) === stable(b).
 */
export function stable(v) {
  if (v === undefined) return 'null';
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
