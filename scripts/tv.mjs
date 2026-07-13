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
// bundled with two deliberate deviations from verbatim (both integrity fixes):
//   1. the spec's `console` is shadowed with a stderr-backed one, so a spec
//      that logs (LLM output often does) cannot corrupt the stdout protocol;
//   2. deepEq uses the shared canonical stringify (key-order-insensitive) from
//      load-spec.mjs, so replay and the model checker share ONE definition of
//      state equality.
// The loader (console-shadowed CJS-in-vm, vendored-SAM require patch) is the
// SHARED one in scripts/load-spec.mjs — the former internal copy was
// consolidated away, so replay and the model checker can never disagree about
// which specs load. Projection-rule semantics below are unchanged from the
// original runner.
import { readFileSync } from 'node:fs';
import { stable, loadSpec } from './load-spec.mjs';

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

// Deep equality over the projected keys (primitives, arrays, objects) —
// key-order-insensitive via the shared canonical stringify, so a spec building
// a nested object in a different key order than the trace is not a mismatch.
const deepEq = (a, b) => stable(a) === stable(b);
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
