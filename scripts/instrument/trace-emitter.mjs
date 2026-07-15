// Guided instrumentation for JS/TS (Step 2 helper).
//
// Emits one NDJSON window {pre, action, data, post} per step to a file. `pre`
// is the projected observable state BEFORE the step; `post` is AFTER it settles.
// You supply a `projectState()` that returns ONLY your contract's observable
// keys — everything else is deliberately excluded.
//
// Two entry points:
//   traceStep(pre, action, data, post, file)   — you already have pre/post
//   withTracing(dispatch, projectState, file)  — wrap a dispatch fn; it snapshots
//                                                pre before and post after.
// For a Redux-style reducer (state, action) => state, use tapReducer below.
//
// NOTE: instrument a COPY of your code, keep the change as a diff/patch, and
// never leave the emitter in production (it does synchronous file I/O).
import { appendFileSync } from 'node:fs';

/** Append one window. `data` is the action payload (or {}). */
export function traceStep(pre, action, data, post, file) {
  appendFileSync(file, JSON.stringify({ pre, action, data: data || {}, post }) + '\n');
}

/**
 * Deep-snapshot a projection AT CAPTURE TIME. A projection that returns
 * object/array values returns REFERENCES into the live model; code that
 * mutates in place (the norm in SAM v1 acceptors and impure reducers) would
 * rewrite the captured `pre` before it is serialized, making every window
 * read pre == post — a corrupted corpus that validates clean.
 */
export const snapshotProjection = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

/**
 * Wrap a dispatch function `dispatch(action, data)` so every call emits a window.
 * `projectState()` must return the observable-state projection at call time.
 */
export function withTracing(dispatch, projectState, file) {
  return (action, data) => {
    const pre = snapshotProjection(projectState());
    const result = dispatch(action, data);
    // If dispatch is async, chain; otherwise snapshot synchronously.
    // A REJECTED dispatch promise emits no window by design: the step never
    // settled, so there is no truthful post-state — and the rejection itself
    // propagates to the caller, so the failure is not silent.
    if (result && typeof result.then === 'function') {
      return result.then((r) => { traceStep(pre, action, data, projectState(), file); return r; });
    }
    traceStep(pre, action, data, projectState(), file);
    return result;
  };
}

/**
 * Tap a pure reducer (state, action) => state. Returns a wrapped reducer that
 * emits a window on every call. `project` maps full state -> observable keys;
 * `actionName` and `actionData` extract the action string and its payload
 * (defaults assume Redux-style { type, ...payload }).
 */
export function tapReducer(reducer, project, file, {
  actionName = (a) => a.type,
  actionData = (a) => { const { type, ...rest } = a; return rest; },
} = {}) {
  return (state, action) => {
    const pre = snapshotProjection(project(state));
    const next = reducer(state, action);
    traceStep(pre, actionName(action), actionData(action), project(next), file);
    return next;
  };
}
