// electron/sync/mutation-writer.js — mutation log writer for Ether sync-ready 3/7.
//
// Conforms to:
//   §3       [N-05]         — infrastructure tables do NOT generate mutation log entries
//   §3       [N-06]/[N-07]  — mutations table has exactly 17 fields
//   §3       [N-09]         — UUIDs stored as lowercase hex with dashes (RFC 4122)
//   §3       [N-10]         — op CHECK: insert|update|delete|checkpoint
//   §4.1     [N-15]         — scalar columns copied verbatim into payloads
//   §4.2     [N-16]/[N-17]  — json-text columns parsed/stringified in payloads
//   §4.2     [N-18]         — malformed json-text stored as __raw_text sentinel
//   §4.3     [N-22]/[N-23]  — blob-ref columns represented as {__blob_ref,__blob_size,__blob_origin}
//   §4.4     [N-24]/[N-25]  — local-only columns excluded from payloads entirely
//   §4.5     [N-26]/[N-27]  — per-table column registry lives in synced-tables.js
//   §5.1     [N-28]–[N-31]  — full-snapshot payloads; op-specific NULL rules
//   §5.4     [N-36]/[N-37]  — data op + mutation log write in one transaction
//   §6.1     [N-38]/[N-40]  — HLC format: <wall_ms>:<logical>:<client_id>; split maxsplit=2
//   §6.2     [N-41]/[N-42]  — hlc_last persisted in system_state
//   §6.3     [N-43]/[N-44]  — HLC monotonicity rule; nextClock() runs inside caller's txn
//   §7.1     [N-48]/[N-49]  — wire format = 17 fields minus 3 LOCAL-ONLY = 14 fields
//   §7.2     [N-51]/[N-52]  — payloads as nested objects in wire JSON; field order per §3 table
//   §7.3     [N-54]         — toWireFormat() exposed on module
//   §8.1     [N-57]         — schema_version read from DB at mutation-write time
//   §11.4    [N-79]         — client_id is stable for DB lifetime; cached at module scope
//   §22      [N-119]–[N-122] — compactMutations(): 90-day rolling delete of synced mutations
//   [Q-14]                  — station_id stringified from integer at write time
//
// DO NOT import this module from infrastructure-table write paths. [N-05] forbids
// logging mutations on mutations/client_identity/system_state themselves.

'use strict';

const crypto    = require('crypto');
const { REGISTRY } = require('./synced-tables');

// ── Module-scoped cache ────────────────────────────────────────
// client_id is stable for the DB lifetime per [N-79].
// Cached after first DB read; never invalidated within a process.

let cachedClientId = null;

// ── Nested-mutation context stack ──────────────────────────────
// Tracks the mutation_id of the currently executing withMutation() call.
// When withMutation() calls fn() and fn() itself calls withMutation(),
// the inner mutation inherits the outer mutation's id as parent_mutation_id.
// better-sqlite3 is synchronous so this stack is never racy.
const _mutationContextStack = [];

// ── Constants ─────────────────────────────────────────────────

const VALID_OPS = new Set(['insert', 'update', 'delete', 'checkpoint']);

// Per [N-08]: these 3 mutation fields are LOCAL-ONLY and excluded from wire format.
//   applied_at   — timestamp this peer applied the mutation
//   origin       — 'local'/'remote'/'system'/'migration', set per-peer
//   sync_status  — 'pending'/'syncing'/'synced'/'conflicted', tracked per-peer
const WIRE_LOCAL_ONLY = new Set(['applied_at', 'origin', 'sync_status']);

// ─────────────────────────────────────────────────────────────
// EXPORT 1: getClientId(db)
// ─────────────────────────────────────────────────────────────

/**
 * Returns this installation's client_id UUID.
 *
 * First call queries client_identity and caches the result at module scope [N-79].
 * All subsequent calls return the cached value without touching the DB.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {string} RFC 4122 UUID in lowercase-hex-with-dashes format [N-09]
 * @throws if client_identity has not been seeded (run migrate-mutations-phase-sync-3.js)
 * @throws if client_identity has more than one row (DB corrupted)
 */
function getClientId(db) {
  if (cachedClientId !== null) return cachedClientId;

  const rows = db.prepare('SELECT client_id FROM client_identity').all();

  if (rows.length === 0) {
    throw new Error(
      'mutation-writer: client_identity not seeded — run migrate-mutations-phase-sync-3.js first'
    );
  }
  if (rows.length > 1) {
    throw new Error(
      'mutation-writer: client_identity has multiple rows — DB corrupted'
    );
  }

  cachedClientId = rows[0].client_id;
  return cachedClientId;
}

// ─────────────────────────────────────────────────────────────
// EXPORT 2: nextClock(db)
// ─────────────────────────────────────────────────────────────

/**
 * Generates the next HLC value for a local mutation. Implements [N-43].
 *
 * HLC format: <wall_ms>:<logical>:<client_id>  [N-38]
 * Parsed by splitting on ':' — UUIDs contain dashes not colons, so exactly
 * 3 parts result [N-40].
 *
 * Monotonicity rule [N-43]/[N-44]:
 *   new_wall    = Math.max(last_wall, Date.now())
 *   new_logical = new_wall > last_wall ? 0 : last_logical + 1
 *
 * @example
 *   // hlc_last='1745000000000:3:f0df...' and Date.now()=1745000000000
 *   // now === last_wall → new_wall=1745000000000, new_logical=4
 *   // returns '1745000000000:4:f0df...'
 *
 *   // hlc_last='1745000000000:3:f0df...' and Date.now()=1745000000050
 *   // now > last_wall → new_wall=1745000000050, new_logical=0
 *   // returns '1745000000050:0:f0df...'
 *
 * CRITICAL: nextClock() does NOT open its own transaction. It must be called
 * from inside an existing transaction or SAVEPOINT (via logMutation → withMutation).
 * The read-modify-write on system_state.hlc_last is only atomic within the
 * surrounding transaction. Calling outside a transaction risks lost updates
 * under concurrent access.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {string} new HLC string
 */
function nextClock(db) {
  const row = db.prepare("SELECT value FROM system_state WHERE key='hlc_last'").get();
  if (!row) {
    throw new Error(
      'mutation-writer: system_state.hlc_last not found — run migrate-mutations-phase-sync-3.js first'
    );
  }

  const value = row.value;
  const parts = value.split(':');
  if (parts.length !== 3) {
    throw new Error('mutation-writer: hlc_last malformed: ' + value + ' [N-40]');
  }

  const last_wall    = parseInt(parts[0], 10);
  const last_logical = parseInt(parts[1], 10);
  // parts[2] is the client_id from the last write — we use our own client_id for new HLC

  if (isNaN(last_wall) || isNaN(last_logical)) {
    throw new Error(
      'mutation-writer: hlc_last has non-integer wall_ms or logical: ' + value + ' [N-38]'
    );
  }

  const current_wall = Date.now();
  const new_wall     = Math.max(last_wall, current_wall);   // [N-44]: monotonicity under clock skew
  const new_logical  = new_wall > last_wall ? 0 : last_logical + 1;  // [N-43]
  const client_id    = getClientId(db);
  const new_hlc      = new_wall + ':' + new_logical + ':' + client_id;
  const updated_at   = new Date().toISOString();

  db.prepare(
    "UPDATE system_state SET value=?, updated_at=? WHERE key='hlc_last'"
  ).run(new_hlc, updated_at);

  return new_hlc;
}

// ─────────────────────────────────────────────────────────────
// EXPORT 3: logMutation(db, opts)
// ─────────────────────────────────────────────────────────────

/**
 * Inserts one row into the mutations table. Caller provides data-layer fields;
 * writer fills in all machinery fields (id, client_id, hlc, schema_version, etc.).
 *
 * CRITICAL: logMutation does NOT open its own transaction. It MUST be called
 * from inside an existing transaction or SAVEPOINT. Use withMutation() for the
 * standard call site. Direct use is permitted only for batch operations that
 * manage their own transactions.
 *
 * opts shape:
 * @param {string}        opts.table_name         REGISTRY key or '__checkpoint__'
 * @param {string}        opts.row_id             UUID of the target row [N-09]; '' for checkpoints
 * @param {string}        opts.op                 'insert'|'update'|'delete'|'checkpoint' [N-10]
 * @param {object|null}   opts.payload_before     null for insert; full serialized row otherwise [N-28]–[N-31]
 * @param {object|null}   opts.payload_after      null for delete; full serialized row otherwise [N-28]–[N-31]
 * @param {string|number} opts.station_id         coerced to string via String() [Q-14]
 * @param {string|null}   opts.actor_id           operator UUID or null for system ops
 * @param {string|null}   opts.parent_mutation_id causal parent UUID or null; omit to inherit from context stack
 * @param {string|null}   opts._mutation_id       pre-generated UUID (used by withMutation context tracking)
 *
 * Checkpoint note: op='checkpoint' may have both payloads null. table_name is
 * stored as '__checkpoint__' and row_id as '' in the DB. Checkpoints are future
 * hooks for the compaction mechanism reserved by [N-10]; v0 does not produce them.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} opts
 * @returns {object} inserted mutation row with payloads as parsed objects (not JSON strings)
 */
function logMutation(db, opts) {
  const {
    table_name,
    row_id,
    op,
    payload_before = null,
    payload_after  = null,
    station_id,
    actor_id           = null,
    parent_mutation_id = null,
    _mutation_id       = null,  // pre-generated by withMutation context tracking
  } = opts;

  // ── Validation ────────────────────────────────────────────

  if (table_name !== '__checkpoint__' && !REGISTRY[table_name]) {
    throw new Error(
      '[mutation-writer] unknown table_name: "' + table_name + '" — not in REGISTRY [N-27]'
    );
  }

  if (!VALID_OPS.has(op)) {
    throw new Error(
      '[mutation-writer] invalid op: "' + op + '" — must be insert|update|delete|checkpoint [N-10]'
    );
  }

  if (op !== 'checkpoint' && (!row_id || typeof row_id !== 'string')) {
    throw new Error(
      '[mutation-writer] row_id must be a non-empty string for op=' + op
    );
  }

  // [N-89]: null is valid for install-scoped tables (songs/artists/albums/mood_tags).
  // undefined means the caller forgot to pass it — that is still an error.
  if (station_id === undefined) {
    throw new Error('[mutation-writer] station_id must be provided (pass null for install-scoped tables) [N-89]');
  }

  if (op === 'insert') {
    if (payload_after  === null || payload_after  === undefined)
      throw new Error('[mutation-writer] payload_after required for op=insert [N-29]');
    if (payload_before !== null && payload_before !== undefined)
      throw new Error('[mutation-writer] payload_before must be null for op=insert [N-29]');
  } else if (op === 'update') {
    if (payload_before === null || payload_before === undefined)
      throw new Error('[mutation-writer] payload_before required for op=update [N-30]');
    if (payload_after  === null || payload_after  === undefined)
      throw new Error('[mutation-writer] payload_after required for op=update [N-30]');
  } else if (op === 'delete') {
    if (payload_before === null || payload_before === undefined)
      throw new Error('[mutation-writer] payload_before required for op=delete [N-31]');
    if (payload_after !== null && payload_after !== undefined)
      throw new Error('[mutation-writer] payload_after must be null for op=delete [N-31]');
  }
  // op='checkpoint': both payloads may be null — no further constraint.

  // ── Current schema_version ────────────────────────────────
  // [N-57]: read from DB at write time; reflects the current schema of this client.

  const svRow = db.prepare(
    'SELECT version FROM schema_version ORDER BY version DESC LIMIT 1'
  ).get();
  if (!svRow) {
    throw new Error('[mutation-writer] schema_version table is empty — DB not initialized');
  }
  const schemaVersion = svRow.version;

  // ── Machinery fields ──────────────────────────────────────

  const mutation_id      = _mutation_id ?? crypto.randomUUID();
  const client_id        = getClientId(db);
  const now_iso          = new Date().toISOString();
  const hlc              = nextClock(db);             // updates system_state.hlc_last as side effect
  // [Q-14] applies when non-null; null passes through as SQL NULL for install-scoped tables [N-89]
  const station_id_str   = station_id === null ? null : String(station_id);
  const actual_table     = op === 'checkpoint' ? '__checkpoint__' : table_name;
  const actual_row_id    = op === 'checkpoint' ? '' : row_id;

  const payload_before_str = payload_before === null || payload_before === undefined
    ? null
    : JSON.stringify(payload_before);
  const payload_after_str  = payload_after  === null || payload_after  === undefined
    ? null
    : JSON.stringify(payload_after);

  // ── INSERT — explicit 17-column form [N-06] ───────────────

  db.prepare(`
    INSERT INTO mutations (
      id, client_id, station_id, actor_id,
      table_name, row_id, op,
      payload_before, payload_after,
      created_at, applied_at, hlc,
      parent_mutation_id, schema_version,
      origin, sync_status, conflict_resolution
    ) VALUES (
      ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?,
      ?, ?, ?,
      ?, ?,
      ?, ?, ?
    )
  `).run(
    mutation_id,            client_id,       station_id_str, actor_id ?? null,
    actual_table,           actual_row_id,   op,
    payload_before_str,     payload_after_str,
    now_iso,                now_iso,         hlc,
    parent_mutation_id ?? null, schemaVersion,
    'local',                'pending',       null
  );

  // Return the row with payloads as objects (not JSON strings) [N-28]
  return {
    id:                  mutation_id,
    client_id,
    station_id:          station_id_str,
    actor_id:            actor_id ?? null,
    table_name:          actual_table,
    row_id:              actual_row_id,
    op,
    payload_before:      payload_before ?? null,
    payload_after:       payload_after  ?? null,
    created_at:          now_iso,
    applied_at:          now_iso,
    hlc,
    parent_mutation_id:  parent_mutation_id ?? null,
    schema_version:      schemaVersion,
    origin:              'local',
    sync_status:         'pending',
    conflict_resolution: null,
  };
}

// ─────────────────────────────────────────────────────────────
// EXPORT 4: withMutation(db, opts, fn)
// ─────────────────────────────────────────────────────────────

/**
 * Standard call site for IPC handlers that write to a synced table.
 * Atomically performs the table write (via fn) and the mutation log entry [N-36]/[N-37].
 *
 * Composes with outer transactions: if called inside an existing transaction,
 * better-sqlite3's db.transaction() automatically promotes to a SAVEPOINT and
 * rollback affects only this withMutation call. Smoke tests in part 2b rely on
 * this — they wrap real synced-table writes in a SAVEPOINT that always rolls
 * back, leaving zero DB residue.
 *
 * If fn throws, the transaction rolls back and no mutation row is created.
 * If logMutation throws (validation failure, schema error, etc.), the
 * transaction rolls back and fn's effects are undone [N-36].
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object}   opts  same shape as logMutation opts
 * @param {function} fn    () => any — caller's data operation; return value is passed through
 * @returns {any} the return value of fn
 */
function withMutation(db, opts, fn) {
  // Pre-generate the mutation id so we can push it onto the context stack
  // before fn() runs, making it available as parent for any nested withMutation calls.
  const mutation_id = crypto.randomUUID();

  // Inherit parent from stack unless caller explicitly included parent_mutation_id in opts.
  // 'parent_mutation_id' in opts: caller set it (even if null). Absent: inherit from context.
  const effective_parent =
    'parent_mutation_id' in opts
      ? (opts.parent_mutation_id ?? null)
      : (_mutationContextStack.length > 0
          ? _mutationContextStack[_mutationContextStack.length - 1]
          : null);

  return db.transaction(() => {
    // Push before fn() so inner withMutation calls see this mutation as their parent
    _mutationContextStack.push(mutation_id);
    try {
      const result = fn();
      logMutation(db, {
        ...opts,
        parent_mutation_id: effective_parent,
        _mutation_id:       mutation_id,
      });
      return result;
    } finally {
      _mutationContextStack.pop();
    }
  })();
}

// ─────────────────────────────────────────────────────────────
// EXPORT 5: serializePayload(row, tableName)
// ─────────────────────────────────────────────────────────────

/**
 * Produces a JSON-serializable payload object from a raw DB row.
 * Uses REGISTRY[tableName].columns to categorize each column [N-26]:
 *
 *   scalar    — copied verbatim [N-15]
 *   json-text — JSON.parse'd from string; malformed → __raw_text sentinel [N-17]/[N-18]
 *   blob-ref  — wrapped as {__blob_ref, __blob_size, __blob_origin} [N-22]/[N-23]
 *   local-only — excluded entirely [N-24]/[N-25]
 *
 * @param {object} row       raw row object from a DB SELECT
 * @param {string} tableName must be a key in REGISTRY
 * @returns {object} payload suitable for logMutation's payload_before / payload_after
 */
function serializePayload(row, tableName) {
  if (row === null || row === undefined) {
    throw new Error('[mutation-writer] serializePayload: row must not be null/undefined');
  }

  const entry = REGISTRY[tableName];
  if (!entry) {
    throw new Error(
      '[mutation-writer] serializePayload: unknown tableName: "' + tableName + '" [N-27]'
    );
  }

  const payload = {};

  for (const [col, category] of Object.entries(entry.columns)) {
    if (category === 'local-only') continue;  // [N-24]/[N-25]

    const val = row[col];

    if (category === 'scalar') {
      // [N-15]: verbatim; treat missing columns as null
      payload[col] = val !== undefined ? val : null;

    } else if (category === 'json-text') {
      // [N-17]: deserialize from TEXT to nested object
      if (val === null || val === undefined) {
        payload[col] = null;
      } else if (typeof val === 'object') {
        payload[col] = val;  // already an object (unusual but defensive)
      } else {
        try {
          payload[col] = JSON.parse(String(val));
        } catch (e) {
          // [N-18]: preserve raw string rather than blocking the mutation
          console.warn(
            '[mutation-writer] failed to parse json-text column ' +
            tableName + '.' + col + ': ' + e.message
          );
          payload[col] = { __raw_text: String(val), __json_parse_failed: true };
        }
      }

    } else if (category === 'blob-ref') {
      // [N-22]/[N-23]: reference-only; v0 does not compute content hashes
      if (val === null || val === undefined) {
        payload[col] = null;
      } else {
        payload[col] = {
          __blob_ref:    String(val),   // [N-23]: use original path as opaque ref in v0
          __blob_size:   null,          // [N-23]: not readily available at this layer
          __blob_origin: String(val),
        };
      }
    }
  }

  return payload;
}

// ─────────────────────────────────────────────────────────────
// EXPORT 6: deserializePayload(payload, tableName)
// ─────────────────────────────────────────────────────────────

/**
 * Inverse of serializePayload. Converts a payload object back to a row-shaped
 * object suitable for INSERT/UPDATE on the synced table.
 *
 * local-only columns are never present in a payload and are never restored [N-24].
 * Caller is responsible for supplying local-only values from local context if needed.
 *
 * Columns missing from the payload result in undefined in the returned object.
 * This is intentional — it is the injection point for future non-identity
 * transformers that supply defaults per [N-70] and [Q-15].
 *
 * json-text  — JSON.stringify'd back to TEXT for DB storage
 * blob-ref   — __blob_origin path extracted from envelope; raw string if no envelope
 *
 * @param {object} payload   serialized payload from a mutation row
 * @param {string} tableName must be a key in REGISTRY
 * @returns {object} row-shaped object (local-only columns absent)
 */
function deserializePayload(payload, tableName) {
  if (payload === null || payload === undefined) {
    throw new Error('[mutation-writer] deserializePayload: payload must not be null/undefined');
  }

  const entry = REGISTRY[tableName];
  if (!entry) {
    throw new Error(
      '[mutation-writer] deserializePayload: unknown tableName: "' + tableName + '" [N-27]'
    );
  }

  const row = {};

  for (const [col, category] of Object.entries(entry.columns)) {
    if (category === 'local-only') continue;  // [N-24]

    const val = payload[col];

    if (category === 'scalar') {
      row[col] = val;  // undefined if missing — caller or transformer injects defaults [Q-15]

    } else if (category === 'json-text') {
      if (val === undefined || val === null) {
        row[col] = val;
      } else {
        row[col] = JSON.stringify(val);
      }

    } else if (category === 'blob-ref') {
      if (val === null || val === undefined) {
        row[col] = val;
      } else if (typeof val === 'object' && val.__blob_origin !== undefined) {
        row[col] = val.__blob_origin;  // extract path from [N-22] envelope
      } else {
        row[col] = String(val);  // fallback: treat as raw path
      }
    }
  }

  return row;
}

// ─────────────────────────────────────────────────────────────
// EXPORT 7: toWireFormat(mutationRow)
// ─────────────────────────────────────────────────────────────

/**
 * Strips LOCAL-ONLY fields from a 17-field mutation row to produce the
 * 14-field wire-format envelope sent to peers [N-48]/[N-49]/[N-54].
 *
 * LOCAL-ONLY fields excluded per [N-08]:
 *   applied_at   — when this peer applied the mutation (receiver sets its own)
 *   origin       — 'local'/'remote'/'system'/'migration' (receiver sets its own)
 *   sync_status  — 'pending'/'syncing'/'synced'/'conflicted' (receiver sets its own)
 *
 * Payloads are delivered as parsed objects, not JSON strings [N-51]. The
 * receiver re-stringifies when storing locally. Field order follows the §3
 * table for consistency and diffability [N-52].
 *
 * @param {object} mutationRow  full 17-field row as read from the mutations table
 * @returns {object} 14-field wire-format object
 */
function toWireFormat(mutationRow) {
  if (!mutationRow || typeof mutationRow !== 'object') {
    throw new Error(
      '[mutation-writer] toWireFormat: mutationRow must be a non-null object [N-54]'
    );
  }

  const required = [
    'id', 'client_id', 'station_id', 'table_name',
    'row_id', 'op', 'created_at', 'hlc', 'schema_version',
  ];
  for (const field of required) {
    if (mutationRow[field] === undefined) {
      throw new Error(
        '[mutation-writer] toWireFormat: mutationRow missing required field: ' + field
      );
    }
  }

  // Payloads may be JSON strings (DB-read) or already-parsed objects (in-memory) [N-51]
  function parseIfString(val) {
    if (val === null || val === undefined) return null;
    if (typeof val === 'string') {
      try {
        return JSON.parse(val);
      } catch (e) {
        throw new Error('[mutation-writer] toWireFormat: failed to parse payload: ' + e.message);
      }
    }
    return val;
  }

  // 14-field wire object in §3 table order [N-52]
  return {
    id:                  mutationRow.id,
    client_id:           mutationRow.client_id,
    station_id:          mutationRow.station_id,
    actor_id:            mutationRow.actor_id            ?? null,
    table_name:          mutationRow.table_name,
    row_id:              mutationRow.row_id,
    op:                  mutationRow.op,
    payload_before:      parseIfString(mutationRow.payload_before),
    payload_after:       parseIfString(mutationRow.payload_after),
    created_at:          mutationRow.created_at,
    // applied_at omitted — LOCAL-ONLY [N-08]
    hlc:                 mutationRow.hlc,
    parent_mutation_id:  mutationRow.parent_mutation_id  ?? null,
    schema_version:      mutationRow.schema_version,
    // origin omitted — LOCAL-ONLY [N-08]
    // sync_status omitted — LOCAL-ONLY [N-08]
    conflict_resolution: mutationRow.conflict_resolution ?? null,
  };
}

// ─────────────────────────────────────────────────────────────
// EXPORT 8: compactMutations(db)
// ─────────────────────────────────────────────────────────────

/**
 * 90-day local retention job per [§22, N-119..N-122].
 *
 * Deletes synced mutations older than 90 days that are not referenced by any
 * other mutation as a causal parent. Never deletes pending/syncing mutations.
 * Logs an ERROR for each stale pending mutation found.
 *
 * Safe to run weekly. Idempotent — multiple runs produce the same result.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {{ deleted: number, stalePending: number }}
 */
function compactMutations(db) {
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

  // Delete synced mutations older than 90 days not referenced as causal parents [N-119].
  // Loop: each pass removes leaf nodes; the next pass can then remove their parents.
  const stmtDel = db.prepare(`
    DELETE FROM mutations
    WHERE created_at < ?
      AND sync_status = 'synced'
      AND id NOT IN (
        SELECT parent_mutation_id FROM mutations
        WHERE parent_mutation_id IS NOT NULL
      )
  `);
  let totalDeleted = 0;
  let del;
  do {
    del = stmtDel.run(cutoff);
    totalDeleted += del.changes;
  } while (del.changes > 0);

  // Log stale pending mutations without deleting [N-120]
  const stalePending = db.prepare(`
    SELECT id, created_at FROM mutations
    WHERE sync_status IN ('pending', 'syncing')
      AND created_at < ?
  `).all(cutoff);

  for (const row of stalePending) {
    console.error(
      '[mutation-writer] compactMutations: stale pending mutation id=' + row.id +
      ' created_at=' + row.created_at + ' — sync not progressing [N-120]'
    );
  }

  return { deleted: totalDeleted, stalePending: stalePending.length };
}

// ─────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────

module.exports = {
  getClientId,
  nextClock,
  logMutation,
  withMutation,
  serializePayload,
  deserializePayload,
  toWireFormat,
  compactMutations,
};
