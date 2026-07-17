// polyrun Postgres store (M1) — the production adapter (spec §5.1/§5.2).
//
// Same interface as the SQLite Store, backed by a pg Pool. Transactions run
// on a dedicated client carried via AsyncLocalStorage, so nested store calls
// inside a txn callback share the client and everything else uses the pool.
// Multi-writer correctness (FR-2.4): the kernel's dispatch txn opens with
// getInstanceForUpdate → SELECT ... FOR UPDATE, so two writers on one
// instance serialize on the row lock; the loser re-reads and its dedupe/seq
// view is fresh by construction. claimEffects/dueTimers use SKIP LOCKED.
'use strict';

import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pr_instance (
  instance_id     text PRIMARY KEY,
  machine_id      text NOT NULL,
  machine_version text NOT NULL,
  seq             bigint NOT NULL DEFAULT 0,
  status          text NOT NULL CHECK (status IN ('active','terminal','poisoned')),
  state           jsonb NOT NULL,
  created_at      bigint NOT NULL,
  updated_at      bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS pr_instance_machine ON pr_instance (machine_id, status);
CREATE INDEX IF NOT EXISTS pr_instance_state ON pr_instance USING gin (state jsonb_path_ops);
CREATE TABLE IF NOT EXISTS pr_journal (
  instance_id     text NOT NULL,
  machine_version text NOT NULL,
  seq             bigint NOT NULL,
  action          text NOT NULL,
  data            jsonb NOT NULL,
  pre             jsonb NOT NULL,
  post            jsonb NOT NULL,
  step_kind       text NOT NULL CHECK (step_kind IN ('accepted','rejected','unhandled')),
  reject_reason   text,
  action_id       text NOT NULL,
  at              bigint NOT NULL,
  PRIMARY KEY (instance_id, seq),
  UNIQUE (instance_id, action_id)
);
CREATE TABLE IF NOT EXISTS pr_outbox (
  intent_id       text PRIMARY KEY,
  instance_id     text NOT NULL,
  seq             bigint NOT NULL,
  kind            text NOT NULL,
  payload         jsonb NOT NULL,
  status          text NOT NULL CHECK (status IN ('pending','inflight','done','dead')),
  attempts        int NOT NULL DEFAULT 0,
  next_attempt_at bigint NOT NULL,
  claimed_until   bigint,
  last_error      text
);
CREATE INDEX IF NOT EXISTS pr_outbox_pending ON pr_outbox (status, next_attempt_at) WHERE status = 'pending';
CREATE TABLE IF NOT EXISTS pr_timer (
  timer_id    text PRIMARY KEY,
  instance_id text NOT NULL,
  key         text NOT NULL,
  fire_at     bigint NOT NULL,
  action      text NOT NULL,
  data        jsonb NOT NULL,
  status      text NOT NULL CHECK (status IN ('scheduled','fired','cancelled'))
);
CREATE INDEX IF NOT EXISTS pr_timer_due ON pr_timer (status, fire_at) WHERE status = 'scheduled';
`;

const num = (v) => (v === null || v === undefined ? v : Number(v));

export class PgStore {
  /** `schema` (optional) namespaces all tables into a Postgres schema —
   *  used by the test suite for per-runtime isolation on one database. */
  constructor(connectionString, poolOptions = {}, schema) {
    this.schema = schema;
    this.pool = new pg.Pool({
      connectionString,
      max: 10,
      ...(schema ? { options: `-csearch_path=${schema}` } : {}),
      ...poolOptions,
    });
    this._als = new AsyncLocalStorage();
    this.fault = null; // test hook, same contract as the SQLite store
  }

  async init() {
    if (this.schema) {
      if (!/^[a-z_][a-z0-9_]*$/.test(this.schema)) throw new Error(`invalid schema name '${this.schema}'`);
      await this.pool.query(`CREATE SCHEMA IF NOT EXISTS ${this.schema}`);
    }
    await this.pool.query(SCHEMA);
    return this;
  }

  async close() { await this.pool.end(); }

  _fault(point) { if (this.fault) this.fault(point); }

  isUniqueViolation(err) { return !!err && err.code === '23505'; }

  _q(text, params) {
    const ctx = this._als.getStore();
    return (ctx ? ctx.client : this.pool).query(text, params);
  }

  async txn(fn) {
    if (this._als.getStore()) return fn();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await this._als.run({ client }, fn);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* connection may be gone */ }
      throw err;
    } finally {
      client.release();
    }
  }

  // ---- instances -----------------------------------------------------------

  async insertInstance({ instanceId, machineId, machineVersion, state, status = 'active', now }) {
    await this._q(
      `INSERT INTO pr_instance (instance_id, machine_id, machine_version, seq, status, state, created_at, updated_at)
       VALUES ($1, $2, $3, 0, $4, $5, $6, $6)`,
      [instanceId, machineId, machineVersion, status, JSON.stringify(state), now]);
  }

  _instanceRow(r) { return r ? { ...r, seq: num(r.seq), state: r.state } : null; }

  async getInstance(instanceId) {
    const { rows } = await this._q('SELECT * FROM pr_instance WHERE instance_id = $1', [instanceId]);
    return this._instanceRow(rows[0] ?? null);
  }

  /** FR-2.4: the dispatch transaction locks the instance row; concurrent
   *  writers on the same instance serialize here. */
  async getInstanceForUpdate(instanceId) {
    const { rows } = await this._q('SELECT * FROM pr_instance WHERE instance_id = $1 FOR UPDATE', [instanceId]);
    return this._instanceRow(rows[0] ?? null);
  }

  async markPoisoned(instanceId, now) {
    return this.txn(async () => {
      await this._q(`UPDATE pr_instance SET status = 'poisoned', updated_at = $2 WHERE instance_id = $1`, [instanceId, now]);
      await this._q(`UPDATE pr_timer SET status = 'cancelled' WHERE instance_id = $1 AND status = 'scheduled'`, [instanceId]);
    });
  }

  async listInstances(machineId, status) {
    const sql = status
      ? 'SELECT * FROM pr_instance WHERE machine_id = $1 AND status = $2'
      : 'SELECT * FROM pr_instance WHERE machine_id = $1';
    const { rows } = await this._q(sql, status ? [machineId, status] : [machineId]);
    return rows.map((r) => this._instanceRow(r));
  }

  // ---- journal -------------------------------------------------------------

  async insertJournal({ instanceId, machineVersion, seq, action, data, pre, post, stepKind, rejectReason, actionId, now }) {
    await this._q(
      `INSERT INTO pr_journal (instance_id, machine_version, seq, action, data, pre, post, step_kind, reject_reason, action_id, at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [instanceId, machineVersion, seq, action, JSON.stringify(data), JSON.stringify(pre),
        JSON.stringify(post), stepKind, rejectReason ?? null, actionId, now]);
  }

  _journalRow(r) { return r ? { ...r, seq: num(r.seq), at: num(r.at) } : null; }

  async getJournalByActionId(instanceId, actionId) {
    const { rows } = await this._q('SELECT * FROM pr_journal WHERE instance_id = $1 AND action_id = $2', [instanceId, actionId]);
    return this._journalRow(rows[0] ?? null);
  }

  async getJournalRow(instanceId, seq) {
    const { rows } = await this._q('SELECT * FROM pr_journal WHERE instance_id = $1 AND seq = $2', [instanceId, seq]);
    return this._journalRow(rows[0] ?? null);
  }

  async lastAcceptedAtOrBefore(instanceId, seq) {
    const { rows } = await this._q(
      `SELECT * FROM pr_journal WHERE instance_id = $1 AND seq <= $2 AND step_kind = 'accepted'
       ORDER BY seq DESC LIMIT 1`, [instanceId, seq]);
    return this._journalRow(rows[0] ?? null);
  }

  async getJournal(instanceId) {
    const { rows } = await this._q('SELECT * FROM pr_journal WHERE instance_id = $1 ORDER BY seq', [instanceId]);
    return rows.map((r) => this._journalRow(r));
  }

  // ---- the one write path ----------------------------------------------------

  async commitStep({ instanceId, machineVersion, seq, journal, newState, newStatus, outboxRows, timerRows, cancelTimerKeys, cancelAllTimers, now }) {
    return this.txn(async () => {
      await this.insertJournal({ instanceId, machineVersion, seq, ...journal, now });
      this._fault('after-journal');

      if (newState !== undefined) {
        await this._q('UPDATE pr_instance SET state = $2, seq = $3, status = $4, updated_at = $5 WHERE instance_id = $1',
          [instanceId, JSON.stringify(newState), seq, newStatus, now]);
      } else {
        await this._q('UPDATE pr_instance SET seq = $2, updated_at = $3 WHERE instance_id = $1', [instanceId, seq, now]);
      }
      this._fault('after-instance');

      for (const row of outboxRows) {
        await this._q(
          `INSERT INTO pr_outbox (intent_id, instance_id, seq, kind, payload, status, attempts, next_attempt_at)
           VALUES ($1, $2, $3, $4, $5, 'pending', 0, $6)`,
          [row.intentId, instanceId, seq, row.kind, JSON.stringify(row.payload), now]);
      }
      this._fault('after-outbox');

      for (const key of cancelTimerKeys) {
        await this._q(`UPDATE pr_timer SET status = 'cancelled' WHERE instance_id = $1 AND key = $2 AND status = 'scheduled'`, [instanceId, key]);
      }
      if (cancelAllTimers) {
        await this._q(`UPDATE pr_timer SET status = 'cancelled' WHERE instance_id = $1 AND status = 'scheduled'`, [instanceId]);
      }
      for (const t of timerRows) {
        await this._q(
          `INSERT INTO pr_timer (timer_id, instance_id, key, fire_at, action, data, status)
           VALUES ($1, $2, $3, $4, $5, $6, 'scheduled')`,
          [t.timerId, instanceId, t.key, t.fireAt, t.action, JSON.stringify(t.data)]);
      }
      this._fault('after-timers');
    });
  }

  // ---- outbox ---------------------------------------------------------------

  async recoverExpiredLeases(now) {
    await this._q(`UPDATE pr_outbox SET status = 'pending', claimed_until = NULL WHERE status = 'inflight' AND claimed_until < $1`, [now]);
  }

  async claimEffects(now, limit, leaseMs) {
    const { rows } = await this._q(
      `UPDATE pr_outbox SET status = 'inflight', claimed_until = $1
       WHERE intent_id IN (
         SELECT intent_id FROM pr_outbox
         WHERE status = 'pending' AND next_attempt_at <= $2
         ORDER BY next_attempt_at LIMIT $3
         FOR UPDATE SKIP LOCKED
       )
       RETURNING *`,
      [now + leaseMs, now, limit]);
    return rows.map((r) => ({ ...r, seq: num(r.seq), attempts: num(r.attempts) }));
  }

  async markEffectDone(intentId) {
    await this._q(`UPDATE pr_outbox SET status = 'done', claimed_until = NULL WHERE intent_id = $1 AND status = 'inflight'`, [intentId]);
  }

  async markEffectRetry(intentId, attempts, nextAttemptAt, lastError) {
    await this._q(
      `UPDATE pr_outbox SET status = 'pending', attempts = $2, next_attempt_at = $3, claimed_until = NULL, last_error = $4
       WHERE intent_id = $1 AND status = 'inflight'`,
      [intentId, attempts, nextAttemptAt, lastError]);
  }

  async markEffectDead(intentId, attempts, lastError) {
    await this._q(
      `UPDATE pr_outbox SET status = 'dead', claimed_until = NULL, attempts = $2, last_error = $3
       WHERE intent_id = $1 AND status = 'inflight'`,
      [intentId, attempts, lastError]);
  }

  async getOutbox(instanceId, status) {
    const sql = status
      ? 'SELECT * FROM pr_outbox WHERE instance_id = $1 AND status = $2'
      : 'SELECT * FROM pr_outbox WHERE instance_id = $1';
    const { rows } = await this._q(sql, status ? [instanceId, status] : [instanceId]);
    return rows.map((r) => ({ ...r, seq: num(r.seq), attempts: num(r.attempts) }));
  }

  async dlqList() {
    const { rows } = await this._q(`SELECT * FROM pr_outbox WHERE status = 'dead' ORDER BY instance_id, seq`);
    return rows.map((r) => ({ ...r, seq: num(r.seq), attempts: num(r.attempts) }));
  }

  async dlqRetry(intentId, now) {
    await this._q(
      `UPDATE pr_outbox SET status = 'pending', attempts = 0, next_attempt_at = $2, last_error = 'dlq-retry' WHERE intent_id = $1 AND status = 'dead'`,
      [intentId, now]);
  }

  async dlqDiscard(intentId) {
    await this._q(`UPDATE pr_outbox SET status = 'done', last_error = 'dlq-discarded' WHERE intent_id = $1 AND status = 'dead'`, [intentId]);
  }

  // ---- timers ---------------------------------------------------------------

  async dueTimers(now, limit) {
    const { rows } = await this._q(
      `SELECT * FROM pr_timer WHERE status = 'scheduled' AND fire_at <= $1 ORDER BY fire_at LIMIT $2 FOR UPDATE SKIP LOCKED`,
      [now, limit]);
    return rows.map((r) => ({ ...r, fire_at: num(r.fire_at) }));
  }

  async markTimerFired(timerId) {
    await this._q(`UPDATE pr_timer SET status = 'fired' WHERE timer_id = $1`, [timerId]);
  }

  async deferTimer(timerId, fireAt) {
    await this._q(`UPDATE pr_timer SET fire_at = $2 WHERE timer_id = $1 AND status = 'scheduled'`, [timerId, fireAt]);
  }

  async getTimers(instanceId, status) {
    const sql = status
      ? 'SELECT * FROM pr_timer WHERE instance_id = $1 AND status = $2'
      : 'SELECT * FROM pr_timer WHERE instance_id = $1';
    const { rows } = await this._q(sql, status ? [instanceId, status] : [instanceId]);
    return rows.map((r) => ({ ...r, fire_at: num(r.fire_at) }));
  }
}
