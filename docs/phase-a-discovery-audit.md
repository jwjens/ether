# Phase A — Multi-Station Infrastructure Audit

> **Status**: Read-only discovery. No edits made.  
> **Purpose**: Surface every piece of multi-station infrastructure already built in Ether so the Phase A plan can be reconciled with it. Phase A must not contradict, duplicate, or roll back existing work.  
> **Date**: 2026-04-29  
> **Base commit**: b7e56d2 (Phase 4 Tauri terminology cleanup)

---

## Area 1 — Sync Scope Registry (`electron/sync/synced-tables.js`)

34 REGISTRY entries total.

**Install-scoped (4)** — shared across all stations; no `station_id` in sync payload:

| Table | Notes |
|---|---|
| albums | facility library |
| artists | facility library |
| mood_tags | facility library |
| songs | `station_id: 'scalar'` physically present in DB but `scope='install'` — column removal deferred to v8 migration |

**Station-scoped (30)** — every sync payload carries `station_id`.

Notable special cases:
- `stations.icecast_password` → `'local-only'` — excluded from all sync payloads per [Q-13]; never leaves the device
- `station_programming` — hand-written handler (not code-generated); always filters by `station_id`; this is the Direction C table carrying per-song/per-station attributes

**Phase A impact**: The scope boundary is already correct. Songs, artists, albums are facility-wide. Station-specific content goes through station-scoped tables. No schema changes needed beyond the deferred songs.station_id v8 removal.

---

## Area 2 — Typed IPC Handler Pattern (`electron/sync/handlers/`)

36 handler files. Pattern is code-generated for most tables; hand-written for `stations.js` and `station_programming.js`.

Each typed handler exports `install(ipcMain, db)` and registers channels in the form `<table>:list | :get-by-id | :create | :update | :delete`.

`electron/sync/handlers/index.js` exports `installAll(ipcMain, db)` which calls all 31 typed sets. Called from `main.js` at startup.

`preload-handlers.js` exposes typed handlers on `window.ether.*` with station-scoped signatures — e.g. `stationProgramming.list(stationId, filters)` passes `stationId` as first positional arg.

**Phase A impact**: Typed handler infrastructure is the correct write path. Any new multi-station IPC work should extend this pattern, not add more legacy handlers.

---

## Area 3 — Mutation Writer (`electron/sync/mutation-writer.js`)

8 exports. Core API:

```js
withMutation(db, opts, fn)
// opts = { table, station_id, op, row_id, payload, client_id, hlc }
// fn   = () => your better-sqlite3 write
// Returns db.transaction(() => { result = fn(); logMutation(db, opts); return result; })()
```

`logMutation` writes to `mutations` table (17 fields). `station_id` is required in `opts` — but `null` is legal for install-scoped tables (albums, artists, songs, mood_tags).

HLC timestamps are Hybrid Logical Clock: `wall_ms:logical:client_id`. `advanceHlc()` is called before each mutation log entry.

`buildWirePayload(row)` strips `applied_at`, `origin`, `sync_status` — 14-field wire format for peer sync.

**Phase A impact**: Any engine-state writes that need to sync across peers must go through `withMutation`. Engine-local state (current deck position, VU levels) does not.

---

## Area 4 — Station-Scoped DB Tables

**Direction C** is confirmed: songs/artists/albums are install-scoped (facility library); `station_programming` carries the per-song/per-station attributes (cart order, jingle type, rotation weight, etc.).

All 30 station-scoped REGISTRY entries have `station_id` columns. Key tables for Phase A:

| Table | Phase A relevance |
|---|---|
| `stream_sessions` | per-station stream history |
| `station_config_kv` | per-station config; holds `multistation_insert_audit_complete` gate |
| `station_programming` | per-station song schedule/rotation |
| `voice_tracks` | per-station voice track library |
| `play_log` | per-station play history |
| `cart_slots` | per-station cart wall |
| `broadcast_segments` | per-station show segments |

**`songs.station_id`**: Physical column still exists (v7 did not drop it). REGISTRY says `scope='install'`. Ignore in query logic; v8 migration will drop the column.

**`src/db/stationScoped.ts`** provides:
```ts
queryScoped<T>(db, sql, params, stationId)    // injects WHERE station_id = ?
executeScopedInsert(db, table, row, stationId) // injects station_id column
```
Pass `skipScoping: true` for cross-station queries (e.g. admin views showing all stations).

---

## Area 5 — Station IPC Surface (CRITICAL CONFLICTS)

### Conflict 1 — Duplicate `stations:*` handler registration

**Legacy handlers in `main.js` (lines 3445–3503):**
```
ipcMain.handle("stations:list", ...)
ipcMain.handle("stations:get-active", ...)
ipcMain.handle("stations:switch", ...)
ipcMain.handle("stations:create", ...)   // has safety gate
ipcMain.handle("stations:update", ...)
ipcMain.handle("stations:delete", ...)
```

**Typed handlers in `electron/sync/handlers/stations.js`** (installed via `installAll()`):
```
stations:list
stations:get-by-id
stations:create
stations:update
stations:delete
```

`installAll()` is called from `main.js`. Both sets attempt to register the same channel names on `ipcMain`. **Whichever registers second will throw** (`Error: An ipcMain handler already exists for 'stations:list'`).

The legacy `:get-active` and typed `:get-by-id` differ in name — these are separate channels and do not collide, but they represent the same logical operation with divergent naming.

### Conflict 2 — Both stations share mount `/live`

From DB state as of audit:
- Station 1 ("Opportunity Village"): `icecast_mount="/live"`, `icecast_server_url="127.0.0.1"`
- Station 3 ("US Phenomenon"): `icecast_mount="/live"`, `icecast_server_url="127.0.0.1"`

Simultaneous streaming is impossible until each station has a unique mount point.

### Conflict 3 — Phase 3 INSERT audit gate

`stations:create` legacy handler (main.js ~3480) blocks second station creation until `station_config_kv` has `multistation_insert_audit_complete='true'`. This gate was added intentionally — 40+ INSERT callsites in `main.js` that lack `station_id` were flagged as requiring audit. The gate must not be removed until those callsites are reviewed and corrected.

### Current preload.js station surface:
```js
station:  { uploadLogo }                          // legacy; station:uploadLogo channel
stations: { list, getActive, switch, create, update, delete }  // legacy direct
stationProgramming:  handlers.stationProgramming  // typed
stationConfigKv:     handlers.stationConfigKv     // typed
```

---

## Area 6 — Renderer Station-Aware Components

51 files reference station concepts.

**Hooks (station-aware foundation):**
- `src/hooks/useActiveStation.tsx` — module-level pub/sub cache; fires on `station-switched` CustomEvent dispatched by renderer; exports `getActiveStationIdSync()` for synchronous reads; `useActiveStation()` for reactive reads
- `src/db/stationScoped.ts` — query helpers (see Area 4)

**Components already station-scoped:**
- `PhoneDesk.tsx`, `PodcastStudio.tsx`, `PublishEpisode.tsx` — call `getActiveStationIdSync()` or `useActiveStation()` in IPC calls
- `HealthMonitor.tsx` — reads active station for play log queries
- `StationManager.tsx` — station switching UI; calls `ether.stations.*`
- `Scheduler.tsx`, `BroadcastEditor.tsx` — pass `stationId` to station_programming queries

**Components needing Phase A wiring:**
- `src/audio/engine.ts` — currently singleton; no station parameter on any method
- `App.tsx` `handleStationSwitch` (line ~938) — stops all decks on switch; must change to per-station engine isolation so switching does not interrupt the other station's playback

---

## Area 7 — Schema Migration History

| Version | File | Key changes | Multi-station impact |
|---|---|---|---|
| v1 | `migrate-v1.js` | Initial schema | — |
| v2 | `migrate-v2.js` | `stations` table created | Foundation |
| v3 | `migrate-v3.js` | `station_programming` created | Core Direction C table |
| v4 | `migrate-v4.js` | `station_config_kv` created | Per-station config store |
| v5 | `migrate-v5.js` | `mutations`, `sync_peers` sync infrastructure | Peer sync foundation |
| v6 | `migrate-v6.js` | `stream_sessions`; station-scoped stream history | Streaming |
| v7 | `migrate-v7.js` | KV-table schema updates; typed handler unification | Phase 3 |
| non-versioned | `migrate-kv-phase3c.js` | KV upsertByKey/removeByKey migration | Phase 3.5 |

Currently applied: v1–v7 + kv-phase3c.

**v8 (not yet created):** Designated for `songs.station_id` column removal. Non-blocking; create after Direction C is validated in production.

---

## Blocker Summary

| # | Issue | Severity | Resolution |
|---|---|---|---|
| B-1 | Duplicate `stations:*` handlers | **Blocker** | Remove legacy handlers from main.js; route through typed handlers/stations.js |
| B-2 | Both stations share mount `/live` | **Blocker** | UPDATE stations to unique mounts before simultaneous streaming |
| B-3 | Phase 3 INSERT audit gate | **Blocker** | Complete 40+ INSERT callsite audit before lifting gate; gate is intentional |
| B-4 | Singleton native engine | Core work | Parameterize #[napi] functions by station_id OR manage per-station engine instances in JS layer |
| B-5 | `handleStationSwitch` stops decks | Core work | Per-station audio context; station switch must not stop other station |
| B-6 | Single `_currentFilePath` in streaming | Core work | Replace with `Map<stationId, streamState>` in main.js streaming section |
| B-7 | `songs.station_id` column present | Deferred | v8 migration; non-blocking for Phase A |
