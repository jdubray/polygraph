// polyvers cross-machine version matrix (M3) — the recorded open item from
// docs/VERSIONING.md, attempted at the depth that is mechanically checkable
// today.
//
// During a rollout window, parent {old,new} × child {old,new} coexist: a
// parent that spawned a child under one version pairing receives its
// completion under another. For each of the four pairings this gate checks
// the spawn/completion PROTOCOL and its DELIVERY:
//
//   wiring     — every spawnChild intent the parent's mapper can emit is
//                well-formed (childKey present and unique per step — the
//                kernel poisons on both) and targets a child whose
//                creation/onParentTerminal actions exist, plus an onComplete
//                action the parent itself exports
//   completion — every terminal outcome the child can actually reach is
//                delivered into the parent with the DISCOVERED childKey
//                ({childKey, childState}, exactly what the polyrun worker
//                dispatches) at every parent corpus state, and must land as
//                accepted or a NAMED observable reject
//   cancel     — the parent-terminal cancel action is delivered to every
//                child corpus state under the same rule
//
// Spawn discovery is a KERNEL-PARITY walk: the mapper runs on every ACCEPTED
// step — including identity-accepts (kernel gates on stepKind, not on state
// change) — classified via lastStep() exactly as dispatch does. The walk and
// the delivery corpora both accept fleet snapshots as seeds (the honest
// tier); synthesis alone covers only the old model's opinion of reachability.
//
// Every narrowing is DISCLOSED (truncation, throwing actions, mapper
// throws), and a bounded run is a failing verdict unless the operator
// explicitly accepts it — check-effects doctrine, uniform across the tool.
//
// Honest scope (recorded): this is the protocol/delivery matrix, NOT the full
// product-space model check — "no reachable INTERLEAVING of parent-vN and
// child-vM violates a cross-machine invariant" needs a joint-state
// exploration with cross-machine invariants, which remains open (the essay's
// scope note stands). What this gate closes is the undefined-behavior class:
// nothing either side can deliver across the version boundary is unhandled.
//
// Deterministic, no API key.
'use strict';

import { stable } from '../../scripts/load-spec.mjs';
import samAdapter from '../../scripts/sam-adapter.cjs';
import { synthesizeCorpus } from './corpus.mjs';
import { observableKeys, isTerminalOf } from './artifacts.mjs';
import { stimulusOutcome, projectState } from './gates.mjs';

const { domainFromManifest } = samAdapter;

/**
 * Enumerate the spawnChild intents a parent version's mapper can emit, with
 * kernel parity: BFS the parent's state space (init + any fleet seeds) and
 * run the mapper on every ACCEPTED step — mutating or identity — classified
 * through the module's own lastStep(), exactly as dispatch does.
 *
 * Returns { spawns, defects, truncated, notes }: `defects` are parent-side
 * protocol violations the kernel would poison on (missing/duplicate
 * childKey); `notes` disclose every narrowing of the walk.
 */
export function discoverSpawns(parentA, { maxStates = 20000, seeds = [] } = {}) {
  if (typeof parentA.mapper !== 'function') {
    throw new Error('matrix: the parent version has no effects.cjs mapper — spawn intents cannot be enumerated');
  }
  const mod = parentA.module;
  if (typeof mod.instance({}).manifest !== 'function') {
    throw new Error('matrix: the parent module\'s instance accessor exposes no manifest() — the exploration domain cannot be read');
  }
  const { steps, notes: domainNotes } = domainFromManifest(parentA.module);
  if (!steps.length) throw new Error('matrix: the parent module\'s manifest() yields no explorable (action, data) steps');
  const contractKeys = observableKeys(parentA.contract);

  const spawns = new Map(); // protocol tuple (incl. childKey) -> intent
  const defects = [];
  const notes = [...(domainNotes ?? [])];
  const threw = new Set();
  const seenDefect = new Set();

  const init = (() => { mod.init(); return projectState(mod, contractKeys); })();
  const seen = new Set([stable(init)]);
  const queue = [init];
  for (const s of seeds) {
    const k = stable(s);
    if (!seen.has(k)) { seen.add(k); queue.push(s); }
  }
  let head = 0;
  let truncated = false;
  outer: while (head < queue.length) {
    const s = queue[head++];
    for (const { action, data } of steps) {
      const handler = mod.actions[action];
      if (typeof handler !== 'function') continue; // contract/module drift is loadGate's finding
      let accepted = false;
      let post = s;
      try {
        mod.init();
        mod.setState(s);
        try {
          handler(data);
        } catch (err) {
          if (!(err && err.name === 'SamSchemaError') && !threw.has(action)) {
            threw.add(action);
            notes.push(`action '${action}' threw during the walk (${err && err.message}) — paths through it are NOT explored`);
          }
          continue;
        }
        const step = mod.instance({}).lastStep();
        // Kernel parity: the mapper runs on every ACCEPTED step — 'mutated'
        // AND 'identity-by-mutation' (kernel gates on stepKind, never on
        // whether the state changed).
        accepted = !!step && (step.intent === undefined || step.intent === null || step.intent === action)
          && step.classification !== 'rejected' && step.classification !== 'unhandled';
        if (accepted) post = projectState(mod, contractKeys);
      } catch (err) {
        if (!threw.has(action)) { threw.add(action); notes.push(`could not drive '${action}' during the walk: ${err && err.message}`); }
        continue;
      }
      if (accepted) {
        let intents = [];
        try {
          intents = parentA.mapper(s, action, data, post, 'accepted') || [];
        } catch (err) {
          if (!threw.has(`mapper:${action}`)) { threw.add(`mapper:${action}`); notes.push(`the mapper threw on '${action}' (${err && err.message}) — its emissions on those transitions are NOT enumerated (run polyrun check-effects)`); }
        }
        const keysThisStep = new Set();
        for (const it of intents) {
          if (!it || it.kind !== 'spawnChild') continue;
          // Kernel-required intent shape (dispatch poisons on violations).
          if (typeof it.childKey !== 'string' || !it.childKey) {
            const dk = `missing:${it.machineId}:${action}`;
            if (!seenDefect.has(dk)) { seenDefect.add(dk); defects.push(`the mapper emits a spawnChild for '${it.machineId}' (on '${action}') without a childKey — the kernel poisons the parent on exactly this`); }
            continue;
          }
          if (keysThisStep.has(it.childKey)) {
            const dk = `dup:${it.childKey}:${action}`;
            if (!seenDefect.has(dk)) { seenDefect.add(dk); defects.push(`the mapper emits duplicate spawnChild key '${it.childKey}' in one step (on '${action}') — the kernel poisons the parent on exactly this`); }
            continue;
          }
          keysThisStep.add(it.childKey);
          const tuple = stable({ machineId: it.machineId, childKey: it.childKey, onComplete: it.onComplete ?? null, onParentTerminal: it.onParentTerminal ?? null, creation: it.creation?.action ?? null });
          if (!spawns.has(tuple)) spawns.set(tuple, it);
        }
      }
      const key = stable(post);
      if (!seen.has(key)) {
        if (seen.size >= maxStates + seeds.length) { truncated = true; break outer; }
        seen.add(key);
        queue.push(post);
      }
    }
  }
  return { spawns: [...spawns.values()], defects, truncated, notes };
}

/**
 * checkPairing — one cell of the matrix. corpora: { parent, child } corpus
 * entries; childTerminals: the child's reachable terminal outcomes (derived
 * from its corpus). One witness per (spawn, failure class).
 */
export function checkPairing(label, parentA, childA, childMachineId, corpora, childTerminals, discovery) {
  const failures = [];
  const seenKey = new Set();
  const record = (key, id, message) => {
    if (seenKey.has(key)) return;
    seenKey.add(key);
    failures.push({ ...(id !== undefined ? { id } : {}), message: message() });
  };
  for (const d of discovery.defects) record(`defect:${d}`, undefined, () => d);

  const relevant = discovery.spawns.filter((s) => s.machineId === childMachineId);
  if (relevant.length === 0 && discovery.defects.length === 0) {
    record('no-spawn', undefined, () => `the parent's mapper emits no spawnChild for machine '${childMachineId}' over the explored space — nothing to check would pass vacuously; refusing (wrong --child-id, the parent does not spawn this child, or the walk was narrowed — see the discovery notes)`);
    return { pairing: label, ok: false, failures };
  }
  for (const spawn of relevant) {
    const tag = `${spawn.childKey}`;
    // ── wiring (polyrun registration/dispatch checks, per pairing) ──
    if (spawn.onComplete && typeof parentA.module.actions[spawn.onComplete] !== 'function') {
      record(`${tag}:onComplete`, undefined, () => `spawn '${tag}' onComplete '${spawn.onComplete}' is not in the parent's action surface — the child's completion would poison the parent`);
    }
    if (spawn.onParentTerminal && typeof childA.module.actions[spawn.onParentTerminal] !== 'function') {
      record(`${tag}:onParentTerminal`, undefined, () => `spawn '${tag}' onParentTerminal '${spawn.onParentTerminal}' is not in the child's action surface — cancelling on parent-terminal would poison the child`);
    }
    if (spawn.creation?.action && typeof childA.module.actions[spawn.creation.action] !== 'function') {
      record(`${tag}:creation`, undefined, () => `spawn '${tag}' creation action '${spawn.creation.action}' is not in the child's action surface — spawning would fail at dispatch`);
    }
    // ── completion delivery: child terminal outcomes → parent corpus,
    //    carrying the DISCOVERED childKey (production's payload, not a
    //    synthetic one a schema could bounce or an acceptor could branch on) ──
    if (spawn.onComplete && typeof parentA.module.actions[spawn.onComplete] === 'function') {
      if (childTerminals.error) {
        record(`${tag}:terminals`, undefined, () => childTerminals.error);
      } else {
        for (const childState of childTerminals.states) {
          for (const { id, state } of corpora.parent) {
            const verdict = stimulusOutcome(parentA.module, state, spawn.onComplete, { childKey: spawn.childKey, childState });
            if (!verdict.ok) {
              record(`${tag}:completion:${verdict.cls}:${stable(childState)}`, id, () => `completion '${spawn.onComplete}({childKey: '${spawn.childKey}', childState: ${stable(childState)}})' from the child's terminal outcome ${verdict.why}`);
            }
          }
        }
      }
    }
    // ── cancel delivery: parent-terminal cancel → child corpus ──
    if (spawn.onParentTerminal && typeof childA.module.actions[spawn.onParentTerminal] === 'function') {
      for (const { id, state } of corpora.child) {
        const verdict = stimulusOutcome(childA.module, state, spawn.onParentTerminal, {});
        if (!verdict.ok) {
          record(`${tag}:cancel:${verdict.cls}`, id, () => `parent-terminal cancel '${spawn.onParentTerminal}' delivered to this child state ${verdict.why}`);
        }
      }
    }
  }
  return { pairing: label, ok: failures.length === 0, failures };
}

/**
 * runMatrix({parentOld, parentNew, childOld, childNew, childMachineId,
 *            maxStates?, allowBounded?, parentSeeds?, childSeeds?}) —
 * the 2×2 rollout-window matrix. `parentSeeds`/`childSeeds` are fleet
 * snapshot corpora (loadCorpus entries) merged into the delivery corpora and
 * seeded into spawn discovery — the honest tier; synthesis alone covers only
 * the old model's opinion of reachability.
 *
 * All exploration is memoized by versionHash (the same version appearing
 * under two labels — the routine child-only-change run — is explored once).
 */
export function runMatrix({ parentOld, parentNew, childOld, childNew, childMachineId, maxStates, allowBounded = false, parentSeeds = [], childSeeds = [] }) {
  const opts = maxStates ? { maxStates } : {};
  const corpusMemo = new Map(); // versionHash -> {entries, truncated, notes}
  const corpusFor = (a, extra) => {
    if (!corpusMemo.has(a.versionHash)) {
      const synth = synthesizeCorpus(a.module, opts);
      // Merge fleet snapshots (dedup by key) — provenance stays disclosed.
      const seen = new Set(synth.entries.map((e) => e.key));
      const merged = [...synth.entries];
      for (const e of extra) if (!seen.has(e.key)) { seen.add(e.key); merged.push(e); }
      corpusMemo.set(a.versionHash, { entries: merged, truncated: synth.truncated, notes: synth.notes, seeded: extra.length });
    }
    return corpusMemo.get(a.versionHash);
  };
  const discoveryMemo = new Map();
  const discoveryFor = (a, seeds) => {
    if (!discoveryMemo.has(a.versionHash)) {
      discoveryMemo.set(a.versionHash, discoverSpawns(a, { ...opts, seeds: seeds.map((e) => e.state) }));
    }
    return discoveryMemo.get(a.versionHash);
  };
  const terminalsFor = (a) => {
    const isTerminal = isTerminalOf(a.contract);
    if (!isTerminal) return { error: `child contract declares no terminalStates/terminal key — completion outcomes cannot be enumerated; declare the terminal metadata (this is contract metadata, not machine behavior)` };
    const c = corpusFor(a, childSeeds);
    const states = c.entries.filter((e) => isTerminal(e.state)).map((e) => e.state);
    if (states.length === 0) return { error: `no terminal state of the child is in the explored corpus${c.truncated ? ' (exploration was TRUNCATED — raise --max-states before concluding anything)' : ' — completions can never fire, and the parent would await them forever'}` };
    return { states };
  };

  const parents = [['parent-old', parentOld, parentSeeds], ['parent-new', parentNew, parentSeeds]];
  const children = [['child-old', childOld, childSeeds], ['child-new', childNew, childSeeds]];
  const provenance = [];
  for (const [label, a, extra] of [...parents, ...children]) {
    const c = corpusFor(a, extra);
    provenance.push({ label, count: c.entries.length, seeded: c.seeded, truncated: c.truncated, notes: c.notes });
  }
  for (const [label, a, extra] of parents) {
    const d = discoveryFor(a, extra);
    if (d.truncated || d.notes.length) provenance.push({ label: `${label} spawn discovery`, count: d.spawns.length, truncated: d.truncated, notes: d.notes });
  }

  const cells = [];
  for (const [pl, pa, pseeds] of parents) {
    for (const [cl, ca] of children) {
      cells.push(checkPairing(`${pl} × ${cl}`, pa, ca, childMachineId,
        { parent: corpusFor(pa, pseeds).entries, child: corpusFor(ca, childSeeds).entries },
        terminalsFor(ca), discoveryFor(pa, pseeds)));
    }
  }
  const bounded = provenance.some((p) => p.truncated);
  return { ok: cells.every((c) => c.ok) && (!bounded || allowBounded), cells, provenance, bounded, allowBounded };
}

export function renderMatrix(result) {
  const lines = ['# polyvers matrix — parent × child version pairings', ''];
  for (const p of result.provenance) {
    lines.push(`> ${p.label}: ${p.count} state(s)${p.seeded ? ` (${p.seeded} fleet snapshot(s) seeded)` : ''}${p.truncated ? ' — TRUNCATED (raise --max-states)' : ''}`);
    for (const n of p.notes ?? []) lines.push(`>   note: ${n}`);
  }
  lines.push('');
  lines.push('| pairing | verdict |');
  lines.push('|---|---|');
  for (const c of result.cells) lines.push(`| ${c.pairing} | ${c.ok ? 'PASS' : `**FAIL** (${c.failures.length})`} |`);
  lines.push('');
  for (const c of result.cells.filter((x) => !x.ok)) {
    lines.push(`## ${c.pairing}`);
    for (const f of c.failures) lines.push(`- ${f.id ? `\`${f.id}\` — ` : ''}${f.message}`);
    lines.push('');
  }
  if (result.bounded && !result.allowBounded) {
    lines.push('## BOUNDED — not a pass');
    lines.push('');
    lines.push('The exploration was truncated (see the provenance lines): a clean matrix');
    lines.push('over a truncated space certifies nothing. Raise --max-states, or accept');
    lines.push('explicitly with --allow-bounded.');
    lines.push('');
  }
  lines.push(`## Verdict: ${result.ok ? 'PASS' : 'FAIL'}`);
  lines.push('');
  lines.push('> Scope note: this is the spawn/completion PROTOCOL and DELIVERY matrix —');
  lines.push('> nothing either side can deliver across the version boundary is unhandled.');
  lines.push('> The full product-space model check (joint interleavings against');
  lines.push('> cross-machine invariants) remains open, as recorded in docs/VERSIONING.md.');
  lines.push('');
  return lines.join('\n');
}
