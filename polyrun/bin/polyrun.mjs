#!/usr/bin/env node
// polyrun CLI (M1): deploy gate, trace export, DLQ operations.
//
//   polyrun deploy        --config <cfg>            FR-6.2 gate over live snapshots
//   polyrun check-effects --config <cfg> [--machine <id>] [--depth N] [--max-paths N]
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
import { auditMachine, renderAudit } from '../src/audit.mjs';
import { stable } from '../../scripts/load-spec.mjs';

const args = process.argv.slice(2);
const command = args[0] === 'dlq' ? `dlq-${args[1]}` : args[0];
const flag = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };

const usage = () => {
  console.error('usage: polyrun <deploy|export-traces|dlq ls|dlq retry|dlq discard> --config <polyrun.config.mjs> [--instance <id>] [--intent <intentId>] [--out <file>]');
  process.exit(2);
};

const configPath = flag('config');
if (!configPath || !command) usage();

const config = await loadConfig(configPath);

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
        contract: m.contract,
        invariants: m.effectInvariants,
        maxDepth: flag('depth') ? Number(flag('depth')) : undefined,
        maxPaths: flag('max-paths') ? Number(flag('max-paths')) : undefined,
      });
      console.log(`== ${m.machineId} ==`);
      console.log(renderReport(result));
      if (result.violations.length > 0) exitCode = 1;
    }
    if (ran === 0) { console.error('check-effects: nothing to check'); exitCode = 1; }
  } else if (command === 'audit') {
    // FR-7.2: replay the production journal through the module — drift report.
    const only = flag('machine');
    const sinceMs = flag('since') ? Number(flag('since')) : 0;
    for (const [machineId] of rt.machines) {
      if (only && machineId !== only) continue;
      const result = await auditMachine({ runtime: rt, machineId, sinceMs, instanceId: flag('instance') });
      console.log(renderAudit(machineId, result));
      if (result.mismatches.length > 0) exitCode = 1;
    }
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
