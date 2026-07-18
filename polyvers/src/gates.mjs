// polyvers M0 gates — the mechanical checks each lane requires.
//
//   load                — the NEW artifact family is internally coherent
//                         (the polyrun runtime constructor's registration
//                         checks, runnable pre-deploy without booting a
//                         runtime)
//   shape-roundtrip     — the NEW module accepts every corpus snapshot and
//                         reproduces it exactly (the FR-6.2 [2/3] check,
//                         corpus-driven)
//   vocabulary          — cross-VERSION vocabulary safety: nothing the old
//                         version could still deliver becomes undefined
//   invariant-diff      — what changed in the rules themselves
//   invariants-pointwise— the NEW invariants hold on every corpus snapshot
//                         (the FR-6.2 [3/3] check, corpus-driven; a
//                         strengthened rule names the states it condemns)
//
// Every gate returns { gate, ok, summary, failures: [{id?, message}] } and
// throws only on caller error (bad inputs), never on a finding.
//
// The GATE_RUNNERS registry at the bottom is the ONE dispatch surface: a
// gate name demanded by classify's LANES table that has no runner here is a
// hard, visible failure — never a silent PASS.
//
// Deterministic, no API key.
'use strict';

import { stable } from '../../scripts/load-spec.mjs';
import samAdapter from '../../scripts/sam-adapter.cjs';
import { check } from '../../scripts/check.mjs';
import { observableKeys, invariantsOf } from './artifacts.mjs';

const { isSamV2Module, domainFromManifest } = samAdapter;

// The kernel's snapshot semantics (polyrun/src/kernel.mjs sanitizeReplacer):
// drop dunder keys AND function values. Both loadGate's key comparison and
// shapeRoundtripGate's projection MUST use this exact rule, or polyvers'
// pre-deploy verdict diverges from what `polyrun deploy` does with the same
// module.
const sanitizeReplacer = (k, v) =>
  (typeof k === 'string' && k.startsWith('__')) || typeof v === 'function' ? undefined : v;
const sanitizedState = (mod) => JSON.parse(JSON.stringify(mod.getState(), sanitizeReplacer));

// ── load ────────────────────────────────────────────────────────────────────
export function loadGate(newA) {
  const failures = [];
  const mod = newA.module;
  if (!isSamV2Module(mod)) {
    failures.push({ message: 'module does not export the v2 SAM surface { instance, init, actions, getState, setState }' });
    return done('load', failures, 'module surface');
  }
  // The library's own obligation check — strict modules throw, lenient ones
  // return a problems array; both must fail loudly (cf. check.mjs).
  try {
    const accessor = mod.instance({});
    if (typeof accessor.validate === 'function') {
      const problems = accessor.validate();
      if (Array.isArray(problems) && problems.length) {
        failures.push({ message: `module fails validate(): ${problems.join('; ')}` });
      }
    }
  } catch (err) {
    failures.push({ message: `module fails validate(): ${err && err.message}` });
  }

  // Contract stateKeys and module state must coincide (kernel registerMachine
  // check): a module key outside the contract is silent state loss on every
  // rehydration; a contract key the module lacks can never be populated.
  const keys = observableKeys(newA.contract);
  if (keys) {
    try {
      mod.init();
      const modKeys = Object.keys(sanitizedState(mod));
      const extra = modKeys.filter((k) => !keys.includes(k));
      const missing = keys.filter((k) => !modKeys.includes(k));
      if (extra.length) failures.push({ message: `module state keys not in contract: ${extra.join(', ')}` });
      if (missing.length) failures.push({ message: `contract stateKeys not in module state: ${missing.join(', ')}` });
    } catch (err) {
      failures.push({ message: `init()/getState() threw: ${err && err.message}` });
    }
  }

  // Contract actions must exist on the module, and manifest completion wiring
  // must target real actions (kernel _crossCheckManifest).
  const actionNames = new Set(Object.keys(mod.actions ?? {}));
  for (const a of Object.keys(newA.contract.actions ?? {})) {
    if (!actionNames.has(a)) failures.push({ message: `contract action '${a}' is not exported by the module` });
  }
  if (newA.manifest) {
    for (const [kind, decl] of Object.entries(newA.manifest.effects ?? {})) {
      for (const hook of ['onSuccess', 'onFailure', 'onExhausted']) {
        const target = decl[hook]?.action;
        if (target && !actionNames.has(target)) {
          failures.push({ message: `manifest effect '${kind}' ${hook} action '${target}' is not in the module's action surface` });
        }
      }
    }
  }
  return done('load', failures, 'module surface, validate(), contract/manifest cross-checks');
}

// ── shape-roundtrip ─────────────────────────────────────────────────────────
export function shapeRoundtripGate(newA, corpus) {
  const failures = [];
  const mod = newA.module;
  const contractKeys = observableKeys(newA.contract);
  for (const { id, state, key } of corpus) {
    try {
      mod.init();
      mod.setState(state);
      const raw = sanitizedState(mod);
      // Project over the contract's observable keys; without a contract key
      // list, project over the SNAPSHOT's own keys — never over raw's, whose
      // extras could be merge-leaks from a previous iteration (setState is
      // merge-only in the strict profile).
      const projected = {};
      for (const k of contractKeys ?? Object.keys(state)) {
        // Never fabricate an explicit-undefined entry for a key absent from
        // raw — stable() renders it as a sentinel distinct from an absent
        // key, which would fail a snapshot the module reproduced exactly.
        if (raw[k] !== undefined) projected[k] = raw[k];
      }
      // Corpus entries always carry their stable() key (the corpus contract;
      // both producers set it) — no silent recompute fallback.
      if (stable(projected) !== key) {
        failures.push({ id, message: 'the new module does not reproduce this snapshot (its projection differs — a shape change without a migration)' });
      }
    } catch (err) {
      failures.push({ id, message: `the new module rejects this snapshot: ${err && err.message}` });
    }
  }
  return done('shape-roundtrip', failures, `setState round-trip over ${corpus.length} snapshot(s)`);
}

// ── vocabulary ──────────────────────────────────────────────────────────────
export function vocabularyGate(oldA, newA, diffs) {
  const failures = [];
  const v = diffs.vocabulary;
  // Deprecate, don't delete (SDLC best-practice #5): while any instance,
  // timer, or outbox completion from the old version can still arrive, a
  // removed action is undefined behavior, not a refactor. Additions are safe.
  for (const a of v.actions.removed) {
    failures.push({ message: `action '${a}' was removed — in-flight stimuli from the old version can still deliver it; deprecate (keep it as an observable reject) for one release, then remove once the fleet and outbox have drained` });
  }
  // Old manifest wiring must still land on the new module's action surface:
  // completions for effects REQUESTED under the old version arrive under the
  // new one.
  const newActions = new Set(Object.keys(newA.module.actions ?? {}));
  for (const [kind, decl] of Object.entries(oldA.manifest?.effects ?? {})) {
    for (const hook of ['onSuccess', 'onFailure', 'onExhausted']) {
      const target = decl[hook]?.action;
      if (target && !newActions.has(target)) {
        failures.push({ message: `old-version effect '${kind}' ${hook} completes into '${target}', which the new module no longer exports — outstanding intents would poison on completion` });
      }
    }
  }
  // Reject-reason renames are reported as failures too — they are public API
  // (journals, logs, client responses), so a rename must be deliberate.
  for (const r of v.rejectReasons.removed) {
    failures.push({ message: `specialRule '${r}' was removed/renamed — reject reasons are public API (they surface in journals and client responses); treat this as a vocabulary break, not a refactor` });
  }
  // Terminal vocabulary: removing a terminal state re-animates every
  // instance resting in it (dispatchable again, timers no longer cancelled);
  // changing the terminal key redefines terminality for the whole fleet.
  if (v.terminal.keyChanged) {
    failures.push({ message: 'the effective terminal key changed (explicit terminalKey, or the first stateKey by convention) — terminality of every live instance is redefined; this needs a deliberate migration story, not a deploy' });
  }
  for (const s of v.terminal.removed) {
    failures.push({ message: `terminal state '${s}' is no longer terminal — instances resting in it become dispatchable again and their timers stop being cancelled at rest; if intentional, say so in the version notes` });
  }
  return done('vocabulary', failures, 'cross-version action/effect/reject-reason/terminal vocabulary');
}

// ── invariant-diff ──────────────────────────────────────────────────────────
export function invariantDiffGate(diffs) {
  // Mostly informational (the pointwise gate does the failing), but a REMOVED
  // invariant is a weakened contract with your own fleet — that deserves a
  // red line in the report, not a footnote. A pure rename (identical
  // predicate source) is NOT a removal; classify detects those separately.
  const failures = [];
  const d = diffs.intent;
  for (const name of d.removed) {
    failures.push({ message: `invariant '${name}' was removed — weakening intent is a decision that deserves a diff in review; if this is a rename with an edited predicate, record it in the version notes` });
  }
  const notes = [];
  if (d.added.length) notes.push(`strengthened: ${d.added.join(', ')}`);
  if (d.renamed.length) notes.push(`renamed (identical predicate): ${d.renamed.map((r) => `${r.from} → ${r.to}`).join(', ')}`);
  if (d.edited) notes.push('edited in place (same names, new predicates)');
  return done('invariant-diff', failures, notes.length ? notes.join('; ') : 'no rule changes detected');
}

// ── invariants-pointwise ────────────────────────────────────────────────────
export function invariantsPointwiseGate(newA, corpus) {
  const failures = [];
  const preds = newA.invariants ?? [];
  // Same vacuity doctrine as the semantic gate: a version with no stated
  // intent at all cannot pass an intent gate on zero checks.
  if (preds.length === 0 && (newA.transitionInvariants ?? []).length === 0) {
    failures.push({ message: 'the new version declares no invariants (no invariants.mjs) — 0 checks over the fleet certifies nothing; state the intent before gating on it' });
    return done('invariants-pointwise', failures, 'refused: no invariants to check');
  }
  let checks = 0;
  for (const inv of preds) {
    for (const { id, state } of corpus) {
      checks += 1;
      let ok = false;
      try { ok = !!inv.pred(state); } catch { ok = false; }
      if (!ok) failures.push({ id, message: `violates '${inv.name}' — this state exists (or is reachable); decide what it means BEFORE the deploy` });
    }
  }
  const transitionCount = (newA.transitionInvariants ?? []).length;
  const summary = `${preds.length} state invariant(s) × ${corpus.length} snapshot(s) = ${checks} checks`
    + (transitionCount ? ` (${transitionCount} transition invariant(s) need transitions, not snapshots — checked by the M1 model-check gate)` : '');
  return done('invariants-pointwise', failures, summary);
}

// ── semantic-model-check (M1) ───────────────────────────────────────────────
// The essay's compatibility definition, executable: v(n+1) is semantically
// compatible with the fleet iff no corpus snapshot can be driven to an
// invariant violation under the NEW machine's rules. One shared checker
// (scripts/check.mjs) runs the exhaustive BFS with the corpus states seeded
// as initial states alongside init() — the v1-reachable/v3-unreachable
// landmine is exactly what the seeds find and the from-init check cannot.
export function semanticModelCheckGate(newA, corpus, { maxStates = 100000, allowBounded = false } = {}) {
  const failures = [];
  const invariants = invariantsOf(newA);
  // A version with no invariants at all must not receive a green "exhaustive
  // check" — the doctrine is uniform: empty corpus refused, present-but-empty
  // invariants.mjs refused at load, and a MISSING invariants file refused
  // here. There is nothing to certify without stated intent.
  if (invariants.stateInvariants.length === 0 && invariants.transitionInvariants.length === 0) {
    failures.push({ message: 'the new version declares no invariants (no invariants.mjs) — an exhaustive check over zero rules certifies vacuous truth; state the intent before gating on it' });
    return done('semantic-model-check', failures, 'refused: no invariants to check');
  }
  const result = check({
    specModule: newA.module,
    contract: newA.contract,
    invariants,
    maxStates,
    initialStates: corpus.map((e) => e.state),
  });
  if (result.error) {
    failures.push({ message: `model check could not run: ${result.error}` });
    return done('semantic-model-check', failures, 'exhaustive check from fleet snapshots as initial states');
  }
  // Corpus entries always carry their stable() key (the corpus contract) —
  // built lazily: violations are few and a clean run needs no map at all.
  const idByKey = result.violations.length ? new Map(corpus.map((e) => [e.key, e.id])) : null;
  for (const v of result.violations) {
    if (v.path.length === 0) {
      // A finding with no counterexample path (e.g. the nondeterminism
      // verdict) must not be dressed up as a root-state violation.
      failures.push({ message: `'${v.invariant}' [${v.kind}] — ${v.detail}` });
      continue;
    }
    const root = v.path[0];
    // Attribute by corpus membership, not just origin: a fleet snapshot that
    // happens to equal init() dedupes to origin 'init' in the checker, but
    // the operator still deserves the snapshot id.
    const snapshotId = idByKey.get(stable(root.state));
    const from = snapshotId ? `snapshot ${snapshotId}` : 'init';
    // action(data) per step, matching check.mjs render(): the data is
    // load-bearing — the same action with different data can be the only
    // trigger, and a data-less repro reads as a flake.
    const steps = v.path.filter((s) => s.action !== null).map((s) => `${s.action}(${JSON.stringify(s.data ?? {})})`);
    failures.push({
      id: snapshotId ?? 'init',
      message: `'${v.invariant}' [${v.kind}] — ${v.detail}; shortest counterexample from ${from}: ${steps.length ? steps.join(' → ') : '(violated at the root state)'}`,
    });
  }
  // BOUNDED is not a pass (check-effects doctrine): "0 violations over almost
  // nothing" must not gate a deploy unless the operator explicitly accepts it.
  if (result.capHit && !allowBounded) {
    failures.push({ message: `exploration BOUNDED at ${result.statesExplored} discovered states — a clean result over a truncated space is not a pass; raise --max-states or accept explicitly with --allow-bounded` });
  }
  // One witness per invariant (the checker dedupes by rule): a FAIL is a
  // compatibility verdict, not the affected-instance list.
  const summary = `exhaustive check from ${corpus.length} fleet snapshot(s) + init, ${result.statesExplored} state(s) discovered${result.capHit ? ' (BOUNDED)' : ''}; one witness per violated rule — not an affected-instance list`;
  return done('semantic-model-check', failures, summary);
}

// ── migrate (M2) ────────────────────────────────────────────────────────────
// polyrun's migrate validate phase, corpus-driven and composed with the rest
// of the pipeline: the gate validates the NEW version's migrate.cjs over
// every corpus snapshot and returns the MIGRATED corpus, which the CLI then
// feeds to every downstream corpus gate — round-trip, pointwise, and the
// seeded model check all run over the states the fleet will actually hold
// after the migration applies. Apply remains `polyrun migrate --apply`.
export function migrateGate(newA, corpus) {
  const failures = [];
  if (typeof newA.migrate !== 'function') {
    failures.push({ message: 'the shape changed but the new version has no migrate.cjs — a failing round-trip in this lane needs a verified migration; start with `polyvers migrate scaffold`' });
    return { ...done('migrate', failures, 'refused: no migrate.cjs in the new version'), migratedCorpus: null };
  }
  const migrated = [];
  const contractKeys = observableKeys(newA.contract);
  for (const { id, state } of corpus) {
    try {
      const next = newA.migrate(JSON.parse(JSON.stringify(state)));
      // Purity/determinism: the same input twice must give the same output —
      // a clock or random dependence would migrate the fleet irreproducibly.
      const again = newA.migrate(JSON.parse(JSON.stringify(state)));
      if (stable(next) !== stable(again)) {
        failures.push({ id, message: 'migrate() is nondeterministic — two applications of the same snapshot differ (clock/random dependence); a migration must be pure' });
        continue;
      }
      // The NEW module must accept the migrated snapshot and reproduce it
      // exactly (polyrun migrate phase 1: stray or dropped keys would poison
      // later rehydrations).
      newA.module.init();
      newA.module.setState(next);
      const raw = sanitizedState(newA.module);
      const projected = {};
      for (const k of contractKeys ?? Object.keys(next)) {
        if (raw[k] !== undefined) projected[k] = raw[k];
      }
      if (stable(projected) !== stable(next)) {
        failures.push({ id, message: 'migrated state is not the module projection (stray or dropped keys)' });
        continue;
      }
      // New state invariants hold on the migrated state (pointwise here; the
      // seeded model check downstream covers what it can be DRIVEN to).
      for (const inv of newA.invariants ?? []) {
        let ok = false;
        try { ok = !!inv.pred(next); } catch { ok = false; }
        if (!ok) failures.push({ id, message: `migrated state violates '${inv.name}'` });
      }
      migrated.push({ id, state: next, key: stable(next), source: `${corpus[0]?.source ?? 'archive'}+migrated` });
    } catch (err) {
      failures.push({ id, message: `migrate() threw: ${err && err.message}` });
    }
  }
  const okAll = failures.length === 0;
  return {
    ...done('migrate', failures, `migrate.cjs validated over ${corpus.length} snapshot(s) (pure, accepted, projection-equal, invariants hold)`),
    // Only a fully-validated migration may redefine what downstream gates
    // see — a partial swap would gate the deploy on a corpus mixing old and
    // new shapes.
    migratedCorpus: okAll ? migrated : null,
  };
}

// ── stimuli (M2) ────────────────────────────────────────────────────────────
// The behavioral gate: cross-version delivery, checked. Every (action, data)
// stimulus the OLD version could still deliver (its own manifest-declared
// domain — timers, completions, callers built against the old vocabulary) is
// fired at the NEW machine in every corpus state, and every outcome must be
// verified behavior: accepted, or an observable reject WITH a named reason.
// 'unhandled' and a throw are exactly the undefined-behavior classes the
// VERSIONING essay calls cross-version delivery's failure mode; an unnamed
// reject would journal as unexplained. Classification mirrors the polyrun
// kernel's dispatch (lastStep(), SamSchemaError→reject, mutate-then-reject
// would throw) so the gate predicts what production would journal.
export function stimuliGate(oldA, newA, corpus) {
  const failures = [];
  const seenFailure = new Set(); // one witness per (action, failure class)
  const { steps } = domainFromManifest(oldA.module);
  if (!steps.length) {
    failures.push({ message: "the old module's manifest() yields no (action, data) stimuli — nothing to replay would pass vacuously; refusing" });
    return done('stimuli', failures, 'refused: empty old-version stimulus set');
  }
  const mod = newA.module;
  let fired = 0;
  const record = (action, cls, id, message) => {
    const k = `${action}:${cls}`;
    if (seenFailure.has(k)) return;
    seenFailure.add(k);
    failures.push({ id, message });
  };
  for (const { id, state } of corpus) {
    for (const { action, data } of steps) {
      fired += 1;
      const handler = mod.actions[action];
      if (typeof handler !== 'function') {
        record(action, 'unhandled-surface', id, `old-version stimulus '${action}' is not in the new machine's action surface — in-flight timers/completions delivering it would journal as unhandled (first witness: this snapshot; every state is affected)`);
        continue;
      }
      try {
        mod.init();
        mod.setState(state);
        try {
          handler(data);
        } catch (err) {
          if (err && err.name === 'SamSchemaError') continue; // observable reject of a schema-invalid payload — verified behavior
          record(action, 'throw', id, `old-version stimulus '${action}(${JSON.stringify(data)})' makes the new machine THROW (${err && err.message}) — in production this poisons the instance`);
          continue;
        }
        const step = mod.instance({}).lastStep();
        if (!step || (step.intent !== undefined && step.intent !== null && step.intent !== action)) {
          record(action, 'unclassifiable', id, `lastStep() did not classify '${action}' — the kernel would poison the instance rather than guess`);
        } else if (step.classification === 'unhandled') {
          record(action, 'unhandled', id, `old-version stimulus '${action}(${JSON.stringify(data)})' is UNHANDLED in this state — neither accepted nor an observable reject; cross-version delivery becomes undefined behavior`);
        } else if (step.classification === 'rejected') {
          const reason = step.rejections && step.rejections[0] && step.rejections[0].reason;
          if (!reason) record(action, 'unnamed-reject', id, `old-version stimulus '${action}(${JSON.stringify(data)})' is rejected WITHOUT a reason — the journal entry would be unexplained; name the rule (contract specialRules)`);
        } // mutated / identity-by-mutation = accepted — verified behavior
      } catch (err) {
        record(action, 'setup', id, `could not deliver '${action}' at this snapshot: ${err && err.message}`);
      }
    }
  }
  return done('stimuli', failures, `${steps.length} old-version stimulus(es) × ${corpus.length} snapshot(s) = ${fired} deliveries; every outcome must be accepted or a NAMED observable reject`);
}

function done(gate, failures, summary) {
  return { gate, ok: failures.length === 0, summary, failures };
}

// ── registry ────────────────────────────────────────────────────────────────
// The single dispatch surface. Every gate name classify's LANES table can
// demand MUST have a runner here; the CLI iterates classification.gates over
// this map and reports a missing runner as a failing gate result — a wanted
// gate can never silently not run.
export const NEEDS_CORPUS = new Set(['shape-roundtrip', 'invariants-pointwise', 'semantic-model-check', 'migrate', 'stimuli']);

export const GATE_RUNNERS = {
  'load': ({ newA }) => loadGate(newA),
  // migrate runs FIRST among corpus gates (the CLI orders it so): when it
  // fully validates, its migratedCorpus replaces the corpus every downstream
  // gate sees — post-migration fleet states are what production will hold.
  'migrate': ({ newA, corpus }) => migrateGate(newA, corpus),
  'shape-roundtrip': ({ newA, corpus }) => shapeRoundtripGate(newA, corpus),
  'vocabulary': ({ oldA, newA, diffs }) => vocabularyGate(oldA, newA, diffs),
  'stimuli': ({ oldA, newA, corpus }) => stimuliGate(oldA, newA, corpus),
  'invariant-diff': ({ diffs }) => invariantDiffGate(diffs),
  'invariants-pointwise': ({ newA, corpus }) => invariantsPointwiseGate(newA, corpus),
  'semantic-model-check': ({ newA, corpus, opts }) => semanticModelCheckGate(newA, corpus, opts),
};
