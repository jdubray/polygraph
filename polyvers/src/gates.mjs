// polyvers M0 gates — the mechanical checks each lane requires.
//
//   load                — the NEW artifact family is internally coherent
//                         (extracted from the polyrun runtime constructor so
//                         it can run pre-deploy without booting a runtime)
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
// Deterministic, no API key.
'use strict';

import { stable } from '../../scripts/load-spec.mjs';
import samAdapter from '../../scripts/sam-adapter.cjs';
import { observableKeys } from './artifacts.mjs';

const { isSamV2Module } = samAdapter;

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
      const modKeys = Object.keys(mod.getState()).filter((k) => !k.startsWith('__'));
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
  const keys = observableKeys(newA.contract);
  for (const { id, state } of corpus) {
    try {
      mod.init();
      mod.setState(state);
      const raw = JSON.parse(JSON.stringify(mod.getState(), (k, v) =>
        (typeof k === 'string' && k.startsWith('__')) || typeof v === 'function' ? undefined : v));
      const projected = {};
      for (const k of keys ?? Object.keys(raw)) projected[k] = raw[k];
      if (stable(projected) !== stable(state)) {
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
  return done('vocabulary', failures, 'cross-version action/effect/reject-reason vocabulary');
}

// ── invariant-diff ──────────────────────────────────────────────────────────
export function invariantDiffGate(diffs) {
  // Informational gate: it never fails on its own (the pointwise gate does
  // the failing), but a REMOVED invariant is a weakened contract with your
  // own fleet — that deserves a red line in the report, not a footnote.
  const failures = [];
  const d = diffs.intent;
  for (const name of d.removed) {
    failures.push({ message: `invariant '${name}' was removed — weakening intent is a decision that deserves a diff in review; if this is a rename, say so in the version notes` });
  }
  const notes = [];
  if (d.added.length) notes.push(`strengthened: ${d.added.join(', ')}`);
  if (d.edited) notes.push('edited in place (same names, new predicates)');
  return { ...done('invariant-diff', failures, notes.length ? notes.join('; ') : 'no rule changes detected'), added: d.added, removed: d.removed, edited: d.edited };
}

// ── invariants-pointwise ────────────────────────────────────────────────────
export function invariantsPointwiseGate(newA, corpus) {
  const failures = [];
  const preds = newA.invariants ?? [];
  let checks = 0;
  for (const inv of preds) {
    for (const { id, state } of corpus) {
      checks += 1;
      let ok = false;
      try { ok = !!inv.pred(state); } catch { ok = false; }
      if (!ok) failures.push({ id, message: `violates '${inv.name}' — this state exists (or is reachable); decide what it means BEFORE the deploy` });
    }
  }
  return done('invariants-pointwise', failures, `${preds.length} invariant(s) × ${corpus.length} snapshot(s) = ${checks} checks`);
}

function done(gate, failures, summary) {
  return { gate, ok: failures.length === 0, summary, failures };
}
