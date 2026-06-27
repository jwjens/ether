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

const { REGISTRY }                               = require('./synced-tables');
const { toWireFormat, compactMutations }          = require('./mutation-writer');
const { MergeEngine, compareHLC }                = require('./merge-engine');
const { CausalOrderQueue }                       = require('./causal-order');
const { applyTransformerChain, TransformerMissingError } = require('./transformer-chain');

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
   * @param {number}   [opts.localSchemaVersion]  defaults to reading schema_version table
   * @param {function} [opts.getStationId]        () => string|null — called per pull so the
   *                                              active station is always current. Defaults to
   *                                              () => null (install-scoped only). Pass from
   *                                              main.js; SyncEngine does not query stations
   *                                              directly [single-station v1; multi-station safe].
   * @param {(event: { applied: number; byTable: Record<string,number> }) => void} [opts.onProgress]
   *                                              Optional. Invoked after each successful pull()
   *                                              with the count of newly-applied mutations and a
   *                                              per-table breakdown. Counts only outcome ===
   *                                              'applied' (mutations that changed local state).
   *                                              Idempotent / loser / held / quarantined / failed
   *                                              outcomes are excluded. Skipped entirely when
   *                                              applied === 0 (no signal worth firing for a
   *                                              no-op pull). Engine stays transport-agnostic —
   *                                              just invokes the callback if set, knows nothing
   *                                              about Electron.
   */
  constructor(db, transport, opts = {}) {
    this._db           = db;
    this._transport    = transport;
    this._localSV      = opts.localSchemaVersion ?? this._readSchemaVersion();
    // Per-context HLC cursor key + pull-only mode (desktop member-sync bridge). A member sync (another
    // account's station) MUST use its own cursor key so it doesn't clobber the owner sync's 'sync_cursor',
    // and runs PULL-ONLY so it never reads the shared pending-mutations queue and pushes the owner's
    // edits to the wrong account. Owner install defaults: legacy cursor key, push enabled.
    this._cursorKey    = opts.cursorKey || CURSOR_KEY;
    this._pullOnly     = opts.pullOnly ?? false;
    this._cursor       = this._loadCursor();
    this._getStationId = opts.getStationId ?? (() => null);
    this._onProgress   = opts.onProgress   ?? null;
    // UUID-identity (Tier-2): when on, push enriches station-scoped mutations with station_uuid +
    // parent-FK uuids, pull scopes by station_uuid, and merge remaps to local ids. Off → legacy.
    this._uuidIdentity   = opts.uuidIdentity   ?? false;
    this._getStationUuid = opts.getStationUuid ?? (() => null);
    this._uuidStmts      = {};
    // On-air predicate (Tier-2 re-baseline safety): () => boolean. The ONLY thing it gates is the heavy
    // one-shot corrective re-pull in rebaseline() — never the normal incremental push/pull. Defaults to
    // () => false (never on-air) so non-Electron callers (proof scripts) behave exactly as before.
    this._isOnAir        = opts.isOnAir ?? (() => false);
    // Per-context push isolation (member-operate). Each station you can operate runs its OWN sync
    // context; push must never send another account's edits under the wrong credential:
    //  • member context  → getPushOnlyStationId() returns that station's LOCAL id → push ONLY its
    //    mutations, under the member Bearer token.
    //  • owner context    → getPushExcludeStationIds() returns the member stations' local ids → push
    //    everything EXCEPT those (install-scoped station_id IS NULL still goes with the owner).
    // Defaults (null / []) → owner behavior unchanged: push all pending (minus EXCLUDED_TABLES).
    this._getPushOnlyStationId     = opts.getPushOnlyStationId     ?? (() => null);
    this._getPushExcludeStationIds = opts.getPushExcludeStationIds ?? (() => []);

    this._causalQueue = new CausalOrderQueue();
    this._mergeEngine = new MergeEngine(db, {
      localSchemaVersion: this._localSV,
      causalQueue:        this._causalQueue,
      onCursorAdvance:    (cid, hlc) => this._advanceCursor(cid, hlc),
      uuidIdentity:       this._uuidIdentity,
    });

    // Prepared statements for push
    this._stmtMarkSynced = db.prepare("UPDATE mutations SET sync_status = 'synced' WHERE id = ?");
  }

  // ── Push [§17] ────────────────────────────────────────────────────────────

  async push() {
    // Member sync runs pull-only: it must never read the shared pending-mutations queue and push the
    // owner's (or another station's) edits to this account's backend. Bidirectional member push is a
    // separate, station-scoped step (not built yet).
    if (this._pullOnly) return { sent: 0, accepted: 0, rejected: 0 };
    const pending = this._loadPendingMutations();
    if (pending.length === 0) return { sent: 0, accepted: 0, rejected: 0 };

    let accepted = 0, rejected = 0;

    for (let i = 0; i < pending.length; i += MAX_PUSH_BATCH) {
      const chunk = pending.slice(i, i + MAX_PUSH_BATCH);
      const batch = {
        client_id:  chunk[0].client_id,
        station_id: null,
        batch:      chunk.map(m => this._enrichWire(toWireFormat(m))),
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
        client_id:    clientId,
        station_id:   this._getStationId(),
        station_uuid: this._uuidIdentity ? this._getStationUuid() : null,
        cursor:       this._cursor,
      });
    } catch (err) {
      console.error('[sync-engine] pull transport error:', err.message);
      return { pulled: 0, byTable: {} };
    }

    const mutations = result.mutations ?? [];
    const outcomes  = { applied: 0, loser: 0, idempotent: 0, held: 0, quarantined: 0, rejected: 0, conflicted: 0, failed: 0 };
    const byTable   = {};

    if (mutations.length > 0) {
      // Disable FK enforcement for the duration of the replay batch [N-107].
      // Mutations arrive in HLC (server-sequence) order, not FK-dependency order;
      // a child row's mutation can legitimately precede its parent's INSERT when the
      // server paginates (page size=500). FK violations mid-batch are temporary
      // sequencing artifacts that resolve in subsequent pulls. foreign_key_check is
      // intentionally NOT run here — it would fire on every partial batch during
      // initial bulk sync and halt the sync permanently. Integrity of the fully
      // converged state is verified in drainQuarantine() and explicit verify calls.
      this._db.pragma('foreign_keys = OFF');
      try {
        for (const m of mutations) {
          let outcome;
          try {
            outcome = this._mergeEngine.apply(m);
          } catch (err) {
            // Individual mutation failure: log and skip rather than crashing the batch [N-108].
            // One failing mutation must not prevent the remaining 499 in the page from applying.
            console.error('[sync-engine] pull: mutation ' + m.id +
              ' table=' + m.table_name + ' op=' + m.op + ' apply failed: ' + err.message);
            outcomes.failed = (outcomes.failed ?? 0) + 1;
            continue;
          }
          outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
          if (outcome === 'applied') {
            byTable[m.table_name] = (byTable[m.table_name] || 0) + 1;
          }

          // After a successful apply, retry anything held on this mutation [N-104]
          if (outcome === 'applied' || outcome === 'loser') {
            this._retryCausalQueue(m.id);
          }
        }
      } finally {
        this._db.pragma('foreign_keys = ON');
      }
    }

    this._saveCursor();

    // Fire optional progress callback. Skipped when applied === 0 — no signal
    // worth firing for a no-op pull. Failures in user-provided callback are
    // logged and swallowed so they cannot break the sync cycle.
    if (this._onProgress && outcomes.applied > 0) {
      try { this._onProgress({ applied: outcomes.applied, byTable }); }
      catch (err) { console.error('[sync-engine] onProgress callback threw:', err.message); }
    }

    return { pulled: mutations.length, byTable, ...outcomes };
  }

  // ── Re-baseline (Tier-2 UUID-identity) ──────────────────────────────────────
  //
  // One-shot corrective re-pull for an install that may hold a legacy gap: under the old
  // local-integer scoping a divergent machine silently missed another machine's station programming
  // (the rows were filtered out and their server_seq is now below the cursor, so a normal incremental
  // pull will never re-fetch them). Re-baseline resets the cursor to 0 and drains pulls under the
  // current UUID-identity scoping, so those rows are delivered and applied now. Correctness:
  //   - resolve-to-existing-local-ids / NO renumber: re-apply goes through the same Tier-2 merge,
  //     which resolves each incoming uuid to THIS install's existing local id and never writes a
  //     row's own integer id (rows are matched by uuid). Existing local rows are corrected/augmented
  //     in place, never renumbered.
  //   - idempotent: mutations already applied are skipped by mutation id (merge Step 1).
  // No on-air gating here (callers gate if needed). One-shot, guarded by system_state.rebaseline_done.

  // Read-only consistency probe: count station-scoped rows whose declared reference columns do NOT
  // resolve to a live local row of the referenced table (dangling = a sign of legacy mis-scoping /
  // a still-missing parent). Used to report divergence before/after a re-baseline.
  rebaselineScan() {
    const dangling = [];
    let scanned = 0;
    for (const [name, entry] of Object.entries(REGISTRY)) {
      if (entry.scope !== 'station') continue;
      const refs = entry.refs || { station_id: 'stations' };
      let rows;
      try { rows = this._db.prepare(`SELECT * FROM ${name} WHERE deleted_at IS NULL`).all(); }
      catch (_) { continue; }   // table not present in this DB
      for (const row of rows) {
        scanned++;
        for (const [col, refTable] of Object.entries(refs)) {
          const v = row[col];
          if (v == null) continue;
          let ok;
          try { ok = !!this._db.prepare(`SELECT 1 FROM ${refTable} WHERE id = ?`).get(v); }
          catch (_) { ok = true; }   // referenced table absent locally → not counted as dangling here
          if (!ok) dangling.push(`${name}.${col}=${v} (uuid=${row.uuid})`);
        }
      }
    }
    return { scanned, dangling };
  }

  // Is a one-shot Tier-2 re-baseline still owed on this install? True only when UUID-identity is on and
  // the re-baseline has not yet completed. Cheap (single system_state read) — safe to call every tick.
  rebaselinePending() {
    if (!this._uuidIdentity) return false;
    const done = this._db.prepare("SELECT value FROM system_state WHERE key = 'rebaseline_done'").get();
    return done?.value !== '1';
  }

  async rebaseline({ force = false } = {}) {
    if (!this._uuidIdentity) return { skipped: 'uuid-identity off' };
    const done = this._db.prepare("SELECT value FROM system_state WHERE key = 'rebaseline_done'").get();
    if (done?.value === '1' && !force) return { skipped: 'already done' };

    // On-air gate (constraint a): NEVER start the heavy corrective re-pull while the station is streaming —
    // a full-history re-pull burst would contend with the daemon's song-boundary reads on the shared WAL
    // DB (busy_timeout 5s → risk of a late transition / dead air). The normal incremental sync is NOT
    // gated; only this re-pull defers to a quiet (off-air) window. The scheduler resumes it off air.
    if (this._isOnAir()) return { skipped: 'on-air (deferred)' };

    // Reset the pull high-water mark exactly ONCE, then persist 'rebaseline_started'. A resume after an
    // on-air suspension (or app restart) must continue from the persisted server_seq, NOT restart at 0 —
    // re-pulling from 0 each resume would never finish if the station is on air often. resetCursor()
    // persists server_seq=0, and every pull() persists its advance, so the cursor survives suspend/resume.
    const startedRow = this._db.prepare("SELECT value FROM system_state WHERE key = 'rebaseline_started'").get();
    let before = null;
    if (startedRow?.value !== '1' || force) {
      before = this.rebaselineScan();
      if (typeof this._transport.resetCursor === 'function') this._transport.resetCursor();
      this._db.prepare(
        `INSERT INTO system_state (key, value, updated_at) VALUES ('rebaseline_started', '1', ?)
         ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = excluded.updated_at`
      ).run(new Date().toISOString());
    }

    let applied = 0, rounds = 0;
    while (rounds++ < 1000) {                 // 1000 = backstop; each round drains up to 500 mutations
      // Re-check on-air BETWEEN pages (constraint a): if the station went live mid-run, suspend cleanly.
      // The last pull() already persisted server_seq, so a later off-air call resumes with no double-pull
      // and no re-reset (idempotent merge makes any overlap harmless anyway). rebaseline_done is NOT set.
      if (this._isOnAir()) return { suspended: true, applied };
      const r = await this.pull();
      applied += r.applied ?? 0;
      if ((r.pulled ?? 0) === 0) break;       // drained
    }
    const after = this.rebaselineScan();

    this._db.prepare(
      `INSERT INTO system_state (key, value, updated_at) VALUES ('rebaseline_done', '1', ?)
       ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = excluded.updated_at`
    ).run(new Date().toISOString());

    const beforeN = before ? before.dangling.length : null;
    console.log(`[sync-engine] rebaseline complete: applied=${applied} dangling ${beforeN ?? '?'}→${after.dangling.length}`);
    return { applied, danglingBefore: beforeN, danglingAfter: after.dangling.length };
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

  // ── Quarantine drain [§20] ────────────────────────────────────────────────
  //
  // Called from SyncScheduler.start() after migrations complete.
  // Replays mutations that were quarantined because their schema_version exceeded
  // local at receive time and are now compatible after a local schema upgrade.
  //
  // retry_count semantics differ from the live-merge conflicted path [N-63]:
  // quarantine drain is a replay of already-safely-stored mutations, not a live
  // merge decision. We allow 3 attempts before dead-lettering so transient state
  // issues don't permanently drop mutations, but TransformerMissingError is always
  // an immediate dead-letter — retrying is pointless until a deployment ships the script.
  // Dead-lettered mutations are set to drain_status='failed' and logged at ERROR level.

  drainQuarantine() {
    const pending = this._db.prepare(`
      SELECT id, raw_json, foreign_schema_version, retry_count
      FROM quarantine_mutations
      WHERE drain_status = 'pending' AND foreign_schema_version <= ?
      ORDER BY foreign_schema_version ASC, received_at ASC
    `).all(this._localSV);

    if (pending.length === 0) return { drained: 0, failed: 0 };

    let drained = 0, failed = 0;

    // Same FK-off bracket as pull(): quarantined mutations replay in schema-version order,
    // not FK-dependency order; foreign_key_check after the loop is the hard safety net.
    this._db.pragma('foreign_keys = OFF');
    try {
      for (const row of pending) {
        let m;
        try {
          m = JSON.parse(row.raw_json);
        } catch (_) {
          this._markQuarantineFailed(row.id);
          console.error('[sync-engine] drainQuarantine: corrupt raw_json id=' + row.id);
          failed++;
          continue;
        }

        // Apply transformer chain to bring both payloads up to local schema version [N-62].
        // payload_before is null for inserts; payload_after is null for deletes — both legitimate.
        // One try/catch: if either transform throws the mutation goes to retry/dead-letter.
        if (row.foreign_schema_version < this._localSV) {
          try {
            m = { ...m,
              payload_before: m.payload_before ? applyTransformerChain(m.payload_before, row.foreign_schema_version, this._localSV, m) : null,
              payload_after:  m.payload_after  ? applyTransformerChain(m.payload_after,  row.foreign_schema_version, this._localSV, m) : null,
            };
          } catch (err) {
            if (err instanceof TransformerMissingError) {
              // Missing script is permanent — no deployment currently provides it.
              this._markQuarantineFailed(row.id);
              console.error(
                '[sync-engine] drainQuarantine: DEAD-LETTER missing transformer v' +
                row.foreign_schema_version + '→' + this._localSV + ' id=' + row.id
              );
              failed++;
            } else {
              if (this._incrementRetry(row, err) >= 3) failed++;
            }
            continue;
          }
        }

        // Apply through MergeEngine — handles idempotency, LWW, causal ordering, log, cursor
        try {
          const outcome = this._mergeEngine.apply(m);
          this._db.prepare(
            "UPDATE quarantine_mutations SET drain_status = 'drained' WHERE id = ?"
          ).run(row.id);
          drained++;
          if (outcome === 'applied' || outcome === 'loser') this._retryCausalQueue(m.id);
        } catch (err) {
          if (this._incrementRetry(row, err) >= 3) failed++;
        }
      }

      const violations = this._db.pragma('foreign_key_check');
      if (violations.length > 0) {
        const msg = '[sync-engine] drainQuarantine: foreign_key_check failed after replay — ' +
          violations.length + ' violation(s): ' + JSON.stringify(violations);
        console.error(msg);
        throw new Error(msg); // cursor not saved; drain state preserved for next restart
      }
    } finally {
      this._db.pragma('foreign_keys = ON');
    }

    if (drained > 0) this._saveCursor();
    return { drained, failed };
  }

  _markQuarantineFailed(id) {
    this._db.prepare(
      "UPDATE quarantine_mutations SET drain_status = 'failed' WHERE id = ?"
    ).run(id);
  }

  // Returns the new retry_count so callers can check against the dead-letter threshold.
  _incrementRetry(row, err) {
    const newCount = row.retry_count + 1;
    if (newCount >= 3) {
      this._db.prepare(
        "UPDATE quarantine_mutations SET drain_status = 'failed', retry_count = ? WHERE id = ?"
      ).run(newCount, row.id);
      console.error(
        '[sync-engine] drainQuarantine: DEAD-LETTER after ' + newCount +
        ' failures id=' + row.id + ' err=' + err.message
      );
    } else {
      this._db.prepare(
        "UPDATE quarantine_mutations SET retry_count = ?, retry_after = ? WHERE id = ?"
      ).run(newCount, new Date().toISOString(), row.id);
      console.warn(
        '[sync-engine] drainQuarantine: retry ' + newCount +
        '/3 id=' + row.id + ' err=' + err.message
      );
    }
    return newCount;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  // UUID-identity (Tier-2): attach stable parent uuids to a station-scoped wire mutation so the
  // receiver can remap to its own local ids. station_uuid (the row's station) is lifted out for the
  // backend's scoping. Resolves each reference column's local id → parent uuid from the live tables.
  _enrichWire(wire) {
    if (!this._uuidIdentity) return wire;
    const entry = REGISTRY[wire.table_name];
    if (!entry || entry.scope !== 'station') return wire;
    const refs = entry.refs || { station_id: 'stations' };
    const src  = wire.payload_after || wire.payload_before || {};
    const refUuids = {};
    for (const [col, refTable] of Object.entries(refs)) {
      const localId = src[col];
      if (localId == null) continue;                    // null FK (e.g. no show_id) — nothing to map
      const row = this._uuidStmt(refTable).get(localId);
      if (row?.uuid) refUuids[col] = row.uuid;
    }
    wire.ref_uuids    = refUuids;
    wire.station_uuid = refUuids.station_id ?? null;     // null for the stations row itself → install-scope
    return wire;
  }

  _uuidStmt(table) {
    if (!this._uuidStmts[table]) {
      this._uuidStmts[table] = this._db.prepare(`SELECT uuid FROM ${table} WHERE id = ?`);
    }
    return this._uuidStmts[table];
  }

  _loadPendingMutations() {
    const clauses = ["sync_status = 'pending'"];
    const params  = [];

    // Per-context push isolation. station_id is stamped on every mutation row by the writer
    // (null = install-scoped). A member context pushes ONLY its station's rows; the owner context
    // pushes everything except the member stations (install-scoped NULL stays with the owner).
    const onlyId = this._getPushOnlyStationId();
    if (onlyId != null) {
      clauses.push('station_id = ?');
      params.push(String(onlyId));
    } else {
      const exclude = (this._getPushExcludeStationIds() || []).map(String);
      if (exclude.length > 0) {
        const ph = exclude.map(() => '?').join(', ');
        clauses.push(`(station_id IS NULL OR station_id NOT IN (${ph}))`);
        params.push(...exclude);
      }
    }

    if (EXCLUDED_TABLES.size > 0) {
      const ph = Array.from(EXCLUDED_TABLES).map(() => '?').join(', ');
      clauses.push(`table_name NOT IN (${ph})`);
      params.push(...EXCLUDED_TABLES);
    }

    return this._db.prepare(
      `SELECT * FROM mutations WHERE ${clauses.join(' AND ')} ORDER BY hlc ASC`
    ).all(...params);
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
    const row = this._db.prepare(`SELECT value FROM system_state WHERE key = ?`).get(this._cursorKey);
    if (!row?.value) return {};
    try { return JSON.parse(row.value) ?? {}; }
    catch (_) { return {}; }
  }

  _saveCursor() {
    const json = JSON.stringify(this._cursor);
    this._db.prepare(
      `INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(this._cursorKey, json, new Date().toISOString());
  }

  _readSchemaVersion() {
    return this._db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get()?.version ?? 0;
  }
}

module.exports = { SyncEngine };
