// polynv intent report — the convergence verdict over the ledger
// (docs/polynv-plan.md §3, M2 semantics): CONVERGED iff every record is in
// a terminal status AND the adequacy grade has run (`polynv grade` refuses
// to store a grade that measured nothing, so a present grade is a real
// measurement); anything less is PARTIAL with the open-record list, per
// assignee where questions are deferred, and `polynv report` exits 1.
'use strict';

export function buildStatus(ledger) {
  const counts = {};
  for (const r of ledger.records) counts[r.status] = (counts[r.status] ?? 0) + 1;
  const open = ledger.records.filter((r) => r.status === 'open');
  const byAssignee = {};
  for (const r of open) (byAssignee[r.assign ?? '(unassigned)'] ??= []).push(r.id);
  // A confirmed rule whose pre-check FAILED is a live finding: the designer
  // said "this must never happen" about a behavior the machine reachably has.
  const findings = ledger.records.filter((r) => r.status === 'confirmed' && r.precheck?.verdict === 'FAILS');
  const emissionConfirmed = ledger.records.filter((r) => r.status === 'confirmed' && r.target === 'emission');
  const temporalConfirmed = ledger.records.filter((r) => r.status === 'confirmed' && r.target === 'temporal');
  const templates = ledger.records.filter((r) => r.source === 'template');
  const templatesDone = templates.filter((r) => r.status !== 'open');
  // M2 semantics: convergence REQUIRES the adequacy grade — an interview
  // where every question was answered but invariant-set strength was never
  // measured is PARTIAL, per the review's convergence redefinition (plan §3).
  const graded = !!ledger.grade;
  return {
    verdict: open.length === 0 && ledger.records.length > 0 && graded ? 'CONVERGED' : 'PARTIAL',
    counts,
    total: ledger.records.length,
    open: open.map((r) => r.id),
    byAssignee,
    findings: findings.map((r) => r.id),
    emissionConfirmed: emissionConfirmed.map((r) => r.id),
    temporalConfirmed: temporalConfirmed.map((r) => r.id),
    templateCoverage: { dispositioned: templatesDone.length, total: templates.length },
    adequacyGrade: graded
      ? `kills ${ledger.grade.killed}/${ledger.grade.distinct} behaviorally distinct mutant(s); ${ledger.grade.survivors.length} survivor(s)${ledger.grade.dropped ? `; ${ledger.grade.dropped} operator(s) dropped by --max-mutants` : ''}`
      : 'NOT MEASURED — run `polynv grade`; convergence requires it',
    graded,
  };
}

export function renderStatus(s) {
  const L = [];
  L.push(`polynv intent report — ${s.verdict}`);
  L.push(`  records: ${s.total} (${Object.entries(s.counts).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'})`);
  L.push(`  template coverage: ${s.templateCoverage.dispositioned}/${s.templateCoverage.total} dispositioned`);
  L.push(`  adequacy grade: ${s.adequacyGrade}`);
  if (s.findings.length) {
    L.push(`  FINDINGS — confirmed rules the machine reachably violates (fix the machine, the repro is on the record):`);
    for (const id of s.findings) L.push(`    ✗ ${id}`);
  }
  if (s.emissionConfirmed.length) {
    L.push(`  confirmed emission rules (NOT in the generated invariants.mjs — wire into effect-invariants for polyrun check-effects):`);
    for (const id of s.emissionConfirmed) L.push(`    · ${id}`);
  }
  if (s.temporalConfirmed.length) {
    L.push(`  confirmed temporal rules (NOT in the generated invariants.mjs — graph-checked at elicitation; runtime monitoring is a recorded follow-up):`);
    for (const id of s.temporalConfirmed) L.push(`    · ${id}`);
  }
  if (s.verdict === 'PARTIAL') {
    if (s.total === 0) L.push('  ledger is empty — run `polynv harvest` first');
    if (s.total > 0 && !s.graded) L.push('  not graded — `polynv grade` measures invariant-set strength; convergence requires it');
    for (const [who, ids] of Object.entries(s.byAssignee)) {
      L.push(`  open — ${who}: ${ids.join(', ')}`);
    }
  }
  return L.join('\n');
}

/** INTENT-LOG.md — the rendered, human-readable view of the ledger; never
 *  the source of truth, never edited by hand. */
export function renderLog(ledger) {
  const L = ['# Intent log', '', '> Rendered from `intent-ledger.json` by `polynv report --log` — do not edit; the ledger is the system of record.', ''];
  for (const r of ledger.records) {
    L.push(`## ${r.id} — **${r.status}**`);
    L.push('');
    L.push(`- source: ${r.source} · target: ${r.target}${r.assign ? ` · deferred to: ${r.assign}` : ''}`);
    if (r.provenance) L.push(`- domain prior: ${r.provenance.domain ?? '?'} — "${r.provenance.norm ?? ''}" (${r.provenance.model ?? 'model unstated'}, ${r.provenance.date ?? ''})`);
    L.push(`- question: ${r.question}`);
    if (r.evidence?.quote) L.push(`- evidence (${r.evidence.from}): ${r.evidence.quote}`);
    if (r.precheck) L.push(`- pre-check: ${r.precheck.verdict}${r.precheck.detail ? ` — ${r.precheck.detail}` : ''}${r.precheck.note ? ` — ${r.precheck.note}` : ''}`);
    if (r.versions.length) {
      L.push(`- predicate versions:`);
      r.versions.forEach((v, i) => L.push(`  ${i + 1}. \`${v.js}\` (${v.author}, ${v.date})`));
    }
    L.push(`- events:`);
    for (const e of r.events) {
      const bits = [e.type, e.disposition, e.author && `by ${e.author}`, e.assign && `→ ${e.assign}`, e.note && `— ${e.note}`].filter(Boolean);
      L.push(`  - ${e.date}: ${bits.join(' ')}`);
    }
    L.push('');
  }
  return L.join('\n');
}
