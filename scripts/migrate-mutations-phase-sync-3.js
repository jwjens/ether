// Migration 3 — create mutations, client_identity, system_state tables per docs/sync-protocol-v0.md.
// Run with: node_modules/.bin/electron --no-sandbox scripts/migrate-mutations-phase-sync-3.js
// IMPORTANT: Stop the Ether dev server before running.
// This migration is ATOMIC — schema creation + seeding are a single transaction per [N-77].
// If any step fails, entire migration rolls back.
//
// Conforms to:
//   §3       [N-06]/[N-07]  — mutations table 17 fields
//   §3       [N-10]         — op CHECK constraint (includes reserved 'checkpoint')
//   §3       [N-11]         — origin CHECK constraint
//   §3       [N-12]         — sync_status CHECK constraint
//   §3.1     [N-13]         — 5 required indexes
//   §6.2     [N-42]         — system_state seeded with hlc_last = '0:0:<client_id>'
//   §11.1    [N-75]         — client_identity table shape
//   §11.2    [N-77]         — atomic seeding
//   §10.1    [N-68]/[N-69]  — identity payloadTransformer exported
//   §10.3    [N-74]         — schema_version row inserted

'use strict';

const path   = require("path");
const os     = require("os");
const fs     = require("fs");
const crypto = require("crypto");

// ── DB path ───────────────────────────────────────────────────

const appData   = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
const dbPath    = path.join(appData, "com.ether.radio", "openair.db");
const scriptDir = path.join(__dirname);

// ── Expected indexes per [N-13] ───────────────────────────────

const REQUIRED_INDEXES = [
  "idx_mutations_table_row_hlc",
  "idx_mutations_client_hlc",
  "idx_mutations_station_created",
  "idx_mutations_sync_status",
  "idx_mutations_created",
];

// ── Payload transformer per [N-68]/[N-69] ────────────────────
// Migration 3 adds infrastructure tables only (mutations, client_identity, system_state).
// No synced-table columns change. Payload shape from schema_version 2 is valid at schema_version 3.

module.exports = {
  payloadTransformer: function payloadTransformer(payload, fromVersion) {
    return payload;
  },
};

// ── Helpers ───────────────────────────────────────────────────

function tableExists(db, name) {
  return !!db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
  ).get(name);
}

function indexExists(db, name) {
  return !!db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND name=?"
  ).get(name);
}

function abort(db, msg) {
  console.error(`\n[migrate-mutations] ABORT: ${msg}`);
  if (db) { try { db.close(); } catch (_) {} }
  process.exit(1);
}

// ── Startup ───────────────────────────────────────────────────

console.log("[migrate-mutations] DB path:", dbPath);
console.log("");

if (!fs.existsSync(dbPath)) {
  abort(null, "DB not found at " + dbPath);
}

const Database = require(path.join(__dirname, "../node_modules/better-sqlite3"));
const db = new Database(dbPath);

// ── Pre-flight checks ─────────────────────────────────────────

console.log("═".repeat(60));
console.log("PRE-FLIGHT CHECKS");
console.log("═".repeat(60));
console.log("");

// Check 1: schema_version snapshot — must be exactly [1, 2]
const svRows = db.prepare("SELECT version FROM schema_version ORDER BY version").all();
const svVersions = svRows.map(r => r.version);
console.log("[migrate-mutations] schema_version contents:", JSON.stringify(svVersions));

if (svVersions.includes(3)) {
  abort(db, "migration 3 already applied — schema_version contains version=3.");
}
if (svVersions.length !== 2 || svVersions[0] !== 1 || svVersions[1] !== 2) {
  abort(db, `expected schema_version to contain exactly [1, 2], got ${JSON.stringify(svVersions)}. Run migrations 1 and 2 first.`);
}
console.log("[migrate-mutations] schema_version pre-check: [1, 2] confirmed ✓");
console.log("");

// Check 2: none of the 3 new tables may already exist
for (const t of ["mutations", "client_identity", "system_state"]) {
  if (tableExists(db, t)) {
    abort(db, `table "${t}" already exists — not safe to proceed. Drop it manually if this is a stale partial run.`);
  }
}
console.log("[migrate-mutations] Pre-flight: mutations, client_identity, system_state do not exist ✓");
console.log("");

// ── Atomic migration transaction ──────────────────────────────

console.log("═".repeat(60));
console.log("RUNNING MIGRATION");
console.log("═".repeat(60));
console.log("");

// Capture generated values outside transaction so post-commit checks can reference them
let generatedClientId;
let generatedTimestamp;

const migrate = db.transaction(() => {

  // ── Step 1: CREATE TABLE mutations ───────────────────────────
  // 17 fields per §3 [N-06]/[N-07], CHECK constraints per [N-10]/[N-11]/[N-12]
  console.log("[migrate-mutations] Step 1: CREATE TABLE mutations");
  db.prepare(`
    CREATE TABLE mutations (
      id                   TEXT PRIMARY KEY NOT NULL,
      client_id            TEXT NOT NULL,
      station_id           TEXT NOT NULL,
      actor_id             TEXT,
      table_name           TEXT NOT NULL,
      row_id               TEXT NOT NULL,
      op                   TEXT NOT NULL CHECK (op IN ('insert', 'update', 'delete', 'checkpoint')),
      payload_before       TEXT,
      payload_after        TEXT,
      created_at           TEXT NOT NULL,
      applied_at           TEXT NOT NULL,
      hlc                  TEXT NOT NULL,
      parent_mutation_id   TEXT,
      schema_version       INTEGER NOT NULL,
      origin               TEXT NOT NULL CHECK (origin IN ('local', 'remote', 'system', 'migration')),
      sync_status          TEXT NOT NULL CHECK (sync_status IN ('pending', 'syncing', 'synced', 'conflicted')),
      conflict_resolution  TEXT
    )
  `).run();
  console.log("[migrate-mutations] Step 1: mutations table created ✓");

  // ── Step 2: CREATE indexes per [N-13] ────────────────────────
  console.log("[migrate-mutations] Step 2: CREATE indexes");
  db.prepare("CREATE INDEX idx_mutations_table_row_hlc    ON mutations (table_name, row_id, hlc)").run();
  console.log("[migrate-mutations] Step 2: idx_mutations_table_row_hlc created ✓");
  db.prepare("CREATE INDEX idx_mutations_client_hlc       ON mutations (client_id, hlc)").run();
  console.log("[migrate-mutations] Step 2: idx_mutations_client_hlc created ✓");
  db.prepare("CREATE INDEX idx_mutations_station_created  ON mutations (station_id, created_at)").run();
  console.log("[migrate-mutations] Step 2: idx_mutations_station_created created ✓");
  db.prepare("CREATE INDEX idx_mutations_sync_status      ON mutations (sync_status)").run();
  console.log("[migrate-mutations] Step 2: idx_mutations_sync_status created ✓");
  db.prepare("CREATE INDEX idx_mutations_created          ON mutations (created_at)").run();
  console.log("[migrate-mutations] Step 2: idx_mutations_created created ✓");

  // ── Step 3: CREATE TABLE client_identity per [N-75] ──────────
  console.log("[migrate-mutations] Step 3: CREATE TABLE client_identity");
  db.prepare(`
    CREATE TABLE client_identity (
      id         INTEGER PRIMARY KEY CHECK (id = 1),
      client_id  TEXT NOT NULL,
      created_at TEXT NOT NULL,
      label      TEXT
    )
  `).run();
  console.log("[migrate-mutations] Step 3: client_identity table created ✓");

  // ── Step 4: CREATE TABLE system_state ────────────────────────
  console.log("[migrate-mutations] Step 4: CREATE TABLE system_state");
  db.prepare(`
    CREATE TABLE system_state (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `).run();
  console.log("[migrate-mutations] Step 4: system_state table created ✓");

  // ── Step 5: Seed client_identity per [N-77] ──────────────────
  console.log("[migrate-mutations] Step 5: Seed client_identity");
  generatedClientId  = crypto.randomUUID();
  generatedTimestamp = new Date().toISOString();
  db.prepare(
    "INSERT INTO client_identity (id, client_id, created_at, label) VALUES (1, ?, ?, NULL)"
  ).run(generatedClientId, generatedTimestamp);
  console.log(`[migrate-mutations] Step 5: client_identity seeded — client_id=${generatedClientId} ✓`);

  // ── Step 6: Seed system_state.hlc_last per [N-42] ────────────
  console.log("[migrate-mutations] Step 6: Seed system_state.hlc_last");
  const hlcInitial = `0:0:${generatedClientId}`;
  db.prepare(
    "INSERT INTO system_state (key, value, updated_at) VALUES ('hlc_last', ?, ?)"
  ).run(hlcInitial, generatedTimestamp);
  console.log(`[migrate-mutations] Step 6: system_state seeded — hlc_last=${hlcInitial} ✓`);

  // ── Step 7: INSERT schema_version = 3 per [N-74] ─────────────
  console.log("[migrate-mutations] Step 7: INSERT schema_version = 3");
  db.prepare("INSERT INTO schema_version (version) VALUES (3)").run();
  console.log("[migrate-mutations] Step 7: schema_version=3 inserted ✓");

});

try {
  migrate();
  console.log("");
  console.log("[migrate-mutations] Transaction committed.");
} catch (err) {
  console.error("\n[migrate-mutations] ERROR — transaction rolled back:", err.message);
  db.close();
  process.exit(1);
}

// ── Post-commit verification ──────────────────────────────────

console.log("");
console.log("═".repeat(60));
console.log("POST-COMMIT VERIFICATION");
console.log("═".repeat(60));
console.log("");

let allOk = true;

function vpass(msg) { console.log(`[migrate-mutations] ✓ ${msg}`); }
function vfail(msg) { console.error(`[migrate-mutations] ✗ ${msg}`); allOk = false; }

// Verify 1: schema_version == [1, 2, 3]
const svPost = db.prepare("SELECT version FROM schema_version ORDER BY version").all().map(r => r.version);
console.log("[migrate-mutations] schema_version post-migration:", JSON.stringify(svPost));
if (svPost.length === 3 && svPost[0] === 1 && svPost[1] === 2 && svPost[2] === 3) {
  vpass("schema_version = [1, 2, 3]");
} else {
  vfail(`schema_version drift — expected [1,2,3], got ${JSON.stringify(svPost)}`);
}

// Verify 2: mutations table exists
if (tableExists(db, "mutations")) {
  vpass("mutations table exists");
} else {
  vfail("mutations table NOT found in sqlite_master");
}

// Verify 3: client_identity row count == 1 and client_id matches
const ciRows = db.prepare("SELECT * FROM client_identity").all();
if (ciRows.length !== 1) {
  vfail(`client_identity row count = ${ciRows.length}, expected 1`);
} else if (ciRows[0].client_id !== generatedClientId) {
  vfail(`client_identity.client_id mismatch — stored=${ciRows[0].client_id}, expected=${generatedClientId}`);
} else {
  vpass(`client_identity has 1 row, client_id matches (${generatedClientId})`);
}

// Verify 4: system_state hlc_last exists and starts with '0:0:<client_id>'
const hlcRow = db.prepare("SELECT value FROM system_state WHERE key='hlc_last'").get();
if (!hlcRow) {
  vfail("system_state: key='hlc_last' not found");
} else {
  const expectedHlc = `0:0:${generatedClientId}`;
  if (hlcRow.value === expectedHlc) {
    vpass(`system_state.hlc_last = "${hlcRow.value}"`);
  } else {
    vfail(`system_state.hlc_last = "${hlcRow.value}", expected "${expectedHlc}"`);
  }
}

// Verify 5: all 5 indexes exist
for (const idx of REQUIRED_INDEXES) {
  if (indexExists(db, idx)) {
    vpass(`index exists: ${idx}`);
  } else {
    vfail(`index MISSING: ${idx}`);
  }
}

// Verify 6: CHECK constraints enforced — try inserting a bad op value (must throw)
console.log("");
console.log("[migrate-mutations] Verify 6: CHECK constraint probe (bad op value)");
try {
  db.prepare(`
    INSERT INTO mutations
      (id, client_id, station_id, table_name, row_id, op, created_at, applied_at, hlc, schema_version, origin, sync_status)
    VALUES
      ('test-id', 'test-client', 'test-station', 'songs', 'test-row', 'BAD_OP', 'now', 'now', '0:0:x', 3, 'local', 'pending')
  `).run();
  vfail("CHECK constraint on op NOT enforced — bad insert succeeded (should have thrown)");
} catch (e) {
  if (e.message && e.message.includes("CHECK")) {
    vpass("op CHECK constraint enforced (bad insert correctly rejected)");
  } else {
    vfail(`unexpected error during CHECK probe: ${e.message}`);
  }
}

console.log("");
if (!allOk) {
  console.error("[migrate-mutations] ABORT: one or more post-commit verifications FAILED.");
  db.close();
  process.exit(1);
}

console.log("[migrate-mutations] All verifications passed. Migration 3 complete. ✓");
console.log(`[migrate-mutations] client_id: ${generatedClientId}`);
console.log(`[migrate-mutations] hlc_last:  0:0:${generatedClientId}`);
db.close();
process.exit(0);
