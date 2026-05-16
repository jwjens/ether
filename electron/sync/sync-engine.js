'use strict';
// electron/sync/sync-engine.js — sync orchestrator per protocol doc §17–§22.
//
// Transport-agnostic: accepts any EtherTransport-conforming object [N-113].
// Not wired into main.js startup until Stage 4.
//
// Responsibilities:
//   push()        — send pending local mutations via transport [§17]
//   pull()        — fetch and merge remote mutations [§18..§19]
//   syncCycle()   — push then pull, retry causal queue, check staleness
//   compact()     — 90-day retention via compactMutations() [§22]

const { REGISTRY }                     = require('./synced-tables');
const { toWireFormat, compactMutations } = require('./mutation-writer');
const { MergeEngine, compareHLC }       = require('./merge-engine');
const { CausalOrderQueue }              = require('./causal-order');

const MAX_PUSH_BATCH = 500;           // [N-93]
const CURSOR_KEY     = 'sync_cursor'; // key in system_state [N-96]

// Tables excluded from push [N-92]
const EXCLUDED_TABLES = new Set(
  Object.values(REGISTRY)
    .filter(e => e.syncExcluded === true || e.scope === 'local-only')
    .map(e => e.tableName)
);

class SyncEngine {
  /**
   * @param {import('better-sqlite3').Database} db
   * @param {import('./transport').EtherTransport} transport
   * @param {object} [opts]
   * @param {number} [opts.localSchemaVersion]  defaults to reading schema_version table
   */
  constructor(db, transport, opts = {}) {
    this._db        = db;
    this._transport = transport;
    this._localSV   = opts.localSchemaVersion ?? this._readSchemaVersion();
    this._cursor    = this._loadCursor();

    this._causalQueue = new CausalOrderQueue();
    this._mergeEngine = new MergeEngine(db, {
      localSchemaVersion: this._localSV,
      causalQueue:        this._causalQueue,
      onCursorAdvance:    (cid, hlc) => this._advanceCursor(cid, hlc),
    });

    // Prepared statements for push
    this._stmtMarkSynced = db.prepare("UPDATE mutations SET sync_status = 'synced' WHERE id = ?");
  }

  // ── Push [§17] ────────────────────────────────────────────────────────────

  async push() {
    const pending = this._loadPendingMutations();
    if (pending.length === 0) return { sent: 0, accepted: 0, rejected: 0 };

    let accepted = 0, rejected = 0;

    for (let i = 0; i < pending.length; i += MAX_PUSH_BATCH) {
      const chunk = pending.slice(i, i + MAX_PUSH_BATCH);
      const batch = {
        client_id:  chunk[0].client_id,
        station_id: null,
        batch:      chunk.map(toWireFormat),
      };

      let result;
      try {
        result = await this._transport.push(batch);
      } catch (err) {
        console.error('[sync-engine] push transport error:', err.message);
        break;
      }

      const acceptedIds = result.accepted ?? [];
      const rejectedIds = result.rejected ?? [];

      if (acceptedIds.length > 0) {
        const markBatch = this._db.transaction((ids) => {
          for (const id of ids) this._stmtMarkSynced.run(id);
        });
        markBatch(acceptedIds);
        accepted += acceptedIds.length;
      }

      if (rejectedIds.length > 0) {
        for (const r of rejectedIds) {
          console.error('[sync-engine] push rejected: id=' + r.id + ' reason=' + r.reason);
        }
        rejected += rejectedIds.length;
      }
    }

    return { sent: pending.length, accepted, rejected };
  }

  // ── Pull [§18..§19] ───────────────────────────────────────────────────────

  async pull() {
    const clientId = this._db.prepare('SELECT client_id FROM client_identity LIMIT 1').get()?.client_id;
    if (!clientId) throw new Error('sync-engine: client_identity not seeded [N-77]');

    let result;
    try {
      result = await this._transport.pull({
        client_id:  clientId,
        station_id: null,
        cursor:     this._cursor,
      });
    } catch (err) {
      console.error('[sync-engine] pull transport error:', err.message);
      return { pulled: 0 };
    }

    const mutations = result.mutations ?? [];
    const outcomes  = { applied: 0, loser: 0, idempotent: 0, held: 0, quarantined: 0, rejected: 0 };

    for (const m of mutations) {
      const outcome = this._mergeEngine.apply(m);
      outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;

      // After a successful apply, retry anything held on this mutation [N-104]
      if (outcome === 'applied' || outcome === 'loser') {
        this._retryCausalQueue(m.id);
      }
    }

    this._saveCursor();
    return { pulled: mutations.length, ...outcomes };
  }

  // ── Sync cycle ────────────────────────────────────────────────────────────

  async syncCycle() {
    const pushResult = await this.push();
    const pullResult = await this.pull();
    this._causalQueue.checkStale();
    return { push: pushResult, pull: pullResult };
  }

  // ── Compaction / retention [§22] ──────────────────────────────────────────

  compact() {
    return compactMutations(this._db);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  _loadPendingMutations() {
    if (EXCLUDED_TABLES.size === 0) {
      return this._db.prepare(
        "SELECT * FROM mutations WHERE sync_status = 'pending' ORDER BY hlc ASC"
      ).all();
    }
    const placeholders = Array.from(EXCLUDED_TABLES).map(() => '?').join(', ');
    return this._db.prepare(
      `SELECT * FROM mutations WHERE sync_status = 'pending' AND table_name NOT IN (${placeholders}) ORDER BY hlc ASC`
    ).all(...EXCLUDED_TABLES);
  }

  _retryCausalQueue(parentId) {
    const released = this._causalQueue.release(parentId);
    for (const m of released) {
      const outcome = this._mergeEngine.apply(m);
      if (outcome === 'applied' || outcome === 'loser') {
        this._retryCausalQueue(m.id);  // recurse for chains [N-103]
      }
    }
  }

  _advanceCursor(clientId, hlc) {
    const current = this._cursor[clientId];
    if (!current || compareHLC(hlc, current) > 0) {
      this._cursor[clientId] = hlc;
    }
  }

  _loadCursor() {
    const row = this._db.prepare(`SELECT value FROM system_state WHERE key = '${CURSOR_KEY}'`).get();
    if (!row?.value) return {};
    try { return JSON.parse(row.value) ?? {}; }
    catch (_) { return {}; }
  }

  _saveCursor() {
    const json = JSON.stringify(this._cursor);
    this._db.prepare(
      `INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(CURSOR_KEY, json, new Date().toISOString());
  }

  _readSchemaVersion() {
    return this._db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get()?.version ?? 0;
  }
}

module.exports = { SyncEngine };
