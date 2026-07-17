// polyrun SQLite store — the default adapter, over node:sqlite (DatabaseSync).
//
// M1 made the Store INTERFACE async (the Postgres adapter needs it); this
// adapter keeps its internals synchronous and serializes async callers with
// a mutex + AsyncLocalStorage transaction context: the whole dispatch txn
// holds the mutex, nested store calls from inside the txn callback run
// directly (they see the ALS token), and concurrent tasks — whose async
// context lacks the token — wait for the mutex. This gate applies to READS
// too: on a shared connection a read inside another task's open transaction
// would see uncommitted state (torn journal/state pairs, phantom timers).
//
// Concurrency note: one process per SQLite file. Multi-writer FR-2.4
// semantics are the Postgres adapter's job (store-pg.mjs).
//
// Fault injection: tests may set store.fault = (point) => { throw ... } to
// simulate a crash between any two writes inside commitStep. Because every
// write sits inside BEGIN IMMEDIATE … COMMIT, a fault at ANY point must roll
// back to exactly the pre-dispatch state.
'use strict';

import { DatabaseSync } from 'node:sqlite';
import { AsyncLocalStorage } from 'node:async_hooks';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pr_instance (
  instance_id     TEXT PRIMARY KEY,
  machine_id      TEXT NOT NULL,
  machine_version TEXT NOT NULL,
  seq             INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL CHECK (status IN ('active','terminal','poisoned')),
  state           TEXT NOT NULL,
  parent_instance_id TEXT,
  child_key       TEXT,
  on_complete     TEXT,
  on_parent_terminal TEXT,
  child_of_seq    INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pr_instance_parent ON pr_instance (parent_instance_id, child_key);
CREATE TABLE IF NOT EXISTS pr_journal (
  global_seq      INTEGER,
  instance_id     TEXT NOT NULL,
  machine_version TEXT NOT NULL,
  seq             INTEGER NOT NULL,
  action          TEXT NOT NULL,
  data            TEXT NOT NULL,
  pre             TEXT NOT NULL,
  post            TEXT NOT NULL,
  step_kind       TEXT NOT NULL CHECK (step_kind IN ('accepted','rejected','unhandled')),
  reject_reason   TEXT,
  action_id       TEXT NOT NULL,
  at              INTEGER NOT NULL,
  PRIMARY KEY (instance_id, seq),
  UNIQUE (instance_id, action_id)
);
CREATE TABLE IF NOT EXISTS pr_meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS pr_outbox (
  intent_id       TEXT PRIMARY KEY,
  instance_id     TEXT NOT NULL,
  seq             INTEGER NOT NULL,
  kind            TEXT NOT NULL,
  payload         TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('pending','inflight','done','dead')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  claimed_until   INTEGER,
  last_error      TEXT
);
CREATE INDEX IF NOT EXISTS pr_outbox_pending ON pr_outbox (status, next_attempt_at);
CREATE TABLE IF NOT EXISTS pr_timer (
  timer_id    TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  key         TEXT NOT NULL,
  fire_at     INTEGER NOT NULL,
  action      TEXT NOT NULL,
  data        TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('scheduled','fired','cancelled'))
);
CREATE INDEX IF NOT EXISTS pr_timer_due ON pr_timer (status, fire_at);
`;

class Mutex {
  constructor() { this._tail = Promise.resolve(); }
  lock() {
    let release;
    const gate = new Promise((r) => { release = r; });
    const acquired = this._tail.then(() => release);
    this._tail = this._tail.then(() => gate);
    return acquired;
  }
}

export class Store {
  constructor(dbPath) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(SCHEMA);
    this.fault = null; // test hook: (point) => void, may throw
    this._mutex = new Mutex();
    this._als = new AsyncLocalStorage();
  }

  /** Additive column migration: CREATE TABLE IF NOT EXISTS never alters an
   *  existing database. Sync so the Runtime constructor's own-store path can
   *  run it too — a store must NEVER serve a pre-migration schema. */
  initSync() {
    const ensure = (table, column, decl) => {
      const cols = this.db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
      if (!cols.includes(column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
    };
    ensure('pr_journal', 'machine_version', `TEXT NOT NULL DEFAULT ''`);
    ensure('pr_instance', 'parent_instance_id', 'TEXT');
    ensure('pr_instance', 'child_key', 'TEXT');
    ensure('pr_instance', 'on_complete', 'TEXT');
    ensure('pr_instance', 'on_parent_terminal', 'TEXT');
    ensure('pr_instance', 'child_of_seq', 'INTEGER');
    ensure('pr_journal', 'global_seq', 'INTEGER');
    // The index must be created AFTER the column exists on migrated files.
    this.db.exec('CREATE INDEX IF NOT EXISTS pr_journal_global ON pr_journal (global_seq)');
    // Backfill pre-M3 rows from rowid and seed the monotonic counter.
    // rowid itself is NOT a safe fan-out cursor once archival deletes rows
    // (deleting the max rowid lets SQLite reuse it, silently skipping the
    // reused row for any poller already past it).
    this.db.exec(`UPDATE pr_journal SET global_seq = rowid WHERE global_seq IS NULL`);
    const max = this.db.prepare(`SELECT COALESCE(MAX(global_seq), 0) AS m FROM pr_journal`).get().m;
    this.db.prepare(`INSERT INTO pr_meta (k, v) VALUES ('journal_global_seq', ?) ON CONFLICT(k) DO UPDATE SET v = MAX(v, excluded.v)`).run(max);
    return this;
  }

  async init() { return this.initSync(); }
  async close() { this.db.close(); }

  _fault(point) { if (this.fault) this.fault(point); }

  /** True when a driver error is a unique-constraint violation (used by the
   *  kernel to convert a create() race into the idempotent path). */
  isUniqueViolation(err) {
    return !!err && typeof err.message === 'string' && /UNIQUE constraint failed/.test(err.message);
  }

  /** Transaction: the callback may await store calls (they run directly via
   *  the ALS token); other async tasks are excluded by the mutex for the
   *  whole transaction. Nested txn() calls join the open transaction. */
  _ctx() {
    const ctx = this._als.getStore();
    if (ctx && ctx.done) {
      // A store call scheduled inside a txn callback but executing after
      // COMMIT (fire-and-forget from user code) would otherwise bypass the
      // mutex with a stale token and land inside another task's transaction.
      throw new Error('store call escaped its transaction (context already committed)');
    }
    return ctx;
  }

  async txn(fn) {
    if (this._ctx()) return fn();
    const release = await this._mutex.lock();
    const token = { txn: true, done: false };
    try {
      this.db.exec('BEGIN IMMEDIATE'); // inside try: a BUSY throw must release the mutex
      try {
        const result = await this._als.run(token, fn);
        this.db.exec('COMMIT');
        return result;
      } catch (err) {
        try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ }
        throw err;
      }
    } finally {
      token.done = true;
      release();
    }
  }

  /** EVERY statement outside a txn context — writes AND reads — takes the
   *  mutex: on a shared SQLite connection a read executing inside another
   *  task's open BEGIN IMMEDIATE would see uncommitted (possibly rolled-back)
   *  state — torn journal/state pairs, phantom timers. */
  async _run(fn) {
    if (this._ctx()) return fn();
    const release = await this._mutex.lock();
    try { return fn(); } finally { release(); }
  }

  // ---- instances -----------------------------------------------------------

  async insertInstance({ instanceId, machineId, machineVersion, state, status = 'active', now, parentInstanceId = null, childKey = null, onComplete = null, onParentTerminal = null, childOfSeq = null }) {
    return this._run(() => this.db.prepare(
      `INSERT INTO pr_instance (instance_id, machine_id, machine_version, seq, status, state, parent_instance_id, child_key, on_complete, on_parent_terminal, child_of_seq, created_at, updated_at)
       VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(instanceId, machineId, machineVersion, status, JSON.stringify(state), parentInstanceId, childKey, onComplete, onParentTerminal, childOfSeq, now, now));
  }

  /** FR-8: newest child of a parent for a given key — "newest" is the
   *  parent's spawn seq (strictly monotonic per parent), never wall-clock,
   *  which is shared by every step of a same-transaction cascade. */
  async findChild(parentInstanceId, childKey) {
    return this._run(() => {
      const row = this.db.prepare(
        `SELECT * FROM pr_instance WHERE parent_instance_id = ? AND child_key = ? ORDER BY child_of_seq DESC LIMIT 1`
      ).get(parentInstanceId, childKey);
      return row ? { ...row, state: JSON.parse(row.state) } : null;
    });
  }

  /** FR-8.4: all children of a parent (for terminal cascade). */
  async listChildren(parentInstanceId) {
    return this._run(() => this.db.prepare(
      `SELECT * FROM pr_instance WHERE parent_instance_id = ? ORDER BY child_of_seq`
    ).all(parentInstanceId).map((r) => ({ ...r, state: JSON.parse(r.state) })));
  }

  async getInstance(instanceId) {
    return this._run(() => {
      const row = this.db.prepare('SELECT * FROM pr_instance WHERE instance_id = ?').get(instanceId);
      if (!row) return null;
      return { ...row, state: JSON.parse(row.state) };
    });
  }

  /** Row-locked read for the dispatch transaction. SQLite: BEGIN IMMEDIATE +
   *  the store mutex already serialize writers, so this is a plain read. */
  async getInstanceForUpdate(instanceId) { return this.getInstance(instanceId); }

  /** FR-1.3: poisoning is a durable status write PLUS cancellation of the
   *  instance's scheduled timers, atomically. */
  async markPoisoned(instanceId, now) {
    return this.txn(() => {
      this.db.prepare(`UPDATE pr_instance SET status = 'poisoned', updated_at = ? WHERE instance_id = ?`)
        .run(now, instanceId);
      this.db.prepare(`UPDATE pr_timer SET status = 'cancelled' WHERE instance_id = ? AND status = 'scheduled'`)
        .run(instanceId);
    });
  }

  async listInstances(machineId, status) {
    return this._run(() => {
      let sql = 'SELECT * FROM pr_instance WHERE machine_id = ?';
      const args = [machineId];
      if (status) { sql += ' AND status = ?'; args.push(status); }
      return this.db.prepare(sql).all(...args).map((r) => ({ ...r, state: JSON.parse(r.state) }));
    });
  }

  // ---- journal -------------------------------------------------------------

  async insertJournal({ instanceId, machineVersion, seq, action, data, pre, post, stepKind, rejectReason, actionId, now }) {
    return this._run(() => {
      const g = this.db.prepare(
        `UPDATE pr_meta SET v = v + 1 WHERE k = 'journal_global_seq' RETURNING v`
      ).get().v;
      return this.db.prepare(
        `INSERT INTO pr_journal (global_seq, instance_id, machine_version, seq, action, data, pre, post, step_kind, reject_reason, action_id, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(g, instanceId, machineVersion, seq, action, JSON.stringify(data), JSON.stringify(pre),
        JSON.stringify(post), stepKind, rejectReason ?? null, actionId, now);
    });
  }

  async getJournalByActionId(instanceId, actionId) {
    return this._run(() => {
      const row = this.db.prepare(
        'SELECT * FROM pr_journal WHERE instance_id = ? AND action_id = ?'
      ).get(instanceId, actionId);
      return row ? this._journalRow(row) : null;
    });
  }

  async getJournalRow(instanceId, seq) {
    return this._run(() => {
      const row = this.db.prepare(
        'SELECT * FROM pr_journal WHERE instance_id = ? AND seq = ?'
      ).get(instanceId, seq);
      return row ? this._journalRow(row) : null;
    });
  }

  async lastAcceptedAtOrBefore(instanceId, seq) {
    return this._run(() => {
      const row = this.db.prepare(
        `SELECT * FROM pr_journal WHERE instance_id = ? AND seq <= ? AND step_kind = 'accepted'
         ORDER BY seq DESC LIMIT 1`
      ).get(instanceId, seq);
      return row ? this._journalRow(row) : null;
    });
  }

  async getJournal(instanceId) {
    return this._run(() => this.db.prepare(
      'SELECT * FROM pr_journal WHERE instance_id = ? ORDER BY seq'
    ).all(instanceId).map((r) => this._journalRow(r)));
  }

  _journalRow(r) {
    return { ...r, data: JSON.parse(r.data), pre: JSON.parse(r.pre), post: JSON.parse(r.post) };
  }

  /** FR-7.5: global journal reader for cross-process consumers; the cursor
   *  is the explicit monotonic global_seq (rowid is unsafe under archival). */
  async journalSince(cursor, limit = 100) {
    return this._run(() => this.db.prepare(
      'SELECT * FROM pr_journal WHERE global_seq > ? ORDER BY global_seq LIMIT ?'
    ).all(cursor, limit).map((r) => this._journalRow(r)));
  }

  // ---- archival (M3, FR-1.2) ------------------------------------------------

  /** Terminal instances not updated since `beforeMs`, ready for archival.
   *  Keyset-paginated on (updated_at, instance_id) so a run can walk past
   *  unpurgeable rows instead of stalling on the first full batch of them. */
  async archivableInstances(beforeMs, limit = 100, after = { updatedAt: 0, instanceId: '' }) {
    return this._run(() => this.db.prepare(
      `SELECT * FROM pr_instance
       WHERE status = 'terminal' AND updated_at < ?
         AND (updated_at > ? OR (updated_at = ? AND instance_id > ?))
       ORDER BY updated_at, instance_id LIMIT ?`
    ).all(beforeMs, after.updatedAt, after.updatedAt, after.instanceId, limit)
      .map((r) => ({ ...r, state: JSON.parse(r.state) })));
  }

  /** Delete one archived instance's rows. Refuses when: effects are
   *  unsettled; the journal moved past the exported seq (rows would be
   *  destroyed unexported); an ACTIVE child still references this parent (its
   *  terminal notify would roll back its own step forever); or an ACTIVE
   *  parent survives (a later signalChild would poison it). */
  async purgeInstance(instanceId, expectedSeq) {
    return this.txn(() => {
      const inst = this.db.prepare(`SELECT * FROM pr_instance WHERE instance_id = ?`).get(instanceId);
      if (!inst) throw new Error(`instance '${instanceId}' does not exist`);
      if (expectedSeq !== undefined && inst.seq !== expectedSeq) {
        throw new Error(`instance '${instanceId}' moved since export (seq ${inst.seq} != ${expectedSeq})`);
      }
      const busy = this.db.prepare(
        `SELECT COUNT(*) AS n FROM pr_outbox WHERE instance_id = ? AND status IN ('pending','inflight')`
      ).get(instanceId).n;
      if (busy > 0) throw new Error(`instance '${instanceId}' still has ${busy} unsettled effect(s)`);
      const activeChildren = this.db.prepare(
        `SELECT COUNT(*) AS n FROM pr_instance WHERE parent_instance_id = ? AND status = 'active'`
      ).get(instanceId).n;
      if (activeChildren > 0) throw new Error(`instance '${instanceId}' has ${activeChildren} active child(ren)`);
      if (inst.parent_instance_id) {
        const parent = this.db.prepare(`SELECT status FROM pr_instance WHERE instance_id = ?`).get(inst.parent_instance_id);
        if (parent && parent.status === 'active') {
          throw new Error(`instance '${instanceId}' has an active parent '${inst.parent_instance_id}'`);
        }
      }
      this.db.prepare(`DELETE FROM pr_journal WHERE instance_id = ?`).run(instanceId);
      this.db.prepare(`DELETE FROM pr_outbox WHERE instance_id = ?`).run(instanceId);
      this.db.prepare(`DELETE FROM pr_timer WHERE instance_id = ?`).run(instanceId);
      this.db.prepare(`DELETE FROM pr_instance WHERE instance_id = ?`).run(instanceId);
    });
  }

  /** FR-3.6 escape hatch: extend an inflight effect's lease. */
  async extendLease(intentId, untilMs) {
    return this._run(() => this.db.prepare(
      `UPDATE pr_outbox SET claimed_until = ? WHERE intent_id = ? AND status = 'inflight'`
    ).run(untilMs, intentId));
  }

  /** Rewrite an instance's snapshot + version (migration tooling), fenced
   *  on the seq observed at validation time — a live dispatch committing in
   *  between must not be silently overwritten with migrate(staleState).
   *  Bumps seq to newSeq (the $migrate journal row's seq). Returns the
   *  number of rows changed (0 = fence rejected). */
  async rewriteSnapshot(instanceId, state, machineVersion, now, expectedSeq, newSeq) {
    return this._run(() => this.db.prepare(
      `UPDATE pr_instance SET state = ?, machine_version = ?, seq = ?, updated_at = ? WHERE instance_id = ? AND seq = ?`
    ).run(JSON.stringify(state), machineVersion, newSeq, now, instanceId, expectedSeq).changes);
  }

  // ---- the one write path (FR-2.2) ----------------------------------------
  //
  // Cancels run BEFORE inserts so a cancel-and-rearm step cancels the OLD
  // timer, not the one it just scheduled.

  async commitStep({ instanceId, machineVersion, seq, journal, newState, newStatus, outboxRows, timerRows, cancelTimerKeys, cancelAllTimers, now }) {
    return this.txn(async () => {
      await this.insertJournal({ instanceId, machineVersion, seq, ...journal, now });
      this._fault('after-journal');

      if (newState !== undefined) {
        this.db.prepare('UPDATE pr_instance SET state = ?, seq = ?, status = ?, updated_at = ? WHERE instance_id = ?')
          .run(JSON.stringify(newState), seq, newStatus, now, instanceId);
      } else {
        this.db.prepare('UPDATE pr_instance SET seq = ?, updated_at = ? WHERE instance_id = ?')
          .run(seq, now, instanceId);
      }
      this._fault('after-instance');

      for (const row of outboxRows) {
        this.db.prepare(
          `INSERT INTO pr_outbox (intent_id, instance_id, seq, kind, payload, status, attempts, next_attempt_at)
           VALUES (?, ?, ?, ?, ?, 'pending', 0, ?)`
        ).run(row.intentId, instanceId, seq, row.kind, JSON.stringify(row.payload), now);
      }
      this._fault('after-outbox');

      for (const key of cancelTimerKeys) {
        this.db.prepare(
          `UPDATE pr_timer SET status = 'cancelled' WHERE instance_id = ? AND key = ? AND status = 'scheduled'`
        ).run(instanceId, key);
      }
      if (cancelAllTimers) {
        this.db.prepare(
          `UPDATE pr_timer SET status = 'cancelled' WHERE instance_id = ? AND status = 'scheduled'`
        ).run(instanceId);
      }
      for (const t of timerRows) {
        this.db.prepare(
          `INSERT INTO pr_timer (timer_id, instance_id, key, fire_at, action, data, status)
           VALUES (?, ?, ?, ?, ?, ?, 'scheduled')`
        ).run(t.timerId, instanceId, t.key, t.fireAt, t.action, JSON.stringify(t.data));
      }
      this._fault('after-timers');
    });
  }

  // ---- outbox (effect runner) ----------------------------------------------

  async recoverExpiredLeases(now) {
    return this._run(() => this.db.prepare(
      `UPDATE pr_outbox SET status = 'pending', claimed_until = NULL
       WHERE status = 'inflight' AND claimed_until < ?`
    ).run(now));
  }

  async claimEffects(now, limit, leaseMs) {
    return this.txn(() => {
      const rows = this.db.prepare(
        `SELECT * FROM pr_outbox WHERE status = 'pending' AND next_attempt_at <= ?
         ORDER BY next_attempt_at LIMIT ?`
      ).all(now, limit);
      const claim = this.db.prepare(
        `UPDATE pr_outbox SET status = 'inflight', claimed_until = ? WHERE intent_id = ?`
      );
      for (const r of rows) claim.run(now + leaseMs, r.intent_id);
      return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
    });
  }

  // Fenced on status='inflight': a stale lease-expired worker must not
  // overwrite a newer outcome (e.g. flip a 'done' row back to 'pending').

  async markEffectDone(intentId) {
    return this._run(() => this.db.prepare(
      `UPDATE pr_outbox SET status = 'done', claimed_until = NULL WHERE intent_id = ? AND status = 'inflight'`
    ).run(intentId));
  }

  async markEffectRetry(intentId, attempts, nextAttemptAt, lastError) {
    return this._run(() => this.db.prepare(
      `UPDATE pr_outbox SET status = 'pending', attempts = ?, next_attempt_at = ?, claimed_until = NULL, last_error = ? WHERE intent_id = ? AND status = 'inflight'`
    ).run(attempts, nextAttemptAt, lastError, intentId));
  }

  async markEffectDead(intentId, attempts, lastError) {
    return this._run(() => this.db.prepare(
      `UPDATE pr_outbox SET status = 'dead', claimed_until = NULL, attempts = ?, last_error = ? WHERE intent_id = ? AND status = 'inflight'`
    ).run(attempts, lastError, intentId));
  }

  async getOutbox(instanceId, status) {
    return this._run(() => {
      let sql = 'SELECT * FROM pr_outbox WHERE instance_id = ?';
      const args = [instanceId];
      if (status) { sql += ' AND status = ?'; args.push(status); }
      return this.db.prepare(sql).all(...args).map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
    });
  }

  // ---- DLQ (CLI surface) -----------------------------------------------------

  async dlqList() {
    return this._run(() => this.db.prepare(`SELECT * FROM pr_outbox WHERE status = 'dead' ORDER BY instance_id, seq`)
      .all().map((r) => ({ ...r, payload: JSON.parse(r.payload) })));
  }

  async dlqRetry(intentId, now) {
    return this._run(() => this.db.prepare(
      `UPDATE pr_outbox SET status = 'pending', attempts = 0, next_attempt_at = ?, last_error = 'dlq-retry' WHERE intent_id = ? AND status = 'dead'`
    ).run(now, intentId));
  }

  async dlqDiscard(intentId) {
    return this._run(() => this.db.prepare(
      `UPDATE pr_outbox SET status = 'done', last_error = 'dlq-discarded' WHERE intent_id = ? AND status = 'dead'`
    ).run(intentId));
  }

  // ---- timers ---------------------------------------------------------------

  async dueTimers(now, limit) {
    return this._run(() => this.db.prepare(
      `SELECT * FROM pr_timer WHERE status = 'scheduled' AND fire_at <= ? ORDER BY fire_at LIMIT ?`
    ).all(now, limit).map((r) => ({ ...r, data: JSON.parse(r.data) })));
  }

  async markTimerFired(timerId) {
    return this._run(() => this.db.prepare(
      `UPDATE pr_timer SET status = 'fired' WHERE timer_id = ?`
    ).run(timerId));
  }

  /** Push an erroring timer's due time forward (per-timer backoff). */
  async deferTimer(timerId, fireAt) {
    return this._run(() => this.db.prepare(
      `UPDATE pr_timer SET fire_at = ? WHERE timer_id = ? AND status = 'scheduled'`
    ).run(fireAt, timerId));
  }

  async getTimers(instanceId, status) {
    return this._run(() => {
      let sql = 'SELECT * FROM pr_timer WHERE instance_id = ?';
      const args = [instanceId];
      if (status) { sql += ' AND status = ?'; args.push(status); }
      return this.db.prepare(sql).all(...args).map((r) => ({ ...r, data: JSON.parse(r.data) }));
    });
  }
}
