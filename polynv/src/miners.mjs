// polynv miners (M1) — two different problems, two substrates (plan §2):
//
//   mineStateProperties — Daikon's real lesson: a FIXED grammar of property
//   templates instantiated against observed states, with statistical
//   confidence thresholds so coincidences on small corpora never become
//   proposals. The grammar is SAM-tuned (plan §11): implications conditioned
//   on the declared control key, domain-value constraints, orderings and
//   ranges over declared state keys. (Key-presence properties are absent by
//   design — a sealed model makes them vacuous.)
//
//   mineTemporal — Perracotta/Synoptic territory: precedence patterns over
//   per-scenario ACTION SEQUENCES ("B never occurs before the first A"),
//   minable only from ordered event streams (traces, the polyrun journal),
//   never from snapshots. Response ("A eventually followed by B") is a
//   liveness property this toolset's safety checker cannot decide — it is
//   deliberately NOT mined rather than mined and silently unverifiable.
//
// Every miner output is a CANDIDATE (behavior, not intent — plan §1) with
// its observation counts as evidence. Deterministic, no API key.
'use strict';

import { canon, renderJs } from './nf.mjs';
import { terminalKeyOf } from '../../polyvers/src/artifacts.mjs';

// Confidence defaults: a property must be observed at least MIN_OBS times to
// become a question at all, and an implication's antecedent at least
// MIN_COND times (an implication over 2 antecedent states is a coincidence).
export const MIN_OBS = 20;
export const MIN_COND = 5;

const candidate = ({ id, nf, question, evidence }) => ({
  id, source: 'mined', target: 'state', nf, js: renderJs(nf), question, evidence,
});

/**
 * Mine state properties from observed states (window pre/post states and/or
 * fleet snapshots). Returns { candidates, notes } — notes name every
 * property that met the grammar but not the confidence threshold.
 */
export function mineStateProperties(contract, states, { minObs = MIN_OBS, minCond = MIN_COND } = {}) {
  const candidates = [];
  const notes = [];
  const keys = (contract.stateKeys || []).map((k) => k.name);
  const controlKey = terminalKeyOf(contract);
  const n = states.length;
  if (n === 0) return { candidates, notes: ['no observed states — state mining skipped'] };
  if (n < minObs) {
    return { candidates, notes: [`${n} observed state(s) < --min-obs ${minObs} — below the confidence threshold, nothing proposed (a small corpus mines coincidences)`] };
  }

  // per-field observation summaries, one pass. A field that is MISSING in
  // any observation (undefined — e.g. an old-shape snapshot from before a
  // schema change) is excluded from mining entirely, with a note: mining a
  // partially-present field would either crash (canon(undefined) is not
  // JSON) or mine properties of the schema gap, not the machine.
  const summary = {};
  const missing = {};
  for (const f of keys) { summary[f] = { values: new Map(), numeric: 0, min: Infinity, max: -Infinity }; missing[f] = 0; }
  for (const s of states) {
    for (const f of keys) {
      const v = s[f];
      if (v === undefined) { missing[f]++; continue; }
      const c = canon(v);
      const fs = summary[f];
      fs.values.set(c, (fs.values.get(c) ?? 0) + 1);
      if (typeof v === 'number') { fs.numeric++; if (v < fs.min) fs.min = v; if (v > fs.max) fs.max = v; }
    }
  }
  const minable = keys.filter((f) => {
    if (missing[f] === 0) return true;
    notes.push(`field '${f}' is missing in ${missing[f]}/${n} observation(s) (old-shape corpus?) — excluded from mining`);
    return false;
  });
  const controlMinable = controlKey && minable.includes(controlKey);
  if (controlKey && !controlMinable) notes.push(`control key '${controlKey}' is missing in some observations — implication mining skipped`);

  for (const f of minable) {
    const fs = summary[f];
    // constancy / small observed domains → in-domain (skip the control key:
    // its domain is the contract's own state enumeration, not news)
    if (f !== controlKey && fs.values.size >= 1 && fs.values.size <= 5 && fs.numeric !== n) {
      const values = [...fs.values.keys()].map((c) => JSON.parse(c));
      candidates.push(candidate({
        id: `mined:in-domain:${f}`,
        nf: { kind: 'in-domain', field: f, values },
        question: `Across ${n} observed states, '${f}' only ever took ${fs.values.size} value(s): ${values.map((v) => JSON.stringify(v)).join(', ')}. Is that the complete legal domain — a rule — or an artifact of the scenarios observed so far?`,
        evidence: { from: 'mined:state', observations: n, quote: `distinct values: ${fs.values.size}` },
      }));
    }
    // observed numeric range
    if (fs.numeric === n) {
      candidates.push(candidate({
        id: `mined:range:${f}`,
        nf: { kind: 'range', field: f, min: fs.min, max: fs.max },
        question: `Across ${n} observed states, '${f}' stayed within ${fs.min}..${fs.max}. Is that the intended bound — a rule — or an artifact of the corpus?`,
        evidence: { from: 'mined:state', observations: n, quote: `observed ${fs.min}..${fs.max}` },
      }));
    }
  }

  // pairwise orderings over numeric fields (a <= b everywhere)
  const numericKeys = minable.filter((f) => summary[f].numeric === n);
  for (const a of numericKeys) {
    for (const b of numericKeys) {
      if (a >= b) continue; // one direction per unordered pair, stable by name
      let aleb = true, blea = true;
      for (const s of states) { if (s[a] > s[b]) aleb = false; if (s[b] > s[a]) blea = false; if (!aleb && !blea) break; }
      if (aleb === blea) continue; // equal everywhere (uninteresting) or unordered
      const [lo, hi] = aleb ? [a, b] : [b, a];
      candidates.push(candidate({
        id: `mined:ordering:${lo}<=${hi}`,
        nf: { kind: 'ordering', a: lo, op: 'le', b: hi },
        question: `Across ${n} observed states, '${lo}' never exceeded '${hi}'. Is '${lo} <= ${hi}' a rule, or an artifact of the corpus?`,
        evidence: { from: 'mined:state', observations: n, quote: `${lo} <= ${hi} in all ${n}` },
      }));
    }
  }

  // implications conditioned on the control key: in control state V, field f
  // is always nonempty / always zero / always one value
  if (controlMinable) {
    const byControl = new Map();
    for (const s of states) {
      const cv = canon(s[controlKey]);
      if (!byControl.has(cv)) byControl.set(cv, []);
      byControl.get(cv).push(s);
    }
    for (const [cv, group] of byControl) {
      if (group.length < minCond) {
        notes.push(`control state ${cv}: only ${group.length} observation(s) < --min-cond ${minCond} — implications not proposed for it`);
        continue;
      }
      const controlValue = JSON.parse(cv);
      for (const f of minable) {
        if (f === controlKey) continue;
        const vals = new Set(group.map((s) => canon(s[f])));
        const wholeCorpus = summary[f];
        // "set" means the type's own empty sentinel is absent: '' for strings,
        // 0 for numbers — and the compiled op must enforce the SAME notion
        // (nonempty for strings, gt 0 for numbers), or the question would
        // claim more than the predicate checks.
        const isNumericField = wholeCorpus.numeric === n;
        const emptySentinel = isNumericField ? 0 : '';
        const allSet = group.every((s) => s[f] !== emptySentinel && s[f] !== null && s[f] !== undefined);
        const emptyElsewhere = [...wholeCorpus.values.keys()].some((c) => { const v = JSON.parse(c); return v === emptySentinel || v === null; });
        if (allSet && emptyElsewhere) {
          candidates.push(candidate({
            id: `mined:implication:${controlKey}=${controlValue}:${f}-set`,
            nf: { kind: 'implication', when: { field: controlKey, value: controlValue }, then: isNumericField ? { field: f, op: 'gt', value: 0 } : { field: f, op: 'nonempty', value: null } },
            question: `In all ${group.length} observed states with ${controlKey} == ${JSON.stringify(controlValue)}, '${f}' was set (not ${JSON.stringify(emptySentinel)}) — while it IS ${JSON.stringify(emptySentinel)} in other states. Is "${controlKey} == ${JSON.stringify(controlValue)} implies ${f} is set" a rule, or an artifact?`,
            evidence: { from: 'mined:state', observations: group.length, quote: `${f} set in ${group.length}/${group.length} states with ${controlKey}=${cv}` },
          }));
        } else if (vals.size === 1 && wholeCorpus.values.size > 1) {
          const only = JSON.parse([...vals][0]);
          candidates.push(candidate({
            id: `mined:implication:${controlKey}=${controlValue}:${f}-eq`,
            nf: { kind: 'implication', when: { field: controlKey, value: controlValue }, then: { field: f, op: 'eq', value: only } },
            question: `In all ${group.length} observed states with ${controlKey} == ${JSON.stringify(controlValue)}, '${f}' was exactly ${JSON.stringify(only)} — while it varies elsewhere. Rule, or artifact?`,
            evidence: { from: 'mined:state', observations: group.length, quote: `${f} == ${JSON.stringify(only)} in all ${group.length}` },
          }));
        }
      }
    }
  }

  return { candidates, notes };
}

/**
 * Mine precedence properties from per-scenario windows: "then never occurs
 * (effectively) before the first (effective) first". Occurrence = the window
 * changed the state — a strict-profile reject is a no-op, not an occurrence.
 * Thresholds: `then` must occur in >= minScenarios scenarios.
 */
export function mineTemporal(windows, { minScenarios = 3 } = {}) {
  const candidates = [];
  const notes = [];
  const byScenario = new Map();
  for (const w of windows) {
    if (canon(w.pre) === canon(w.post)) continue; // rejects are not occurrences
    if (!byScenario.has(w.scenario)) byScenario.set(w.scenario, []);
    byScenario.get(w.scenario).push(w.action);
  }
  const sequences = [...byScenario.values()];
  if (!sequences.length) return { candidates, notes: ['no effective windows — temporal mining skipped'] };
  const actions = [...new Set(sequences.flat())].sort();
  // One pass per sequence builds action → first-occurrence index; each pair
  // check is then two O(1) lookups instead of linear scans (review
  // efficiency finding: the doubly-nested indexOf was O(A² × events)).
  const firstIndex = sequences.map((seq) => {
    const m = new Map();
    seq.forEach((a, i) => { if (!m.has(a)) m.set(a, i); });
    return m;
  });

  for (const first of actions) {
    for (const then of actions) {
      if (first === then) continue;
      let thenScenarios = 0;
      let holds = true;
      for (const m of firstIndex) {
        const ti = m.get(then);
        if (ti === undefined) continue;
        thenScenarios++;
        const fi = m.get(first);
        if (fi === undefined || fi > ti) { holds = false; break; }
      }
      if (!holds || thenScenarios === 0) continue;
      if (thenScenarios < minScenarios) {
        notes.push(`'${first}' precedes '${then}' in the corpus, but '${then}' appears in only ${thenScenarios} scenario(s) < ${minScenarios} — below threshold, not proposed`);
        continue;
      }
      candidates.push({
        id: `mined:precedence:${first}->${then}`,
        source: 'mined',
        target: 'temporal',
        nf: { kind: 'precedence', first, then },
        js: null,
        question: `In all ${thenScenarios} observed scenario(s) where '${then}' had an effect, '${first}' had already occurred first. Is "no ${then} before ${first}" a rule — or just how the recorded scenarios happened to run? (The pre-check explores whether the machine itself can violate it.)`,
        evidence: { from: 'mined:temporal', observations: thenScenarios, quote: `${first} before ${then} in ${thenScenarios}/${thenScenarios} scenarios containing ${then}` },
      });
    }
  }
  return { candidates, notes };
}

/**
 * Normal-form pruning (the question-economy linchpin, plan §10.2). Rules,
 * applied against the union of existing ledger records and already-accepted
 * candidates of this harvest:
 *   - identical rendered predicate → pruned (whatever the id)
 *   - nonneg(f) implied by an existing range(f, min>=0) → pruned
 *   - mined range(f) pruned unless STRICTLY tighter than an existing
 *     range(f) (equal or looser adds no question worth a human minute)
 * Returns { kept, pruned } with a reason per pruned candidate.
 */
export function pruneCandidates(candidates, existingRecords) {
  const kept = [];
  const pruned = [];
  const nfOf = (r) => (r.versions ? r.versions[r.versions.length - 1]?.nf : r.nf);
  const jsOf = (r) => (r.versions ? r.versions[r.versions.length - 1]?.js : r.js);
  // Incremental indexes (review efficiency finding — rebuilding these per
  // candidate was O(C×(R+C))): built once over the existing records, then
  // extended as candidates are kept.
  const jsSet = new Set();
  const rangeByField = new Map();
  const index = (r) => {
    const js = jsOf(r);
    if (js) jsSet.add(js);
    const nf = nfOf(r);
    if (nf?.kind === 'range' && !rangeByField.has(nf.field)) rangeByField.set(nf.field, nf);
  };
  for (const r of existingRecords) index(r);
  for (const c of candidates) {
    if (c.js && jsSet.has(c.js)) { pruned.push({ id: c.id, reason: 'identical predicate already present' }); continue; }
    if (c.nf?.kind === 'nonneg') {
      const covering = rangeByField.get(c.nf.field);
      if (covering && covering.min >= 0) { pruned.push({ id: c.id, reason: `implied by range:${c.nf.field} (min ${covering.min} >= 0)` }); continue; }
    }
    if (c.nf?.kind === 'range') {
      const other = rangeByField.get(c.nf.field);
      if (other && !(c.nf.min > other.min || c.nf.max < other.max)) {
        pruned.push({ id: c.id, reason: `not tighter than the existing range on '${c.nf.field}' (${other.min}..${other.max})` });
        continue;
      }
    }
    kept.push(c);
    index(c);
  }
  return { kept, pruned };
}

/**
 * Vacuity check against the reachable graph: a guarded rule whose guard
 * never fires on any reachable state would pass vacuously — it is marked,
 * not asked (a wasted question AND a misleading HOLDS). Covers every
 * guarded grammar kind, not just implications (review finding, 2026-07-18):
 * a terminal-absorbing rule for a declared-but-unreachable terminal, a
 * set-once rule for a field never set, a reject-in-state rule for an
 * unreachable pre-state are all statements about nothing. NOTE for callers:
 * only meaningful over a SOUND graph (see graphSound in consequences.mjs) —
 * an unreachable-antecedent verdict from a truncated graph is not evidence.
 */
export function vacuousOverGraph(nf, graph) {
  const someState = (pred) => graph.states.some(({ state }) => pred(state));
  switch (nf?.kind) {
    case 'implication':
      return !someState((s) => canon(s[nf.when.field]) === canon(nf.when.value));
    case 'terminal-absorbing':
      return !someState((s) => canon(s[nf.key]) === canon(nf.value)); // declared terminal never reached — itself worth raising
    case 'set-once':
      return !someState((s) => s[nf.field] !== nf.empty); // the field is never set past its sentinel
    case 'reject-in-state':
      return !someState((s) => canon(s[nf.key]) === canon(nf.value)); // the guarded pre-state is unreachable
    default:
      return false; // unguarded kinds (range/nonneg/monotone/in-domain/ordering) have no antecedent to be vacuous over
  }
}
