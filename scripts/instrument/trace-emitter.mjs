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
 * Wrap a dispatch function `dispatch(action, data)` so every call emits a window.
 * `projectState()` must return the observable-state projection at call time.
 */
export function withTracing(dispatch, projectState, file) {
  return (action, data) => {
    const pre = projectState();
    const result = dispatch(action, data);
    // If dispatch is async, chain; otherwise snapshot synchronously.
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
    const pre = project(state);
    const next = reducer(state, action);
    traceStep(pre, actionName(action), actionData(action), project(next), file);
    return next;
  };
}
