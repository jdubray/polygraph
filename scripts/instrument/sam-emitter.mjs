// Guided instrumentation for the SAM pattern (Step 2 helper).
//
// For code built on @cognitive-fab/sam-pattern (optionally with
// @cognitive-fab/sam-fsm). `withSamTracing` augments the `component` config you
// pass to `instance({ initialState, component, render })` so that every
// dispatch emits one NDJSON window {pre, action, data, post} — the same format
// the rest of Polygraph consumes — including FSM-rejected (observable no-op)
// dispatches.
//
// How it works (the mechanism the finixpos study proved): sam-pattern runs the
// component's acceptors AND reactors on every presented proposal. This helper
//   - PREPENDS a capture acceptor that snapshots `project(model)` (pre) plus the
//     dispatched action name and its data, BEFORE any of your acceptors run, and
//   - APPENDS an emit reactor that writes the window with `project(model)` (post)
//     AFTER the whole acceptor chain has settled.
// Your own acceptors/reactors run in between, unchanged.
//
// The action name is read from `proposal.__actionName` (set by sam-pattern from
// the action label, and what sam-fsm keys on), falling back to `proposal.__name`.
// Internal error re-presentations (no action name) are not steps and are skipped.
//
// `project(model)` MUST return ONLY your contract's observable keys — exclude
// everything else. For an sam-fsm machine, the FSM's program-counter field
// (whatever you named `pc`, e.g. `state` or `txState`) is a normal model field;
// include it in the projection as your primary state key.
//
// Usage:
//   import { withSamTracing } from '<plugin>/scripts/instrument/sam-emitter.mjs';
//   const project = (m) => ({ state: m.state, coins: m.coins }); // observable keys only
//   const traced  = withSamTracing(component, project, 'traces/s1_normal.ndjson');
//   const { intents } = instance({ initialState, component: traced, render });
//   // ...then drive `intents` through your scenarios as usual.
//
// NOTE: instrument a COPY of your code, keep the change as a diff/patch, and
// never leave the emitter in production (it does synchronous file I/O).
import { traceStep } from './trace-emitter.mjs';

/** Strip SAM-internal keys (those starting with `__`) from a proposal. */
function extractData(proposal) {
  const out = {};
  for (const k of Object.keys(proposal)) {
    if (!k.startsWith('__')) out[k] = proposal[k];
  }
  return out;
}

/**
 * Return a copy of `component` with tracing woven in. Non-mutating: your
 * original component object is left untouched.
 *
 * @param {{actions?: any[], acceptors?: any[], reactors?: any[], naps?: any[]}} component
 * @param {(model: any) => object} project  observable-state projection (contract keys only)
 * @param {string} file  NDJSON output path
 */
export function withSamTracing(component, project, file) {
  // One window under construction per wrapped component. Dispatches are
  // presented one at a time (the acceptor chain then the reactor chain run to
  // completion before the next proposal), so a single closure slot is correct
  // and mirrors the finixpos traced workflow's `_pendingTrace`.
  let pending = null;

  const captureAcceptor = (model) => (proposal) => {
    const action = proposal.__actionName ?? proposal.__name;
    if (!action) return; // internal __error presentations are not steps
    pending = { pre: project(model), action, data: extractData(proposal) };
  };

  const emitReactor = (model) => () => {
    if (!pending) return;
    try {
      traceStep(pending.pre, pending.action, pending.data, project(model), file);
    } catch {
      /* tracing must never break the workflow */
    }
    pending = null;
  };

  return {
    ...component,
    acceptors: [captureAcceptor, ...(component.acceptors ?? [])],
    reactors: [...(component.reactors ?? []), emitReactor],
  };
}
