# Option B Implementation Plan — Migrations as Single Source of Truth

**Date:** 2026-05-16  
**Status:** Plan — not yet implemented  
**Decision:** Selected over A (per-script dual logic) and C (drift risk + SQLite diff tooling burden)  
**Prerequisite:** schema_version stamping fix and migration-1 rowid fix committed first (independent, correct, needed regardless)

---

## Goal

Eliminate the two-source-of-truth problem. Today `runMigrations()` defines ~40 tables; 9 additional sync-era tables exist only in standalone migration scripts. Fresh installs are missing those 9. The fix: all schema definitions live in one chain. Fresh installs run the full chain from v0. Upgraded installs skip already-applied steps. Structural drift between fresh and upgraded installs becomes impossible.

---

## What moves and what stays

### Moves into a v0 baseline migration

Everything that is pure schema definition — the `CREATE TABLE IF NOT EXISTS` block in `runMigrations()` (lines 160–617 of `electron/main.js`). This is approximately 617 lines, ~40 tables. The statements are unchanged — same SQL, new file. Because they use `CREATE TABLE IF NOT EXISTS`, the v0 migration is fully idempotent on an existing install (all tables already exist; every statement is a no-op).

The 9 currently-missing sync-era tables that live in migration scripts v4, v6, v8 are **not** duplicated into v0. They stay exactly where they are — in their existing migration scripts. v0 establishes the base schema; the numbered chain adds to it.

### Stays in `runMigrations()` (or moves to `seedFreshInstall()`)

`runMigrations()` becomes a thin chain runner. The following **do not move into migrations** — they are business logic, not schema:

| Block | Destination |
|---|---|
| `alterSafe(...)` backfills (~70 lines) | Stay in `runMigrations()` temporarily — see **Deferred cleanup** below. |
| Station 1 seed (INSERT if no stations) | `seedFreshInstall()` |
| Default separation rules seed | `seedFreshInstall()` |
| Default users seed (Admin, Jock, MD) | `seedFreshInstall()` |
| `INSERT OR IGNORE INTO crash_recovery (id) VALUES (1)` sentinel | `seedFreshInstall()` |
| `INSERT OR IGNORE INTO station_config_kv ... multistation_insert_audit_complete` | `seedFreshInstall()` |
| `UPDATE deck_configs SET enabled=1 WHERE slot IN ('D','E','F')` | Keep in `runMigrations()` — it is an idempotent repair, not seeding |
| FTS table + triggers (`songs_fts`, `trg_songs_fts_*`) | Keep in `runMigrations()` — idempotent, runs every startup to pick up trigger changes |
| `station_config_kv` composite-PK recreation block | Keep in `runMigrations()` — upgrade repair logic, must run every startup until all OV installs have passed it |
| `seedDeckConfigs()` call | Unchanged — already a separate function |

---

## v0 baseline migration — naming and handling

### Naming decision: special-case file, not in the `migrate-*-phase-sync-N.js` namespace

The existing regex `migrate-.+-phase-sync-(\d+)\.js` governs:
- `transformer-chain.js` discovery
- `verify-transformer-chain.js` coverage check (v2 → currentVersion)
- `scripts/verify-transformer-chain.js` pre-commit hook

A file named `migrate-baseline-phase-sync-0.js` would match this regex with N=0. That creates two complications: the coverage check starts at v2 (v1 is the "implicit base"), so v0 would be outside the checked range — benign but confusing. More importantly, `transformer-chain.js` uses migration scripts only as payload transformers for sync; a v0 transformer is never invoked (you never receive a mutation from schema_version 0). Including v0 in that namespace creates a dead entry in the transformer map.

**Decision: name it `scripts/schema-v0-baseline.js`.** It does not match `MIGRATION_RE`. The chain runner calls it directly as a special first step, before iterating the numbered migrations. This keeps the existing transformer/verify infrastructure unchanged.

### v0 file structure

```
scripts/schema-v0-baseline.js
```

```js
'use strict';
// schema-v0-baseline.js — base schema for fresh installs (Option B).
// Called by the chain runner BEFORE v1–v16 migrations.
// All statements are CREATE TABLE IF NOT EXISTS — fully idempotent on
// existing installs (every statement is a no-op if the table exists).
// Do NOT add seeding, ALTER TABLE, or business logic here.

module.exports = function applyBaseline(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version ( ... );
    CREATE TABLE IF NOT EXISTS artists ( ... );
    -- all ~40 base tables, verbatim from runMigrations()
  `);
};
```

The function receives the already-open `db` connection. No file I/O, no process.exit, no standalone runner — it is a library module only.

---

## Chain runner design

`runMigrations()` becomes:

```js
function runMigrations() {
  const isFreshInstall = !db.prepare("SELECT 1 FROM schema_version LIMIT 1").get();

  // Step 1: v0 baseline (idempotent on existing installs)
  require('./schema-v0-baseline')(db);   // path relative to electron/

  // Step 2: numbered migrations v1–vN, skipping already-applied versions
  runMigrationChain(db);

  // Step 3: idempotent repairs that must run every startup (FTS, deck enable, etc.)
  runStartupRepairs(db);

  // Step 4: seed business data only on a fresh install
  if (isFreshInstall) seedFreshInstall(db);

  // Step 5: existing seedDeckConfigs() — unchanged
  seedDeckConfigs();
}
```

`isFreshInstall` is captured **before** v0 runs so that the check reflects the true pre-startup state. After v0 runs, `schema_version` will have rows even on a fresh install.

### `runMigrationChain(db)`

```js
function runMigrationChain(db) {
  const applied = new Set(
    db.prepare("SELECT version FROM schema_version").all().map(r => r.version)
  );
  const MIGRATION_RE = /^migrate-.+-phase-sync-(\d+)\.js$/;
  const scriptsDir = path.join(__dirname, '..', 'scripts');
  const scripts = [];
  for (const f of require('fs').readdirSync(scriptsDir)) {
    const m = MIGRATION_RE.exec(f);
    if (m) scripts.push({ v: parseInt(m[1], 10), file: f });
  }
  scripts.sort((a, b) => a.v - b.v);
  for (const { v, file } of scripts) {
    if (applied.has(v)) continue;
    require(path.join(scriptsDir, file)).applyMigration(db);
    // applyMigration() is responsible for inserting schema_version row
  }
}
```

This requires the migration scripts to export an `applyMigration(db)` function in addition to `payloadTransformer`. That is a change to the migration script interface — see "Migration script interface" below.

---

## Migration script interface change

Today each migration script is a standalone runnable (uses `require.main === module` guard) that also exports `payloadTransformer`. Under Option B it additionally exports `applyMigration(db)` — the schema-change logic extracted from the `if (_isMain)` body.

```js
module.exports = {
  payloadTransformer: function(...) { ... },   // unchanged
  applyMigration: function(db) { ... },        // new export — called by chain runner
};
```

The standalone runner (`if (_isMain)`) block can remain for manual one-off use but is no longer the primary invocation path.

**This is the largest mechanical change**: all 16 scripts need `applyMigration` extracted and exported. The logic is the same SQL — it moves from the `_isMain` body into the export. Pre-flight checks (schema_version guards, column-existence checks) must be updated to use the passed-in `db` rather than opening a fresh connection.

---

## What happens to existing OV installs

On first launch after this change:

1. `isFreshInstall = false` (schema_version has rows 1–16)
2. v0 baseline runs — all 40 `CREATE TABLE IF NOT EXISTS` are no-ops
3. Chain runner checks applied versions (1–16 all present) — all 16 migrations are skipped
4. Startup repairs run as today
5. `seedFreshInstall()` is **not** called (isFreshInstall = false)

Result: existing OV installs are unaffected. The chain runner is a no-op for them.

---

## What happens on a fresh 2nd client install

1. `isFreshInstall = true` (schema_version empty)
2. v0 baseline runs — creates all 40 base tables, stamps schema_version with row... actually: v0 should NOT stamp schema_version. The chain runner stamps it as each migration applies. After the full chain, schema_version = {1, 2, ..., 16}.

   **Open question**: does v0 stamp schema_version = 0? If it does, `isFreshInstall` (captured before v0) correctly detects fresh. If it does not, fresh detection still works. Recommendation: v0 does NOT insert into schema_version (it predates the numbered chain). The chain runner inserts each version as the migration applies.

3. Migrations v1–v16 all run in order (none yet in applied set after v0)
4. Startup repairs run
5. `seedFreshInstall()` is called — inserts station 1, default users, separation rules, etc.

---

## Implementation order (do not begin until plan is approved)

1. **schema_version + rowid fixes** ✓ committed (446ad5c)

2. **Remove the interim schema_version 1..maxN stamping block from `runMigrations()`.**  
   Commit 446ad5c added this as a temporary bridge. Under Option B it is actively harmful: on a fresh install it stamps `{1..16}` before the chain runner reads `schema_version`, causing the runner to see all versions present and skip all 16 migrations — so the 9 sync-era tables are never created. This is the exact bug Option B exists to fix, reintroduced.  
   Remove it in its own commit before any other Option B work. The chain runner's `applyMigration()` calls stamp their own versions; no interim code is needed once the chain runs.

3. **Extract `seedFreshInstall()`** — move seeding blocks out of `runMigrations()` into a new function; verify OV still boots.

4. **Write `scripts/schema-v0-baseline.js`** — move CREATE TABLE block verbatim from `runMigrations()`; verify OV still boots (no regressions).

5. **Add `applyMigration(db)` to each migration script — one script at a time.**  
   Extract the schema logic from the `_isMain` body, export it as `applyMigration(db)`, keep the `_isMain` standalone block intact. After each script: verify it still works standalone AND verify the runner can call `applyMigration` without error. Do not batch all 16 — sixteen small verified steps.  
   Order: v1, v2, v3, v4, v5, v6, v7, v8, v9, v10, v11, v12, v13, v14, v15, v16.

6. **Wire `runMigrationChain(db)` and the full `runMigrations()` shape** — v0 + chain + repairs + seed; verify fresh install gets all 9 sync-era tables and OV is unaffected.

7. **Update `verify-transformer-chain.js`** if needed (likely none — it still reads DB + scans filenames).

8. **Commit as a single focused commit** with the full scope documented.

---

## Deferred cleanup

**`alterSafe(...)` backfills in `runMigrations()` (~70 lines)**

These are idempotent `ALTER TABLE ... ADD COLUMN` calls added over time as columns were introduced to tables that predated those columns. On a fresh install after Option B, v0 baseline creates all columns correctly in the original `CREATE TABLE` statements, so the `alterSafe` calls are no-ops. On OV they remain necessary until OV has run the full Option B chain at least once (at which point all columns exist via migration scripts).

Once OV has shipped with Option B and the `alterSafe` backfills are confirmed redundant, they can be deleted from `runMigrations()` in a follow-up cleanup commit. This is explicitly not in scope for the Option B implementation pass — do not remove them during this work.

**Tracking:** Remove `alterSafe` backfill block from `runMigrations()` after Option B ships and OV confirms a clean boot.

---

## Known issues to resolve at Step 6

### ROOT CAUSE — multiple migrations assume a station row exists

Any migration that seeds per-station data or does station-scoped work (station_id-dependent ALTERs, per-station INSERTs) will silently no-op or throw on a fresh install, because the migration chain runs **before** `seedFreshInstall()` creates station 1. This is a structural ordering problem, not a per-migration bug.

**Step 6 must decide the ordering principle.** Likely candidates:

1. **(Preferred) Seed station 1 BEFORE the migration chain runs.** Only the bare station 1 INSERT (and nothing else from `seedFreshInstall()`) moves to before the chain. The rest of `seedFreshInstall()` stays after. Any per-station migration seeding then sees exactly 1 station and works correctly. No per-migration changes needed.

2. **Make each station-dependent migration handle the zero-stations case and have `seedFreshInstall()` backfill.** More invasive — each affected migration needs to be written so that 0-station runs are non-fatal, and `seedFreshInstall()` re-runs their seeding for the newly created station. Higher coupling.

The `pinned_songs` and migration-6 entries below are instances of this pattern. Watch for more in migrations 7–16 — note any occurrence in the relevant callout and add an entry here.

---

### `pinned_songs` — chain runner will throw "no such table" on a fresh install

**Problem:** Migration-4 Step 5 does:
```sql
ALTER TABLE pinned_songs ADD COLUMN station_id INTEGER NOT NULL DEFAULT 1 ...
ALTER TABLE pinned_songs ADD COLUMN uuid TEXT
ALTER TABLE pinned_songs ADD COLUMN updated_at TEXT
ALTER TABLE pinned_songs ADD COLUMN deleted_at TEXT
```
On a fresh install via the chain runner, `pinned_songs` does not exist at the point migration-4 runs. The table predates the git history of `electron/main.js` and was never part of the `runMigrations()` `CREATE TABLE` block — therefore it was not included in `scripts/schema-v0-baseline.js`. The chain runner will throw `"no such table: pinned_songs"` at migration-4, rolling back the entire transaction.

**Decided fix:** Add `pinned_songs` to `scripts/schema-v0-baseline.js` as a `CREATE TABLE IF NOT EXISTS` with its **original pre-migration-4 column shape**:

```sql
CREATE TABLE IF NOT EXISTS pinned_songs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  song_id        INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
  slot_hour      INTEGER NOT NULL,
  slot_position  INTEGER NOT NULL,
  recur_dow      INTEGER,
  play_at_unix   INTEGER,
  start_unix     INTEGER,
  end_unix       INTEGER,
  force_play     INTEGER NOT NULL DEFAULT 0,
  pinned_by      TEXT,
  reason         TEXT,
  consumed_at    INTEGER,
  created_at     TEXT NOT NULL
);
```

With `pinned_songs` in v0, migration-4 Step 5's `ALTER TABLE` calls run against an existing table on both fresh and upgrade paths — identical behaviour, consistent with every other base table.

**Status:** NOT yet implemented. This is a Step 6 pre-fresh-test item. Do not implement during the migration-5–16 extraction pass (Step 5).

---

### Migration-6 metadata seeding — stations table is empty on a fresh install

**Problem:** Migration-6 Step 4 seeds 47 `metadata_definitions` rows + 35 `metadata_vocabulary` rows per station, by querying `SELECT id FROM stations`. On a fresh install via the chain runner, `seedFreshInstall()` runs **after** the migration chain completes. This means `stations` is empty when migration-6 runs — the seed loop executes 0 iterations, and the station 1 created by `seedFreshInstall()` ends up with no metadata definitions or vocabulary.

This is the same class of ordering issue as the `pinned_songs` gap: seed data that depends on a station record being present, but the station isn't seeded until after the migration chain.

**Decided fix:** `seedFreshInstall()` must also seed metadata definitions and vocabulary for the newly created station 1. The seeding logic already exists in migration-6's `applyMigration` (Steps 4a-4b: INSERT INTO metadata_definitions + metadata_vocabulary per station). The fix is to either:

- (a) After inserting station 1 in `seedFreshInstall()`, call migration-6's seeding loop directly for that station (pass `stationId` to a helper extracted from migration-6), or
- (b) Add an idempotent `INSERT OR IGNORE` metadata seed block to `seedFreshInstall()` that covers station 1 if `metadata_definitions` is empty.

Approach (a) is preferred — it keeps the definitions list as the single source of truth in migration-6. The concrete implementation is a Step 6 decision.

**Status:** NOT yet implemented. This is a Step 6 pre-fresh-test item. Do not implement during the migration-5–16 extraction pass (Step 5).

---

### Migration-8 — real schema work lives in `migrate-phase-a-v8.js`, outside the chain runner

**Problem:** `migrate-station-schema-phase-sync-8.js` is a genuine stub. Its `_isMain` body is three `console.log` lines that redirect the operator to `migrate-phase-a-v8.js` and `process.exit(0)`. The actual v8 schema work — 12 steps — lives entirely in `migrate-phase-a-v8.js`, which does NOT match the chain runner's `MIGRATION_RE` pattern and is never called by `runMigrationChain`.

The `applyMigration` added to the stub in Step 5 inserts schema_version = 8 only. On a fresh install via the chain runner, version 8 is stamped but the following schema changes are NOT applied:

- `stations.icecast_port INTEGER DEFAULT 8000` — **covered by `alterSafe()` backfills in `runMigrations()`**, so this is safe on fresh install
- `stations.audio_device_output TEXT` — **covered by `alterSafe()`**
- `stations.mic_device TEXT` — **covered by `alterSafe()`**
- `stations.mount_pending_provision INTEGER NOT NULL DEFAULT 1` — **covered by `alterSafe()`**
- `CREATE TABLE monitor_routing` — **NOT covered** — missing on fresh install (one of the 9 sync-era tables)
- `CREATE TABLE install_config_kv` — **NOT covered** — missing on fresh install
- `CREATE TABLE install_secrets_kv` — **NOT covered** — missing on fresh install (one of the 9 sync-era tables)
- `station_config_kv` rebuild (removes DEFAULT 0) — **NOT covered** — fresh install gets v0 baseline's DDL, which may or may not have the DEFAULT 0 issue

**Decided fix options (Step 6 decision):**

1. Move the 12-step schema logic from `migrate-phase-a-v8.js` into `migrate-station-schema-phase-sync-8.js`'s `applyMigration`, making it idempotent (`CREATE TABLE IF NOT EXISTS`, `colExists` guards on ALTER TABLE). This makes the chain runner the single source of truth for v8.

2. Add `monitor_routing`, `install_config_kv`, `install_secrets_kv` to `scripts/schema-v0-baseline.js` with their pre-migration-4 (v0) shapes. This covers the missing-table gap; the alterSafe backfills cover the station columns.

Option 2 is lower risk for Step 6 since it doesn't require restructuring the 12-step migration. Option 1 is cleaner long-term.

Since migrations 8–11 were previously flagged as stubs in the same pattern, there are likely more `migrate-phase-a-vN.js` files holding real schema work outside the chain runner's reach. This is a **category problem, not a per-migration one**. Step 6's fix is a single architectural decision:

- **(a)** Extend the chain runner to also discover and run `migrate-phase-a-vN.js` files (changes the runner, leaves scripts untouched), or
- **(b)** Fold all `migrate-phase-a-*` schema work into the corresponding `migrate-station-schema-phase-sync-N.js`'s `applyMigration` (or into `schema-v0-baseline.js` for table creations), making the `MIGRATION_RE` chain the single source of truth.

Findings from migrations 9, 10, 11 accumulate below. Once all stubs are identified, Step 6 makes the one decision that resolves all of them.

**Migration-9** (`migrate-phase-a-v9.js`): Full `stations` table recreation to change `icecast_server_url DEFAULT '127.0.0.1'` → `DEFAULT NULL`, plus data rewrite of existing `'127.0.0.1'` rows to live Icecast IP. No new tables. Fresh-install gap: `stations.icecast_server_url` has wrong default. Data rewrite is a no-op (stations empty at chain run time). NOT covered by `alterSafe()`. Lower severity than v8 (no missing tables), but stations DDL diverges from OV.

**Migration-11** (`main.js` at startup — outdated comment): Stub with no `migrate-phase-a-v11.js`. The three DDL items (`CREATE INDEX idx_macros_station_trigger`, `CREATE INDEX idx_macros_station_hotkey`, `CREATE TABLE scheduling_rules`) are already in `scripts/schema-v0-baseline.js` (extracted verbatim from the original `runMigrations()` block in Step 4). The chain runner calls v0 baseline first, so a fresh install already gets all three. **No fresh-install gap for v11.** The stub comment referencing "main.js at startup" is outdated — the work is now covered by the v0 baseline. `applyMigration` is version stamp only; no further fix needed.

**Migration-10** (`migrate-phase-a-v10.js`): Data-only backfill — copies 47 built-in `metadata_definitions` + 35 `metadata_vocabulary` rows from station 1 to any station with 0 is_built_in definitions. Pre-flights on station 1 having exactly 47 definitions. Idempotent via `INSERT OR IGNORE`. Also stamps `system_state.schema_version = '10'`. Fresh-install gap: **subsumed by the migration-6 metadata seeding fix**. If the migration-6 fix correctly seeds metadata for station 1 (either by seeding station 1 before the chain runs, or in `seedFreshInstall()`), station 1 already has 47 definitions and v10 is a no-op on a fresh single-station install. If the migration-6 fix is not done, v10 cannot help — its own pre-flight aborts when station 1 has 0 definitions. No independent fix needed for v10 beyond resolving migration-6.

**Status:** NOT yet implemented. Step 6 decision required before fresh-install test.

---

## Pre-existing inconsistencies noted during Step 5 (not fixed — out of scope, tracked for later)

Neither issue affects the Option B chain runner (which calls `applyMigration` directly, bypassing `_isMain`) or fresh-install correctness. Both are standalone-operator-path concerns only.

### Migration-14: `_isMain` guard is `if (require.main === module)` only — missing `_scriptArg` Electron fallback

Migrations 1–13 all use:
```js
const _scriptArg = process.argv.slice(1).find(a => !a.startsWith('-'));
const _isMain = require.main === module ||
  (_scriptArg && require('path').resolve(_scriptArg) === __filename);
if (_isMain) {
```

Migration-14 uses only `if (require.main === module)`. Under Electron's bootstrapper, `require.main !== module`, so the `_isMain` block will never fire when run as a script via `node_modules/.bin/electron --no-sandbox scripts/migrate-station-schema-phase-sync-14.js`. The standalone backup/pre-flight/post-verification body is dead in that invocation path.

**Consequence:** Chain runner is unaffected (calls `applyMigration` directly). Standalone operator use via Electron is silently broken. Candidate cleanup; not a blocker.

### Migration-14: Pre-flight 2 is "soft" — `process.exit(0)` on already-applied

Migrations 12 and 13 use the hard-abort form on double-application:
```js
console.error('[migrate-vN] ERROR: ... already applied?');
db.close(); process.exit(1);
```

Migration-14 uses:
```js
console.log("INFO: station_id already present — migration already applied, exiting cleanly.");
process.exit(0);
```

Pre-existing behavior, intentionally left unchanged in Step 5. The chain runner skips already-applied versions via the `applied` set — it never calls `applyMigration` for an already-applied version, so this guard is only relevant for standalone use. Worth a later decision on whether v14 should match 12/13's hard-abort or whether the soft/clean-exit behavior was deliberate. Migration-15 has the same soft form.

---

## Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| **Interim schema_version stamp (446ad5c) collides with chain runner** | **Certain if not removed** — stamp fills `{1..16}` before runner reads applied set; runner skips all migrations; 9 sync-era tables never created | **Step 2 removes it before any other Option B work.** No other mitigation is sufficient. |
| A migration script's `applyMigration()` assumes a standalone DB connection | Medium — scripts open their own `new Database()` today | Systematic: each extraction replaces `new Database()` with the passed-in `db`; `applyMigration` receives `db` as its only argument |
| Pre-flight version checks in migration scripts reject fresh installs | Medium — many scripts check `schema_version < N` | Each `applyMigration()` skips its pre-flight (pre-flights are for the standalone operator tool, not the in-process runner which guarantees ordering) |
| `seedFreshInstall()` runs on OV (corrupts data) | Low — guarded by `isFreshInstall` captured before chain | Double-check: `isFreshInstall` uses schema_version, which is populated on OV; guard is reliable |
| v0 baseline creates a table with different DDL than what OV has | Low — statements are `CREATE TABLE IF NOT EXISTS`; OV's existing tables are untouched | Post-implementation: run `PRAGMA table_info` comparison on OV vs fresh install for all 9 formerly-missing tables |
