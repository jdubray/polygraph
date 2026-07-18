// polynv pre-check — run one candidate as the SOLE invariant through the
// existing model checker (scripts/check.mjs), so every question arrives at
// the dialog with a verdict attached:
//   HOLDS   — over every reachable state/transition (declared domains); the
//             question is "rule or coincidence?"
//   FAILS   — with a shortest counterexample; the question is the concrete
//             story: "is this sequence acceptable?"
//   BOUNDED — exploration hit the cap; bounded-is-not-a-pass doctrine — the
//             verdict is carried as its own class, never conflated with HOLDS.
//   ERROR   — the machine/module could not be explored (a machine problem,
//             surfaced first in the question ranking).
//   NOT-RUN — emission-target candidates (check-effects territory; M1).
'use strict';

import { check } from '../../scripts/check.mjs';
import { compile } from './nf.mjs';
import { currentVersion } from './ledger.mjs';
import { checkPrecedence } from './consequences.mjs';

export function precheckRecord(record, artifacts, { maxStates = 100000, date, graph = null }) {
  let result;
  if (record.target === 'emission') {
    result = { verdict: 'NOT-RUN', note: 'emission invariant — pre-check lives at the machine ∘ mapper layer (polyrun check-effects); recorded follow-up', date };
  } else if (record.target === 'temporal') {
    const v = currentVersion(record);
    if (v?.nf?.kind !== 'precedence') {
      result = { verdict: 'NOT-RUN', note: `temporal kind '${v?.nf?.kind}' has no checker`, date };
    } else if (!graph) {
      result = { verdict: 'NOT-RUN', note: 'temporal pre-check needs the reachable graph — caller did not supply one', date };
    } else if (graph.error) {
      result = { verdict: 'ERROR', detail: graph.error, date };
    } else if (graph.throws.length || graph.nondeterministic) {
      // an incomplete/chimeric graph cannot support a temporal verdict —
      // and this is a MACHINE problem, never the candidate's
      result = { verdict: 'ERROR', detail: graph.nondeterministic ? 'the machine is nondeterministic — the reachable graph is a union of differing runs' : `the machine throws on ${graph.throws.length} explored step(s) — the reachable graph is incomplete (first: ${graph.throws[0].invariant})`, date };
    } else {
      const r = checkPrecedence(v.nf, graph);
      result = r.verdict === 'HOLDS'
        ? { verdict: graph.capHit ? 'BOUNDED' : 'HOLDS', statesExplored: graph.states.length, date, ...(graph.capHit ? { detail: 'no violation found over a TRUNCATED graph — not a pass' } : {}) }
        : { verdict: 'FAILS', detail: `the machine can drive '${v.nf.then}' before any '${v.nf.first}'`, kind: 'temporal', counterexample: r.path, statesExplored: graph.states.length, date };
    }
  } else {
    const v = currentVersion(record);
    const { target, pred } = compile(v.nf);
    const invariants = target === 'state'
      ? { stateInvariants: [{ name: record.id, pred }] }
      : { transitionInvariants: [{ name: record.id, pred }] };
    const r = check({ specModule: artifacts.module, contract: artifacts.contract, invariants, maxStates });
    // Attribution (review finding, 2026-07-18): only a violation of THIS
    // candidate's invariant is the candidate FAILING. 'throw' and
    // 'nondeterminism' violations are MACHINE problems and land as ERROR —
    // otherwise the dialog asks "is this behavior acceptable?" about a crash.
    const own = (r.violations ?? []).filter((x) => x.invariant === record.id);
    const machine = (r.violations ?? []).filter((x) => x.invariant !== record.id);
    if (r.error) {
      result = { verdict: 'ERROR', detail: r.error, date };
    } else if (own.length) {
      const v0 = own[0];
      result = { verdict: 'FAILS', detail: v0.detail, kind: v0.kind, counterexample: v0.path, statesExplored: r.statesExplored, date };
      if (machine.length) result.machineNote = `a machine problem is also present: ${machine[0].invariant}`;
    } else if (machine.length) {
      result = { verdict: 'ERROR', detail: `machine problem, not this candidate: ${machine[0].invariant} — ${machine[0].detail}`, kind: machine[0].kind, counterexample: machine[0].path, statesExplored: r.statesExplored, date };
    } else if (r.capHit) {
      result = { verdict: 'BOUNDED', detail: `no violation found, but exploration was truncated at ${r.statesExplored} states — not a pass`, statesExplored: r.statesExplored, date };
    } else {
      result = { verdict: 'HOLDS', statesExplored: r.statesExplored, date };
    }
    if (r.domainNotes?.length) result.domainNotes = r.domainNotes;
  }
  record.precheck = result;
  record.events.push({ type: 'precheck', verdict: result.verdict, date });
  return result;
}

/** Render a counterexample path in the checker's own style. */
export function renderCounterexample(path) {
  if (!path?.length) return [];
  const L = [];
  path.forEach((step, i) => {
    // temporal counterexamples are action-only (no per-step states)
    const st = step.state === undefined ? '' : typeof step.state === 'string' ? step.state : JSON.stringify(step.state);
    if (i === 0 && step.action === null) L.push(`init            ${st}`);
    else L.push(`${step.action}(${JSON.stringify(step.data)})${st ? ` -> ${st}` : ''}`);
  });
  return L;
}
