// polyrun DST fleet simulator (composition plan CP-M4) — seeded,
// deterministic falsification against the REAL kernel, complementing the
// static product checker (check-product.mjs) from the other side:
//
// - the CHECKER explores the model of the kernel exhaustively within
//   declared domains; its ladder is a mirror of _dispatchInTxn, and mirrors
//   can drift;
// - the SIMULATOR drives the real kernel (in-memory store, injected clock,
//   seeded schedules) and, on parity runs, steps the checker's model in
//   LOCKSTEP — after every dispatch the durable joint state must equal the
//   model's joint state exactly. Any divergence is a bug in one of them:
//   this is the structural kernel-parity check the counterexample-replay
//   tests only sample.
//
// Chaos runs add what the model deliberately does not cover: duplicate
// actionIds (the dedupe path), deliveries to terminal instances, and store
// faults injected mid-commit (the store's fault hook) followed by
// at-least-once redelivery — after every step the durable journal must
// still audit clean (dense seqs, chained accepted steps, snapshot = last
// accepted post; the soak test's invariants, evaluated continuously).
// Cross-machine invariants (invariants.compose.mjs) are asserted on the
// reconstructed joint state after every top-level dispatch in both modes.
//
// Determinism: mulberry32 seed, injected clock, no workers (see boundary
// below), no Math.random/Date.now — the same seed replays byte-identically,
// and every finding carries {seed, run, step, trail} for exact reproduction.
//
// Honest boundary (disclosed in every report): outbox effects are recorded
// but not executed and timers are not fired (no worker loop) — the actions
// their completions would deliver are already in the external-stimulus
// superset, the same boundary the model checker draws (semantics §3/§4).
// A simulator FALSIFIES; no findings is evidence, never a proof.
'use strict';

import { createRuntime, PoisonedError } from './index.mjs';
import { stable } from '../../scripts/load-spec.mjs';
import { loadProduct, productStep, alphabetFor, mulberry32 } from './check-product.mjs';

/** Reconstruct the model-shaped joint state from the durable store. */
async function jointFromRuntime(rt, parentId, parentMachineId) {
  const inst = await rt.getState(parentId);
  const children = {};
  for (const row of await rt.store.listChildren(parentId)) {
    children[row.child_key] = {
      machineId: row.machine_id,
      state: row.state,
      status: row.status,
      onComplete: row.on_complete ?? null,
      onParentTerminal: row.on_parent_terminal ?? null,
    };
  }
  return { parent: { machineId: parentMachineId, state: inst.state, status: inst.status }, children };
}

/**
 * runFleetSim({ parent, children, invariants, parityRuns, chaosRuns, steps,
 *               seed })
 * parent/children/invariants: the same artifact-path options checkProduct
 * takes (abstraction options are not accepted — the simulator drives real
 * machines only).
 * Returns { simulated: true, findings, stats, notes, parityRuns, chaosRuns,
 *           steps, seed } — findings is the verdict; empty = nothing
 * falsified (not a proof).
 */
export async function runFleetSim(opts) {
  if (opts.abstractChildren?.length) throw new Error('runFleetSim drives real machines only — abstraction is a model-checker device (use polyrun check-product)');
  const { parentDef, machineDefs, mapper, declaredKinds, stateInv, transInv, notes, initJoint } = await loadProduct(opts);
  const ctx = { parentDef, machineDefs, mapper, declaredKinds };
  const parityRuns = opts.parityRuns ?? 25;
  const chaosRuns = opts.chaosRuns ?? 25;
  const steps = opts.steps ?? 20;
  const seed = opts.seed ?? 1;
  if (parityRuns < 0 || chaosRuns < 0 || steps < 1 || parityRuns + chaosRuns < 1) {
    throw new Error(`invalid simulation bounds: parityRuns=${parityRuns} chaosRuns=${chaosRuns} steps=${steps}`);
  }
  const rng = mulberry32(seed);

  const findings = [];
  const seen = new Set();
  const record = (kind, detail, where) => {
    const k = `${kind}:${detail}`;
    if (seen.has(k)) return;
    seen.add(k);
    findings.push({ kind, detail, ...where });
  };
  const stats = { dispatches: 0, deduped: 0, duplicatesSent: 0, staleToTerminal: 0, faultsInjected: 0, poisons: 0 };

  const machinesConfig = [
    { machineId: opts.parent.machineId, module: opts.parent.module, contract: opts.parent.contract, effects: { mapper: opts.parent.mapper, manifest: opts.parent.manifest } },
    ...(opts.children ?? []).map((c) => ({ machineId: c.machineId, module: c.module, contract: c.contract })),
  ];
  if (!opts.parent.manifest) throw new Error('runFleetSim: the parent effects manifest is required (the kernel registers mapper and manifest together)');

  const FAULT_POINTS = ['after-journal', 'after-instance', 'after-outbox', 'after-timers'];

  const runOne = async (runIx, mode) => {
    let simNow = 1;
    const rt = await createRuntime({ store: { sqlite: ':memory:' }, machines: machinesConfig, handlers: {}, now: () => simNow });
    try {
      const parentId = `sim-${mode}-${runIx}`;
      await rt.create(opts.parent.machineId, parentId);
      let modelJoint = initJoint();
      const trail = [];
      // Per-dispatch cascade capture: every journaled sub-step emits one
      // 'step' event post-commit — sliced per dispatch for the transition
      // invariants (the same {target, action, stepKind} shape the model's
      // cascade carries).
      const events = [];
      rt.events.on('step', (e) => events.push(e));
      const keyOf = async (instanceId) => {
        if (instanceId === parentId) return 'parent';
        for (const row of await rt.store.listChildren(parentId)) {
          if (row.instance_id === instanceId) return row.child_key;
        }
        return instanceId; // unknown — surfaces verbatim in the finding
      };
      const where = (step, extra = {}) => ({ mode, run: runIx, step, seed, trail: [...trail], ...extra });
      const sent = []; // {instanceId, action, data, actionId} — duplicate pool

      for (let step = 1; step <= steps; step++) {
        simNow += 1;
        const runtimeJoint = await jointFromRuntime(rt, parentId, opts.parent.machineId);
        const preJoint = mode === 'parity' ? modelJoint : runtimeJoint;
        const stimuli = alphabetFor(preJoint, parentDef, machineDefs);
        if (stimuli.length === 0) break; // fleet fully terminal — run done

        // ---- chaos-only moves: duplicates, stale-to-terminal, faults ----
        if (mode === 'chaos' && sent.length && rng() < 0.2) {
          const dup = sent[Math.floor(rng() * sent.length)];
          stats.duplicatesSent += 1;
          const before = await jointFromRuntime(rt, parentId, opts.parent.machineId);
          const res = await rt.dispatch(dup.instanceId, dup.action, dup.data, dup.actionId);
          const after = await jointFromRuntime(rt, parentId, opts.parent.machineId);
          if (res.deduped) stats.deduped += 1;
          else record('dedupe', `redelivered actionId '${dup.actionId}' was EXECUTED, not deduped`, where(step));
          if (stable(before) !== stable(after)) record('dedupe', `redelivered actionId '${dup.actionId}' changed durable state`, where(step));
          continue;
        }
        if (mode === 'chaos' && rng() < 0.15) {
          const terminals = Object.entries(runtimeJoint.children).filter(([, c]) => c.status === 'terminal');
          if (terminals.length) {
            const [key, child] = terminals[Math.floor(rng() * terminals.length)];
            const def = machineDefs.get(child.machineId);
            const s = def.steps[Math.floor(rng() * def.steps.length)];
            const childRow = await rt.store.findChild(parentId, key);
            stats.staleToTerminal += 1;
            stats.dispatches += 1;
            const res = await rt.dispatch(childRow.instance_id, s.action, s.data, `sim:${mode}:${runIx}:${step}:stale`);
            if (res.stepKind !== 'rejected' || res.rejectReason !== 'terminal') {
              record('doctrine', `delivery to a terminal instance was '${res.stepKind}' (${res.rejectReason ?? 'no reason'}), not the FR-1.2 status-reject`, where(step));
            }
            continue;
          }
        }

        // ---- the scheduled stimulus ----
        const stim = stimuli[Math.floor(rng() * stimuli.length)];
        trail.push(stim);
        const instanceId = stim.target === 'parent'
          ? parentId
          : (await rt.store.findChild(parentId, stim.target))?.instance_id;
        if (!instanceId) {
          record('parity-divergence', `model has child '${stim.target}' but the kernel has no such child`, where(step));
          break;
        }
        const actionId = `sim:${mode}:${runIx}:${step}`;

        // Chaos: inject a store fault mid-commit, then redeliver (the
        // at-least-once crash-retry path). The txn must roll back cleanly.
        let injectFault = mode === 'chaos' && rng() < 0.15;
        if (injectFault) {
          const point = FAULT_POINTS[Math.floor(rng() * FAULT_POINTS.length)];
          stats.faultsInjected += 1;
          let armed = true;
          rt.store.fault = (p) => { if (armed && p === point) { armed = false; throw new Error(`injected fault at ${point}`); } };
        }

        const eventsBefore = events.length;
        let res;
        try {
          stats.dispatches += 1;
          res = await rt.dispatch(instanceId, stim.action, stim.data, actionId);
        } catch (err) {
          rt.store.fault = null;
          if (err instanceof PoisonedError) {
            stats.poisons += 1;
            const modelDefect = mode === 'parity'
              ? productStep(modelJoint, stim, ctx).defect
              : null;
            if (mode === 'parity' && !modelDefect) {
              record('parity-divergence', `kernel POISONED on [${stim.target}] ${stim.action} but the model sees no defect: ${err.message}`, where(step));
            } else if (mode === 'chaos') {
              record('poisoned', `kernel poisoned on [${stim.target}] ${stim.action}: ${err.message}`, where(step));
            }
            break; // the instance is halted — end the run
          }
          if (injectFault) {
            // The crash-retry path: the txn rolled back; redeliver with the
            // SAME actionId (at-least-once). It must succeed cleanly now.
            stats.dispatches += 1;
            res = await rt.dispatch(instanceId, stim.action, stim.data, actionId);
          } else {
            throw err;
          }
        }
        rt.store.fault = null;
        if (res.deduped) stats.deduped += 1;
        sent.push({ instanceId, action: stim.action, data: stim.data, actionId });

        const postJoint = await jointFromRuntime(rt, parentId, opts.parent.machineId);

        // ---- parity: the model in lockstep ----
        if (mode === 'parity') {
          const m = productStep(modelJoint, stim, ctx);
          if (m.defect) {
            record('parity-divergence', `model says production POISONS on [${stim.target}] ${stim.action} (${m.defect.message}) but the kernel completed with '${res.stepKind}'`, where(step));
            break;
          }
          modelJoint = m.joint;
          if (stable(modelJoint) !== stable(postJoint)) {
            record('parity-divergence', `joint state diverged after [${stim.target}] ${stim.action}`, where(step, { model: modelJoint, kernel: postJoint }));
            break;
          }
        }

        // ---- invariants on the DURABLE joint, every step ----
        const cascade = [];
        for (const e of events.slice(eventsBefore)) {
          cascade.push({ target: await keyOf(e.instanceId), action: e.action, data: e.data, stepKind: e.stepKind, ...(e.rejectReason ? { reason: e.rejectReason } : {}) });
        }
        for (const inv of stateInv) {
          let ok; try { ok = inv.pred(postJoint); } catch { ok = false; }
          if (!ok) record(`invariant:${inv.name}`, `state invariant '${inv.name}' violated on the durable joint state`, where(step, { joint: postJoint }));
        }
        for (const inv of transInv) {
          let ok; try { ok = inv.pred(preJoint, { ...stim, cascade }, postJoint); } catch { ok = false; }
          if (!ok) record(`invariant:${inv.name}`, `transition invariant '${inv.name}' violated by [${stim.target}] ${stim.action}`, where(step, { joint: postJoint }));
        }
      }

      // ---- end-of-run journal audit (the soak invariants, per instance) ----
      const auditIds = [parentId, ...(await rt.store.listChildren(parentId)).map((r) => r.instance_id)];
      for (const id of auditIds) {
        const journal = await rt.getJournal(id);
        const inst = await rt.getState(id);
        let state = journal[0]?.post;
        let chainOk = true;
        journal.forEach((row, i) => { if (row.seq !== i) { chainOk = false; record('journal', `${id}: seq gap at ${i}`, where(steps)); } });
        for (const row of journal.slice(1)) {
          if (stable(row.pre) !== stable(state)) { chainOk = false; record('journal', `${id}#${row.seq}: pre does not chain`, where(steps)); break; }
          if (row.step_kind === 'accepted') state = row.post;
          else if (stable(row.post) !== stable(row.pre)) { chainOk = false; record('journal', `${id}#${row.seq}: a non-accepted step mutated state`, where(steps)); break; }
        }
        if (chainOk && journal.length && stable(inst.state) !== stable(state)) {
          record('journal', `${id}: snapshot diverged from the journal's last accepted post`, where(steps));
        }
      }
    } finally {
      await rt.close();
    }
  };

  for (let i = 0; i < parityRuns; i++) await runOne(i, 'parity');
  for (let i = 0; i < chaosRuns; i++) await runOne(i, 'chaos');

  notes.push(`DST simulation: ${parityRuns} parity run(s) (model in lockstep with the real kernel) + ${chaosRuns} chaos run(s) (duplicates, stale deliveries, store faults + at-least-once redelivery) × ≤${steps} step(s), seed ${seed} — deterministic; a simulator FALSIFIES, no findings is not a proof`);
  notes.push('boundary: outbox effects are recorded but not executed and timers are not fired (no worker loop) — their completion actions are already in the external-stimulus superset (semantics §3/§4)');
  return { simulated: true, findings, stats, notes, parityRuns, chaosRuns, steps, seed };
}

export function renderSim(result) {
  const L = [];
  L.push(`DST fleet simulation: ${result.parityRuns} parity + ${result.chaosRuns} chaos run(s) × ≤${result.steps} step(s), seed ${result.seed}`);
  const s = result.stats;
  L.push(`stats: ${s.dispatches} dispatches · ${s.deduped} deduped · ${s.duplicatesSent} duplicates sent · ${s.staleToTerminal} stale-to-terminal · ${s.faultsInjected} store faults injected · ${s.poisons} poisons`);
  for (const n of result.notes ?? []) L.push(`note: ${n}`);
  if (result.findings.length === 0) {
    L.push('NO FINDINGS — falsification only, not a proof (pair with polyrun check-product)');
    return L.join('\n');
  }
  L.push(`${result.findings.length} finding(s):`);
  for (const f of result.findings) {
    L.push(`\n  ✗ [${f.kind}] ${f.detail}`);
    L.push(`    reproduce: seed ${f.seed}, ${f.mode} run ${f.run}, step ${f.step}`);
    L.push(`    trail: ${f.trail.map((t) => `[${t.target}] ${t.action}(${JSON.stringify(t.data)})`).join(' → ') || '(init)'}`);
    if (f.model) L.push(`    model : ${stable(f.model)}`);
    if (f.kernel) L.push(`    kernel: ${stable(f.kernel)}`);
    if (f.joint) L.push(`    joint : ${stable(f.joint)}`);
  }
  return L.join('\n');
}
