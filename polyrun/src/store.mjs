// polyrun store — SQLite adapter over node:sqlite (DatabaseSync).
//
// Everything durable lives in four tables mirroring docs/polyrun-spec.md §5.2
// (SQLite dialect, ms-epoch timestamps). The adapter is fully synchronous —
// node:sqlite is sync and so is a SAM step — which is what lets the kernel
// run the WHOLE dispatch (dedupe read, instance read, step, writes) inside
// one literal transaction with no async seams (FR-2.2/FR-2.4). txn() is
// nesting-tolerant so the kernel can compose store calls freely.
//
// Concurrency note (M0): one process per database file. SQLite + BEGIN
// IMMEDIATE serializes writers, but the multi-writer "loser re-reads and
// re-runs" contract of FR-2.4 is the Postgres adapter's job (M1).
//
// Fault injection: tests may set store.fault = (point) => { throw ... } to
// simulate a crash between any two writes inside commitStep. Because every
// write sits inside BEGIN IMMEDIATE … COMMIT, a fault at ANY point must roll
// back to exactly the pre-dispatch state — that property is the kernel's
// atomicity test, not a best effort.
'use strict';

import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pr_instance (
  instance_id     TEXT PRIMARY KEY,
  machine_id      TEXT NOT NULL,
  machine_version TEXT NOT NULL,
  seq             INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL CHECK (status IN ('active','terminal','poisoned')),
  state           TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pr_journal (
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

export class Store {
  constructor(dbPath) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(SCHEMA);
    this.fault = null; // test hook: (point) => void, may throw
    this._txnDepth = 0;
  }

  close() { this.db.close(); }

  _fault(point) { if (this.fault) this.fault(point); }

  /** Nesting-tolerant transaction: only the outermost call opens/commits. */
  txn(fn) {
    if (this._txnDepth > 0) { this._txnDepth++; try { return fn(); } finally { this._txnDepth--; } }
    this.db.exec('BEGIN IMMEDIATE');
    this._txnDepth = 1;
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw err;
    } finally {
      this._txnDepth = 0;
    }
  }

  // ---- instances -----------------------------------------------------------

  insertInstance({ instanceId, machineId, machineVersion, state, status = 'active', now }) {
    this.db.prepare(
      `INSERT INTO pr_instance (instance_id, machine_id, machine_version, seq, status, state, created_at, updated_at)
       VALUES (?, ?, ?, 0, ?, ?, ?, ?)`
    ).run(instanceId, machineId, machineVersion, status, JSON.stringify(state), now, now);
  }

  getInstance(instanceId) {
    const row = this.db.prepare('SELECT * FROM pr_instance WHERE instance_id = ?').get(instanceId);
    if (!row) return null;
    return { ...row, state: JSON.parse(row.state) };
  }

  /** FR-1.3: poisoning is a durable status write PLUS cancellation of the
   *  instance's scheduled timers, atomically — a poisoned instance must not
   *  keep generating timer round-trips. */
  markPoisoned(instanceId, now) {
    this.txn(() => {
      this.db.prepare(`UPDATE pr_instance SET status = 'poisoned', updated_at = ? WHERE instance_id = ?`)
        .run(now, instanceId);
      this.db.prepare(`UPDATE pr_timer SET status = 'cancelled' WHERE instance_id = ? AND status = 'scheduled'`)
        .run(instanceId);
    });
  }

  listInstances(machineId, status) {
    let sql = 'SELECT * FROM pr_instance WHERE machine_id = ?';
    const args = [machineId];
    if (status) { sql += ' AND status = ?'; args.push(status); }
    return this.db.prepare(sql).all(...args).map((r) => ({ ...r, state: JSON.parse(r.state) }));
  }

  // ---- journal -------------------------------------------------------------

  insertJournal({ instanceId, machineVersion, seq, action, data, pre, post, stepKind, rejectReason, actionId, now }) {
    this.db.prepare(
      `INSERT INTO pr_journal (instance_id, machine_version, seq, action, data, pre, post, step_kind, reject_reason, action_id, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(instanceId, machineVersion, seq, action, JSON.stringify(data), JSON.stringify(pre),
      JSON.stringify(post), stepKind, rejectReason ?? null, actionId, now);
  }

  getJournalByActionId(instanceId, actionId) {
    const row = this.db.prepare(
      'SELECT * FROM pr_journal WHERE instance_id = ? AND action_id = ?'
    ).get(instanceId, actionId);
    return row ? this._journalRow(row) : null;
  }

  getJournalRow(instanceId, seq) {
    const row = this.db.prepare(
      'SELECT * FROM pr_journal WHERE instance_id = ? AND seq = ?'
    ).get(instanceId, seq);
    return row ? this._journalRow(row) : null;
  }

  lastAcceptedAtOrBefore(instanceId, seq) {
    const row = this.db.prepare(
      `SELECT * FROM pr_journal WHERE instance_id = ? AND seq <= ? AND step_kind = 'accepted'
       ORDER BY seq DESC LIMIT 1`
    ).get(instanceId, seq);
    return row ? this._journalRow(row) : null;
  }

  getJournal(instanceId) {
    return this.db.prepare(
      'SELECT * FROM pr_journal WHERE instance_id = ? ORDER BY seq'
    ).all(instanceId).map((r) => this._journalRow(r));
  }

  _journalRow(r) {
    return {
      ...r,
      data: JSON.parse(r.data),
      pre: JSON.parse(r.pre),
      post: JSON.parse(r.post),
    };
  }

  // ---- the one write path (FR-2.2) ----------------------------------------
  //
  // Everything a step decided commits here, atomically: journal row, snapshot
  // + status, outbox intents, timer cancellations then creations. Cancels run
  // BEFORE inserts so a cancel-and-rearm step cancels the OLD timer, not the
  // one it just scheduled. `fault(point)` fires between each group so tests
  // can prove all-or-nothing.

  commitStep({ instanceId, machineVersion, seq, journal, newState, newStatus, outboxRows, timerRows, cancelTimerKeys, cancelAllTimers, now }) {
    return this.txn(() => {
      this.insertJournal({ instanceId, machineVersion, seq, ...journal, now });
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

  recoverExpiredLeases(now) {
    this.db.prepare(
      `UPDATE pr_outbox SET status = 'pending', claimed_until = NULL
       WHERE status = 'inflight' AND claimed_until < ?`
    ).run(now);
  }

  claimEffects(now, limit, leaseMs) {
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

  // The three mark* below are FENCED on status='inflight': a worker whose
  // lease expired (row recovered and possibly re-claimed, finished, or
  // killed by another worker) must not overwrite the newer outcome — a
  // stale markEffectRetry flipping a 'done' row back to 'pending' would
  // re-execute a completed effect and could deliver conflicting completions.

  markEffectDone(intentId) {
    this.db.prepare(`UPDATE pr_outbox SET status = 'done', claimed_until = NULL WHERE intent_id = ? AND status = 'inflight'`).run(intentId);
  }

  markEffectRetry(intentId, attempts, nextAttemptAt, lastError) {
    this.db.prepare(
      `UPDATE pr_outbox SET status = 'pending', attempts = ?, next_attempt_at = ?, claimed_until = NULL, last_error = ? WHERE intent_id = ? AND status = 'inflight'`
    ).run(attempts, nextAttemptAt, lastError, intentId);
  }

  markEffectDead(intentId, attempts, lastError) {
    this.db.prepare(
      `UPDATE pr_outbox SET status = 'dead', claimed_until = NULL, attempts = ?, last_error = ? WHERE intent_id = ? AND status = 'inflight'`
    ).run(attempts, lastError, intentId);
  }

  getOutbox(instanceId, status) {
    let sql = 'SELECT * FROM pr_outbox WHERE instance_id = ?';
    const args = [instanceId];
    if (status) { sql += ' AND status = ?'; args.push(status); }
    return this.db.prepare(sql).all(...args).map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
  }

  // ---- timers ---------------------------------------------------------------

  dueTimers(now, limit) {
    return this.db.prepare(
      `SELECT * FROM pr_timer WHERE status = 'scheduled' AND fire_at <= ? ORDER BY fire_at LIMIT ?`
    ).all(now, limit).map((r) => ({ ...r, data: JSON.parse(r.data) }));
  }

  markTimerFired(timerId) {
    this.db.prepare(`UPDATE pr_timer SET status = 'fired' WHERE timer_id = ?`).run(timerId);
  }

  /** Push an erroring timer's due time forward so it neither aborts its
   *  batch-mates nor starves the head of the due queue (per-timer backoff). */
  deferTimer(timerId, fireAt) {
    this.db.prepare(`UPDATE pr_timer SET fire_at = ? WHERE timer_id = ? AND status = 'scheduled'`).run(fireAt, timerId);
  }

  getTimers(instanceId, status) {
    let sql = 'SELECT * FROM pr_timer WHERE instance_id = ?';
    const args = [instanceId];
    if (status) { sql += ' AND status = ?'; args.push(status); }
    return this.db.prepare(sql).all(...args).map((r) => ({ ...r, data: JSON.parse(r.data) }));
  }
}
