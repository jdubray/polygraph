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
// v2 path (sam-pattern 2.0.0-alpha strict profile): `withSamTracingV2` hooks
// the framework's own per-step observability (`instance({ stepListener })`)
// instead of injecting a capture acceptor / emit reactor. Strictly cleaner:
// the listener fires once per presented proposal — INCLUDING steps an
// acceptor rejected via reject(reason) — so rejected dispatches show up as
// windows too, carrying an optional `"rejected": "<reason>"` metadata key.
// A rejected window always has pre == post, so validate_corpus.mjs (and all
// v1 tooling, which ignores unknown window keys) treats it as a plain no-op
// window; the `rejected` key is extra triage evidence, not a format change.
import { appendFileSync } from 'node:fs';
import { traceStep, snapshotProjection } from './trace-emitter.mjs';

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
    // snapshotProjection: acceptors mutate the model IN PLACE, and a
    // projection with object/array values returns references into it — the
    // serialized `pre` would otherwise show post-mutation content (pre ==
    // post on every window, silently).
    pending = { pre: snapshotProjection(project(model)), action, data: snapshotProjection(extractData(proposal)) };
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

/**
 * v2 (strict profile) tracing: emit one NDJSON window per SAM step, including
 * rejected steps, using the framework's stepListener instead of injected
 * acceptors/reactors.
 *
 * Call AFTER the spec's own `instance({ initialState, component })` call has
 * registered its intents/acceptors (the '*' capture acceptor must not run
 * before the model shape and intents exist):
 *
 *   const control = instance({ initialState, component });
 *   withSamTracingV2(instance, 'traces/s1_normal.ndjson');
 *   // ...drive control.intents through your scenarios as usual.
 *
 * Window shape: { pre, action, data, post [, rejected] }
 *   - pre/post come from getState(), which in the v2 strict profile already
 *     projects to the DECLARED modelShape keys — no project() needed.
 *   - pre is the previous window's post (the initial pre is getState() at
 *     wiring time), so wire the tracer before dispatching and do not call
 *     setState() mid-scenario.
 *   - a step some acceptor rejected via reject(reason) still emits a window;
 *     it carries `rejected: "<reason>"` and pre == post. validate_corpus.mjs
 *     treats such a window as a no-op window (the key is ignored by v1
 *     tooling; it exists for rejection-reason triage).
 *   - post is captured when the listener fires: after the acceptor chain,
 *     BEFORE reactors run. v2 strict specs declare `reactors: []`; if yours
 *     doesn't, reactor-computed state is not in `post`.
 *   - framework-internal presentations (no action name, e.g. __error) are
 *     not steps and are skipped, exactly like the v1 path.
 *
 * @param {Function} instance  the spec's sam-pattern instance() function
 * @param {string|((window: object) => void)} sink  NDJSON file path, or a
 *        function receiving each window object (handy for tests)
 * @returns {Function} the same instance function, for chaining
 */
export function withSamTracingV2(instance, sink) {
  const emit =
    typeof sink === 'function'
      ? sink
      : (w) => appendFileSync(sink, JSON.stringify(w) + '\n');

  const { getState } = instance({});
  let lastPost = getState();
  let pendingData = {};

  instance({
    // '*' registers an explicitly cross-cutting acceptor (allowed in strict
    // mode); it runs on every proposal and only records the payload.
    component: {
      acceptors: {
        '*': () => (proposal) => {
          if (proposal.__actionName ?? proposal.__name) {
            pendingData = extractData(proposal);
          }
        },
      },
    },
    stepListener: (step) => {
      if (step.intent == null) return; // __error presentations are not steps
      let window = null;
      try {
        const post = getState();
        window = { pre: lastPost, action: step.intent, data: pendingData, post };
        // Advance the chain FIRST — before any optional decoration and before
        // emitting: a failure past this point must lose (or under-decorate)
        // only its own window, never desynchronize the NEXT window's pre
        // (which would silently record a two-step transition as one).
        lastPost = post;
        if (step.classification === 'rejected' && Array.isArray(step.rejections)) {
          window.rejected = step.rejections.map((r) => r && r.reason).filter((r) => r !== undefined).join('; ');
        }
      } catch (e) {
        // tracing must never break the workflow — but never silently either
        console.error(`[sam-emitter] window skipped for '${step.intent}' (snapshot failed: ${e && e.message})`);
      } finally {
        pendingData = {};
      }
      if (window) {
        try {
          emit(window);
        } catch (e) {
          // Loud on stderr, never breaking: the window is lost but named, and
          // the pre/post chain stays consistent for the windows that follow.
          console.error(`[sam-emitter] dropped window for '${window.action}' (emit failed: ${e && e.message}); pre/post chain remains consistent`);
        }
      }
    },
  });
  return instance;
}
