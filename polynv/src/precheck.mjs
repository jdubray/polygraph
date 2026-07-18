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

import { existsSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check } from '../../scripts/check.mjs';
import { compile } from './nf.mjs';
import { currentVersion } from './ledger.mjs';
import { checkPrecedence, graphSound, violationsOf, pathsOf } from './consequences.mjs';

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
  } else if (graph && graphSound(graph)) {
    // Fast path (review efficiency finding): a SOUND shared graph already
    // contains every reachable state and explored edge — evaluate the
    // candidate over it and reconstruct the shortest counterexample from
    // the memoized parent pointers, instead of re-running a full check()
    // double-pass per candidate. Verdicts are identical by construction;
    // unsound graphs (truncated/throwing/nondeterministic) fall through to
    // the full check() below, whose attribution logic handles them.
    const v = currentVersion(record);
    const compiled = compile(v.nf);
    const violations = violationsOf(compiled, graph) ?? [];
    if (violations.length === 0) {
      result = { verdict: 'HOLDS', statesExplored: graph.states.length, date };
    } else {
      const { pathToState, pathToEdge } = pathsOf(graph);
      let best = null;
      for (const viol of violations) {
        const p = viol.kind === 'state' ? pathToState(viol.key) : pathToEdge(viol.edge);
        if (p && (!best || p.length < best.length)) best = p;
      }
      result = {
        verdict: 'FAILS',
        detail: violations[0].kind === 'state' ? 'reachable state violates the rule' : `violated by ${violations[0].edge?.action ?? 'a transition'}`,
        kind: violations[0].kind === 'state' ? 'state' : 'transition',
        counterexample: best ?? [],
        statesExplored: graph.states.length,
        date,
      };
    }
    if (graph.domainNotes?.length) result.domainNotes = graph.domainNotes;
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

/**
 * Emission pre-check (recorded follow-up, now wired): an
 * emission-at-most-once candidate is checked at the machine ∘ mapper layer
 * through polyrun's check-effects — the composition explorer that evaluates
 * invariants over per-path EMISSIONS. Runs only when the artifact dir
 * carries the composition (effects.cjs + effects.manifest.json); otherwise
 * the candidate keeps its explicit NOT-RUN. Async because checkEffects is.
 */
export async function precheckEmissionRecord(record, artifactsDir, { date, maxDepth, maxPaths } = {}) {
  const v = currentVersion(record);
  let result;
  if (v?.nf?.kind !== 'emission-at-most-once') {
    result = { verdict: 'NOT-RUN', note: `emission kind '${v?.nf?.kind}' has no checker`, date };
  } else if (!existsSync(join(artifactsDir, 'effects.cjs')) || !existsSync(join(artifactsDir, 'effects.manifest.json'))) {
    result = { verdict: 'NOT-RUN', note: 'emission invariant — needs effects.cjs + effects.manifest.json in the artifact dir (the machine ∘ mapper composition); ask the designer without a verdict', date };
  } else {
    const { checkEffects } = await import('../../polyrun/src/check-effects.mjs');
    const { findModulePath } = await import('../../polyvers/src/artifacts.mjs');
    // checkEffects takes an invariants MODULE PATH — write the single
    // candidate as a throwaway effectInvariants module.
    const dir = mkdtempSync(join(tmpdir(), 'polynv-emis-'));
    const invPath = join(dir, 'inv.mjs');
    writeFileSync(invPath, `export const effectInvariants = [{ name: ${JSON.stringify(record.id)}, pred: (path) => path.count(${JSON.stringify(v.nf.effect)}) <= 1 }];\n`);
    try {
      const r = await checkEffects({
        module: findModulePath(artifactsDir),
        mapper: join(artifactsDir, 'effects.cjs'),
        manifest: join(artifactsDir, 'effects.manifest.json'),
        contract: join(artifactsDir, 'contract.json'),
        invariants: invPath,
        maxDepth, maxPaths,
      });
      // Attribution mirrors the state/transition path: only THIS candidate's
      // violations are the candidate failing; mapper defects etc. are
      // machine/composition problems.
      const own = (r.violations ?? []).filter((x) => x.invariant === record.id);
      const other = (r.violations ?? []).filter((x) => x.invariant !== record.id);
      if (own.length) {
        result = { verdict: 'FAILS', detail: `'${v.nf.effect}' can be emitted more than once on a reachable path: ${own[0].counterexample}`, kind: 'emission', statesExplored: r.statesSeen, date };
      } else if (other.length) {
        result = { verdict: 'ERROR', detail: `composition problem, not this candidate: ${other[0].invariant} — ${other[0].detail ?? other[0].counterexample}`, date };
      } else if (r.bounded) {
        result = { verdict: 'BOUNDED', detail: `no violation found, but path exploration was bounded (${r.pathsExplored} paths) — not a pass`, statesExplored: r.statesSeen, date };
      } else {
        result = { verdict: 'HOLDS', statesExplored: r.statesSeen, date };
      }
    } catch (e) {
      result = { verdict: 'ERROR', detail: `check-effects could not run: ${String(e && e.message)}`, date };
    }
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
