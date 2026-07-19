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
// The ONE projection: sanitize the module state, keep `keys` (or, with null,
// the raw post-setState keys — polyrun's convention, which keeps module-added
// stray keys visible), never fabricating explicit-undefined entries (stable()
// renders those as a sentinel distinct from an absent key). Exported for the
// matrix's kernel-parity transition walk.
export const projectState = (mod, keys) => {
  const raw = sanitizedState(mod);
  const projected = {};
  for (const k of keys ?? Object.keys(raw)) {
    if (raw[k] !== undefined) projected[k] = raw[k];
  }
  return projected;
};

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
      // Project over the contract's observable keys; without a contract key
      // list, project over the SNAPSHOT's own keys — never over raw's, whose
      // extras could be merge-leaks from a previous iteration (setState is
      // merge-only in the strict profile).
      const projected = projectState(mod, contractKeys ?? Object.keys(state));
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
  // `statesExplored` counts only what exploration DISCOVERED beyond the seeds.
  // Reporting it alone understates coverage badly on exactly the runs this gate
  // exists for: a fleet-seeded check over 12 snapshots that discovers 3 new
  // states read as "3 state(s) discovered", which an operator would reasonably
  // take for a vacuous check. The seeded states ARE the coverage — they are the
  // fleet — so the total is what makes a PASS legible. check.mjs's own renderer
  // has always printed both; this summary dropped one of them.
  const seeded = result.seededStates ?? 0;
  const total = seeded + result.statesExplored;
  const coverage = seeded
    ? `${total} state(s) checked = ${seeded} seeded from the fleet + ${result.statesExplored} discovered from them`
    : `${result.statesExplored} state(s) discovered`;
  const summary = `exhaustive check from ${corpus.length} fleet snapshot(s) + init, ${coverage}${result.capHit ? ' (BOUNDED)' : ''}; one witness per violated rule — not an affected-instance list`;
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
  // Defense in depth: the CLI already refuses an empty corpus before any gate
  // runs, so this is unreachable through `polyvers check`. It matters because
  // migrateGate is exported and called directly (tests, polyvers/src/product),
  // and an empty corpus would otherwise validate vacuously AND hand `[]`
  // downstream — which is truthy at the CLI's `if (result.migratedCorpus)`,
  // so every later gate would report clean over zero snapshots.
  if (!corpus || corpus.length === 0) {
    failures.push({ message: 'corpus is empty — a migration cannot be validated over zero snapshots; refusing to report a migrated corpus' });
    return { ...done('migrate', failures, 'refused: empty corpus'), migratedCorpus: null };
  }
  if (typeof newA.migrate !== 'function') {
    failures.push({ message: 'the shape changed but the new version has no migrate.cjs — a failing round-trip in this lane needs a verified migration; start with `polyvers migrate scaffold`' });
    return { ...done('migrate', failures, 'refused: no migrate.cjs in the new version'), migratedCorpus: null };
  }
  const migrated = [];
  const seen = new Set(); // many-to-one migrations collapse — the corpus contract (one entry per distinct state, FIRST id wins) must survive the swap
  const contractKeys = observableKeys(newA.contract);
  // Two failure kinds live in this gate and they have DIFFERENT consequences
  // for the corpus:
  //
  //   STRUCTURAL — migrate threw, was nondeterministic, or produced a state
  //     the module does not reproduce. The snapshot never reaches `migrated`,
  //     so the corpus is incomplete and nothing downstream may consume it.
  //
  //   INVARIANT — migrate ran cleanly, purely, and round-trips, but the state
  //     it produced violates a rule. The corpus is COMPLETE AND WELL-FORMED;
  //     only the verdict is bad.
  //
  // Conflating them (as this gate did until 2026-07) suppressed every
  // downstream corpus gate whenever a migration was correct-but-unhappy, and
  // told the operator the corpus was "unmigrated old-shape" when it was
  // neither. That is the archetypal fleet case — a narrowed domain whose
  // migration is right and whose fleet still violates the new rule — and it
  // is exactly when the operator most needs the pointwise gate's affected
  // population and the model check's reachability answer.
  let structuralFailure = false;
  for (const { id, state } of corpus) {
    try {
      const frozen = JSON.stringify(state); // one stringify, two fresh parses
      const next = newA.migrate(JSON.parse(frozen));
      // Purity/determinism: the same input twice must give the same output —
      // a clock or random dependence would migrate the fleet irreproducibly.
      const again = newA.migrate(JSON.parse(frozen));
      const nextKey = stable(next);
      if (nextKey !== stable(again)) {
        failures.push({ id, message: 'migrate() is nondeterministic — two applications of the same snapshot differ (clock/random dependence); a migration must be pure' });
        structuralFailure = true;
        continue;
      }
      // The NEW module must accept the migrated snapshot and reproduce it
      // exactly (polyrun migrate phase 1: stray or dropped keys would poison
      // later rehydrations). Without contract keys, project over the RAW
      // post-setState keys (polyrun's convention) so a stray key the module
      // ADDS on rehydration is visible to the comparison.
      newA.module.init();
      newA.module.setState(next);
      const projected = projectState(newA.module, contractKeys);
      if (stable(projected) !== nextKey) {
        failures.push({ id, message: 'migrated state is not the module projection (stray or dropped keys)' });
        structuralFailure = true;
        continue;
      }
      // New state invariants hold on the migrated state (pointwise here; the
      // seeded model check downstream covers what it can be DRIVEN to).
      for (const inv of newA.invariants ?? []) {
        let ok = false;
        try { ok = !!inv.pred(next); } catch { ok = false; }
        if (!ok) failures.push({ id, message: `migrated state violates '${inv.name}'` });
      }
      // The migration IS a transition — the one every live instance takes at
      // deploy — and the intent artifact's transition invariants apply to it
      // like any other. A migration the rules forbid must fail here, not slip
      // through because only machine actions were ever checked. (If the
      // migration legitimately breaks an old rule, the rule moves first —
      // VERSIONING doctrine — and the diff shows it.)
      for (const inv of newA.transitionInvariants ?? []) {
        let ok = false;
        try { ok = !!inv.pred(state, '$migrate', {}, next); } catch { ok = false; }
        if (!ok) failures.push({ id, message: `the migration transition violates '${inv.name}' — the fleet-wide $migrate step would perform precisely the transition the intent forbids` });
      }
      if (!seen.has(nextKey)) {
        seen.add(nextKey);
        migrated.push({ id, state: next, key: nextKey, source: 'migrated' });
      }
    } catch (err) {
      failures.push({ id, message: `migrate() threw: ${err && err.message}` });
      structuralFailure = true;
    }
  }
  const okAll = failures.length === 0;
  const summary = okAll
    ? `migrate.cjs validated over ${corpus.length} snapshot(s) (pure, accepted, projection-equal, state+transition invariants hold) — against this corpus tier; polyrun migrate's live dry run remains the apply-time gate`
    : structuralFailure
      ? `migrate.cjs FAILED STRUCTURALLY over ${corpus.length} snapshot(s) — it threw, was nondeterministic, or produced states the module does not reproduce; the corpus cannot be migrated and downstream corpus gates are refused`
      : `migrate.cjs is well-formed over all ${corpus.length} snapshot(s) (pure, accepted, projection-equal) but the states it produces VIOLATE the new version's rules — the migration is not the defect; downstream gates run over the migrated corpus to size the affected population`;
  return {
    ...done('migrate', failures, summary),
    // A STRUCTURALLY sound migration may redefine what downstream gates see
    // even when its output violates a rule: those gates then measure the real
    // post-migration fleet, which is the answer the operator needs. Only a
    // structural failure withholds the corpus — a partial swap would gate the
    // deploy on a corpus mixing old and new shapes.
    migratedCorpus: structuralFailure ? null : migrated,
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
// One delivery, classified — the kernel's dispatch ladder as a reusable
// verdict: { ok, cls?, why? }. Used by the stimuli gate (old-version stimuli
// into the new machine) and the cross-machine matrix (child completions into
// the parent, parent cancels into the child). `cls` is a stable failure class
// for per-(action, class) dedup.
export function stimulusOutcome(mod, state, action, data) {
  const handler = mod.actions[action];
  if (typeof handler !== 'function') {
    return { ok: false, cls: 'unhandled-surface', why: `is not in the machine's action surface — delivery would journal as unhandled` };
  }
  try {
    mod.init();
    mod.setState(state);
    try {
      handler(data);
    } catch (err) {
      if (err && err.name === 'SamSchemaError') return { ok: true }; // observable reject of a schema-invalid payload — verified behavior (kernel parity)
      return { ok: false, cls: 'throw', why: `makes the machine THROW (${err && err.message}) — in production this poisons the instance` };
    }
    // Classification parity note: like the kernel, we read lastStep() after a
    // synchronous handler call — polyrun machines are synchronous by
    // construction (FR-2.6), and an async module would mislead the kernel
    // identically, so parity is the honest contract.
    const step = mod.instance({}).lastStep();
    if (!step || (step.intent !== undefined && step.intent !== null && step.intent !== action)) {
      return { ok: false, cls: 'unclassifiable', why: `is not classified by lastStep() — the kernel would poison the instance rather than guess` };
    }
    if (step.classification === 'unhandled') {
      return { ok: false, cls: 'unhandled', why: `is UNHANDLED in this state — neither accepted nor an observable reject; delivery becomes undefined behavior` };
    }
    if (step.classification === 'rejected') {
      // A reject can be defective in TWO independent ways — report both in
      // one verdict, so fixing one does not hide the other for a review
      // cycle (mutate-then-reject poisons in production, kernel FR-2.5; an
      // unnamed reject journals unexplained).
      const problems = [];
      const projected = projectState(mod, Object.keys(state));
      if (stable(projected) !== stable(state)) {
        problems.push('mutates the observable model and then rejects — in production the kernel poisons the instance for exactly this');
      }
      const reason = step.rejections && step.rejections[0] && step.rejections[0].reason;
      if (!reason) {
        problems.push('is rejected WITHOUT a reason — the journal entry would be unexplained; name the rule (contract specialRules)');
      }
      if (problems.length) {
        return { ok: false, cls: problems.length === 2 ? 'mutate-then-reject+unnamed' : (reason ? 'mutate-then-reject' : 'unnamed-reject'), why: problems.join('; AND ') };
      }
    }
    return { ok: true }; // mutated / identity-by-mutation / named reject = verified behavior
  } catch (err) {
    return { ok: false, cls: 'setup', why: `could not be delivered at this snapshot: ${err && err.message}` };
  }
}

export function stimuliGate(oldA, newA, corpus) {
  const failures = [];
  // The stimulus set is the FULL declared domain — a deliberate conservative
  // SUPERSET of what could actually be in flight: the strict profile makes
  // every not-applicable delivery an observable reject, so the superset can
  // only fail on genuine undefined behavior, never on doctrine-compliant
  // rejection.
  if (typeof oldA.module.instance({}).manifest !== 'function') {
    failures.push({ message: "the old module's instance accessor exposes no manifest() — the old-version stimulus set cannot be read (module predates the SAM structural registry); the gate refuses rather than replaying nothing" });
    return done('stimuli', failures, 'refused: old-version stimulus set unreadable');
  }
  const { steps, notes } = domainFromManifest(oldA.module);
  if (!steps.length) {
    failures.push({ message: "the old module's manifest() yields no (action, data) stimuli — nothing to replay would pass vacuously; refusing" });
    return done('stimuli', failures, 'refused: empty old-version stimulus set');
  }
  const mod = newA.module;
  const seenFailure = new Set(); // one witness per (action, failure class)
  // Messages are built lazily: record() discards duplicates, so the string
  // (with its JSON.stringify of the payload) is only assembled on first sight.
  const record = (action, cls, id, message) => {
    const k = `${action}:${cls}`;
    if (seenFailure.has(k)) return;
    seenFailure.add(k);
    failures.push({ id, message: message() });
  };
  // Action-surface misses cannot vary by state — settle them in ONE pass over
  // the stimulus set, then deliver only the deliverable.
  const deliverable = [];
  for (const s of steps) {
    if (typeof mod.actions[s.action] !== 'function') {
      record(s.action, 'unhandled-surface', corpus[0]?.id, () => `old-version stimulus '${s.action}' is not in the new machine's action surface — in-flight timers/completions delivering it would journal as unhandled (every state is affected)`);
    } else {
      deliverable.push(s);
    }
  }
  let fired = 0;
  for (const { id, state } of corpus) {
    for (const { action, data } of deliverable) {
      fired += 1;
      const verdict = stimulusOutcome(mod, state, action, data);
      if (!verdict.ok) {
        record(action, verdict.cls, id, () => `old-version stimulus '${action}(${JSON.stringify(data)})' ${verdict.why}`);
      }
    }
  }
  const exclusions = (notes ?? []).length;
  return done('stimuli', failures, `${steps.length} old-version stimulus(es) (full declared domain — a conservative superset of in-flight stimuli) × ${corpus.length} snapshot(s) = ${fired} deliveries; every outcome must be accepted or a NAMED observable reject${exclusions ? `; ${exclusions} intent(s) excluded by the domain builder: ${notes.join('; ')}` : ''}`);
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
