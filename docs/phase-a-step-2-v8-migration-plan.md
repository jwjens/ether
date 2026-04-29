# Phase A Step 2 — v8 Migration Plan

> **Status**: Plan ready for execution. Step 0 prerequisites must complete first.  
> **Basis**: KV audit (this session, 2026-04-29) + phase-a-execution-plan.md + phase-a-amendment-1.md  
> **Date**: 2026-04-29  
> **Scope**: Phase A Step 2 schema work + config architecture cleanup

---

## Context

The Phase A execution plan (see `phase-a-execution-plan.md`) describes Step 2 as "Per-Station Stream
State Map." Before that step can safely proceed, the config architecture needs to be in a clean state.
Two problems have been building since Phase 1:

1. **Silent `DEFAULT 0` in `station_config_kv`**: The `station_id` column defaults to `0`. Any INSERT
   that omits `station_id` silently writes to station 0 — a phantom station that has no corresponding
   row in `stations`. This has been masking station-scoping bugs since the composite PK migration.

2. **Install-level data in a station-scoped table**: Ten keys currently in `station_config_kv` are
   conceptually install-level (license, plan tier, DMCA ack, first-run gate, active station pointer,
   last operator, tour completion, admin gate, and two credential blobs). They don't belong per-station.
   They're at `station_id=0` by accident, not by design.

This plan resolves both. It is the largest single migration in Ether's history by line count, touching
schema, data, and code in a coordinated 5-commit sequence.

---

## KV Audit Summary (basis for this plan)

The full audit of all 32 `station_config_kv` keys is in the session output. Summary for migration
planning:

| Bucket | Count | Notes |
|--------|-------|-------|
| A — Fully wired (READ + WRITE) | 28 | Migrate forward; no action needed |
| B — Read-only wired | 1 | `multistation_insert_audit_complete` — intentional; WRITE is manual admin script |
| C — Write-only wired | 3 | `active_station_id`, `canvas_active_name`, `station_tagline` — see Open Items |
| D — Reference-only | 0 | No pure cruft found |
| E — Zero hits | 0 | Nothing safe to delete |

**Install-level keys confirmed**: 8 keys belong in `install_config_kv`, not `station_config_kv`.  
**Secrets keys confirmed**: 2 keys belong in `install_secrets_kv`.  
**Theme defaults confirmed**: 2 keys (`theme_preset_id='system'`, `theme_font_id='system'`) are default
sentinel rows — defaults should live in code, not DB rows.

---

## Prerequisites

Three prerequisites must be satisfied before any work in this plan begins.

| # | Prerequisite | Status |
|---|---|---|
| 1 | INSERT audit gate sound (`multistation_insert_audit_complete` key name and query verified) | **Closed on inspection** — confirmed correct in `phase-a-amendment-1.md` |
| 2 | KV audit complete (all 32 keys classified by bucket) | **Complete** — this session |
| 3 | Lightsail Icecast: confirm `/live-1` and `/live-3` mounts configured on the remote server | **Remains open** — coordinate with Lightsail operator before Step 0-B |

**Prerequisite 2A (folded in)**: The original standalone prerequisite "audit renderer INSERT callsites
for missing `crypto.randomUUID()`" is absorbed into Code Change C4 below rather than shipped as a
separate commit.

---

## Schema Changes (8)

These changes ship as a single migration function appended to `setupDb()` in `electron/main.js`.
All use `alterSafe()` for column additions and the `IF NOT EXISTS` pattern for new tables.

### S1 — `stations.icecast_port`

```sql
ALTER TABLE stations ADD COLUMN icecast_port INTEGER DEFAULT 8000;
```

Separates port from the existing `icecast_server_url` blob. Enables per-station port configuration.
The existing `icecast_server_url` retains its value; callers that construct Icecast URLs must be
updated to combine `icecast_server_url` + `icecast_port`.

### S2 — `stations.audio_device_output`

```sql
ALTER TABLE stations ADD COLUMN audio_device_output TEXT;
```

CPAL device name or index string for this station's output device. `NULL` = use system default.
Drives Phase A Step 5 native addon assessment — if physical per-station output is required, the JS
layer reads this column to route each station to its assigned device.

### S3 — `stations.mic_device`

```sql
ALTER TABLE stations ADD COLUMN mic_device TEXT;
```

CPAL device name for the mic/phone-line input assigned to this station. `NULL` = use system default.
Paired with S2 — together they give each station its own I/O identity.

### S4 — CREATE TABLE `monitor_routing`

```sql
CREATE TABLE IF NOT EXISTS monitor_routing (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid        TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
  station_id  INTEGER NOT NULL REFERENCES stations(id),
  source      TEXT NOT NULL,   -- 'deck_A' | 'deck_B' | 'mix_bus' | 'program' etc.
  output      TEXT NOT NULL,   -- audio device name or 'default'
  volume      REAL NOT NULL DEFAULT 1.0,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER DEFAULT (unixepoch()),
  updated_at  INTEGER DEFAULT (unixepoch()),
  deleted_at  INTEGER
);
```

Per-station monitor routing table. Each row routes a named audio source to an output device at a
given volume. Required for Phase A Step 5 (native addon assessment) and the master output monitor
fader. Scoped per station.

### S5 — CREATE TABLE `install_config_kv`

```sql
CREATE TABLE IF NOT EXISTS install_config_kv (
  key        TEXT PRIMARY KEY NOT NULL,
  value      TEXT,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);
```

Install-level config store. No `station_id` — these values are device-global. Replaces the pattern
of writing conceptually-global keys to `station_config_kv` at `station_id=0`.

### S6 — CREATE TABLE `install_secrets_kv`

```sql
CREATE TABLE IF NOT EXISTS install_secrets_kv (
  key        TEXT PRIMARY KEY NOT NULL,
  value      TEXT,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);
```

Install-level secrets store. Same structure as `install_config_kv`. Kept in a separate table so:
- It can be excluded from peer sync payloads by a single registry scope rule
- It can be excluded from DB exports/backups by name
- Access can be tightened independently in a future encrypted-at-rest pass

### S7 — Recreate `station_config_kv` without `DEFAULT 0`

The current DDL has `station_id INTEGER NOT NULL DEFAULT 0`. This silent default is the root cause
of the install-level data contamination. Remove it.

Migration is table-swap (SQLite cannot `ALTER COLUMN`):

```sql
-- 1. Rename old table
ALTER TABLE station_config_kv RENAME TO _station_config_kv_old;

-- 2. Create new table without DEFAULT 0
CREATE TABLE station_config_kv (
  station_id INTEGER NOT NULL,              -- no DEFAULT — omitting station_id is now a hard error
  key        TEXT    NOT NULL,
  value      TEXT,
  uuid       TEXT    NOT NULL DEFAULT (lower(hex(randomblob(16)))),
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch()),
  deleted_at INTEGER,
  PRIMARY KEY (station_id, key)
);

-- 3. Copy remaining rows (install-level and secrets keys will have been moved in M1/M2 already)
INSERT INTO station_config_kv (station_id, key, value, uuid, created_at, updated_at, deleted_at)
SELECT station_id, key, value, uuid, created_at, updated_at, deleted_at
FROM _station_config_kv_old;

-- 4. Drop old table
DROP TABLE _station_config_kv_old;
```

This migration **must run after M1 and M2** (install-level and secrets keys moved out) and **after
M3 and M4** (orphan and sentinel rows deleted). Sequence enforced in the migration function body.

**Note on uuid column**: The audit found no `uuid` column in the original `CREATE TABLE` in
`setupDb()`, but `synced-tables.js` registry declares it (`uuid: 'scalar'`). It was likely added
via a prior `alterSafe`. The new DDL includes it explicitly so the schema and registry are in sync.

### S8 — `synced-tables.js` registry update

Add registry entries for the 3 new tables:

```js
// monitor_routing — station-scoped; syncs per-station routing config
monitor_routing: {
  tableName: 'monitor_routing',
  primaryKey: ['id'],
  scope: 'station',
  columns: { id, uuid, station_id, source, output, volume, is_active,
             created_at, updated_at, deleted_at },
},

// install_config_kv — install-scoped; never carries station_id in sync payload
install_config_kv: {
  tableName: 'install_config_kv',
  primaryKey: ['key'],
  scope: 'install',
  isKv: true,
  kvKeyCol: 'key',
  kvValueCol: 'value',
  columns: { key, value, created_at, updated_at },
},

// install_secrets_kv — install-scoped; EXCLUDED from all sync payloads
install_secrets_kv: {
  tableName: 'install_secrets_kv',
  primaryKey: ['key'],
  scope: 'install',
  isKv: true,
  syncExcluded: true,   // never leave the device in any sync payload
  kvKeyCol: 'key',
  kvValueCol: 'value',
  columns: { key, value, created_at, updated_at },
},
```

Increment `schema_version` after adding these entries and run `scripts/verify-synced-tables.js`.

---

## Data Migration (8 Steps)

These steps run inside a single `db.transaction()` in a new `migrateV8Data()` function called from
`setupDb()`, after all S1–S8 schema changes are applied.

### M1 — Move 8 install-level keys from `station_config_kv` → `install_config_kv`

Keys to move (all currently at `station_id=0`):

| Key | Rationale |
|-----|-----------|
| `active_station_id` | Which station the UI is showing — a device-level pointer, not station data |
| `dmca_acknowledged` | One-time click-through per device install |
| `first_run_complete` | First-run gate is per device, not per station |
| `last_error` | HealthMonitor tracks install-wide system errors |
| `last_operator_id` | Operators are install-scoped entities |
| `multistation_insert_audit_complete` | Admin safety gate for the install |
| `plan_tier` | Subscription is per device, not per station |
| `tour_done_version` | Onboarding tour completion is per device |

```sql
INSERT OR IGNORE INTO install_config_kv (key, value)
SELECT key, value FROM station_config_kv
WHERE key IN (
  'active_station_id', 'dmca_acknowledged', 'first_run_complete',
  'last_error', 'last_operator_id', 'multistation_insert_audit_complete',
  'plan_tier', 'tour_done_version'
)
AND station_id = 0;

DELETE FROM station_config_kv
WHERE key IN (
  'active_station_id', 'dmca_acknowledged', 'first_run_complete',
  'last_error', 'last_operator_id', 'multistation_insert_audit_complete',
  'plan_tier', 'tour_done_version'
);
```

### M2 — Move 2 secrets keys from `station_config_kv` → `install_secrets_kv`

| Key | Secret content |
|-----|---------------|
| `license_key` | Subscription activation credential |
| `cloud_backup_r2` | JSON blob containing R2 `accessKeyId` + `secretAccessKey` |

```sql
INSERT OR IGNORE INTO install_secrets_kv (key, value)
SELECT key, value FROM station_config_kv
WHERE key IN ('license_key', 'cloud_backup_r2')
AND station_id = 0;

DELETE FROM station_config_kv
WHERE key IN ('license_key', 'cloud_backup_r2');
```

### M3 — Delete 3 duplicate orphan rows

After Phase 3, station-scoped keys were written to the active station's `station_id`. Rows at
`station_id=0` for those keys are orphans — duplicates of rows that now live at the correct
station_id. Delete the station_id=0 orphans for keys confirmed station-scoped:

```sql
DELETE FROM station_config_kv
WHERE station_id = 0
AND key IN (
  'canvas_active_name',
  'canvas_layout',
  'canvas_layout_version'
);
```

**Verification before running**: Confirm each of these keys has a row at `station_id=1` (or the
active station's id) before deleting the station_id=0 row. If a key only exists at station_id=0,
the row is the canonical value and must NOT be deleted — it should be moved to the active station_id
instead.

```sql
SELECT key, station_id, value FROM station_config_kv
WHERE key IN ('canvas_active_name', 'canvas_layout', 'canvas_layout_version')
ORDER BY key, station_id;
```

### M4 — Delete 2 'system' theme default sentinel rows

`theme_preset_id='system'` and `theme_font_id='system'` are default-value rows — the code already
falls back to `'system'` when no row exists (`?? 'system'` in SkinPicker.tsx). Writing these rows
to the DB adds noise and risks confusing the "was this set by the user?" check.

```sql
DELETE FROM station_config_kv
WHERE key = 'theme_preset_id' AND value = 'system';

DELETE FROM station_config_kv
WHERE key = 'theme_font_id' AND value = 'system';
```

After this, code must never write `'system'` as the value for these keys. Code change C1 enforces this.

### M5 — USPH UUID backfill

Rows in `station_config_kv` that predate the uuid column addition have `uuid = NULL`. The sync
system requires non-null UUIDs on every synced row. Backfill:

```sql
UPDATE station_config_kv
SET uuid = lower(hex(randomblob(16)))
WHERE uuid IS NULL OR uuid = '';
```

Also backfill `created_at` and `updated_at` for rows missing them:

```sql
UPDATE station_config_kv
SET created_at = unixepoch()
WHERE created_at IS NULL;

UPDATE station_config_kv
SET updated_at = unixepoch()
WHERE updated_at IS NULL;
```

### M6 — Mount collision fix

Both stations currently share `icecast_mount = '/live'`. Per AD-3, unique mounts are required before
Phase A streaming work begins. This is Step 0-B from the execution plan — included here so it executes
inside the same transaction.

```sql
UPDATE stations SET icecast_mount = '/live-1' WHERE id = 1;
UPDATE stations SET icecast_mount = '/live-3' WHERE id = 3;
```

**Prerequisite 3 dependency**: Confirm with Lightsail Icecast operator that both `/live-1` and
`/live-3` mounts exist and are configured for the expected bitrate and format before running.

### M7 — `eq_deck_*` integrity check

`eq_deck_A`, `eq_deck_B` etc. are written via the dynamic template `` `eq_deck_${deckId}` `` in
OnAirDeck.tsx. They are always written with the active station's `station_id`. Verify no rows exist
at station_id=0 for these keys (which would indicate they were written before the component picked
up the station_id parameter):

```sql
SELECT key, station_id, value FROM station_config_kv
WHERE key LIKE 'eq_deck_%'
ORDER BY key, station_id;
```

If any `eq_deck_*` rows exist at station_id=0, move them to the active station's id:

```sql
UPDATE station_config_kv
SET station_id = (SELECT id FROM stations WHERE is_active = 1 LIMIT 1)
WHERE key LIKE 'eq_deck_%' AND station_id = 0;
```

### M8 — Belt-and-suspenders UUID backfill

After S7 (station_config_kv recreated) and after rows from M1/M2 have been moved out, run a final
pass to ensure every remaining row in station_config_kv has a uuid. Identical to M5 but runs against
the newly-recreated table:

```sql
UPDATE station_config_kv
SET uuid = lower(hex(randomblob(16)))
WHERE uuid IS NULL OR uuid = '';
```

This is a no-op if M5 ran correctly but is cheap and eliminates any edge-case where a row was
inserted between M5 and the table recreate.

---

## Code Changes (9)

### C1 — Theme defaults move to code constants

Remove the writes of `'system'` as a value for `theme_preset_id` and `theme_font_id`. After M4,
these rows no longer exist in the DB. Code must treat the absent row as `'system'`:

**SkinPicker.tsx** — already correct (`?? 'system'`). Verify no write path sets value to `'system'`:
- In `saveTheme()`: `upsertByKey(..., 'theme_preset_id', presetId)` — only write when user actively
  selects a non-system preset
- In `saveTheme()`: conditional write for `theme_font_id` already skipped when falsy — extend to
  also skip when value is `'system'`

Add a module-level constant:
```ts
const DEFAULT_PRESET_ID = 'system';
const DEFAULT_FONT_ID   = 'system';
```

Replace every `?? 'system'` hardcoded string with these constants.

### C2 — 8 install-level paths rewired

All callsites that read or write the 8 install-level keys must switch from `station_config_kv`
queries to `install_config_kv` queries. The query shape changes from:

```ts
// Before
query<{ value: string }>("SELECT value FROM station_config_kv WHERE key = 'plan_tier'")
execute("INSERT OR REPLACE INTO station_config_kv (key, value) VALUES ('plan_tier', ?)", [v])
```

to:

```ts
// After
query<{ value: string }>("SELECT value FROM install_config_kv WHERE key = 'plan_tier'")
execute("INSERT OR REPLACE INTO install_config_kv (key, value) VALUES ('plan_tier', ?)", [v])
```

Callsite inventory (from audit — file:line):

| Key | Callsite | Type |
|-----|----------|------|
| `active_station_id` | src/App.tsx:946 | WRITE |
| `dmca_acknowledged` | src/components/DMCANotice.tsx:11 | READ |
| `dmca_acknowledged` | src/components/DMCANotice.tsx:19 | WRITE |
| `first_run_complete` | electron/main.js:935 | READ |
| `first_run_complete` | electron/main.js:957 | WRITE |
| `first_run_complete` | src/App.tsx:507 | READ |
| `first_run_complete` | src/components/FirstRunWizard.tsx:156 | WRITE |
| `last_error` | src/components/HealthMonitor.tsx:26 | WRITE |
| `last_error` | src/components/HealthMonitor.tsx:194 | READ |
| `last_error` | src/components/HealthMonitor.tsx:313 | WRITE (DELETE) |
| `last_operator_id` | electron/main.js:962 | WRITE |
| `last_operator_id` | src/components/OnShiftScreen.tsx:87 | READ |
| `last_operator_id` | src/components/OnShiftScreen.tsx:235 | WRITE |
| `multistation_insert_audit_complete` | electron/main.js:3465 | READ |
| `plan_tier` | src/App.tsx:511 | READ |
| `plan_tier` | src/hooks/usePlan.tsx:65 | READ |
| `plan_tier` | src/components/SubscriptionPanel.tsx:63 | READ |
| `plan_tier` | src/components/SubscriptionPanel.tsx:107 | WRITE |
| `plan_tier` | src/components/SubscriptionPanel.tsx:122 | WRITE |
| `tour_done_version` | src/components/OnboardingTour.tsx:225 | WRITE |
| `tour_done_version` | src/components/OnboardingTour.tsx:407 | READ |
| `tour_done_version` | src/components/OnboardingTour.tsx:423 | WRITE |

**Note on `multistation_insert_audit_complete`**: The WRITE for this key is in
`scripts/flip-safety-gate.js` (intentionally a manual admin script, not app code). Update that
script independently to write to `install_config_kv` instead.

**Note on `active_station_id`**: The audit found zero READ callsites in src/ or electron/ (see
Bucket C in audit). The WRITE at App.tsx:946 should also be rewired to `install_config_kv`. The
diagnostic scripts in scripts/ that read this key (delete-station-2.js, force-switch-to-ov.js,
diag-stations.js) must also be updated.

### C3 — 2 secrets paths rewired

Switch `license_key` and `cloud_backup_r2` callsites from `station_config_kv` to
`install_secrets_kv`:

| Key | Callsite | Type |
|-----|----------|------|
| `license_key` | src/components/CloudBackup.tsx:134 | READ (bulk SELECT) |
| `license_key` | src/components/SubscriptionPanel.tsx:108 | WRITE |
| `license_key` | src/components/SubscriptionPanel.tsx:123 | WRITE (DELETE) |
| `cloud_backup_r2` | electron/cloud-backup.js:51 | READ |
| `cloud_backup_r2` | electron/cloud-backup.js:335 | WRITE |

**CloudBackup.tsx:134** uses a bulk `WHERE key IN (...)` that includes both `license_key` and
`station_name`. After this change, `license_key` comes from `install_secrets_kv` and `station_name`
still comes from `station_config_kv`. The bulk query must be split into two separate queries.

### C4 — 25 renderer INSERT paths get `crypto.randomUUID()` (Prerequisite 2A)

Every renderer INSERT into a station-scoped table that has a `uuid` column must pass
`crypto.randomUUID()` as the uuid value. Without this, rows written from the renderer have
`uuid = NULL` and cannot sync.

The 25 callsites correspond to the subset of the Phase 3 checklist (main.js:5–51) that target
tables with `uuid` columns in the synced-tables.js registry. For each:

```ts
// Before
execute("INSERT INTO songs (title, artist_id, station_id) VALUES (?, ?, ?)", [t, a, sid])

// After
execute("INSERT INTO songs (uuid, title, artist_id, station_id) VALUES (?, ?, ?, ?)",
  [crypto.randomUUID(), t, a, sid])
```

If `window.crypto.randomUUID` is not available in the renderer context (older Electron), use:
```ts
const uuid = () => (window.crypto?.randomUUID?.() ?? require('crypto').randomUUID());
```

Tables affected (subset of Phase 3 list — confirm uuid column presence against registry before
each update): categories, songs, artists, clock_slots, shows, clocks, voice_tracks, spots,
cart_slots, announcements, macros, liner_cards, prep_notes, format_clocks, published_episodes.

### C5 — `install_config_kv` typed handler

New file: `electron/sync/handlers/install-config-kv.js`

Registers channels:
- `install-config-kv:get` — returns value for a key
- `install-config-kv:set` — INSERT OR REPLACE
- `install-config-kv:delete` — DELETE by key
- `install-config-kv:get-all` — returns all rows as `{ key, value }[]`

No `station_id` parameter anywhere. Does not use `withMutation` (install-scoped tables do not sync
station-specific mutations).

### C6 — `install_secrets_kv` typed handler

New file: `electron/sync/handlers/install-secrets-kv.js`

Same channel shape as C5 with `install-secrets-kv:*` prefix. Additional constraint: this handler
must never appear in any sync payload builder or `buildWirePayload()` call. Mark the table as
`syncExcluded: true` in the registry (S8) and add a guard in the mutation writer.

### C7 — `monitor_routing` typed handler

New file: `electron/sync/handlers/monitor-routing.js`

Standard station-scoped typed handler (code-generated pattern):
- `monitor-routing:list` — by station_id
- `monitor-routing:get-by-id`
- `monitor-routing:create` — uses `withMutation`
- `monitor-routing:update` — uses `withMutation`
- `monitor-routing:delete` — soft-delete (`deleted_at`)

### C8 — Handler registration

In `electron/sync/handlers/index.js`, add:

```js
const installInstallConfigKv  = require('./install-config-kv');
const installInstallSecretsKv = require('./install-secrets-kv');
const installMonitorRouting   = require('./monitor-routing');

function installAll(ipcMain, db) {
  // ... existing installs ...
  installInstallConfigKv(ipcMain, db);
  installInstallSecretsKv(ipcMain, db);
  installMonitorRouting(ipcMain, db);
}
```

These three are **added to `installAll`**, unlike the typed stations handler (which is deferred per
Amendment 1). These are new tables with no legacy handlers to conflict with.

### C9 — Preload exposure

In `electron/preload-handlers.js`, expose the three new handler sets on `window.ether`:

```js
installConfigKv: {
  get:    (key)        => ipcRenderer.invoke('install-config-kv:get', { key }),
  set:    (key, value) => ipcRenderer.invoke('install-config-kv:set', { key, value }),
  delete: (key)        => ipcRenderer.invoke('install-config-kv:delete', { key }),
  getAll: ()           => ipcRenderer.invoke('install-config-kv:get-all'),
},
installSecretsKv: {
  get:    (key)        => ipcRenderer.invoke('install-secrets-kv:get', { key }),
  set:    (key, value) => ipcRenderer.invoke('install-secrets-kv:set', { key, value }),
  delete: (key)        => ipcRenderer.invoke('install-secrets-kv:delete', { key }),
},
monitorRouting: {
  list:     (stationId)      => ipcRenderer.invoke('monitor-routing:list', { stationId }),
  create:   (stationId, row) => ipcRenderer.invoke('monitor-routing:create', { stationId, ...row }),
  update:   (id, row)        => ipcRenderer.invoke('monitor-routing:update', { id, ...row }),
  delete:   (id)             => ipcRenderer.invoke('monitor-routing:delete', { id }),
},
```

---

## 5-Commit Sequencing

The migration is split into 5 commits to keep each reviewable and to allow rollback at any boundary.

### Commit 1 — Schema + registry

**Contents**: S1–S8 in `setupDb()` (column additions, new table creates, KV table recreation) +
synced-tables.js registry additions + schema_version bump.  
**Does not run** M1–M8 yet (data migration is separate).  
**Verification**: App boots; existing data intact; new tables exist and are empty; no DEFAULT 0 on
`station_config_kv.station_id`.

### Commit 2 — Data migration

**Contents**: `migrateV8Data()` function with M1–M8 inside a single transaction. Called from
`setupDb()` after schema changes.  
**Idempotent**: Each step checks whether the work is already done (e.g., M1 uses `INSERT OR IGNORE`;
M3/M4 DELETE are no-ops if already run; M5/M8 UUID backfill is no-op on non-null rows).  
**Verification**: `SELECT * FROM install_config_kv` returns 8 rows; `SELECT * FROM install_secrets_kv`
returns 2 rows; no `station_id=0` rows remain in `station_config_kv` for moved keys; mounts are
distinct.

### Commit 3 — Code rewires

**Contents**: C1–C4 (callsite rewires + uuid additions). All renderer and main-process callsites
updated. No new handler files yet — callsites use raw `execute/query` with new table names for now.  
**Verification**: App runs; license activation, DMCA ack, first-run, plan tier, tour, operator
selection all work end-to-end. CloudBackup reads license from install_secrets_kv. No regression
in existing single-station workflow.

### Commit 4 — New typed handlers + preload

**Contents**: C5–C9. Three new handler files, registration in index.js, preload exposure.  
**Converts** the raw SQL queries from Commit 3 to use the typed handler methods where appropriate
(optional in first pass — raw SQL works; typed handlers are the clean architecture).  
**Verification**: `window.ether.installConfigKv.getAll()` returns expected rows from devtools console.
`window.ether.installSecretsKv.get('license_key')` returns the license key value.

### Commit 5 — Verification + gate lift

**Contents**: Post-migration verification script (`scripts/verify-v8-migration.js`) output captured
in git. Update `multistation_insert_audit_complete` in `install_config_kv` to `'true'` via updated
`flip-safety-gate.js`. Remove or soften the `stations:create` gate check per Step 0-C.  
**This is the commit that lifts the second-station creation gate.**  
**Verification**: `stations:create` succeeds for a test second station. All seven Phase A success
criteria hold.

---

## Open Items Carried Forward (8)

These are not blockers for this migration but must not be lost. Captured here as a forward pointer.

### 1 — `canvas_active_name` cold-start read

**Finding**: Three WRITE callsites in `CanvasEngine.tsx` (lines 230, 241, 256); zero READ callsites
anywhere. Written on every profile activation but never read back. Cold-start init reads
`canvas_profiles` (the full JSON blob) but does not use `canvas_active_name` to restore the
last-active profile.  
**Risk**: If the intent is to restore the last-active profile on startup, the read is missing.  
**Action**: Add a READ in `CanvasEngine.init()` that uses `canvas_active_name` to pre-select the
correct profile, or explicitly document that active profile is always derived from `canvas_profiles`
and remove the writes.

### 2 — `station_tagline` display consumer

**Finding**: One WRITE in `FirstRunWizard.tsx:153`; zero reads anywhere. The tagline is collected
during first-run setup but never displayed.  
**Risk**: User enters a tagline that is silently ignored. Wasted onboarding friction.  
**Action**: Wire to at least one display surface (welcome screen subtext, podcast RSS feed, stream
metadata). Or remove the first-run field if no consumer is planned.

### 3 — `experience_mode` half-deprecation

**Finding**: App.tsx:517 comment says the key is "now ignored" for deck visibility (deck visibility
is driven by Configure Decks). However, `SettingsPanel.tsx` still shows an Experience Mode selector
that reads and writes the key; `OnShiftScreen.tsx` reads it.  
**Risk**: User changes experience mode in Settings; nothing happens. Silent no-op creates confusion.  
**Action**: Either fully deprecate (remove Settings UI, remove DB key) or fully re-implement (wire
deck visibility back to the key per the Part 1 spec in the 9-part feature prompt).

### 4, 5, 6 — 3 duplicate-write-path consolidations

Three keys have independent write paths in multiple components that can drift out of sync:

- **`station_logo`**: Written in both `SettingsPanel.tsx` (lines 181, 191) and `SkinPicker.tsx`
  (lines 700, 709). Two independent upload/remove UI surfaces writing the same key.
- **`cloud_backup_config`**: Written in `cloud-backup.js:137` (save path) and `:324` (trigger path).
  Two paths that write different shapes of config to the same key.
- **`station_name`**: Written in `FirstRunWizard.tsx:152` (first-run) and `SettingsPanel.tsx:982`
  (settings edit). Low risk — these are clearly different lifecycle points — but the reads are
  scattered across 8 callsites. A central hook would reduce drift.

**Action**: For each: consolidate to a single write path or document why multiple paths are
intentional.

### 7 — 5 Bucket D `withMutation` migrations

Five existing station-scoped write callsites in the legacy `stations:*` handler set do not use
`withMutation`. These rows are written correctly (with `station_id`) but never enter the `mutations`
log, so peers never sync them.  
**Action**: After Phase A ships, audit the legacy `stations:*` handler for the 5 writes, wrap each
in `withMutation`, and confirm with the peer sync team that these mutations should appear in the
sync stream. This is part of the broader typed stations migration (Phase B).

### 8 — Typed `stations:*` handler migration + missing `stream_sessions` / `broadcast_segments`

**Typed stations migration**: Deferred per Amendment 1. See `phase-a-amendment-1.md` for full
scope. Create a "Phase B" planning document after Phase A ships.

**Missing tables**: `stream_sessions` and `broadcast_segments` are referenced in Phase A success
criteria (item 5: "stream_sessions writes carry correct station_id") but neither table appears in
`001_initial.sql` or `setupDb()`. Verify whether these tables exist in the live DB via migration
history, or add CREATE IF NOT EXISTS statements for them before Phase A verification.

---

## Verification Checklist

Run after all 5 commits land:

```sql
-- 1. All 8 install-level keys present in install_config_kv
SELECT key FROM install_config_kv ORDER BY key;
-- Expected: active_station_id, dmca_acknowledged, first_run_complete, last_error,
--           last_operator_id, multistation_insert_audit_complete, plan_tier, tour_done_version

-- 2. Both secret keys present in install_secrets_kv
SELECT key FROM install_secrets_kv ORDER BY key;
-- Expected: cloud_backup_r2, license_key

-- 3. No station_id=0 rows remain in station_config_kv for moved keys
SELECT key FROM station_config_kv WHERE station_id = 0
AND key IN (
  'active_station_id','dmca_acknowledged','first_run_complete','last_error',
  'last_operator_id','multistation_insert_audit_complete','plan_tier','tour_done_version',
  'license_key','cloud_backup_r2'
);
-- Expected: 0 rows

-- 4. No DEFAULT 0 on station_config_kv (check DDL)
SELECT sql FROM sqlite_master WHERE name = 'station_config_kv';
-- Expected: CREATE TABLE station_config_kv (station_id INTEGER NOT NULL, ...) — no DEFAULT

-- 5. No uuid=NULL in station_config_kv
SELECT COUNT(*) FROM station_config_kv WHERE uuid IS NULL;
-- Expected: 0

-- 6. Distinct icecast mounts
SELECT id, name, icecast_mount FROM stations ORDER BY id;
-- Expected: /live-1 and /live-3 (or whatever was agreed with Lightsail operator)

-- 7. New tables exist
SELECT name FROM sqlite_master WHERE type='table'
AND name IN ('install_config_kv','install_secrets_kv','monitor_routing');
-- Expected: 3 rows

-- 8. New columns on stations
PRAGMA table_info(stations);
-- Expected: icecast_port, audio_device_output, mic_device present
```
