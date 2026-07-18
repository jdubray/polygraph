// polyvers compat-report — the deliverable: lanes, gates run, corpus
// provenance, verdicts, named failures. Deterministic: no timestamps, and
// corpus ids/source contain no machine-local absolute paths — the report for
// the same change against the same corpus content is byte-identical, so it
// diffs cleanly in a PR.
'use strict';

export function buildReport({ classification, corpusInfo, gateResults }) {
  const ok = gateResults.every((g) => g.ok);
  return {
    tool: 'polyvers',
    milestone: 'M0',
    changeId: classification.changeId,
    oldVersion: classification.oldVersion,
    newVersion: classification.newVersion,
    lanes: classification.lanes,
    diffs: classification.diffs,
    corpus: corpusInfo, // { source, count, truncated?, notes? } — provenance is part of the verdict
    gates: gateResults,
    deferred: classification.deferred,
    verdict: ok ? 'PASS' : 'FAIL',
  };
}

export function renderReport(r) {
  const lines = [];
  lines.push(`# polyvers compat-report — change ${r.changeId}`);
  lines.push('');
  lines.push(`old version \`${r.oldVersion}\` → new version \`${r.newVersion}\``);
  lines.push('');
  lines.push(`**Lanes:** ${r.lanes.join(', ')}`);
  lines.push(`**Corpus:** ${r.corpus.count} snapshot(s), source: ${r.corpus.source}${r.corpus.truncated ? ' (TRUNCATED — raise --max-states)' : ''}`);
  for (const n of r.corpus.notes ?? []) lines.push(`> corpus note: ${n}`);
  lines.push('');
  lines.push('| gate | verdict | summary |');
  lines.push('|---|---|---|');
  for (const g of r.gates) {
    lines.push(`| ${g.gate} | ${g.ok ? 'PASS' : `**FAIL** (${g.failures.length})`} | ${g.summary} |`);
  }
  for (const d of r.deferred) {
    lines.push(`| ${d.gate} | NOT RUN (${d.milestone}) | ${d.why} — required by: ${d.lanes.join(', ')} |`);
  }
  lines.push('');
  const failing = r.gates.filter((g) => !g.ok);
  if (failing.length) {
    lines.push('## Failures');
    lines.push('');
    for (const g of failing) {
      lines.push(`### ${g.gate}`);
      for (const f of g.failures) lines.push(`- ${f.id ? `\`${f.id}\` — ` : ''}${f.message}`);
      lines.push('');
    }
  }
  // Diff detail worth surfacing even on a pass.
  const v = r.diffs.vocabulary;
  if (v.changed) {
    lines.push('## Vocabulary diff');
    if (v.actions.added.length) lines.push(`- actions added: ${v.actions.added.join(', ')}`);
    if (v.actions.removed.length) lines.push(`- actions removed: ${v.actions.removed.join(', ')}`);
    if (v.actions.possibleRenames.length) lines.push(`- possible rename(s): ${v.actions.possibleRenames.map((p) => `'${p.removed}' → one of {${p.addedCandidates.join(', ')}}`).join('; ')} — confirm and record in the version notes`);
    if (v.actions.fieldsChanged.length) lines.push(`- dataFields changed: ${v.actions.fieldsChanged.join(', ')}`);
    if (v.actions.domainChanged) lines.push('- dataDomain changed');
    if (v.rejectReasons.added.length) lines.push(`- reject reasons added: ${v.rejectReasons.added.join(', ')}`);
    if (v.rejectReasons.removed.length) lines.push(`- reject reasons removed: ${v.rejectReasons.removed.join(', ')}`);
    if (v.terminal.keyChanged) lines.push('- terminal key changed');
    if (v.terminal.added.length) lines.push(`- terminal states added: ${v.terminal.added.join(', ')}`);
    if (v.terminal.removed.length) lines.push(`- terminal states removed: ${v.terminal.removed.join(', ')}`);
    if (v.effects.kindsAdded.length) lines.push(`- effect kinds added: ${v.effects.kindsAdded.join(', ')}`);
    if (v.effects.kindsRemoved.length) lines.push(`- effect kinds removed: ${v.effects.kindsRemoved.join(', ')}`);
    if (v.effects.wiringChanged.length) lines.push(`- effect wiring changed: ${v.effects.wiringChanged.join(', ')}`);
    lines.push('');
  }
  const s = r.diffs.shape;
  if (s.changed) {
    lines.push('## Shape diff');
    if (s.added.length) lines.push(`- state keys added: ${s.added.join(', ')}`);
    if (s.removed.length) lines.push(`- state keys removed: ${s.removed.join(', ')}`);
    if (s.retyped.length) lines.push(`- state keys retyped: ${s.retyped.join(', ')}`);
    lines.push('');
  }
  const i = r.diffs.intent;
  if (i.changed) {
    lines.push('## Intent diff');
    if (i.added.length) lines.push(`- invariants added: ${i.added.join(', ')}`);
    if (i.removed.length) lines.push(`- invariants removed: ${i.removed.join(', ')}`);
    if (i.renamed.length) lines.push(`- invariants renamed (identical predicate): ${i.renamed.map((x) => `${x.from} → ${x.to}`).join(', ')}`);
    if (i.edited) lines.push('- edited in place (same names, new predicates)');
    lines.push('');
  }
  lines.push(`## Verdict: ${r.verdict}`);
  if (r.deferred.length) {
    lines.push('');
    lines.push(`> Scope note: ${r.deferred.length} gate(s) this change's lanes require are not implemented at M0 (see the NOT RUN rows). A PASS here is a pass over the gates that ran — nothing more.`);
  }
  lines.push('');
  return lines.join('\n');
}
