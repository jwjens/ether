# Fresh-Install Schema Gap

**Date:** 2026-05-16  
**Status:** Documented — architecture decision pending  
**Scope:** `electron/main.js` `runMigrations()`, sync-era migration scripts, `schema_version` stamping

---

## Finding 1 — Nine sync-era tables are never created on a fresh install

`runMigrations()` in `electron/main.js` builds the base schema on every startup via `CREATE TABLE IF NOT EXISTS`. It creates ~40 tables. The sync subsystem (`electron/sync/`) requires 9 additional tables that **only exist in the codebase as `CREATE TABLE` statements inside standalone upgrade scripts** written for the OV-to-sync migration path. Those scripts are never called by `runMigrations()` and are never called at Ether startup.

A fresh install therefore opens with those 9 tables absent. The IPC handlers, the merge-engine, and UI components that reference them fail with `no such table` the first time they are touched.

### The 9 missing tables

| Table | Authoritative definition | IPC handlers installed at startup |
|---|---|---|
| `pinned_songs` | Predates git history of `main.js`; final form on upgrade path is OV's `sqlite_master` (base columns) + migration-4 alters | Yes — `electron/sync/handlers/pinned_songs.js`; also queried directly in `PDPicks.tsx`, `SchedulePreview.tsx` |
| `station_programming` | `scripts/migrate-library-phase-sync-4.js` | Yes — `electron/sync/handlers/station_programming.js` |
| `station_programming_moods` | `scripts/migrate-library-phase-sync-4.js` | Yes — `electron/sync/handlers/station_programming_moods.js` |
| `mood_tags` | `scripts/migrate-library-phase-sync-4.js` | Yes — `electron/sync/handlers/mood_tags.js` |
| `metadata_definitions` | `scripts/migrate-metadata-tables-phase-sync-6.js` | Yes — `electron/sync/handlers/metadata_definitions.js` |
| `metadata_vocabulary` | `scripts/migrate-metadata-tables-phase-sync-6.js` | Yes — `electron/sync/handlers/metadata_vocabulary.js` |
| `song_metadata_values` | `scripts/migrate-metadata-tables-phase-sync-6.js` | Yes — `electron/sync/handlers/song_metadata_values.js` |
| `monitor_routing` | `scripts/migrate-phase-a-v8.js` | No direct IPC handlers; referenced in `synced-tables.js` — merge-engine will attempt INSERT on incoming mutations |
| `install_secrets_kv` | `scripts/migrate-phase-a-v8.js` | No direct IPC handlers; referenced in `synced-tables.js` — merge-engine will attempt INSERT on incoming mutations |

`7 of 9` tables have active IPC handlers that throw on first renderer call. All 9 are in `electron/sync/synced-tables.js` and will cause merge-engine failures on incoming mutations.

### Why it hid

The `uuidNeededNow` loop in `runMigrations()` calls `alterSafe("ALTER TABLE pinned_songs ADD COLUMN uuid TEXT")` and similar. `alterSafe` wraps every call in a try/catch that swallows all errors, including `no such table`. The loop appeared to handle pinned_songs; it was silently doing nothing.

The other 8 tables were never referenced in `runMigrations()` at all — they simply were not missed because OV always had them from Phase A and Phase Sync migrations run historically.

---

## Finding 2 — `schema_version` is never stamped on a fresh install

`runMigrations()` creates the `schema_version` table but inserts no rows. The only write in `main.js` is:

```js
// electron/main.js:892-894
const maxVer = db.prepare("SELECT MAX(version) AS v FROM schema_version").get();
if (maxVer?.v) {
  db.prepare("INSERT OR REPLACE INTO system_state ...").run(String(maxVer.v));
}
```

On a fresh install `maxVer.v` is `NULL`, the `if` is false, and nothing is written anywhere.

### Consequences

| Consumer | Location | Behavior on empty `schema_version` |
|---|---|---|
| `mutation-writer.js` | line 262-267 | Hard throw: `'schema_version table is empty — DB not initialized'` — every sync mutation write fails |
| `sync-engine._readSchemaVersion()` | line 309 | Returns `0` via `?? 0` — treats local schema as v0; every incoming mutation triggers full v1→v16 transformer chain |
| `verify-transformer-chain.js` | line 70-73 | Exits with error: `'cannot determine current schema_version from DB'` — pre-commit hook fails |

### There is no static `CURRENT_SCHEMA_VERSION` constant

The pre-commit hook (`verify-transformer-chain.js`) determines the current max version by reading the DB. The transformer chain (`transformer-chain.js`) discovers migration scripts dynamically via the regex `migrate-.+-phase-sync-(\d+)\.js` on the `scripts/` directory. There is no exported constant anywhere.

Whatever fix stamps `schema_version` on a fresh install **must derive the version number the same way** — `Math.max` over the integer suffixes of files matching `migrate-*-phase-sync-N.js` in `scripts/` — never a literal. A hardcoded `16` is silently wrong the moment `migrate-*-phase-sync-17.js` ships.

---

## What must NOT be done

Do not add 9 `CREATE TABLE` statements to `runMigrations()`. The 9 tables already have authoritative definitions in the migration scripts. Duplicating them into `runMigrations()` creates two sources of truth: any future schema change to one of these tables must be made in two places simultaneously. It guarantees divergence between fresh and upgraded installs the moment either copy is edited independently. This is a worse bug than the one being fixed.

---

## Architecture options

These are candidate approaches. No option has been selected. Each has meaningful tradeoffs.

---

### Option A — Fresh installs run the migration chain too

Make the standalone `migrate-*-phase-sync-N.js` scripts idempotent from a zero-row DB (all 9 missing tables absent, `schema_version` empty) and call them in sequence from `runMigrations()` or from `initDb()` after `runMigrations()` completes.

**What it costs:**
- Every migration script must be audited and made safe against the fresh-install starting state (many currently assume OV-era preconditions). This is the core work done for `pinned_songs` in the revert — it was extensive.
- `runMigrations()` currently runs synchronously at startup before the window loads. Chaining 16 scripts adds startup latency on every fresh install (one-time, but visible).
- Electron process-tree issues on Windows require running scripts under the same process rather than spawning child processes, complicating the runner.

**What it risks:**
- Migration scripts are upgrade scripts with upgrade-specific pre-flight checks (e.g., "abort if schema_version > N"). Adapting them all to handle both zero-row and existing-row states is invasive — each script becomes dual-path code.
- Any future migration script must be written to be idempotent from zero. This is a new authoring discipline not currently established.

**What it touches:**
- All 16 `migrate-*-phase-sync-N.js` scripts (audit + possible changes to each)
- `electron/main.js` `initDb()` / `runMigrations()` (runner invocation)
- `scripts/verify-transformer-chain.js` (pre-flight checks may need updating)

---

### Option B — Migration scripts become the single source of truth; base tables move out of `runMigrations()`

Move all or most `CREATE TABLE` statements out of `runMigrations()` and into early migration scripts (v0→v1 or a new v0 baseline migration). `runMigrations()` becomes a thin bootstrapper that runs the full migration chain from zero every time (skipping already-applied versions). Schema is defined exactly once — in migrations.

**What it costs:**
- Significant refactor: `runMigrations()` is ~735 lines including ALTER TABLE chains, seeding logic, FTS triggers, and business rules. Decomposing it into migrations is a large, careful rewrite.
- All existing migrations must be renumbered or a v0 baseline migration must be inserted. The pre-commit hook and transformer chain discovery must account for the new numbering.
- For existing OV installs the chain must correctly skip already-applied steps — requires solid idempotency at every step.

**What it risks:**
- This is the highest-risk option. A mistake in the decomposition breaks both the fresh-install path and the upgrade path simultaneously.
- `runMigrations()` currently runs with `db` already open; migrations running as separate scripts under a different process model (Electron vs plain node) have ABI constraints (better-sqlite3 ABI 145 vs 137) that require a rebuild step. An in-process runner avoids this but changes the current script architecture.

**What it touches:**
- `electron/main.js` `runMigrations()` (substantial rewrite)
- All 16 existing migration scripts (at minimum, numbering and pre-flight checks)
- A new v0 or expanded v1 migration covering the base schema
- `scripts/verify-transformer-chain.js` and pre-commit hook

---

### Option C — A canonical full-schema snapshot that fresh installs apply directly

Introduce a `scripts/schema-current.sql` (or equivalent) that is the single authoritative definition of the complete current schema at schema_version N. Fresh installs run this snapshot directly. Upgrades continue to run the delta migration scripts as today. The snapshot is generated (not hand-maintained) by tooling that exports the schema from a known-good upgraded DB.

**What it costs:**
- Requires a generation step: every time a migration adds a table or column, the snapshot must be regenerated and committed. This must be enforced (pre-commit hook or CI check).
- The snapshot and the migration chain must produce identical schemas — verifying this requires a schema-diff tool or test. Without enforcement, they drift.
- Fresh-install path (snapshot) and upgrade path (chain) are distinct code paths that must be actively kept synchronized.

**What it risks:**
- If the generation/verification step is skipped once, fresh and upgraded installs silently diverge. The bug recurs in a different form.
- Schema comparison tools for SQLite are less mature than for Postgres/MySQL. A reliable diff requires either custom tooling or careful `PRAGMA table_info` comparison across all tables.

**What it touches:**
- New tooling: schema export script, schema diff verifier
- `electron/main.js` `runMigrations()` (add snapshot-apply branch for fresh installs)
- CI / pre-commit hook (enforce snapshot freshness)
- Every future migration (must regenerate snapshot as part of the migration workflow)

---

## Summary table

| | Option A (run chain from zero) | Option B (migrations as single source) | Option C (snapshot for fresh installs) |
|---|---|---|---|
| Single source of truth | No — scripts + runMigrations() base still coexist | Yes | No — snapshot + scripts are two sources, but one is generated |
| Touches existing migration scripts | Yes — all 16, audit required | Yes — all 16, numbering/pre-flights | No |
| Touches runMigrations() | Minimally — adds runner call | Major rewrite | Adds fresh-install branch |
| Risk to OV upgrade path | Medium | High | Low |
| Ongoing authoring discipline | Migrations must be zero-idempotent | Migrations are single source (simpler long-term) | Snapshot must be regenerated on every schema change |
| Implementation size | Medium | Large | Medium + new tooling |
