// {init, next} adapter over a v2 SAM strict-profile spec module — the bridge
// that lets check.mjs's BFS engine (written against the bare-next contract)
// explore a v2 module unchanged.
//
// Adapted from SysMoBench's tools/js-sam/lean-adapter.cjs (verified unmodified
// against v2 in E2-v2), with two deliberate differences:
//   - factory form: makeSamAdapter(specModule) wraps an ALREADY-LOADED module
//     (the pipeline loads specs through load-spec.mjs, which pins the SAM
//     library to the vendored 2.0.0-alpha bundle) instead of the env-var +
//     require() selection the SysMoBench explorer needed;
//   - rejection detection reads instance({}).lastStep().classification
//     ('rejected' — the v2 strict-profile signal) first, keeping the v1
//     error-slot 'unexpected action' prefix as a compatibility fallback.
//
// Semantics:
//   init()               -> spec.init(); return sanitized spec.getState()
//   next(state, a, data) -> spec.init() (reset); clear error slot; spec.setState(state);
//                           spec.actions[a](data); a REJECTED step returns the
//                           INPUT state (a rejection is a legal, observable
//                           no-op, not a fault); any other model-error content
//                           or strict-profile throw propagates, so the checker
//                           records it as a violation.
//
// Purity: the checker treats next() as pure, so the model must be a function
// of the INPUT SNAPSHOT alone. The library's setState is MERGE-ONLY (it
// assigns keys present in the snapshot and never resets the rest) and
// getState OMITS undefined-valued and `internal` modelShape keys — so a bare
// setState(state) would leave residue from whatever transition ran last, and
// BFS node identity would depend on traversal order. next() therefore resets
// the instance via spec.init() FIRST and merges the snapshot on top: any key
// outside the snapshot canonically holds its initial value (the same
// semantics sam-tv.mjs gives each replay window). Snapshots are re-serialized
// with the __-key/function-stripping replacer so internal keys never leak
// into the visited-state set. Async acceptors: generated specs declare
// hasAsyncActions: false (acceptor throws land synchronously); a truly async
// acceptor's rejection would not be observable mid-BFS — same caveat as the
// SysMoBench original.
'use strict';

// SAM v1 rejected gated intents via the model error slot with this prefix.
const REJECTION_PREFIX = 'unexpected action';

/** True when the module exports the v2 SAM surface the pipeline targets. */
function isSamV2Module(mod) {
  return !!mod
    && typeof mod.instance === 'function'
    && typeof mod.init === 'function'
    && typeof mod.getState === 'function'
    && typeof mod.setState === 'function'
    && mod.actions !== null
    && typeof mod.actions === 'object';
}

/** Strips SAM-internal (__-prefixed) keys and functions from snapshots. */
const sanitizeReplacer = (key, value) => {
  if (typeof key === 'string' && key.startsWith('__')) return undefined;
  if (typeof value === 'function') return undefined;
  return value;
};

/** Build the {init, next} lean contract over a loaded v2 SAM module. */
function makeSamAdapter(spec) {
  if (!isSamV2Module(spec)) {
    throw new Error('makeSamAdapter: module does not export the v2 SAM surface { instance, init, actions, getState, setState }');
  }

  const snapshot = () => JSON.parse(JSON.stringify(spec.getState(), sanitizeReplacer));

  const accessor = () => spec.instance({});

  const clearError = () => {
    try {
      const state = accessor().state();
      if (state && typeof state.clearError === 'function') state.clearError();
    } catch { /* pre-v2 instances may lack the accessor; nothing to clear.
                 (The sam-lib#28 state-key shadowing this also guarded is fixed
                 structurally in 2.0.0-alpha.2 / issue #29.) */ }
  };

  /** v1-compat error-slot read (strict-profile errors THROW instead). */
  const readModelError = () => {
    try {
      const model = accessor().state();
      if (!model || typeof model.hasError !== 'function' || !model.hasError()) return null;
      const raw = model.error();
      const message = (typeof model.errorMessage === 'function' && model.errorMessage()) || String(raw ?? 'unknown error');
      const text = typeof raw === 'string' ? raw : (raw && raw.message) || '';
      return { message, isRejection: text.startsWith(REJECTION_PREFIX) };
    } catch {
      return null;
    }
  };

  const lastStepOf = (action) => {
    try {
      const acc = accessor();
      if (typeof acc.lastStep !== 'function') return null;
      const step = acc.lastStep();
      if (!step || (step.intent !== undefined && step.intent !== action)) return null;
      return step;
    } catch {
      return null;
    }
  };

  const init = () => {
    spec.init();
    return snapshot();
  };

  const next = (state, action, data) => {
    // Reset-then-merge: without init(), setState's merge-only semantics let
    // hidden state leak between transitions and node identity becomes
    // traversal-order-dependent (states wrongly merged or missed).
    spec.init();
    clearError();
    spec.setState(state);
    // Entry snapshot: the observable state the model actually holds at the
    // start of this transition (init values merged with `state`). Used below
    // to detect an OBSERVABLE mutate-then-reject.
    const entry = snapshot();
    const handler = spec.actions[action];
    if (typeof handler !== 'function') {
      throw new Error(`action '${action}' is not exported by the spec`);
    }
    handler(data);
    const step = lastStepOf(action);
    if (step && step.classification === 'rejected') {
      // lastStep() classifies 'rejected' whenever reject() was called — even
      // if the acceptor mutated the model FIRST. Treating that as a pure
      // no-op would explore an identity transition the replayer (which reads
      // getState() and sees the mutation) would fail: the two halves of the
      // pipeline would contradict each other on the same spec. A rejection
      // that OBSERVABLY mutated is therefore a spec defect. The snapshot
      // comparison ALONE is the authoritative test: under sam-pattern 2.1
      // primes the remaining mutate-then-reject path is a deep/nested write
      // through the shallow-frozen pre-state, which the library reports with
      // step.mutations EMPTY — gating on the mutations list would wave the
      // defect through. (`internal`-key writes stay invisible to snapshot()
      // and to the replayer alike, so they still pass here, as they should.)
      if (JSON.stringify(snapshot()) !== JSON.stringify(entry)) {
        const what = Array.isArray(step.mutations) && step.mutations.length > 0
          ? step.mutations.join(', ')
          : 'deep/nested write through the frozen pre-state';
        throw new Error(`acceptor for '${action}' mutated the observable model (${what}) and then rejected — a rejection must be an observable no-op`);
      }
      return state; // legal, observable no-op
    }
    const modelError = readModelError();
    if (modelError) {
      clearError();
      if (modelError.isRejection) return state; // v1-style gated no-op
      throw new Error(`action raised: ${modelError.message}`);
    }
    return snapshot();
  };

  return { init, next };
}

/**
 * Read the (action, data) exploration domain off instance({}).manifest() —
 * the v2 replacement for buildDomain()'s contract/trace inference: what the
 * spec DECLARES is what gets explored, so an action can never be silently
 * excluded by missing inference. Returns { steps:[{action,data}], notes:[] }
 * (the same shape as buildDomain, so check.mjs consumes either).
 *
 * Domain entries (per the v2 contract): a function is a generator evaluated
 * now; an array is spread as intent arguments — the pipeline's window contract
 * is single-payload, so [] -> {} and [x] -> x, longer arrays are skipped with
 * a note; anything else is the payload itself.
 */
function domainFromManifest(spec) {
  const manifest = spec.instance({}).manifest();
  const intents = (manifest && manifest.intents) || {};
  const intentNames = Object.keys(intents);
  const steps = [];
  const notes = [];
  for (const [action, decl] of Object.entries(intents)) {
    let domain = decl && decl.domain;
    if (typeof domain === 'function') { try { domain = domain(); } catch (e) { notes.push(`domain generator for ${action} threw (${e && e.message}) — skipped`); continue; } }
    if (!Array.isArray(domain) || domain.length === 0) {
      notes.push(`no declared domain for intent ${action} in manifest() — skipped`);
      continue;
    }
    for (let entry of domain) {
      if (typeof entry === 'function') { try { entry = entry(); } catch (e) { notes.push(`domain entry generator for ${action} threw (${e && e.message}) — skipped`); continue; } }
      if (Array.isArray(entry)) {
        if (entry.length === 0) steps.push({ action, data: {} });
        else if (entry.length === 1) steps.push({ action, data: entry[0] });
        else notes.push(`multi-argument domain entry for ${action} (${entry.length} args) is not representable as a single window payload — skipped`);
      } else {
        steps.push({ action, data: entry });
      }
    }
  }
  return { steps, notes, intentNames };
}

module.exports = { isSamV2Module, makeSamAdapter, domainFromManifest };
