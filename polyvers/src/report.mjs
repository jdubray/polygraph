// polyvers compat-report — the deliverable: lanes, gates run, corpus
// provenance, verdicts, named failures. Deterministic: no timestamps, and
// corpus ids/source contain no machine-local absolute paths — the report for
// the same change against the same corpus content AND the same committed
// intent-ledger.json (the invariant-adequacy line's source; absent = NOT
// MEASURED) is byte-identical, so it diffs cleanly in a PR. Commit the
// ledger alongside the artifacts or the adequacy line differs per machine.
'use strict';

// The ONE milestone label — stamped into every report; bump it with the
// build, never in prose alone (three consecutive reviews caught a stale
// copy — this constant plus its test is the enforcement).
export const MILESTONE = 'M3';

export function buildReport({ classification, corpusInfo, gateResults, adequacy, intentProvenance }) {
  const ok = gateResults.every((g) => g.ok);
  return {
    tool: 'polyvers',
    milestone: MILESTONE,
    changeId: classification.changeId,
    oldVersion: classification.oldVersion,
    newVersion: classification.newVersion,
    lanes: classification.lanes,
    diffs: classification.diffs,
    corpus: corpusInfo, // { source, count, truncated?, notes? } — provenance is part of the verdict
    // Invariant-set strength is the same KIND of disclosure as corpus
    // provenance: a semantic-lane PASS against invariants that kill 9/40
    // mutants is a different object than one against 36/40, and the report
    // says which one the reader is holding (polynv grade; not a gate — the
    // verdict is unchanged, the trust tier is named).
    adequacy: adequacy ?? { measured: false },
    // record-id → {status, by} from the new version's intent ledger (null
    // when no ledger exists) — annotates the intent diff with elicitation
    // provenance: a rule confirmed through the dialog vs one with no record.
    intentProvenance: intentProvenance ?? null,
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
  lines.push(`**Corpus:** ${r.corpus.count} snapshot(s), source: ${r.corpus.source}${r.corpus.truncated ? ' (TRUNCATED — raise --max-states)' : ''}${r.corpus.migrated ? ` — migrated through the new version's migrate.cjs before the downstream gates${r.corpus.migratedCount !== r.corpus.count ? ` (${r.corpus.migratedCount} distinct post-migration state(s) — the migration collapses some old states together)` : ''}` : ''}`);
  for (const n of r.corpus.notes ?? []) lines.push(`> corpus note: ${n}`);
  lines.push(r.adequacy?.measured
    ? `**Invariant adequacy:** the intent artifact kills ${r.adequacy.killed}/${r.adequacy.distinct} behaviorally distinct machine mutant(s)${r.adequacy.survivors ? ` — ${r.adequacy.survivors} unconstrained behavior class(es) open` : ''} (polynv grade)`
    : r.adequacy?.stale
      ? `**Invariant adequacy:** STALE — the invariants changed after the last \`polynv grade\`; the recorded score no longer describes this intent artifact (regrade to restore the disclosure)`
      : r.adequacy?.unreadable
        ? `**Invariant adequacy:** UNREADABLE — an intent-ledger.json is present but could not be parsed (${r.adequacy.unreadable}); fix or regenerate it — this is not the same as never graded`
        : r.adequacy?.unverifiable
          ? `**Invariant adequacy:** RECORDED BUT UNVERIFIED — a grade is present but ${r.adequacy.unverifiable}; treat as unmeasured`
          : `**Invariant adequacy:** NOT MEASURED — invariant-set strength unknown; a PASS against weak invariants is weaker than it looks (\`polynv grade\` measures it)`);
  lines.push('');
  lines.push('| gate | verdict | summary |');
  lines.push('|---|---|---|');
  for (const g of r.gates) {
    lines.push(`| ${g.gate} | ${g.ok ? 'PASS' : `**FAIL** (${g.failures.length})`} | ${g.summary} |`);
  }
  // LIVE as of M3: the composition lane defers to `polyrun check-effects`,
  // so NOT RUN rows render whenever a mapper changed. Deleting this would
  // reintroduce silent PASS-over-gates-that-never-ran.
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
    // provenance annotation only when the new version carries a ledger with
    // records — absence of a ledger (or an empty one) is not evidence and
    // stays silent. Diff names are prefixed 'state:'/'transition:' by the
    // classifier; ledger record ids are bare — strip before lookup. A miss
    // states the FACT (no ledger record), never a verdict like "unelicited":
    // a hand-written rule may be thoroughly reviewed outside polynv.
    const prov = (name) => {
      if (!r.intentProvenance) return '';
      const p = r.intentProvenance[name.replace(/^(state|transition):/, '')];
      if (!p) return ' (no ledger record)';
      return p.status === 'confirmed' ? ` (elicited: confirmed${p.by ? ` by ${p.by}` : ''})` : ` (ledger: ${p.status})`;
    };
    if (i.added.length) lines.push(`- invariants added: ${i.added.map((n) => n + prov(n)).join(', ')}`);
    if (i.removed.length) lines.push(`- invariants removed: ${i.removed.join(', ')}`);
    if (i.renamed.length) lines.push(`- invariants renamed (identical predicate): ${i.renamed.map((x) => `${x.from} → ${x.to}`).join(', ')}`);
    if (i.edited) lines.push('- edited in place (same names, new predicates)');
    lines.push('');
  }
  lines.push(`## Verdict: ${r.verdict}`);
  if (r.deferred.length) {
    lines.push('');
    lines.push(`> Scope note: ${r.deferred.length} gate(s) this change's lanes require are not implemented in this build (see the NOT RUN rows). A PASS here is a pass over the gates that ran — nothing more.`);
  }
  lines.push('');
  return lines.join('\n');
}
