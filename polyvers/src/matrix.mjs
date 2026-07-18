// polyvers cross-machine version matrix (M3) — the recorded open item from
// docs/VERSIONING.md, attempted at the depth that is mechanically checkable
// today.
//
// During a rollout window, parent {old,new} × child {old,new} coexist: a
// parent that spawned a child under one version pairing receives its
// completion under another. For each of the four pairings this gate checks
// the spawn/completion PROTOCOL and its DELIVERY:
//
//   wiring     — every spawnChild intent the parent's mapper can emit targets
//                a child whose creation/onParentTerminal actions exist, and an
//                onComplete action the parent itself exports (the polyrun
//                registration/dispatch checks, run pre-deploy per pairing)
//   completion — every terminal outcome the child can actually reach is
//                delivered into the parent ({childKey, childState}, exactly
//                what the polyrun worker dispatches) at every parent fleet
//                state, and must land as accepted or a NAMED observable
//                reject (the stimuli doctrine, cross-machine)
//   cancel     — the parent-terminal cancel action is delivered to every
//                child fleet state under the same rule
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
import { terminalKeyOf } from './artifacts.mjs';
import { stimulusOutcome } from './gates.mjs';

const { makeSamAdapter, domainFromManifest } = samAdapter;

/**
 * Enumerate the spawnChild intents a parent version's mapper can emit:
 * BFS the parent machine over its manifest domain and run the mapper on
 * every ACCEPTED mutating transition (kernel parity: the mapper only runs on
 * accepted steps). Deduped by the protocol tuple.
 */
export function discoverSpawns(parentA, { maxStates = 20000 } = {}) {
  if (typeof parentA.mapper !== 'function') {
    throw new Error('matrix: the parent version has no effects.cjs mapper — spawn intents cannot be enumerated');
  }
  const mod = makeSamAdapter(parentA.module);
  const { steps } = domainFromManifest(parentA.module);
  const spawns = new Map(); // protocol tuple -> intent
  const seen = new Set();
  const init = mod.init();
  seen.add(stable(init));
  const queue = [init];
  let head = 0;
  while (head < queue.length && seen.size < maxStates) {
    const s = queue[head++];
    const sJson = JSON.stringify(s);
    for (const { action, data } of steps) {
      let post;
      try { post = mod.next(JSON.parse(sJson), action, data); } catch { continue; }
      const key = stable(post);
      const mutated = key !== stable(s);
      if (mutated) {
        let intents = [];
        try { intents = parentA.mapper(s, action, data, post, 'accepted') || []; } catch { /* mapper defects are check-effects' job */ }
        for (const it of intents) {
          if (it && it.kind === 'spawnChild') {
            const tuple = stable({ machineId: it.machineId, onComplete: it.onComplete ?? null, onParentTerminal: it.onParentTerminal ?? null, creation: it.creation?.action ?? null });
            if (!spawns.has(tuple)) spawns.set(tuple, it);
          }
        }
      }
      if (!seen.has(key)) { seen.add(key); queue.push(post); }
    }
  }
  return [...spawns.values()];
}

/** The child's reachable TERMINAL states (what completions can actually carry). */
function terminalStates(childA, { maxStates = 20000 } = {}) {
  const tKey = terminalKeyOf(childA.contract);
  const tVals = new Set(childA.contract.terminalStates ?? []);
  if (!tKey || tVals.size === 0) return [];
  return synthesizeCorpus(childA.module, { maxStates }).entries
    .filter((e) => tVals.has(e.state[tKey]))
    .map((e) => e.state);
}

/**
 * checkPairing(parentA, childA, childMachineId, corpora) — one cell of the
 * matrix. corpora: { parent: entries, child: entries } fleet states for
 * delivery checks. Returns { pairing, ok, failures }.
 */
export function checkPairing(label, parentA, childA, childMachineId, corpora, spawns) {
  const failures = [];
  const relevant = spawns.filter((s) => s.machineId === childMachineId);
  if (relevant.length === 0) {
    failures.push({ message: `the parent's mapper emits no spawnChild for machine '${childMachineId}' — nothing to check would pass vacuously; refusing (wrong --child-id, or the parent does not spawn this child)` });
    return { pairing: label, ok: false, failures };
  }
  for (const spawn of relevant) {
    // ── wiring (polyrun registration/dispatch checks, per pairing) ──
    if (spawn.onComplete && typeof parentA.module.actions[spawn.onComplete] !== 'function') {
      failures.push({ message: `spawn onComplete '${spawn.onComplete}' is not in the parent's action surface — the child's completion would poison the parent` });
    }
    if (spawn.onParentTerminal && typeof childA.module.actions[spawn.onParentTerminal] !== 'function') {
      failures.push({ message: `spawn onParentTerminal '${spawn.onParentTerminal}' is not in the child's action surface — cancelling on parent-terminal would poison the child` });
    }
    if (spawn.creation?.action && typeof childA.module.actions[spawn.creation.action] !== 'function') {
      failures.push({ message: `spawn creation action '${spawn.creation.action}' is not in the child's action surface — spawning would fail at dispatch` });
    }
    // ── completion delivery: child terminal outcomes → parent fleet ──
    if (spawn.onComplete && typeof parentA.module.actions[spawn.onComplete] === 'function') {
      const outcomes = terminalStates(childA);
      if (outcomes.length === 0) {
        failures.push({ message: `child '${childMachineId}' has no reachable terminal state — completions can never fire, and the parent would await them forever` });
      }
      for (const childState of outcomes) {
        for (const { id, state } of corpora.parent) {
          const verdict = stimulusOutcome(parentA.module, state, spawn.onComplete, { childKey: 'matrix-check', childState });
          if (!verdict.ok) {
            failures.push({ id, message: `completion '${spawn.onComplete}({childState: ${stable(childState)}})' from the child's terminal outcome ${verdict.why}` });
          }
        }
      }
    }
    // ── cancel delivery: parent-terminal cancel → child fleet ──
    if (spawn.onParentTerminal && typeof childA.module.actions[spawn.onParentTerminal] === 'function') {
      for (const { id, state } of corpora.child) {
        const verdict = stimulusOutcome(childA.module, state, spawn.onParentTerminal, {});
        if (!verdict.ok) {
          failures.push({ id, message: `parent-terminal cancel '${spawn.onParentTerminal}' delivered to this child state ${verdict.why}` });
        }
      }
    }
  }
  // One witness per distinct message keeps a fleet-wide failure readable.
  const seenMsg = new Set();
  const deduped = failures.filter((f) => !seenMsg.has(f.message) && seenMsg.add(f.message));
  return { pairing: label, ok: deduped.length === 0, failures: deduped };
}

/**
 * runMatrix({parentOld, parentNew, childOld, childNew, childMachineId}) —
 * the 2×2 rollout-window matrix. Spawns are discovered per PARENT version
 * (each parent's own mapper defines what it can emit).
 */
export function runMatrix({ parentOld, parentNew, childOld, childNew, childMachineId, maxStates }) {
  const corpus = (a) => synthesizeCorpus(a.module, maxStates ? { maxStates } : {}).entries;
  const parents = [['parent-old', parentOld], ['parent-new', parentNew]];
  const children = [['child-old', childOld], ['child-new', childNew]];
  const spawnsByParent = new Map(parents.map(([label, a]) => [label, discoverSpawns(a, maxStates ? { maxStates } : {})]));
  const corpora = new Map([...parents, ...children].map(([label, a]) => [label, corpus(a)]));
  const cells = [];
  for (const [pl, pa] of parents) {
    for (const [cl, ca] of children) {
      cells.push(checkPairing(`${pl} × ${cl}`, pa, ca, childMachineId, { parent: corpora.get(pl), child: corpora.get(cl) }, spawnsByParent.get(pl)));
    }
  }
  return { ok: cells.every((c) => c.ok), cells };
}

export function renderMatrix(result) {
  const lines = ['# polyvers matrix — parent × child version pairings', ''];
  lines.push('| pairing | verdict |');
  lines.push('|---|---|');
  for (const c of result.cells) lines.push(`| ${c.pairing} | ${c.ok ? 'PASS' : `**FAIL** (${c.failures.length})`} |`);
  lines.push('');
  for (const c of result.cells.filter((x) => !x.ok)) {
    lines.push(`## ${c.pairing}`);
    for (const f of c.failures) lines.push(`- ${f.id ? `\`${f.id}\` — ` : ''}${f.message}`);
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
