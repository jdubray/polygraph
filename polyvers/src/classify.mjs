// polyvers classifier — the VERSIONING.md decision table as data.
//
// Given two loaded artifact families (old, new), diff each artifact and
// classify the change into lanes: shape, vocabulary, intent, semantic.
// Lanes fire independently and the required gate set is their union — a
// shape change usually drags a vocabulary change, and any code edit is at
// least a semantic change.
//
// Deterministic, no API key.
'use strict';

import { createHash } from 'node:crypto';
import { stable } from '../../scripts/load-spec.mjs';
import { terminalKeyOf } from './artifacts.mjs';

// The decision table (docs/VERSIONING.md §"A practical decision table"),
// encoded. `gates` names checks in gates.mjs; entries marked deferred are
// reported honestly as NOT RUN until their milestone lands.
export const LANES = {
  semantic: {
    description: 'same shape, same vocabulary, new transition rules',
    gates: ['load', 'shape-roundtrip', 'invariants-pointwise', 'semantic-model-check'],
    deferred: [],
  },
  shape: {
    description: 'the sealed state shape changed',
    gates: ['load', 'shape-roundtrip'],
    deferred: [{ gate: 'migrate', milestone: 'M2', why: 'a failing round-trip in this lane needs a verified migrate.cjs' }],
  },
  vocabulary: {
    description: 'the action / reject-reason / effect / terminal vocabulary changed',
    gates: ['load', 'vocabulary'],
    deferred: [{ gate: 'stimuli', milestone: 'M2', why: 'in-flight timers/completions from the old vocabulary replayed against the new machine' }],
  },
  intent: {
    description: 'the invariants themselves changed',
    gates: ['load', 'invariant-diff', 'invariants-pointwise', 'semantic-model-check'],
    deferred: [],
  },
};

const keyTypeMap = (contract) =>
  new Map((contract.stateKeys ?? []).map((k) => [k.name, String(k.type ?? '')]));

const setDiff = (a, b) => [...a].filter((x) => !b.has(x));
// Key-order-insensitive equality — a reformatted contract.json must never
// read as a vocabulary change (stable() is THE canonical comparator).
const sameJson = (a, b) => stable(a ?? null) === stable(b ?? null);

function diffShape(oldA, newA) {
  const oldKeys = keyTypeMap(oldA.contract);
  const newKeys = keyTypeMap(newA.contract);
  const added = setDiff(new Set(newKeys.keys()), new Set(oldKeys.keys()));
  const removed = setDiff(new Set(oldKeys.keys()), new Set(newKeys.keys()));
  const retyped = [...oldKeys.keys()].filter((k) => newKeys.has(k) && newKeys.get(k) !== oldKeys.get(k));
  const changed = added.length || removed.length || retyped.length;
  return { changed: !!changed, added, removed, retyped };
}

function diffVocabulary(oldA, newA) {
  const oldActions = new Set(Object.keys(oldA.contract.actions ?? {}));
  const newActions = new Set(Object.keys(newA.contract.actions ?? {}));
  const added = setDiff(newActions, oldActions);
  const removed = setDiff(oldActions, newActions);

  // dataFields / dataDomain changes on surviving actions are vocabulary
  // changes too — callers build dispatches from them.
  const fieldsChanged = [...oldActions].filter((a) => newActions.has(a)
    && !sameJson(oldA.contract.actions[a] ?? {}, newA.contract.actions[a] ?? {}));
  const domainChanged = !sameJson(oldA.contract.dataDomain ?? {}, newA.contract.dataDomain ?? {});

  // Reject-reason vocabulary: specialRules names are public API (SDLC
  // best-practice #4) — they surface in journals, logs, and client responses.
  const ruleNames = (c) => new Set((c.specialRules ?? []).map((r) => r.name).filter(Boolean));
  const oldRules = ruleNames(oldA.contract);
  const newRules = ruleNames(newA.contract);
  const rulesAdded = setDiff(newRules, oldRules);
  const rulesRemoved = setDiff(oldRules, newRules);

  // Terminal vocabulary: the runtime derives instance terminality from
  // contract.terminalStates + the effective terminal key (explicit
  // terminalKey, else the FIRST stateKey — so even a stateKeys reorder can
  // flip terminality). A change here alters lifecycle behavior for every
  // live instance and must fire a lane, never slip through unclassified.
  const oldTerm = new Set(oldA.contract.terminalStates ?? []);
  const newTerm = new Set(newA.contract.terminalStates ?? []);
  const terminal = {
    keyChanged: terminalKeyOf(oldA.contract) !== terminalKeyOf(newA.contract),
    added: setDiff(newTerm, oldTerm),
    removed: setDiff(oldTerm, newTerm),
  };
  terminal.changed = terminal.keyChanged || terminal.added.length > 0 || terminal.removed.length > 0;

  // Effect vocabulary: manifest kinds and their completion wiring.
  const kinds = (m) => new Set(Object.keys(m?.effects ?? {}));
  const oldKinds = kinds(oldA.manifest);
  const newKinds = kinds(newA.manifest);
  const kindsAdded = setDiff(newKinds, oldKinds);
  const kindsRemoved = setDiff(oldKinds, newKinds);
  const wiringChanged = [...oldKinds].filter((k) => newKinds.has(k)
    && !sameJson(oldA.manifest.effects[k], newA.manifest.effects[k]));

  // A removed+added pair is possibly a rename — flag it, a human confirms.
  const possibleRenames = removed.length && added.length
    ? removed.map((r) => ({ removed: r, addedCandidates: added })) : [];

  const changed = added.length || removed.length || fieldsChanged.length || domainChanged
    || rulesAdded.length || rulesRemoved.length || terminal.changed
    || kindsAdded.length || kindsRemoved.length || wiringChanged.length;
  return {
    changed: !!changed,
    actions: { added, removed, fieldsChanged, domainChanged, possibleRenames },
    rejectReasons: { added: rulesAdded, removed: rulesRemoved },
    terminal,
    effects: { kindsAdded, kindsRemoved, wiringChanged },
  };
}

function diffIntent(oldA, newA) {
  // State AND transition invariants both carry intent; either changing is an
  // intent change (deleting a transition invariant must never classify as a
  // mere 'edit').
  const collect = (a) => new Map([
    ...(a.invariants ?? []).map((i) => [`state:${i.name}`, i]),
    ...(a.transitionInvariants ?? []).map((i) => [`transition:${i.name}`, i]),
  ]);
  const oldInv = collect(oldA);
  const newInv = collect(newA);
  let added = setDiff(new Set(newInv.keys()), new Set(oldInv.keys()));
  let removed = setDiff(new Set(oldInv.keys()), new Set(newInv.keys()));
  // Rename detection: a removed+added pair with an IDENTICAL predicate source
  // is a rename, not a weakening — report it as such instead of failing the
  // gate on a rule that still exists under a new name.
  const renamed = [];
  for (const r of [...removed]) {
    const rSrc = String(oldInv.get(r).pred);
    const match = added.find((a) => String(newInv.get(a).pred) === rSrc);
    if (match) {
      renamed.push({ from: r, to: match });
      removed = removed.filter((x) => x !== r);
      added = added.filter((x) => x !== match);
    }
  }
  const sourceChanged = (oldA.invariantsHash ?? '') !== (newA.invariantsHash ?? '');
  // Same names + changed source = a rule was rewritten in place; without
  // evaluating semantics we can only say WHICH direction at the gate (a
  // pointwise pass/fail over the corpus), so classification reports it as
  // 'edited'.
  const edited = sourceChanged && !added.length && !removed.length && !renamed.length;
  return { changed: sourceChanged, added, removed, renamed, edited };
}

/**
 * classify(oldArtifacts, newArtifacts) →
 *   { changeId, oldVersion, newVersion, lanes, diffs, gates, deferred }
 */
export function classify(oldA, newA) {
  const diffs = {
    shape: diffShape(oldA, newA),
    vocabulary: diffVocabulary(oldA, newA),
    intent: diffIntent(oldA, newA),
    moduleChanged: oldA.moduleHash !== newA.moduleHash,
  };

  const lanes = [];
  if (diffs.shape.changed) lanes.push('shape');
  if (diffs.vocabulary.changed) lanes.push('vocabulary');
  if (diffs.intent.changed) lanes.push('intent');
  // Any module edit is at least a semantic change; a pure contract/invariant
  // edit is not (the code didn't move).
  if (diffs.moduleChanged) lanes.push('semantic');

  const gates = [...new Set(lanes.flatMap((l) => LANES[l].gates))];
  // Dedupe deferred gates by name (a module+invariants change would otherwise
  // list semantic-model-check once per lane); merge the lanes that demand it.
  const deferredByGate = new Map();
  for (const l of lanes) {
    for (const d of LANES[l].deferred) {
      const cur = deferredByGate.get(d.gate);
      if (cur) cur.lanes.push(l);
      else deferredByGate.set(d.gate, { ...d, lanes: [l] });
    }
  }
  const deferred = [...deferredByGate.values()];

  const changeId = createHash('sha256')
    .update(`${oldA.versionHash}\n${newA.versionHash}`).digest('hex').slice(0, 12);

  return {
    changeId,
    oldVersion: oldA.versionHash,
    newVersion: newA.versionHash,
    identical: oldA.versionHash === newA.versionHash,
    lanes,
    diffs,
    gates,
    deferred,
  };
}
