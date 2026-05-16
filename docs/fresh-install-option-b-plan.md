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
| `alterSafe(...)` backfills (~70 lines) | Stay in `runMigrations()` temporarily; these are idempotent column additions for pre-existing OV installs. On Option B completion they can be removed once OV has run the chain — not in scope for this pass. |
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

1. **Commit schema_version + rowid fixes** (already staged/written — independent)
2. Extract `seedFreshInstall()` — move seeding blocks out of `runMigrations()` into a new function; verify OV still boots
3. Write `scripts/schema-v0-baseline.js` — move CREATE TABLE block verbatim from `runMigrations()`; verify OV still boots (no regressions)
4. Add `applyMigration(db)` export to each of the 16 migration scripts — extract schema logic, keep `_isMain` standalone body intact
5. Write `runMigrationChain(db)` inline in `runMigrations()`; wire v0 + chain + repairs + seed; verify fresh install and existing install both boot correctly
6. Update `verify-transformer-chain.js` if needed (likely none — it still reads DB + scans filenames)
7. Commit as a single focused commit with the full scope documented

---

## Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| A migration script's `applyMigration()` assumes a standalone DB connection | Medium — scripts open their own `new Database()` today | Systematic: each extraction replaces `new Database()` with the passed-in `db`; `applyMigration` receives `db` as its only argument |
| Pre-flight version checks in migration scripts reject fresh installs | Medium — many scripts check `schema_version < N` | Each `applyMigration()` skips its pre-flight (pre-flights are for the standalone operator tool, not the in-process runner which guarantees ordering) |
| `seedFreshInstall()` runs on OV (corrupts data) | Low — guarded by `isFreshInstall` captured before chain | Double-check: `isFreshInstall` uses schema_version, which is populated on OV; guard is reliable |
| v0 baseline creates a table with different DDL than what OV has | Low — statements are `CREATE TABLE IF NOT EXISTS`; OV's existing tables are untouched | Post-implementation: run `PRAGMA table_info` comparison on OV vs fresh install for all 9 formerly-missing tables |
