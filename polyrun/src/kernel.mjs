// polyrun kernel — the dispatch loop over a polygen-authored SAM v2
// strict-profile module (docs/polyrun-spec.md §5.3).
//
// The kernel hosts the verified artifact unchanged: rehydrate via
// init()+setState() (reset-then-merge, same semantics as scripts/
// sam-adapter.cjs and sam-tv.mjs give every replay window), fire
// actions[name](data), classify via instance({}).lastStep(), commit
// everything the step decided in one store transaction — INCLUDING the
// dedupe read and instance read, so a second writer on the same store
// serializes instead of racing. It contains no business logic — that is
// the whole point.
//
// Poisoning doctrine (FR-1.3): anything that "cannot happen" for a verified
// strict-profile module — a mid-step throw, an unreadable step
// classification, a snapshot the module rejects, a mapper emitting an
// undeclared kind or a malformed/duplicate timer — poisons the instance
// LOUDLY (status write + timer cancellation in its own transaction, then a
// PoisonedError to the caller). A schema-invalid payload from a caller is
// NOT that: it is journaled as an observable rejected step.
'use strict';

import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadSpec, stable } from '../../scripts/load-spec.mjs';
import { Store } from './store.mjs';
import { resolveFireAt } from './duration.mjs';

const CREATE_ACTION = '$create';
// MAX_CASCADE_DEPTH and sanitizeReplacer live in constants.mjs (store-free)
// so check-product.mjs and polyvers can share them without importing the
// kernel's sqlite-backed module graph; re-exported here for kernel consumers.
export { MAX_CASCADE_DEPTH, sanitizeReplacer } from './constants.mjs';
import { MAX_CASCADE_DEPTH, sanitizeReplacer } from './constants.mjs';

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

/** Internal sentinel: thrown inside the dispatch transaction to request
 *  poisoning; converted OUTSIDE the transaction (so the rollback of the step
 *  cannot roll back the poison mark) into a durable status + PoisonedError.
 *  Carries the FAULTY instanceId: in a parent/child cascade the defect may
 *  be frames away from the dispatch root, and the wrong-instance poison
 *  would brick a healthy machine while the defective one stays active. */
class PoisonRequest extends Error {
  constructor(message, instanceId) { super(message); this.instanceId = instanceId; }
}

export class Runtime {
  constructor({ store, dbPath, machines = [], handlers = {}, now = Date.now }) {
    this.store = store ?? new Store(dbPath ?? ':memory:').initSync();
    this.handlers = handlers;
    this.now = now;
    this.machines = new Map();
    this.metrics = { dispatches: 0, accepted: 0, rejected: 0, unhandled: 0, deduped: 0, poisoned: 0, effectsEmitted: 0, timersScheduled: 0, childrenSpawned: 0 };
    // FR-7.5 fan-out: 'step' events emitted AFTER the owning transaction
    // commits — never for rolled-back steps. In-process consumers subscribe
    // here; cross-process consumers poll store.journalSince(cursor).
    this.events = new EventEmitter();
    for (const m of machines) this.registerMachine(m);
  }

  async close() { return this.store.close(); }

  registerMachine({ machineId, module: modulePath, contract: contractPath, effects, isTerminal }) {
    const abs = resolve(modulePath);
    const source = readFileSync(abs, 'utf-8');
    const mod = loadSpec(abs);
    if (!isSamV2Module(mod)) {
      throw new Error(`machine '${machineId}': module does not export the v2 SAM surface { instance, init, actions, getState, setState }`);
    }
    // Load-time gate (§5.3 / FR-6.2 belt): the module must validate
    // strict-clean — undeclared obligations block registration instead of
    // surfacing as runtime poisonings.
    try {
      const acc = mod.instance({});
      if (typeof acc.validate === 'function') {
        const problems = acc.validate();
        if (Array.isArray(problems) && problems.length > 0) {
          throw new Error(problems.join('; '));
        }
      }
    } catch (err) {
      throw new Error(`machine '${machineId}': module does not validate strict-clean: ${err && err.message}`);
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

    // Observable-is-total check: the durable snapshot IS the projection, so
    // the module's declared state and the contract's observable state must
    // coincide — a module key outside the contract would be silently dropped
    // on every rehydration (state loss), a contract key the module lacks
    // would journal 'undefined' forever.
    if (observableKeys) {
      mod.init();
      const raw = JSON.parse(JSON.stringify(mod.getState(), sanitizeReplacer));
      const modKeys = Object.keys(raw);
      const extra = modKeys.filter((k) => !observableKeys.includes(k));
      const missing = observableKeys.filter((k) => !modKeys.includes(k));
      if (extra.length || missing.length) {
        throw new Error(`machine '${machineId}': contract stateKeys and module state disagree`
          + (extra.length ? ` — module keys not in contract: ${extra.join(', ')}` : '')
          + (missing.length ? ` — contract keys not in module state: ${missing.join(', ')}` : ''));
      }
    }

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
    // sam-adapter.cjs). House rule: getState()/setState() only — no
    // instance({}).state() error-slot access; strict-profile errors throw.
    machine.mod.init();
    machine.mod.setState(state);
  }

  _lastStep(machine, action, instanceId) {
    const acc = machine.mod.instance({});
    if (typeof acc.lastStep !== 'function') {
      throw new PoisonRequest(`module exposes no lastStep() — step classification unreadable`, instanceId);
    }
    const step = acc.lastStep();
    if (!step || (step.intent !== undefined && step.intent !== null && step.intent !== action)) {
      // An unreadable classification on a strict module must NEVER default to
      // 'accepted' — that would run the effect mapper for a step the module
      // may have refused.
      throw new PoisonRequest(`lastStep() did not classify action '${action}' (got ${step ? `intent '${step.intent}'` : 'nothing'})`, instanceId);
    }
    return step;
  }

  async _poison(instanceId, message) {
    try {
      await this.store.markPoisoned(instanceId, this.now());
    } catch (err) {
      try {
        await this.store.markPoisoned(instanceId, this.now()); // one retry (e.g. pg deadlock)
      } catch (err2) {
        // The durable mark failed; the defect is deterministic, so the next
        // dispatch re-attempts it — but say so LOUDLY now (FR-1.3).
        console.error(`[polyrun] FAILED to durably poison ${instanceId}: ${err2 && err2.message} (original: ${err && err.message})`);
      }
    }
    return new PoisonedError(instanceId, message);
  }

  // ---- API -------------------------------------------------------------------

  /**
   * FR-1.1. Atomically persists the initial snapshot + journal row 0
   * ('$create') + the optional creation action and its effects — one
   * transaction. Same-parameters recreate is idempotent; different
   * parameters is a ConflictError.
   */
  async create(machineId, instanceId, creation) {
    const machine = this.machines.get(machineId);
    if (!machine) throw new Error(`unknown machine '${machineId}'`);
    if (creation && typeof machine.mod.actions[creation.action] !== 'function') {
      throw new Error(`creation action '${creation.action}' is not in machine '${machineId}'`);
    }
    const id = instanceId ?? randomUUID();
    const now = this.now();
    const events = [];
    try {
      const made = await this.store.txn(() => this._createInTxn(machineId, id, creation, null, now, 0, events));
      for (const e of events) this.events.emit('step', e);
      return { instanceId: id, ...made };
    } catch (err) {
      if (err instanceof PoisonRequest) {
        // The insert rolled back with the transaction: if the faulty instance
        // EXISTS (a cascade defect on an established machine), poison it
        // durably; if it is the never-created instance itself, a PoisonedError
        // would be a lie — nothing durable records it, and a retried create()
        // would loop through the deterministic defect while claiming
        // poisoning each time. Fail as what it is: a creation failure.
        const target = err.instanceId ?? id;
        if (await this.store.getInstance(target)) {
          this.metrics.poisoned += 1;
          throw await this._poison(target, err.message);
        }
        throw new Error(`create '${id}' failed (machine/mapper defect — nothing was persisted): ${err.message}`);
      }
      // Cross-process create race: the loser converts the unique violation
      // into the idempotent path by re-entering (it now finds the row).
      if (this.store.isUniqueViolation(err)) return this.create(machineId, id, creation);
      throw err;
    }
  }

  async _createInTxn(machineId, id, creation, parentInfo, now, depth, events) {
    const machine = this.machines.get(machineId);
    const creationData = creation ? { action: creation.action, data: creation.data ?? {} } : {};
    const existing = await this.store.getInstanceForUpdate(id);
    if (existing) {
      if (existing.machine_id !== machineId) {
        throw new ConflictError(`instance '${id}' already exists for machine '${existing.machine_id}'`);
      }
      // stable(): key-order-insensitive — Postgres jsonb does not preserve
      // object key order, so JSON.stringify equality would false-conflict.
      const row0 = await this.store.getJournalRow(id, 0);
      if (row0 && stable(row0.data) !== stable(creationData)) {
        throw new ConflictError(`instance '${id}' was created with different parameters`);
      }
      return { created: false, state: existing.state };
    }
    machine.mod.init();
    const state = this._snapshot(machine);
    const terminal = machine.isTerminal(state);
    await this.store.insertInstance({
      instanceId: id, machineId, machineVersion: machine.version, state,
      status: terminal ? 'terminal' : 'active', now,
      parentInstanceId: parentInfo?.parentInstanceId ?? null,
      childKey: parentInfo?.childKey ?? null,
      onComplete: parentInfo?.onComplete ?? null,
      onParentTerminal: parentInfo?.onParentTerminal ?? null,
      childOfSeq: parentInfo?.childOfSeq ?? null,
    });
    await this.store.insertJournal({
      instanceId: id, machineVersion: machine.version, seq: 0,
      action: CREATE_ACTION, data: creationData, pre: state, post: state,
      stepKind: 'accepted', rejectReason: null, actionId: CREATE_ACTION, now,
    });
    events.push({ instanceId: id, machineId, seq: 0, action: CREATE_ACTION, data: creationData, stepKind: 'accepted', pre: state, post: state, at: now });
    if (creation) {
      const res = await this._dispatchInTxn(id, creation.action, creation.data ?? {}, `${CREATE_ACTION}:action`, now, depth + 1, events);
      return { created: true, state: res.state };
    }
    return { created: true, state };
  }

  async getState(instanceId) {
    const inst = await this.store.getInstance(instanceId);
    if (!inst) throw new Error(`unknown instance '${instanceId}'`);
    return { state: inst.state, status: inst.status, seq: inst.seq, machineId: inst.machine_id };
  }

  /** FR-5.2: the observable state as of journal seq (post of the last
   *  accepted step at or before it). */
  async getStateAt(instanceId, seq) {
    if (!(await this.store.getInstance(instanceId))) throw new Error(`unknown instance '${instanceId}'`);
    const row = await this.store.lastAcceptedAtOrBefore(instanceId, seq);
    if (!row) throw new Error(`instance '${instanceId}' has no accepted step at or before seq ${seq}`);
    return row.post;
  }

  async getJournal(instanceId) { return this.store.getJournal(instanceId); }

  async list(machineId, status) { return this.store.listInstances(machineId, status); }

  /** ndjson Polygraph trace windows for the accepted steps (FR-7.1). */
  async exportTraces(instanceId) {
    if (!(await this.store.getInstance(instanceId))) throw new Error(`unknown instance '${instanceId}'`);
    return (await this.getJournal(instanceId))
      .filter((r) => r.step_kind === 'accepted' && r.action !== CREATE_ACTION)
      .map((r) => JSON.stringify({ pre: r.pre, action: r.action, data: r.data, post: r.post }))
      .join('\n');
  }

  async dispatch(instanceId, action, data = {}, actionId) {
    const aid = actionId ?? `${action}:${randomUUID()}`;
    const now = this.now();
    this.metrics.dispatches += 1;
    const events = [];
    // Parent↔child lock ordering can invert on Postgres (parent txn signals
    // child while a child txn notifies parent) — PG aborts one side with a
    // deadlock error; retry it, the surviving side has committed.
    for (let attempt = 0; ; attempt++) {
      events.length = 0;
      try {
        const result = await this.store.txn(() => this._dispatchInTxn(instanceId, action, data, aid, now, 0, events));
        for (const e of events) this.events.emit('step', e);
        return result;
      } catch (err) {
        if (err instanceof PoisonRequest) {
          // The step's transaction has rolled back; the poison mark gets its
          // own durable transaction so it cannot be lost with the step. The
          // mark goes on the FAULTY instance (a cascade can surface a child's
          // or parent's defect from another frame), never blindly on the root.
          this.metrics.poisoned += 1;
          throw await this._poison(err.instanceId ?? instanceId, err.message);
        }
        if (err && err.code === '40P01' && attempt < 3) continue; // PG deadlock: retry
        throw err;
      }
    }
  }

  async _dispatchInTxn(instanceId, action, data, aid, now, depth = 0, events = []) {
    if (depth > MAX_CASCADE_DEPTH) {
      throw new PoisonRequest(`dispatch cascade exceeded depth ${MAX_CASCADE_DEPTH} (parent/child wiring cycle?)`, instanceId);
    }
    const inst = await this.store.getInstanceForUpdate(instanceId);
    if (!inst) throw new Error(`unknown instance '${instanceId}'`);
    const machine = this.machines.get(inst.machine_id);
    if (!machine) throw new Error(`instance '${instanceId}' references unregistered machine '${inst.machine_id}'`);

    // FR-2.3 dedupe: a redelivered (instanceId, actionId) returns the
    // original step's result without re-executing — but only for the SAME
    // action; an actionId reused across different actions is a caller bug
    // that must be loud, not a silent no-op.
    const cached = await this.store.getJournalByActionId(instanceId, aid);
    if (cached) {
      if (cached.action !== action) {
        throw new ConflictError(`actionId '${aid}' was already used for action '${cached.action}' (now '${action}')`);
      }
      this.metrics.deduped += 1;
      return {
        seq: cached.seq, stepKind: cached.step_kind, rejectReason: cached.reject_reason ?? undefined,
        state: cached.post, terminal: cached.step_kind === 'accepted' && machine.isTerminal(cached.post),
        deduped: true,
      };
    }

    if (inst.status !== 'active') {
      // FR-1.2: terminal (and poisoned) instances reject observably, never error.
      const journal = { action, data, pre: inst.state, post: inst.state, stepKind: 'rejected', rejectReason: inst.status, actionId: aid };
      await this.store.commitStep({ instanceId, machineVersion: machine.version, seq: inst.seq + 1, journal, outboxRows: [], timerRows: [], cancelTimerKeys: [], cancelAllTimers: false, now });
      // Every journaled row emits exactly one event — this path included, or
      // event consumers and journal pollers would see different histories.
      events.push({ instanceId, machineId: inst.machine_id, seq: inst.seq + 1, action, data, stepKind: 'rejected', rejectReason: inst.status, pre: inst.state, post: inst.state, at: now });
      return { seq: inst.seq + 1, stepKind: 'rejected', rejectReason: inst.status, state: inst.state, terminal: false };
    }

    // ---- the SAM step (pure, in-memory) ----
    let pre;
    try {
      this._rehydrate(machine, inst.state);
      pre = this._snapshot(machine);
    } catch (err) {
      // The module rejecting its own persisted snapshot (SamShapeError from
      // an incompatible deploy) is exactly the "cannot happen" class.
      throw new PoisonRequest(`module rejected persisted snapshot: ${err && err.message}`, instanceId);
    }
    const handler = machine.mod.actions[action];

    let stepKind, rejectReason = null, post = pre;
    let classified = false;
    if (typeof handler !== 'function') {
      stepKind = 'unhandled';
      rejectReason = `action '${action}' is not in the machine's action surface`;
      classified = true;
    } else {
      try {
        handler(data);
      } catch (err) {
        if (err && err.name === 'SamSchemaError') {
          // A schema-invalid payload is a CALLER error, not an internal
          // impossibility: the strict profile rejected it before any
          // mutation, so journal it as an observable reject and keep the
          // instance healthy.
          stepKind = 'rejected';
          rejectReason = err.message;
          classified = true;
        } else {
          throw new PoisonRequest(`action '${action}' threw: ${err && err.message}`, instanceId);
        }
      }
      if (!classified) {
        const step = this._lastStep(machine, action, instanceId); // throws PoisonRequest if unreadable
        if (step.classification === 'rejected') {
          stepKind = 'rejected';
          rejectReason = (step.rejections && step.rejections[0] && step.rejections[0].reason) || 'rejected';
          const after = this._snapshot(machine);
          if (JSON.stringify(after) !== JSON.stringify(pre)) {
            throw new PoisonRequest(`acceptor for '${action}' mutated the observable model and then rejected`, instanceId);
          }
        } else if (step.classification === 'unhandled') {
          stepKind = 'unhandled';
          rejectReason = `no acceptor handled '${action}'`;
        } else {
          // 'mutated' and 'identity-by-mutation' are both accepted steps.
          stepKind = 'accepted';
          post = this._snapshot(machine);
        }
      }
    }

    // ---- derive effects (pure) ----
    const seq = inst.seq + 1;
    const outboxRows = [];
    const timerRows = [];
    const cancelTimerKeys = [];
    const spawns = [];
    const signals = [];
    if (stepKind === 'accepted' && machine.mapper) {
      const intents = machine.mapper(pre, action, data, post, stepKind) || [];
      let ordinal = 0;
      const timerKeysThisStep = new Set();
      const childKeysThisStep = new Set();
      const signalsThisStep = new Set();
      for (const intent of intents) {
        if (intent.kind === 'spawnChild') {
          // FR-8.1: validated here, created atomically with the step below.
          const childMachine = this.machines.get(intent.machineId);
          if (!childMachine) throw new PoisonRequest(`spawnChild: machine '${intent.machineId}' is not registered`, instanceId);
          if (typeof intent.childKey !== 'string' || !intent.childKey) throw new PoisonRequest('spawnChild: childKey is required', instanceId);
          if (intent.onComplete && typeof machine.mod.actions[intent.onComplete] !== 'function') {
            throw new PoisonRequest(`spawnChild: onComplete action '${intent.onComplete}' is not in the parent's action surface`, instanceId);
          }
          if (intent.creation && typeof childMachine.mod.actions[intent.creation.action] !== 'function') {
            throw new PoisonRequest(`spawnChild: creation action '${intent.creation.action}' is not in machine '${intent.machineId}'`, instanceId);
          }
          if (intent.onParentTerminal && typeof childMachine.mod.actions[intent.onParentTerminal] !== 'function') {
            throw new PoisonRequest(`spawnChild: onParentTerminal action '${intent.onParentTerminal}' is not in machine '${intent.machineId}'`, instanceId);
          }
          if (childKeysThisStep.has(intent.childKey)) {
            // Same doctrine as duplicate timer keys: a deterministic mapper
            // defect must poison, not silently dedupe or retry-storm.
            throw new PoisonRequest(`effect mapper emitted duplicate spawnChild key '${intent.childKey}' in one step`, instanceId);
          }
          childKeysThisStep.add(intent.childKey);
          spawns.push({
            machineId: intent.machineId,
            childId: sha('child', instanceId, intent.childKey, String(seq)),
            childKey: intent.childKey,
            onComplete: intent.onComplete ?? null,
            onParentTerminal: intent.onParentTerminal ?? null,
            creation: intent.creation ?? null,
          });
        } else if (intent.kind === 'signalChild') {
          // FR-8.2: the parent may dispatch declared actions into a child; a
          // child that rejects it is journaled, not forced.
          if (typeof intent.childKey !== 'string' || !intent.childKey) throw new PoisonRequest('signalChild: childKey is required', instanceId);
          if (typeof intent.action !== 'string' || !intent.action) throw new PoisonRequest('signalChild: action is required', instanceId);
          const sig = `${intent.childKey}\u0000${intent.action}`;
          if (signalsThisStep.has(sig)) {
            throw new PoisonRequest(`effect mapper emitted duplicate signalChild '${intent.action}' for key '${intent.childKey}' in one step`, instanceId);
          }
          signalsThisStep.add(sig);
          signals.push({ childKey: intent.childKey, action: intent.action, data: intent.data ?? {} });
        } else if (intent.kind === 'timer') {
          if (typeof intent.key !== 'string' || !intent.key) {
            throw new PoisonRequest(`effect mapper emitted a timer without a key`, instanceId);
          }
          if (timerKeysThisStep.has(intent.key)) {
            // Deterministic mapper defect: the second identical timerId would
            // fail the PK on every retry forever — poison instead.
            throw new PoisonRequest(`effect mapper emitted duplicate timer key '${intent.key}' in one step`, instanceId);
          }
          timerKeysThisStep.add(intent.key);
          let fireAt;
          try {
            fireAt = resolveFireAt(intent, now);
          } catch (err) {
            throw new PoisonRequest(`effect mapper: ${err.message}`, instanceId);
          }
          timerRows.push({ timerId: sha(instanceId, intent.key, String(seq)), key: intent.key, fireAt, action: intent.action, data: intent.data ?? {} });
        } else if (intent.kind === 'cancelTimer') {
          cancelTimerKeys.push(intent.key);
        } else if (machine.manifest && machine.manifest.effects && machine.manifest.effects[intent.kind]) {
          outboxRows.push({ intentId: sha(instanceId, String(seq), intent.kind, String(ordinal++)), kind: intent.kind, payload: intent.payload ?? {} });
        } else {
          throw new PoisonRequest(`effect mapper emitted undeclared kind '${intent.kind}'`, instanceId);
        }
      }
    }

    const terminal = stepKind === 'accepted' && machine.isTerminal(post);
    const journal = { action, data, pre, post, stepKind, rejectReason, actionId: aid };
    await this.store.commitStep({
      instanceId,
      machineVersion: machine.version,
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
    events.push({ instanceId, machineId: inst.machine_id, seq, action, data, stepKind, rejectReason: rejectReason ?? undefined, pre, post, at: now });

    // ---- FR-8: children, atomic with the parent's step ----
    for (const spawn of spawns) {
      // Idempotent by id: a redelivered parent step dedupes before reaching
      // here, so a spawn executes at most once per (parent, childKey, seq).
      await this._createInTxn(spawn.machineId, spawn.childId, spawn.creation ?? undefined, {
        parentInstanceId: instanceId, childKey: spawn.childKey, onComplete: spawn.onComplete,
        onParentTerminal: spawn.onParentTerminal, childOfSeq: seq,
      }, now, depth, events);
      this.metrics.childrenSpawned += 1;
    }
    for (const signal of signals) {
      const child = await this.store.findChild(instanceId, signal.childKey);
      if (!child) throw new PoisonRequest(`signalChild: no child with key '${signal.childKey}'`, instanceId);
      await this._dispatchInTxn(child.instance_id, signal.action, signal.data,
        `signal:${sha(instanceId, signal.childKey, signal.action, String(seq))}`, now, depth + 1, events);
    }
    // FR-8.2: a child reaching terminal notifies its parent — in the SAME
    // transaction as the terminal step, deduped by the child's id.
    if (terminal && inst.parent_instance_id && inst.on_complete) {
      await this._dispatchInTxn(inst.parent_instance_id, inst.on_complete,
        { childKey: inst.child_key, childState: post },
        `child:${instanceId}:complete`, now, depth + 1, events);
    }
    // FR-8.4: a terminal PARENT dispatches the declared cancel action into
    // each non-terminal child (never deletes state); a child that rejects it
    // is journaled and surfaced, not forced.
    if (terminal) {
      for (const child of await this.store.listChildren(instanceId)) {
        if (child.status !== 'active' || !child.on_parent_terminal) continue;
        await this._dispatchInTxn(child.instance_id, child.on_parent_terminal,
          { reason: 'parent-terminal' },
          `parent:${instanceId}:terminal:${child.instance_id}`, now, depth + 1, events);
      }
    }

    this.metrics[stepKind === 'accepted' ? 'accepted' : stepKind === 'rejected' ? 'rejected' : 'unhandled'] += 1;
    this.metrics.effectsEmitted += outboxRows.length;
    this.metrics.timersScheduled += timerRows.length;
    return { seq, stepKind, rejectReason: rejectReason ?? undefined, state: post, terminal };
  }
}
