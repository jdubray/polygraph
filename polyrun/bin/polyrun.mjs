#!/usr/bin/env node
// polyrun CLI (M1): deploy gate, trace export, DLQ operations.
//
//   polyrun deploy        --config <cfg>            FR-6.2 gate over live snapshots
//   polyrun migrate       --config <cfg> [--machine <id>] [--apply]   pure migrate.cjs over live snapshots
//   polyrun archive       --config <cfg> --before <ms|ISO date> --out <dir> [--apply]
//   polyrun check-effects --config <cfg> [--machine <id>] [--depth N] [--max-paths N] [--allow-bounded]
//   polyrun check-product --config <cfg> --parent <machineId> --invariants <compose.mjs> [--max-states N] [--allow-bounded] [--abstract-child <id[,id]> [--abstract-max-states N]] [--pct N [--pct-depth D] [--pct-steps L] [--seed S] [--allow-sampled]] [--json <out>]
//   polyrun simulate      --config <cfg> --parent <machineId> --invariants <compose.mjs> [--parity-runs N] [--chaos-runs N] [--steps L] [--seed S] [--json <out>]
//   polyrun audit         --config <cfg> [--machine <id>] [--instance <id>] [--since <ms-epoch>]
//   polyrun export-traces --config <cfg> --instance <id> [--out <file>]
//   polyrun dlq ls        --config <cfg>
//   polyrun dlq retry     --config <cfg> --intent <intentId>
//   polyrun dlq discard   --config <cfg> --intent <intentId>
//
// Everything here is pure local execution — no API key (NFR-6).
'use strict';

import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '../src/index.mjs';
import { loadConfig } from '../src/config.mjs';
import { checkEffects, renderReport } from '../src/check-effects.mjs';
import { checkProduct, pctSample, renderProduct } from '../src/check-product.mjs';
import { runFleetSim, renderSim } from '../src/simulate.mjs';
import { auditMachine, renderAudit } from '../src/audit.mjs';
import { stable } from '../../scripts/load-spec.mjs';

const args = process.argv.slice(2);
const command = args[0] === 'dlq' ? `dlq-${args[1]}` : args[0];
const flag = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const numFlag = (name, dflt, min = 1) => {
  const raw = flag(name);
  if (raw === undefined) return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) { console.error(`invalid --${name} '${raw}'`); process.exit(2); }
  return n;
};

const usage = () => {
  console.error('usage: polyrun <deploy|export-traces|dlq ls|dlq retry|dlq discard> --config <polyrun.config.mjs> [--instance <id>] [--intent <intentId>] [--out <file>]');
  process.exit(2);
};

const configPath = flag('config');
if (!configPath || !command) usage();

const config = await loadConfig(configPath);

// check-product (static model check) and simulate (DST against fresh
// in-memory runtimes) never touch the CONFIGURED store — they dispatch
// BEFORE the runtime is built. Opening the production store here would both
// double the module loads and make an unreachable DB fail commands that do
// not need it.
if (command === 'check-product' || command === 'simulate') {
  const parentId = flag('parent');
  const invariantsPath = flag('invariants');
  if (!parentId || !invariantsPath) {
    console.error(`${command} requires --parent <machineId> and --invariants <compose.mjs>`);
    process.exit(2);
  }
  const pm = (config.machines ?? []).find((m) => m.machineId === parentId);
  if (!pm) { console.error(`check-product: no machine '${parentId}' in the config`); process.exit(2); }
  if (!pm.effects || !pm.contract) {
    console.error(`check-product: machine '${parentId}' needs a contract and an effects mapper in the config (the cascade IS the mapper's output)`);
    process.exit(2);
  }
  // Every other configured machine is a candidate spawn target. A machine
  // without a contract cannot enter the product model (no projection, no
  // terminal metadata) — disclose the exclusion loudly instead of silently
  // reporting its spawns as 'not registered'. A child WITH its own mapper
  // is passed through so checkProduct refuses (v1 models only the parent's
  // cascades — a silent drop would certify an unexplored fleet).
  const children = [];
  for (const m of config.machines ?? []) {
    if (m.machineId === parentId) continue;
    if (!m.contract) {
      console.error(`check-product: machine '${m.machineId}' has no contract — it cannot enter the product model, and a spawnChild targeting it will be reported as unregistered (add a contract to include it)`);
      continue;
    }
    children.push({ machineId: m.machineId, module: m.module, contract: m.contract, mapper: m.effects?.mapper });
  }
  // CP-M2 surfaces: --abstract-child <id[,id]> collapses those children to
  // running + terminal outcomes (refinement-checked, own cap via
  // --abstract-max-states); --pct N switches to seeded PCT sampling
  // (--pct-depth, --pct-steps, --seed — seed 0 is legal) — a sampler is
  // never a pass without --allow-sampled (BOUNDED doctrine).
  const productOpts = {
    parent: { machineId: pm.machineId, module: pm.module, contract: pm.contract, mapper: pm.effects.mapper, manifest: pm.effects.manifest },
    children,
    invariants: invariantsPath,
    abstractChildren: (flag('abstract-child') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    maxStates: numFlag('max-states', undefined),
    abstractMaxStates: numFlag('abstract-max-states', undefined),
  };
  let productExit = 0;
  try {
    if (command === 'simulate') {
      // CP-M4: the seeded DST fleet simulator — real kernel, in-memory
      // stores, injected clock; parity runs step the model in lockstep,
      // chaos runs add duplicates/stale deliveries/store faults. Findings
      // are the verdict; a clean run is falsification evidence, not a proof.
      const result = await runFleetSim({
        ...productOpts,
        abstractChildren: [],
        parityRuns: numFlag('parity-runs', undefined, 0),
        chaosRuns: numFlag('chaos-runs', undefined, 0),
        steps: numFlag('steps', undefined),
        seed: numFlag('seed', undefined, 0),
      });
      console.log(renderSim(result));
      if (result.findings.length > 0) productExit = 1;
      const jsonOut = flag('json');
      if (jsonOut) writeFileSync(jsonOut, JSON.stringify(result, null, 2));
    } else {
      const pct = numFlag('pct', undefined);
      const result = pct !== undefined
        ? await pctSample({ ...productOpts, schedules: pct, pctDepth: numFlag('pct-depth', undefined), pctSteps: numFlag('pct-steps', undefined), seed: numFlag('seed', undefined, 0) })
        : await checkProduct(productOpts);
      console.log(renderProduct(result));
      if (result.violations.length > 0) productExit = 1;
      if (result.capHit && !args.includes('--allow-bounded')) {
        console.error('check-product: BOUNDED exploration is not a full pass (use --allow-bounded to accept)');
        productExit = productExit || 1;
      }
      if (result.sampled && result.violations.length === 0 && !args.includes('--allow-sampled')) {
        console.error('check-product: a clean SAMPLED run is not a proof of absence (use --allow-sampled to accept, or run exhaustively)');
        productExit = productExit || 1;
      }
      const jsonOut = flag('json');
      if (jsonOut) writeFileSync(jsonOut, JSON.stringify(result, null, 2));
    }
  } catch (err) {
    console.error(String(err && err.message));
    productExit = 1;
  }
  process.exit(productExit);
}

// The runtime constructor IS the first half of the deploy gate: module loads,
// validate() strict-clean, manifest/contract cross-checks, observable-is-total.
let rt;
try {
  rt = await createRuntime(config);
} catch (err) {
  console.error(`GATE FAIL (load): ${err.message}`);
  process.exit(1);
}

let exitCode = 0;
try {
  if (command === 'deploy') {
    console.log('polyrun deploy gate (FR-6.2)');
    console.log('  [1/3] module gates (validate strict-clean, domain cross-checks, observable-is-total): PASS (loaded)');

    // [2/3] snapshot round-trip over live instances: the NEW module must
    // accept every persisted snapshot and reproduce it exactly.
    let checked = 0, failed = 0, poisonedSkipped = 0;
    for (const [machineId, machine] of rt.machines) {
      const instances = await rt.list(machineId);
      for (const inst of instances) {
        if (inst.status === 'poisoned') {
          // A poisoned snapshot may legitimately be unloadable; it must not
          // block every future deploy — report it separately.
          poisonedSkipped += 1;
          console.error(`  note: ${machineId}/${inst.instance_id} is POISONED — excluded from the gate, resolve it via the DLQ/journal`);
          continue;
        }
        checked += 1;
        try {
          machine.mod.init();
          machine.mod.setState(inst.state);
          const raw = JSON.parse(JSON.stringify(machine.mod.getState(), (k, v) =>
            (typeof k === 'string' && k.startsWith('__')) || typeof v === 'function' ? undefined : v));
          const projected = {};
          for (const k of machine.observableKeys ?? Object.keys(raw)) projected[k] = raw[k];
          if (stable(projected) !== stable(inst.state)) {
            failed += 1;
            console.error(`  round-trip FAIL: ${machineId}/${inst.instance_id} — module does not reproduce its persisted snapshot`);
          }
        } catch (err) {
          failed += 1;
          console.error(`  round-trip FAIL: ${machineId}/${inst.instance_id} — ${err.message}`);
        }
      }
    }
    console.log(`  [2/3] setState round-trip over live snapshots: ${checked} checked, ${failed} failed${poisonedSkipped ? `, ${poisonedSkipped} poisoned excluded` : ''}${failed ? ' — GATE FAIL' : ': PASS'}`);
    if (failed) exitCode = 1;

    // [3/3] state invariants over live snapshots (per-machine `invariants`
    // module exporting stateInvariants: [{name, pred}]). Full model-checking
    // from live snapshots as initial states arrives with the M2 --effects
    // checker; this tier evaluates the invariants pointwise.
    let invChecked = 0, invFailed = 0, invSkipped = 0;
    for (const m of config.machines ?? []) {
      if (!m.invariants) { invSkipped += 1; continue; }
      let mod;
      try {
        mod = await import(pathToFileURL(m.invariants).href);
      } catch (err) {
        invFailed += 1;
        console.error(`  invariant FAIL: cannot load invariants for '${m.machineId}' (${m.invariants}): ${err.message}`);
        continue;
      }
      const preds = mod.stateInvariants ?? mod.invariants ?? [];
      const instances = await rt.list(m.machineId);
      for (const inst of instances) {
        for (const inv of preds) {
          invChecked += 1;
          let ok = false;
          try { ok = !!inv.pred(inst.state); } catch { ok = false; }
          if (!ok) {
            invFailed += 1;
            console.error(`  invariant FAIL: ${m.machineId}/${inst.instance_id} violates '${inv.name}'`);
          }
        }
      }
    }
    console.log(`  [3/3] state invariants over live snapshots: ${invChecked} checks, ${invFailed} failed${invSkipped ? ` (${invSkipped} machine(s) without invariants file)` : ''}${invFailed ? ' — GATE FAIL' : invChecked ? ': PASS' : ''}`);
    if (invFailed) exitCode = 1;

    console.log(exitCode ? 'DEPLOY GATE: FAIL' : 'DEPLOY GATE: PASS');
  } else if (command === 'check-effects') {
    // §6.2: explore the machine ∘ mapper composition against effect-emission
    // invariants (machine config key: effectInvariants).
    const only = flag('machine');
    const maxDepth = numFlag('depth', undefined);
    const maxPaths = numFlag('max-paths', undefined);
    let ran = 0;
    for (const m of config.machines ?? []) {
      if (only && m.machineId !== only) continue;
      if (!m.effects || !m.effectInvariants) {
        console.log(`${m.machineId}: skipped (needs effects mapper + effectInvariants in the config)`);
        continue;
      }
      ran += 1;
      const result = await checkEffects({
        module: m.module,
        mapper: m.effects.mapper,
        manifest: m.effects.manifest,
        contract: m.contract,
        invariants: m.effectInvariants,
        maxDepth,
        maxPaths,
      });
      console.log(`== ${m.machineId} ==`);
      console.log(renderReport(result));
      if (result.violations.length > 0) exitCode = 1;
      // A bounded run is NOT a pass for CI gating — "0 violations over almost
      // nothing" must not exit 0 (unless the operator explicitly accepts it).
      if (result.bounded && !args.includes('--allow-bounded')) {
        console.error(`${m.machineId}: BOUNDED exploration is not a full pass (use --allow-bounded to accept)`);
        exitCode = exitCode || 1;
      }
    }
    if (ran === 0) { console.error('check-effects: nothing to check'); exitCode = 1; }
  } else if (command === 'audit') {
    // FR-7.2: replay the production journal through the module — drift report.
    const only = flag('machine');
    const sinceMs = numFlag('since', 0, 0);
    for (const [machineId] of rt.machines) {
      if (only && machineId !== only) continue;
      const result = await auditMachine({ runtime: rt, machineId, sinceMs, instanceId: flag('instance') });
      console.log(renderAudit(machineId, result));
      if (result.mismatches.length > 0) exitCode = 1;
    }
  } else if (command === 'migrate') {
    // FR-6.2 step 4: a pure migrate.cjs (module.exports.migrate(oldState) ->
    // newState) is gated over live snapshots and applied only with --apply.
    // Two-phase: validate EVERYTHING first (a failure applies nothing), then
    // apply each instance fenced on its validation-time seq and with a
    // $migrate journal marker in the same transaction — the audit's
    // version-aware replay depends on that record.
    const only = flag('machine');
    const apply = args.includes('--apply');
    let migrated = 0, failed = 0, fencedOut = 0, ran = 0;
    for (const m of config.machines ?? []) {
      if (only && m.machineId !== only) continue;
      if (!m.migrate) continue;
      ran += 1;
      const { createRequire } = await import('node:module');
      const migrateMod = createRequire(import.meta.url)(m.migrate);
      if (typeof migrateMod.migrate !== 'function') { console.error(`${m.machineId}: ${m.migrate} does not export migrate()`); exitCode = 1; continue; }
      const machine = rt.machines.get(m.machineId);
      let preds = [];
      if (m.invariants) {
        try { preds = (await import(pathToFileURL(m.invariants).href)).stateInvariants ?? []; } catch { /* gate reported by deploy */ }
      }
      // ---- phase 1: validate all ----
      const plan = [];
      for (const inst of await rt.list(m.machineId)) {
        if (inst.status === 'poisoned') continue;
        try {
          const next = migrateMod.migrate(inst.state);
          machine.mod.init();
          machine.mod.setState(next); // the NEW module must accept the migrated snapshot
          // the persisted snapshot must equal the observable projection —
          // stray keys a merge-lenient module tolerates would poison later
          const raw = JSON.parse(JSON.stringify(machine.mod.getState(), (k, v) =>
            (typeof k === 'string' && k.startsWith('__')) || typeof v === 'function' ? undefined : v));
          const projected = {};
          for (const k of machine.observableKeys ?? Object.keys(raw)) projected[k] = raw[k];
          if (stable(projected) !== stable(next)) {
            throw new Error('migrated state is not the module projection (stray or dropped keys)');
          }
          for (const inv of preds) {
            if (!inv.pred(next)) throw new Error(`migrated state violates '${inv.name}'`);
          }
          plan.push({ inst, next });
        } catch (err) {
          failed += 1;
          console.error(`  migrate FAIL: ${m.machineId}/${inst.instance_id} — ${err.message}`);
        }
      }
      if (failed > 0) continue; // gate: apply nothing for this machine
      // ---- phase 2: apply, fenced + journaled ----
      for (const { inst, next } of plan) {
        if (apply) {
          const applied = await rt.store.txn(async () => {
            const newSeq = inst.seq + 1;
            const changed = await rt.store.rewriteSnapshot(inst.instance_id, next, machine.version, rt.now(), inst.seq, newSeq);
            if (!changed) return false; // a live dispatch moved the instance
            await rt.store.insertJournal({
              instanceId: inst.instance_id, machineVersion: machine.version, seq: newSeq,
              action: '$migrate', data: {}, pre: inst.state, post: next,
              stepKind: 'accepted', rejectReason: null, actionId: `$migrate:${newSeq}`, now: rt.now(),
            });
            return true;
          });
          if (applied) migrated += 1;
          else { fencedOut += 1; console.error(`  migrate SKIP: ${m.machineId}/${inst.instance_id} moved during migration — re-run`); }
        } else migrated += 1;
      }
    }
    if (ran === 0) { console.error('migrate: no machine with a migrate module (config key: migrate) matched'); exitCode = 1; }
    console.log(`migrate: ${migrated} snapshot(s) ${apply ? 'MIGRATED' : 'validated (dry run — use --apply)'}, ${failed} failed${fencedOut ? `, ${fencedOut} skipped (moved during migration — re-run)` : ''}`);
    if (failed || fencedOut) exitCode = 1;
  } else if (command === 'archive') {
    // FR-1.2 retention: export each eligible terminal instance (journal +
    // final state, ndjson) then purge its rows — only with --apply.
    const beforeRaw = flag('before');
    const before = /^\d+$/.test(beforeRaw ?? '') ? Number(beforeRaw) : Date.parse(beforeRaw ?? '');
    if (!Number.isFinite(before)) { console.error(`invalid --before '${beforeRaw}' (ms epoch or ISO date)`); process.exit(2); }
    const outDir = flag('out');
    const apply = args.includes('--apply');
    if (apply && !outDir) { console.error('--apply requires --out <dir> (never purge without an export)'); process.exit(2); }
    const { mkdirSync } = await import('node:fs');
    if (outDir && apply) mkdirSync(outDir, { recursive: true });
    let archived = 0, skipped = 0;
    let cursor = { updatedAt: 0, instanceId: '' };
    for (;;) {
      const batch = await rt.store.archivableInstances(before, 100, cursor);
      if (batch.length === 0) break;
      cursor = { updatedAt: batch[batch.length - 1].updated_at, instanceId: batch[batch.length - 1].instance_id };
      for (const inst of batch) {
        if (!apply) { archived += 1; continue; } // dry run: report only, no side effects
        const journal = await rt.getJournal(inst.instance_id);
        // instance ids are caller-supplied — never let them become path segments
        const safeName = encodeURIComponent(inst.instance_id);
        const lines = journal.map((r) => JSON.stringify(r)).join('\n');
        writeFileSync(`${outDir}/${safeName}.ndjson`, `${JSON.stringify({ archived: inst })}\n${lines}\n`);
        try {
          // fenced on the exported seq: rows journaled after the export
          // (e.g. a stale timer's rejected(terminal) step) must never be
          // purged unexported
          await rt.store.purgeInstance(inst.instance_id, inst.seq);
          archived += 1;
        } catch (err) {
          skipped += 1;
          console.error(`  skip ${inst.instance_id}: ${err.message}`);
        }
      }
    }
    console.log(`archive: ${archived} instance(s) ${apply ? 'exported+purged' : 'eligible (dry run — use --apply with --out)'}${skipped ? `, ${skipped} skipped (see reasons above)` : ''}`);
  } else if (command === 'export-traces') {
    const instance = flag('instance');
    if (!instance) usage();
    const text = await rt.exportTraces(instance);
    const out = flag('out');
    if (out) { writeFileSync(out, text + '\n'); console.log(`wrote ${text ? text.split('\n').length : 0} windows to ${out}`); }
    else process.stdout.write(text + '\n');
  } else if (command === 'dlq-ls') {
    const rows = await rt.store.dlqList();
    if (rows.length === 0) console.log('DLQ empty');
    for (const r of rows) {
      console.log(`${r.intent_id}  ${r.instance_id}#${r.seq}  ${r.kind}  attempts=${r.attempts}  ${r.last_error}`);
    }
  } else if (command === 'dlq-retry' || command === 'dlq-discard') {
    const intent = flag('intent');
    if (!intent) usage();
    // The store updates are fenced on status='dead'; verify the target IS
    // dead first so a typo'd id fails loudly instead of printing success.
    const dead = await rt.store.dlqList();
    if (!dead.some((r) => r.intent_id === intent)) {
      console.error(`no dead intent '${intent}' in the DLQ`);
      exitCode = 1;
    } else if (command === 'dlq-retry') {
      await rt.store.dlqRetry(intent, rt.now());
      console.log(`re-queued ${intent}`);
    } else {
      await rt.store.dlqDiscard(intent);
      console.log(`discarded ${intent}`);
    }
  } else {
    usage();
  }
} catch (err) {
  // Operator tools print the error, never a raw stack; the exit code is the
  // machine-readable signal.
  console.error(String(err && err.message));
  exitCode = 1;
} finally {
  await rt.close();
}
process.exit(exitCode);
