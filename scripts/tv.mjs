// Bare-next() transition-validation replayer (task-agnostic).
//
// Reads a JSON request { specPath, windows } on stdin, where the spec is a
// CommonJS module exporting a pure transition function
//   next(state, action, data) -> state'
// and each window is { action, data, preState, postState }.
//
// For each window: call next(pre, action, data) and compare the result to
// postState under the *projection rule* — every key present in the trace's
// postState must deep-match; extra keys the module carries are ignored. This
// makes the replayer independent of the observable-state shape (works for
// {lockHeld, lockHolder}, {txState, orderId, ...}, {locked}, etc.).
// Emits { ok, results } as JSON on stdout; per-window status is "pass"|"fail".
// A load failure or a missing next() export yields { ok:false, error } (the
// caller treats all windows as unscoreable).
//
// Origin: this file is the SysMoBench plain-JS transition-validation runner,
// bundled verbatim. See https://github.com/jdubray/SysMoBench-1
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import vm from 'node:vm';

// Load a spec as a CommonJS module (module.exports = { init, next }) regardless
// of the surrounding package's "type" field or the file extension. We wrap the
// file in the standard CommonJS parameter list (module, exports, require,
// __filename, __dirname) using vm.compileFunction — the same mechanism Node's
// own CJS loader uses. The spec source is the compiled function BODY, not
// interpolated into a template, so there is no injection surface beyond what
// require() of the same file would already do (executing the spec module is the
// replayer's purpose). Projection-rule semantics below are unchanged from the
// original SysMoBench runner.
function loadSpec(specPath) {
  const abs = resolve(specPath);
  const code = readFileSync(abs, 'utf-8');
  const module = { exports: {} };
  const require = createRequire(abs);
  const compiled = vm.compileFunction(
    code,
    ['module', 'exports', 'require', '__filename', '__dirname'],
    { filename: abs }
  );
  compiled(module, module.exports, require, abs, dirname(abs));
  return module.exports;
}

const req = JSON.parse(readFileSync(0, 'utf-8'));

let mod;
try {
  mod = loadSpec(req.specPath);
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: 'load failed: ' + (e && e.message) }));
  process.exit(0);
}
if (!mod || typeof mod.next !== 'function') {
  console.log(JSON.stringify({ ok: false, error: 'module does not export a next() function' }));
  process.exit(0);
}

const norm = (v) => (v === undefined ? null : v);
// Deep equality over the projected keys (handles primitives, arrays, objects).
const deepEq = (a, b) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));
const results = [];
for (const w of req.windows) {
  const post = w.postState;
  let status;
  try {
    // Deep-copy the pre-state so a non-pure next() can't corrupt later windows.
    const out = mod.next(structuredClone(w.preState), w.action, w.data);
    // Projection rule: only keys present in the trace post-state must match.
    const ok = out !== null && typeof out === 'object'
      && Object.keys(post).every((k) => deepEq(out[k], post[k]));
    status = ok ? 'pass' : 'fail';
  } catch (e) {
    status = 'fail'; // a runtime error on a window is a failed transition
  }
  results.push({ action: w.action, status });
}
console.log(JSON.stringify({ ok: true, results }));
