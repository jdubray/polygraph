// polyrun kernel — the dispatch loop over a polygen-authored SAM v2
// strict-profile module (docs/polyrun-spec.md §5.3).
//
// The kernel hosts the verified artifact unchanged: rehydrate via
// init()+setState() (reset-then-merge, same semantics as scripts/
// sam-adapter.cjs and sam-tv.mjs give every replay window), fire
// actions[name](data), classify via instance({}).lastStep(), commit
// everything the step decided in one store transaction. It contains no
// business logic — that is the whole point.
'use strict';

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadSpec } from '../../scripts/load-spec.mjs';
import { Store } from './store.mjs';

const BUILTIN_KINDS = new Set(['timer', 'cancelTimer']);

const sanitizeReplacer = (key, value) => {
  if (typeof key === 'string' && key.startsWith('__')) return undefined;
  if (typeof value === 'function') return undefined;
  return value;
};

function isSamV2Module(mod) {
  return !!mod
    && typeof mod.instance === 'function'
    && typeof mod.init === 'function'
    && typeof mod.getState === 'function'
    && typeof mod.setState === 'function'
    && mod.actions !== null && typeof mod.actions === 'object';
}

const sha = (...parts) => createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);

export class PoisonedError extends Error {
  constructor(instanceId, message) {
    super(`instance ${instanceId} poisoned: ${message}`);
    this.name = 'PoisonedError';
  }
}

export class ConflictError extends Error {
  constructor(message) { super(message); this.name = 'ConflictError'; }
}

export class Runtime {
  constructor({ store, dbPath, machines = [], handlers = {}, now = Date.now }) {
    this.store = store ?? new Store(dbPath ?? ':memory:');
    this.handlers = handlers;
    this.now = now;
    this.machines = new Map();
    for (const m of machines) this.registerMachine(m);
  }

  close() { this.store.close(); }

  registerMachine({ machineId, module: modulePath, contract: contractPath, effects, isTerminal }) {
    const abs = resolve(modulePath);
    const source = readFileSync(abs, 'utf-8');
    const mod = loadSpec(abs);
    if (!isSamV2Module(mod)) {
      throw new Error(`machine '${machineId}': module does not export the v2 SAM surface { instance, init, actions, getState, setState }`);
    }
    const contract = contractPath ? JSON.parse(readFileSync(resolve(contractPath), 'utf-8')) : null;

    let mapper = null;
    let manifest = null;
    if (effects) {
      const effMod = loadSpec(resolve(effects.mapper));
      if (typeof effMod.effects !== 'function') {
        throw new Error(`machine '${machineId}': effect mapper does not export an effects() function`);
      }
      mapper = effMod.effects;
      manifest = JSON.parse(readFileSync(resolve(effects.manifest), 'utf-8'));
      this._crossCheckManifest(machineId, mod, contract, manifest);
    }

    let terminal = isTerminal;
    if (!terminal && contract && Array.isArray(contract.terminalStates)) {
      // Convention shared with polygen contracts: terminalStates enumerates
      // values of the contract's FIRST stateKey unless a terminalKey is named.
      const key = contract.terminalKey
        ?? (Array.isArray(contract.stateKeys) && contract.stateKeys[0] && contract.stateKeys[0].name);
      const values = new Set(contract.terminalStates);
      terminal = key ? (state) => values.has(state[key]) : () => false;
    }

    const observableKeys = contract && Array.isArray(contract.stateKeys)
      ? contract.stateKeys.map((k) => k.name)
      : null;

    this.machines.set(machineId, {
      machineId,
      mod,
      version: sha(source).slice(0, 12),
      mapper,
      manifest,
      isTerminal: terminal ?? (() => false),
      observableKeys,
    });
  }

  _crossCheckManifest(machineId, mod, contract, manifest) {
    // The §4.2 domain gate: every completion action the manifest wires must
    // exist in the machine's action surface; a mismatch is a load-time error,
    // never a runtime surprise.
    const actionNames = new Set(Object.keys(mod.actions));
    if (contract && contract.actions) for (const a of Object.keys(contract.actions)) {
      if (!actionNames.has(a)) throw new Error(`machine '${machineId}': contract action '${a}' is not exported by the module`);
    }
    for (const [kind, decl] of Object.entries(manifest.effects ?? {})) {
      for (const hook of ['onSuccess', 'onFailure', 'onExhausted']) {
        const target = decl[hook] && decl[hook].action;
        if (target && !actionNames.has(target)) {
          throw new Error(`machine '${machineId}': manifest effect '${kind}' ${hook} action '${target}' is not in the module's action surface`);
        }
      }
    }
  }

  // ---- projection / rehydration --------------------------------------------

  _snapshot(machine) {
    const raw = JSON.parse(JSON.stringify(machine.mod.getState(), sanitizeReplacer));
    if (!machine.observableKeys) return raw;
    const out = {};
    for (const k of machine.observableKeys) out[k] = raw[k];
    return out;
  }

  _rehydrate(machine, state) {
    // Reset-then-merge: setState is merge-only, so without init() residue from
    // the previous dispatch would leak between instances (same rationale as
    // sam-adapter.cjs).
    machine.mod.init();
    try {
      const model = machine.mod.instance({}).state();
      if (model && typeof model.clearError === 'function') model.clearError();
    } catch { /* model key may shadow the accessor; strict errors throw anyway */ }
    machine.mod.setState(state);
  }

  _lastStep(machine, action) {
    try {
      const acc = machine.mod.instance({});
      if (typeof acc.lastStep !== 'function') return null;
      const step = acc.lastStep();
      if (!step || (step.intent !== undefined && step.intent !== null && step.intent !== action)) return null;
      return step;
    } catch { return null; }
  }

  // ---- API -------------------------------------------------------------------

  create(machineId, instanceId) {
    const machine = this.machines.get(machineId);
    if (!machine) throw new Error(`unknown machine '${machineId}'`);
    const id = instanceId ?? randomUUID();
    const existing = this.store.getInstance(id);
    if (existing) {
      if (existing.machine_id !== machineId) throw new ConflictError(`instance '${id}' already exists for machine '${existing.machine_id}'`);
      return { instanceId: id, created: false, state: existing.state };
    }
    machine.mod.init();
    const state = this._snapshot(machine);
    this.store.insertInstance({ instanceId: id, machineId, machineVersion: machine.version, state, now: this.now() });
    return { instanceId: id, created: true, state };
  }

  getState(instanceId) {
    const inst = this.store.getInstance(instanceId);
    if (!inst) throw new Error(`unknown instance '${instanceId}'`);
    return { state: inst.state, status: inst.status, seq: inst.seq, machineId: inst.machine_id };
  }

  getJournal(instanceId) { return this.store.getJournal(instanceId); }

  list(machineId, status) { return this.store.listInstances(machineId, status); }

  /** ndjson Polygraph trace windows for the accepted steps (FR-7.1). */
  exportTraces(instanceId) {
    return this.getJournal(instanceId)
      .filter((r) => r.step_kind === 'accepted')
      .map((r) => JSON.stringify({ pre: r.pre, action: r.action, data: r.data, post: r.post }))
      .join('\n');
  }

  dispatch(instanceId, action, data = {}, actionId) {
    const aid = actionId ?? `${action}:${randomUUID()}`;
    const now = this.now();

    const inst = this.store.getInstance(instanceId);
    if (!inst) throw new Error(`unknown instance '${instanceId}'`);
    const machine = this.machines.get(inst.machine_id);
    if (!machine) throw new Error(`instance '${instanceId}' references unregistered machine '${inst.machine_id}'`);

    // FR-2.3 dedupe: a redelivered (instanceId, actionId) returns the original
    // step's result without re-executing.
    const cached = this.store.getJournalByActionId(instanceId, aid);
    if (cached) {
      return { seq: cached.seq, stepKind: cached.step_kind, rejectReason: cached.reject_reason ?? undefined, state: cached.post, deduped: true };
    }

    if (inst.status !== 'active') {
      // FR-1.2: terminal (and poisoned) instances reject observably, never error.
      const journal = { action, data, pre: inst.state, post: inst.state, stepKind: 'rejected', rejectReason: inst.status, actionId: aid };
      this.store.commitStep({ instanceId, seq: inst.seq + 1, journal, outboxRows: [], timerRows: [], cancelTimerKeys: [], cancelAllTimers: false, now });
      return { seq: inst.seq + 1, stepKind: 'rejected', rejectReason: inst.status, state: inst.state };
    }

    // ---- the SAM step (pure, in-memory) ----
    this._rehydrate(machine, inst.state);
    const pre = this._snapshot(machine);
    const handler = machine.mod.actions[action];

    let stepKind, rejectReason = null, post = pre;
    let schemaRejected = false;
    if (typeof handler !== 'function') {
      stepKind = 'unhandled';
      rejectReason = `action '${action}' is not in the machine's action surface`;
    } else {
      try {
        handler(data);
      } catch (err) {
        if (err && err.name === 'SamSchemaError') {
          // A schema-invalid payload is a CALLER error, not an internal
          // impossibility: the strict profile rejected it before any mutation,
          // so journal it as an observable reject and keep the instance
          // healthy. Poisoning (below) is reserved for the module violating
          // its own profile.
          stepKind = 'rejected';
          rejectReason = err.message;
          schemaRejected = true;
        } else {
          // A strict-profile throw mid-step is FR-1.3 territory: by
          // construction "cannot happen", so it must be loud and stop the
          // instance.
          this.store.setInstanceStatus(instanceId, 'poisoned', now);
          throw new PoisonedError(instanceId, `action '${action}' threw: ${err && err.message}`);
        }
      }
      const step = schemaRejected ? null : this._lastStep(machine, action);
      if (step && step.classification === 'rejected') {
        stepKind = 'rejected';
        rejectReason = (step.rejections && step.rejections[0] && step.rejections[0].reason) || 'rejected';
        const after = this._snapshot(machine);
        if (JSON.stringify(after) !== JSON.stringify(pre)) {
          this.store.setInstanceStatus(instanceId, 'poisoned', now);
          throw new PoisonedError(instanceId, `acceptor for '${action}' mutated the observable model and then rejected`);
        }
      } else if (step && step.classification === 'unhandled') {
        stepKind = 'unhandled';
        rejectReason = `no acceptor handled '${action}'`;
      } else if (!schemaRejected) {
        stepKind = 'accepted';
        post = this._snapshot(machine);
      }
    }

    // ---- derive effects (pure) ----
    const seq = inst.seq + 1;
    const outboxRows = [];
    const timerRows = [];
    const cancelTimerKeys = [];
    if (stepKind === 'accepted' && machine.mapper) {
      const intents = machine.mapper(pre, action, data, post, stepKind) || [];
      let ordinal = 0;
      for (const intent of intents) {
        if (intent.kind === 'timer') {
          const fireAt = intent.fireAt ?? now + (intent.fireInMs ?? 0);
          timerRows.push({ timerId: sha(instanceId, intent.key, String(seq)), key: intent.key, fireAt, action: intent.action, data: intent.data ?? {} });
        } else if (intent.kind === 'cancelTimer') {
          cancelTimerKeys.push(intent.key);
        } else if (machine.manifest && machine.manifest.effects && machine.manifest.effects[intent.kind]) {
          outboxRows.push({ intentId: sha(instanceId, String(seq), intent.kind, String(ordinal++)), kind: intent.kind, payload: intent.payload ?? {} });
        } else if (!BUILTIN_KINDS.has(intent.kind)) {
          this.store.setInstanceStatus(instanceId, 'poisoned', now);
          throw new PoisonedError(instanceId, `effect mapper emitted undeclared kind '${intent.kind}'`);
        }
      }
    }

    const terminal = stepKind === 'accepted' && machine.isTerminal(post);
    const journal = { action, data, pre, post, stepKind, rejectReason, actionId: aid };
    this.store.commitStep({
      instanceId,
      seq,
      journal,
      newState: stepKind === 'accepted' ? post : undefined,
      newStatus: terminal ? 'terminal' : 'active',
      outboxRows,
      timerRows,
      cancelTimerKeys,
      cancelAllTimers: terminal, // FR-1.2: terminal instances cancel their timers
      now,
    });

    return { seq, stepKind, rejectReason: rejectReason ?? undefined, state: post, terminal };
  }
}
