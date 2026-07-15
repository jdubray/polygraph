// SAM-v2 transition-validation replayer (task-agnostic).
//
// Same child-process stdin/stdout JSON protocol as tv.mjs, but speaking the
// v2 (sam-lib 2.0.0-alpha strict profile) module contract instead of the
// bare-next() one. The spec is a CommonJS module exporting
//   { instance, init, actions, getState, setState }
// (the shape defined in the plan's P1 module contract; `checkerIntents` is
// not needed — domains live in instance({}).manifest()).
//
// Reads { specPath, windows } on stdin, each window { action, data, preState,
// postState }. Per window:
//   init(); setState(preState); actions[action](data);
// then getState() is compared to postState under the SAME projection rule as
// tv.mjs — every key present in the trace's postState must deep-match (the
// shared canonical stringify), extra keys are ignored.
//
// Strict-profile throws (SamSchemaError / SamShapeError / SamValidationError,
// or any acceptor throw) are window FAILURES carrying the error name — never
// protocol failures.
//
// NEW versus tv.mjs (the triage upgrade): every window result carries the
// step classification from instance({}).lastStep():
//   { classification: 'mutated'|'rejected'|'identity-by-mutation'|'unhandled',
//     deep, rejectionReason? }
// so a no-op window now says WHY the spec did nothing — 'rejected' (with the
// contract-anchored reason) and 'identity-by-mutation' are the two good no-op
// classes; 'unhandled' is a finding for the caller to surface.
//
// Emits { ok, results:[{ action, status, classification?, deep?,
// rejectionReason?, error? }] } on stdout. A load failure or a missing v2
// surface yields { ok:false, error } (the caller treats all windows as
// unscoreable). The spec's console is shadowed to stderr by the shared loader,
// so spec logging cannot corrupt the stdout protocol.
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

const missing = ['instance', 'init', 'getState', 'setState'].filter((f) => typeof mod?.[f] !== 'function');
if (!mod || typeof mod.actions !== 'object' || mod.actions === null) missing.push('actions');
if (missing.length) {
  const hint = mod && typeof mod.next === 'function'
    ? ' (module exports next() — a legacy bare-next spec; replay it with --legacy-bare-next / tv.mjs)'
    : '';
  console.log(JSON.stringify({ ok: false, error: `module is not a v2 SAM spec — missing export(s): ${missing.join(', ')}${hint}` }));
  process.exit(0);
}

/**
 * Read { classification, deep, rejectionReason } off instance({}).lastStep()
 * — but only when the recorded step belongs to `action`: after a strict-
 * profile throw the last COMPLETED step may be a previous window's, and stale
 * triage metadata is worse than none.
 */
function readLastStep(action, staleJson = null) {
  try {
    const acc = mod.instance({});
    if (typeof acc?.lastStep !== 'function') return null;
    const step = acc.lastStep();
    if (!step || (step.intent !== undefined && step.intent !== action)) return null;
    // Staleness guard (error path only): a strict-profile throw BEFORE the
    // framework's beginStep leaves the PREVIOUS window's step recorded; if
    // that previous window dispatched the same action, the intent filter
    // above cannot tell. The caller passes the pre-dispatch step serialization
    // — an identical post-dispatch step means no new step ran.
    if (staleJson !== null && JSON.stringify(step) === staleJson) return null;
    const rejection = Array.isArray(step.rejections) && step.rejections.length ? step.rejections[0] : null;
    return {
      classification: step.classification,
      deep: !!step.deep,
      ...(rejection && rejection.reason !== undefined ? { rejectionReason: rejection.reason } : {}),
    };
  } catch {
    return null; // triage metadata is best-effort; never fails a window by itself
  }
}

// Deep equality over the projected keys — key-order-insensitive via the shared
// canonical stringify (the ONE state-equality definition of the pipeline).
const deepEq = (a, b) => stable(a) === stable(b);

const results = [];
for (const w of req.windows) {
  const post = w.postState;
  const entry = { action: w.action };
  // Empty/missing postState would pass vacuously ([].every() is true) —
  // unscoreable-with-reason, same rule as tv.mjs.
  if (!post || typeof post !== 'object' || Array.isArray(post) || Object.keys(post).length === 0) {
    entry.status = 'unscoreable';
    entry.error = 'empty, missing, or non-object postState — nothing to compare (corpus defect; run validate_corpus)';
    results.push(entry);
    continue;
  }
  // Pre-dispatch step serialization for the error path's staleness guard.
  let stepBefore = null;
  try { stepBefore = JSON.stringify(mod.instance({}).lastStep()); } catch { /* best-effort */ }
  try {
    mod.init();
    // structuredClone: a spec that aliases the snapshot cannot corrupt later windows.
    mod.setState(structuredClone(w.preState));
    const handler = mod.actions[w.action];
    if (typeof handler !== 'function') throw Object.assign(new Error(`action '${w.action}' is not exported by the spec`), { name: 'MissingActionError' });
    handler(w.data ?? {});
    const step = readLastStep(w.action);
    if (step) Object.assign(entry, step);
    const out = mod.getState();
    // Projection rule (same as tv.mjs): only keys in the trace post-state must match.
    const ok = out !== null && typeof out === 'object'
      && Object.keys(post).every((k) => deepEq(out[k], post[k]));
    entry.status = ok ? 'pass' : 'fail';
  } catch (e) {
    // Strict-profile throws (SamSchemaError, SamShapeError, ...) and acceptor
    // throws are window failures carrying the error name for triage.
    entry.status = 'fail';
    entry.error = `${(e && e.name) || 'Error'}: ${(e && e.message) || String(e)}`;
    const step = readLastStep(w.action, stepBefore);
    if (step && entry.classification === undefined) Object.assign(entry, step);
  }
  results.push(entry);
}
console.log(JSON.stringify({ ok: true, results }));
