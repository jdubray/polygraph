// polynv question ranking — information-greedy ordering of the open records
// (design decision §10.1): counterexample questions first (a concrete story
// to judge — the highest information per human minute), then machine
// problems (ERROR/BOUNDED — the interview cannot be trusted until the
// exploration can), then domain priors, then holds-everywhere templates
// ("rule or coincidence?"), then the emission questions the M0 checker
// cannot pre-check.
'use strict';

import { renderCounterexample } from './precheck.mjs';

const rank = (r) => {
  // an open candidate whose kill profile duplicates a confirmed rule adds
  // nothing this mutation set can see — deprioritized behind everything
  if (r.grade?.redundantWith) return 7;
  const v = r.precheck?.verdict;
  if (v === 'FAILS') return 0;
  if (v === 'ERROR' || v === 'BOUNDED') return 1;
  // hypothesis-splitting signal (plan §3): candidates that kill mutants no
  // confirmed rule kills, and the surviving-behavior questions themselves
  if (r.grade?.newKills > 0 || r.source === 'mutation-survivor') return 2;
  if (r.source === 'domain-prior') return 3;
  if (v === 'HOLDS') return r.source === 'mined' ? 5 : 4; // mined HOLDS = coincidence questions, after templates
  return 6; // NOT-RUN (emission) and anything unprechecked
};

/** Open records, ranked; `assignee` filters to questions deferred to a name. */
export function openQuestions(ledger, { assignee } = {}) {
  let open = ledger.records.filter((r) => r.status === 'open');
  if (assignee) open = open.filter((r) => r.assign === assignee);
  return open.sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
}

/** One question as a plain object — what the skill consumes (`--next`). */
export function questionPayload(record) {
  const p = record.precheck || {};
  return {
    id: record.id,
    source: record.source,
    target: record.target,
    question: record.question,
    evidence: record.evidence,
    predicate: record.versions.length ? record.versions[record.versions.length - 1].js : null,
    precheck: p.verdict ?? 'NOT-RUN',
    precheckDetail: p.detail ?? p.note ?? null,
    counterexample: p.counterexample ? renderCounterexample(p.counterexample) : null,
    assign: record.assign,
    provenance: record.provenance ?? null,
  };
}

export function renderQuestion(record) {
  const p = questionPayload(record);
  const L = [];
  L.push(`■ ${p.id}  [${p.source} · ${p.target} · pre-check: ${p.precheck}]${p.assign ? `  (deferred to: ${p.assign})` : ''}`);
  L.push(`  ${p.question}`);
  if (p.evidence?.quote) L.push(`  evidence (${p.evidence.from}): ${p.evidence.quote}`);
  if (p.predicate) L.push(`  predicate: ${p.predicate}`);
  if (p.precheck === 'FAILS' && p.counterexample) {
    L.push('  the machine CAN do this today (shortest path) — is this behavior acceptable?');
    for (const line of p.counterexample) L.push(`    ${line}`);
    L.push('  → acceptable: reject the candidate (the behavior is intended).');
    L.push('  → NOT acceptable: confirm it — the rule becomes intent, and this path is the repro of a live finding.');
  }
  if (p.precheckDetail && (p.precheck !== 'FAILS' || !p.counterexample)) L.push(`  ${p.precheck === 'FAILS' ? 'failure' : 'note'}: ${p.precheckDetail}`);
  return L.join('\n');
}
