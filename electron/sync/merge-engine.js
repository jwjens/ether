'use strict';
// electron/sync/merge-engine.js — apply remote mutations per protocol doc §19.
//
// Transport-agnostic. Implements the 7-step merge algorithm:
//   Step 1 — Idempotency check [N-100]
//   Step 2 — Filter check (syncExcluded / local-only) [N-101]
//   Step 3 — Schema version check (same / backward / forward) [N-102]
//   Step 4 — Causal ordering hold-and-wait [N-103..N-104]
//   Step 5 — LWW resolution [N-105..N-106]
//   Step 6 — Apply to live table [N-107]
//   Step 7 — Log mutation + advance cursor [N-108]
//
// Returns one of: 'applied' | 'loser' | 'idempotent' | 'held' | 'quarantined' | 'rejected' | 'conflicted'

const { deserializePayload }                      = require('./mutation-writer');
const { REGISTRY }                                = require('./synced-tables');
const { applyTransformerChain } = require('./transformer-chain');

// ── HLC comparison [N-46] ─────────────────────────────────────────────────────
// Returns -1 if a < b, 0 if a === b, +1 if a > b.
// Format: <wall_ms>:<logical>:<client_id> — split on first two colons only.
// UUIDs contain dashes, not colons, so plain split(':') yields exactly 3 parts.

function compareHLC(a, b) {
  const partsA = a.split(':');
  const partsB = b.split(':');

  const wallA = parseInt(partsA[0], 10);
  const wallB = parseInt(partsB[0], 10);
  if (wallA !== wallB) return wallA < wallB ? -1 : 1;

  const logA = parseInt(partsA[1], 10);
  const logB = parseInt(partsB[1], 10);
  if (logA !== logB) return logA < logB ? -1 : 1;

  // client_id is everything after the second colon [N-40]
  const cA = partsA.slice(2).join(':');
  const cB = partsB.slice(2).join(':');
  if (cA < cB) return -1;
  if (cA > cB) return 1;
  return 0;
}

// ── MergeEngine ───────────────────────────────────────────────────────────────

class MergeEngine {
  /**
   * @param {import('better-sqlite3').Database} db
   * @param {object} opts
   * @param {number}   opts.localSchemaVersion
   * @param {import('./causal-order').CausalOrderQueue} opts.causalQueue
   * @param {function} opts.onCursorAdvance  (clientId: string, hlc: string) => void
   */
  constructor(db, { localSchemaVersion, causalQueue, onCursorAdvance, uuidIdentity }) {
    this._db                  = db;
    this._localSchemaVersion  = localSchemaVersion;
    this._causalQueue         = causalQueue;
    this._onCursorAdvance     = onCursorAdvance ?? (() => {});
    // UUID-identity (Tier-2): when on, incoming station_id / parent-FK columns are remapped from the
    // sender's local integers to THIS install's local ids via the row's stable uuids (m.ref_uuids),
    // and the row's own integer `id` is never written (matched by uuid). Off → legacy behavior.
    this._uuidIdentity        = uuidIdentity ?? false;
    this._refStmts            = {};

    // Prepare reusable statements
    this._stmtExists = db.prepare('SELECT 1 FROM mutations WHERE id = ? LIMIT 1');
    this._stmtLatest = db.prepare(
      'SELECT hlc, client_id FROM mutations WHERE table_name = ? AND row_id = ? ORDER BY hlc DESC LIMIT 1'
    );
    this._stmtLog = db.prepare(`
      INSERT INTO mutations (
        id, client_id, station_id, actor_id,
        table_name, row_id, op,
        payload_before, payload_after,
        created_at, applied_at, hlc,
        parent_mutation_id, schema_version,
        origin, sync_status, conflict_resolution
      ) VALUES (
        @id, @client_id, @station_id, @actor_id,
        @table_name, @row_id, @op,
        @payload_before, @payload_after,
        @created_at, @applied_at, @hlc,
        @parent_mutation_id, @schema_version,
        'remote', @sync_status, @conflict_resolution
      )
    `);
  }

  /**
   * Apply one remote wire-format mutation.
   * All 7 steps execute inside a single SQLite transaction.
   * @param {object} wireMutation  14-field wire object
   * @returns {string}  'applied'|'loser'|'idempotent'|'held'|'quarantined'|'rejected'|'conflicted'
   */
  apply(wireMutation) {
    return this._db.transaction(() => this._applyInner(wireMutation))();
  }

  _applyInner(m) {
    const now = new Date().toISOString();

    // ── Step 1: Idempotency [N-100] ───────────────────────────────────────────
    if (this._stmtExists.get(m.id)) {
      this._advanceCursor(m.client_id, m.hlc);
      return 'idempotent';
    }

    // ── Step 2: Filter check [N-101] ──────────────────────────────────────────
    const entry = REGISTRY[m.table_name];
    if (!entry || entry.syncExcluded === true || entry.scope === 'local-only') {
      console.error(
        '[merge-engine] protocol violation: received excluded/local-only mutation for "' +
        m.table_name + '" id=' + m.id
      );
      return 'rejected';
    }

    // ── Step 3: Schema version check [N-102] ──────────────────────────────────
    if (m.schema_version > this._localSchemaVersion) {
      this._quarantine(m);
      this._advanceCursor(m.client_id, m.hlc);
      return 'quarantined';
    }
    if (m.schema_version < this._localSchemaVersion) {
      // Transformer chain: upgrade both payloads from mutation's schema version to local [N-62].
      // payload_before is null for inserts; payload_after is null for deletes — both legitimate.
      // One try/catch: if either transform throws the whole mutation goes conflicted [N-63].
      try {
        m = { ...m,
          payload_before: m.payload_before ? applyTransformerChain(m.payload_before, m.schema_version, this._localSchemaVersion, m) : null,
          payload_after:  m.payload_after  ? applyTransformerChain(m.payload_after,  m.schema_version, this._localSchemaVersion, m) : null,
        };
      } catch (err) {
        // Transformer failure — log as conflicted and skip apply [N-63].
        // Cursor advances so the next pull does not re-deliver this mutation.
        // m is still the original untransformed wire object here (assignment threw before completing).
        console.error(
          '[merge-engine] transformer chain failed id=' + m.id +
          ' sv=' + m.schema_version + ': ' + err.message
        );
        this._logRemote(m, now, 'conflicted');
        this._advanceCursor(m.client_id, m.hlc);
        return 'conflicted';
      }
    }

    // ── Step 4: Causal ordering [N-103..N-104] ────────────────────────────────
    if (m.parent_mutation_id && !this._stmtExists.get(m.parent_mutation_id)) {
      this._causalQueue.hold(m);
      // Do NOT advance cursor — leaves re-delivery path open [N-108]
      return 'held';
    }

    // ── Step 5: LWW resolution [N-105..N-106] ─────────────────────────────────
    const localLatest = this._stmtLatest.get(m.table_name, m.row_id);

    if (localLatest) {
      const cmp = compareHLC(m.hlc, localLatest.hlc);
      if (cmp <= 0) {
        // Incoming loses (lower HLC, or tied with lower client_id)
        this._logRemote(m, now);
        this._advanceCursor(m.client_id, m.hlc);
        return 'loser';
      }
      // cmp > 0 → incoming wins; fall through to apply
    }
    // No prior history OR incoming has higher HLC → incoming wins

    // ── Step 6: Apply to live table [N-107] ───────────────────────────────────
    this._applyToLiveTable(m, now);

    // ── Step 7: Log + advance cursor [N-108] ──────────────────────────────────
    this._logRemote(m, now);
    this._advanceCursor(m.client_id, m.hlc);
    return 'applied';
  }

  // Wire name → physical table. The WIRE name is protocol (peers key on it and it must never change);
  // the PHYSICAL name is where SQL actually writes. They diverge for `songs`, which is now a VIEW over
  // `songs_all WHERE deleted_at IS NULL` so a deleted song is unreachable to every reader by
  // construction (docs/deleted-songs-still-air-design-2026-08-06.md §7.1). Views are not writable, so
  // every apply must resolve through here. Any future table that gains a live-view gets it free.
  _physical(tableName) {
    const entry = REGISTRY[tableName];
    return (entry && entry.tableName) || tableName;
  }

  _applyToLiveTable(m, now) {
    const { row_id, op, payload_after, created_at } = m;
    const table_name = this._physical(m.table_name);
    const db = this._db;

    if (op === 'insert' || op === 'update') {
      if (!payload_after) return;
      // Deserialization is keyed on the WIRE name (the REGISTRY key), never the physical table.
      const row = deserializePayload(payload_after, m.table_name);

      // UUID-identity: remap the sender's local-integer references (station_id + parent FKs) to THIS
      // install's local ids via their stable uuids before writing, so a station that is local id 1 on
      // the sender and id 2 here lands on id 2 here (and its slots link to the local clock/category).
      if (this._uuidIdentity) this._remapRefs(m, row);

      // Build column list from defined values (undefined = column missing from payload).
      // Under uuid-identity the row's own integer `id` is NOT cross-install identity (rows are keyed
      // by uuid), so never write it — that is what prevents renumbering local rows out from under
      // generated_schedule's local-id references.
      const cols = Object.keys(row).filter(k => row[k] !== undefined && !(this._uuidIdentity && k === 'id'));
      if (cols.length === 0) return;

      const placeholders = cols.map(() => '?').join(', ');
      const vals         = cols.map(c => row[c] ?? null);

      if (op === 'insert') {
        // INSERT OR REPLACE handles both new row and re-insert-after-tombstone [N-107]
        db.prepare(
          `INSERT OR REPLACE INTO ${table_name} (${cols.join(', ')}) VALUES (${placeholders})`
        ).run(...vals);

      } else {
        // UPDATE; fall back to INSERT OR REPLACE if row doesn't exist locally [N-107]
        // id IS included so UPDATE mutations can move a row's integer pk (e.g. shows id=null→real) [N-108c]
        const setCols = cols.filter(c => c !== 'uuid');
        if (setCols.length > 0) {
          const setClause = setCols.map(c => `${c} = ?`).join(', ');
          const setVals   = setCols.map(c => row[c] ?? null);
          const changes = db.prepare(
            `UPDATE ${table_name} SET ${setClause} WHERE uuid = ?`
          ).run(...setVals, row_id).changes;

          if (changes === 0) {
            // Row not present locally — treat as INSERT [N-107]
            db.prepare(
              `INSERT OR REPLACE INTO ${table_name} (${cols.join(', ')}) VALUES (${placeholders})`
            ).run(...vals);
          }
        }
      }

    } else if (op === 'delete') {
      // Tombstone: set deleted_at to the mutation's created_at [N-107]/[N-109]
      const deleteTime = created_at || now;
      db.prepare(
        `UPDATE ${table_name} SET deleted_at = ?, updated_at = ? WHERE uuid = ?`
      ).run(deleteTime, deleteTime, row_id);
      // songs: a remote delete must be as final as a local one, or the song stays airable on this
      // install. Same neutering the local path applies — rotation_status='inactive' + file_path=NULL,
      // on fields every selector already reads. docs/migration-safety-and-customer-recovery-2026-08-06.md
      if (m.table_name === 'songs') {
        try { require('./handlers/songs').neuterSong(db, row_id, deleteTime); }
        catch (e) { console.error('[merge-engine] songs neuter failed (tombstone still set):', e.message); }
      }
      // If row not present locally: no-op — tombstone already satisfied [N-107]
    }
    // op='checkpoint': reserved; not applied to live tables in v0 [N-10]
  }

  // ── UUID-identity helpers (Tier-2) ────────────────────────────────────────────
  // Resolve a stable row uuid to THIS install's local integer id in the referenced table.
  _resolveLocalId(table, uuid) {
    if (!uuid) return null;
    if (!this._refStmts[table]) {
      // IDENTITY must never be blinded by deletion: resolve against the PHYSICAL table so a row that
      // legitimately references a deleted song (e.g. a preserved `played` history row) keeps its
      // reference instead of silently serializing null. Product reads use the live view; identity
      // resolution does not. docs/deleted-songs-still-air-design-2026-08-06.md §11.5.
      this._refStmts[table] = this._db.prepare(`SELECT id FROM ${this._physical(table)} WHERE uuid = ?`);
    }
    return this._refStmts[table].get(uuid)?.id ?? null;
  }

  // Rewrite each reference column on `row` from the sender's local id to this install's local id,
  // using the parent uuids the sender attached (m.ref_uuids: column → parent uuid) and the registry's
  // refs map (column → referenced table). station_id is the universal default for station-scoped
  // tables. An unresolved uuid means the parent isn't on this install yet — left as-is and logged;
  // ordered delivery (parents before children, by server_seq) makes this the rare case.
  _remapRefs(m, row) {
    const entry = REGISTRY[m.table_name];
    if (!entry || entry.scope !== 'station') return;
    const refs = entry.refs || { station_id: 'stations' };
    const refUuids = m.ref_uuids || {};
    for (const [col, refTable] of Object.entries(refs)) {
      const uuid = refUuids[col];
      if (uuid == null) continue;               // sender had no value for this ref (e.g. null show_id)
      const localId = this._resolveLocalId(refTable, uuid);
      if (localId != null) row[col] = localId;
      else console.warn(`[merge-engine] uuid-identity: ${m.table_name}.${col} uuid=${uuid} not resolvable on this install`);
    }
  }

  _logRemote(m, appliedAt, syncStatus = 'synced') {
    this._stmtLog.run({
      id:                  m.id,
      client_id:           m.client_id,
      station_id:          m.station_id ?? null,
      actor_id:            m.actor_id   ?? null,
      table_name:          m.table_name,
      row_id:              m.row_id,
      op:                  m.op,
      payload_before:      m.payload_before ? JSON.stringify(m.payload_before) : null,
      payload_after:       m.payload_after  ? JSON.stringify(m.payload_after)  : null,
      created_at:          m.created_at,
      applied_at:          appliedAt,
      hlc:                 m.hlc,
      parent_mutation_id:  m.parent_mutation_id ?? null,
      schema_version:      m.schema_version,
      sync_status:         syncStatus,
      conflict_resolution: m.conflict_resolution ? JSON.stringify(m.conflict_resolution) : null,
    });
  }

  _quarantine(m) {
    this._db.prepare(`
      INSERT INTO quarantine_mutations
        (id, raw_json, foreign_schema_version, local_schema_version, received_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `).run(
      m.id,
      JSON.stringify(m),
      m.schema_version,
      this._localSchemaVersion,
      new Date().toISOString(),
    );
    console.warn(
      '[merge-engine] quarantined: id=' + m.id +
      ' foreign_sv=' + m.schema_version +
      ' local_sv=' + this._localSchemaVersion + ' [N-64]'
    );
  }

  _advanceCursor(clientId, hlc) {
    this._onCursorAdvance(clientId, hlc);
  }
}

module.exports = { MergeEngine, compareHLC };
