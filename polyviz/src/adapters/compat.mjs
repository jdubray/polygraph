// Adapter: polyvers `compat-report.json` → viz-model `compat` section (spec §4.3).
// The only stage coupled to polyvers' native format. Extracts everything
// structural; narrative fields (titles, version-card labels) come from an
// optional annotations object, falling back to defaults derived from the report.

const STATE_KEYS = ['state', 'orderState', 'status', 'phase']; // preferred display-state fields

function short(hash) {
  return hash ? String(hash).slice(0, 8) : '?';
}

// A compact card id from a corpus id like "synthesized#0" → "s0", "live#o2" → "o2".
function shortId(id) {
  const s = String(id ?? '');
  if (s.includes('#')) {
    const [prefix, tail] = [s.slice(0, s.indexOf('#')), s.slice(s.indexOf('#') + 1)];
    return prefix === 'synthesized' ? `s${tail}` : tail || s;
  }
  return s;
}

// Pick a single display-state string from a snapshot's state object.
function pickState(state) {
  if (typeof state === 'string') return state;
  if (state && typeof state === 'object') {
    for (const k of STATE_KEYS) if (typeof state[k] === 'string') return state[k];
    const firstStr = Object.values(state).find((v) => typeof v === 'string' && v);
    if (firstStr) return firstStr;
  }
  return '—';
}

function diffSummary(report) {
  const shape = report.diffs?.shape?.added ?? [];
  const intent = report.diffs?.intent?.added ?? [];
  const parts = [...shape.map((s) => `+${s}`), ...intent.map((s) => `+${s}`)];
  return parts.length ? parts.join(', ') : 'no shape change';
}

/**
 * Adapt a parsed compat-report.json into a viz-model `compat` section.
 * opts: { annotations?, maxFleet=3, log }.
 */
export function adaptCompat(report, { annotations = {}, maxFleet = 3, log = () => {} } = {}) {
  if (!report || !Array.isArray(report.gates)) {
    throw new Error('compat adapter: input is not a polyvers compat-report.json (missing gates[])');
  }
  const a = annotations;
  const clear = report.verdict != null ? report.verdict === 'PASS' : report.gates.every((g) => g.ok);
  const failing = report.gates.filter((g) => !g.ok);
  const offenders = failing
    .flatMap((g) => (g.failures ?? []).map((f) => (typeof f === 'string' ? f : f.id ?? f.snapshot ?? f.key)))
    .filter(Boolean)
    .map(shortId);

  const corpusGate = report.gates.find((g) => Array.isArray(g.migratedCorpus));
  const raw = corpusGate?.migratedCorpus ?? [];
  if (raw.length > maxFleet) {
    log(`polyviz: compat fleet has ${raw.length} snapshots — showing the first ${maxFleet} (fleetLabel notes the rest)`);
  }
  const offenderRawIds = new Set(failing.flatMap((g) => (g.failures ?? []).map((f) => (typeof f === 'string' ? f : f.id ?? f.snapshot ?? f.key))));
  const fleet = raw.slice(0, maxFleet).map((e) => ({
    id: shortId(e.id),
    state: pickState(e.state),
    note: e.source ?? '',
    flagged: offenderRawIds.has(e.id)
  }));

  const detail = clear
    ? `All ${report.gates.length} gates passed over ${raw.length || report.corpus?.count || 0} live/migrated state(s). No reachable state violates the new version.`
    : `Gate(s) failed: ${failing.map((g) => g.gate).join(', ')}. ${offenders.length} live state(s) named. Repro attached.`;

  return {
    kicker: a.kicker ?? 'THE VERSION GATE',
    title: a.title ?? (clear ? 'The change is compatible with live state' : 'A live state breaks under the new rules'),
    subtitle: a.subtitle ?? `${report.tool ?? 'polyvers'}${report.milestone ? ` ${report.milestone}` : ''} · change ${short(report.changeId)}`,
    from: a.from ?? { label: `v ${short(report.oldVersion)}`, detail: 'live' },
    to: a.to ?? { label: `v ${short(report.newVersion)} (deploy)`, detail: diffSummary(report) },
    gate: a.gate ?? 'polyvers · seed the check with the live states',
    fleetLabel: a.fleetLabel ?? `LIVE FLEET — ${raw.length || report.corpus?.count || 0} state(s) already in flight`,
    fleet,
    verdict: {
      status: clear ? 'clear' : 'blocked',
      title: a.verdictTitle ?? (clear ? 'SAFE TO DEPLOY' : 'DEPLOY BLOCKED'),
      detail: a.verdictDetail ?? detail,
      offenders
    }
  };
}
