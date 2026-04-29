# Phase A — Multi-Engine + Per-Station Streaming Execution Plan

> **Goal**: Enable two radio stations to broadcast simultaneously from a single Ether instance, each with an independent audio engine, independent stream, and independent Icecast mount.  
> **Feeds into**: `multi-station-broadcast-architecture.md` (b6a9cd0)  
> **Audit basis**: `phase-a-discovery-audit.md` (this commit)  
> **Date**: 2026-04-29

---

## Locked Architectural Decisions

| ID | Decision |
|---|---|
| AD-1 | **JS-layer engine map, not Rust parameterization.** The native addon stays singleton. A `Map<stationId, EngineHandle>` in `electron/main.js` manages per-station audio state. Rust is called once per station but the addon itself is not multi-tenanted at the NAPI layer. |
| AD-2 | **One ffmpeg process per station.** The streaming section in `main.js` replaces the module-level `_currentFilePath` / `_liveIcecastUrl` variables with a `Map<stationId, StreamState>` struct. Each station gets its own ffmpeg child process and its own Icecast mount. |
| AD-3 | **Unique Icecast mounts required before Phase A work begins (Step 0).** Both existing stations must have distinct `icecast_mount` values. This is a DB UPDATE, not a schema change. |
| AD-4 | **Legacy `stations:*` handlers in main.js are removed, not shimmed.** The typed handler in `electron/sync/handlers/stations.js` becomes the sole owner of all `stations:*` channels. The legacy `stations:get-active` channel is replaced by `stations:get-by-id` (typed handler) plus a renderer-side cache in `useActiveStation`. |
| AD-5 | **Station switch does not stop the active audio engine.** `handleStationSwitch` in `App.tsx` switches the renderer's active station context; it does not call `engine.stop()` on any deck. Each station's engine runs independently. |
| AD-6 | **`station_config_kv` is the per-station engine config store.** Keys like `active_deck`, `stream_enabled`, `monitor_mix` are written per station. `stationScoped.ts` query helpers handle injection. |
| AD-7 | **INSERT audit gate (`multistation_insert_audit_complete`) is lifted only after all 40+ callsites in main.js are verified.** The gate is intentional. Lifting it prematurely risks orphaned rows with wrong station_id. |
| AD-8 | **Direction C library architecture is preserved.** songs/artists/albums remain install-scoped. `station_programming` remains the per-station attribute table. No new `station_id` columns are added to install-scoped tables. |
| AD-9 | **Peer sync is station-scoped throughout.** All Phase A writes that need to sync go through `withMutation` with correct `station_id`. Engine-local transient state (deck position, VU levels, peak meters) is never written to the mutations log. |
| AD-10 | **v8 migration (songs.station_id removal) is deferred.** It is non-blocking for Phase A. Create after Direction C is validated in production. |

---

## Step 0 — Prerequisites (ship as separate commits before main work)

Three blockers must be resolved before any Phase A implementation begins. Each ships as its own commit.

### Step 0-A: Resolve duplicate `stations:*` handler registration

**Problem**: `electron/sync/handlers/stations.js` and the legacy block in `main.js` (lines 3445–3503) both register `stations:list`, `stations:create`, `stations:update`, `stations:delete`. The second registration throws at startup.

**Action**:
1. Delete the six legacy `ipcMain.handle("stations:*", ...)` blocks from `main.js`
2. Verify `installAll()` in `handlers/index.js` calls `installStations` (it does — confirmed in audit)
3. Update `preload.js` to route `stations.*` calls through `window.ether` typed handler bindings rather than direct `ipcRenderer.invoke`
4. The legacy `stations:get-active` channel has no typed equivalent — add `stations:get-active` to the typed handler as an alias, or update all renderer callsites to use `stations:get-by-id`

**Verification**: Boot app, open DevTools console, confirm no `ipcMain handler already exists` errors. Run `ether.stations.list()` from console — should return station rows.

### Step 0-B: Assign unique Icecast mounts to all stations

**Problem**: Both stations have `icecast_mount="/live"`. Simultaneous streaming is impossible.

**Action**: Run migration or one-time DB script:
```sql
UPDATE stations SET icecast_mount = '/live-1' WHERE id = 1;
UPDATE stations SET icecast_mount = '/live-3' WHERE id = 3;
```
Wrap in `withMutation` with `station_id` per row so the change is logged and syncs to peers.

Confirm with Lightsail Icecast operator that both `/live-1` and `/live-3` mounts exist and are configured for the expected bitrate/format.

**Verification**: `SELECT id, name, icecast_mount FROM stations;` — mounts are distinct.

### Step 0-C: Complete Phase 3 INSERT audit (lift gate)

**Problem**: `stations:create` blocks second station creation until `multistation_insert_audit_complete='true'`. 40+ `db.prepare("INSERT INTO ...").run(...)` callsites in `main.js` lack `station_id`.

**Action**:
1. Work through the callsite list at the top of `main.js`
2. For each callsite: determine if the target table is station-scoped (check REGISTRY); if yes, ensure `station_id` is in the INSERT
3. After all callsites are verified: `INSERT OR REPLACE INTO station_config_kv (key, value, station_id) VALUES ('multistation_insert_audit_complete', 'true', <id>)` for each station
4. Remove or soften the gate check in `stations:create` handler

**Verification**: `stations:create` succeeds for a third test station without the gate error.

---

## Step 1 — JS-Layer Engine Map

**Goal**: Replace the single implicit engine with a `Map<stationId, EngineHandle>` in `main.js`.

**Design**:
```js
// electron/main.js
const _engines = new Map(); // stationId -> { audio handle, deck state }

function getEngine(stationId) {
  if (!_engines.has(stationId)) {
    _engines.set(stationId, initStationEngine(stationId));
  }
  return _engines.get(stationId);
}
```

**`initStationEngine(stationId)`** calls the existing `audio.initAudioEngine()` (or a new per-station variant if the native addon is extended) and returns a handle object with deck references.

**Impact on boot**: The eager `audio.initAudioEngine()` call at boot (lines 91–116) initializes station 1's engine. Station N's engine is initialized on first `stations:switch` or on explicit `engine:init` IPC call.

**Discovery tasks**:
- Determine if `audio.initAudioEngine()` can be called more than once safely (check native/src/lib.rs `OnceLock` behavior)
- If not: the JS layer must manage per-station state above the single native instance; native stays singleton but JS tracks which station owns the output

**Verification**: Two station engines initialized; `_engines.size === 2`; neither step on each other's deck state.

---

## Step 2 — Per-Station Stream State Map

**Goal**: Replace module-level `_currentFilePath` / `_liveIcecastUrl` with a `Map<stationId, StreamState>`.

**Design**:
```js
// StreamState shape
{
  filePath: string | null,
  icecastUrl: string,
  mount: string,
  ffmpegProcess: ChildProcess | null,
  isLive: boolean,
}
```

**Actions**:
1. Audit the streaming section (~lines 3345–3443) — identify every read/write of `_currentFilePath` and `_liveIcecastUrl`
2. Replace with `_streams.get(stationId).*`
3. All streaming IPC handlers (`stream:start`, `stream:stop`, `stream:status`) accept `stationId` in payload
4. ffmpeg spawn command reads `icecast_mount` from the DB row for the given `stationId`

**Verification**: Start stream for station 1 (`/live-1`), start stream for station 3 (`/live-3`), confirm two ffmpeg processes running, both mounts active on Icecast.

---

## Step 3 — Renderer: Per-Station Engine Context

**Goal**: `App.tsx` `handleStationSwitch` switches active station context without stopping decks.

**Current behavior** (App.tsx ~line 938):
```ts
engine.getDeck("A")?.stop();
engine.getDeck("B")?.stop();
engine.getDeck("C")?.stop();
engine.clearQueue();
```

**Target behavior**: Station switch is a renderer-side context change. The active station's decks remain running. The UI re-renders to show the newly selected station's queue, play log, and metadata.

**Actions**:
1. Remove the `stop()` calls from `handleStationSwitch`
2. `useActiveStation` already pub/subs the `station-switched` event — no change needed to the hook
3. Components that bind to deck state must filter by active station (already done via `getActiveStationIdSync()` in most components)
4. Add a station indicator to the main header so the operator always knows which station they are viewing

**Verification**: Play a track on station 1; switch to station 3 in the UI; confirm station 1 continues playing; confirm UI shows station 3's queue without interrupting audio.

---

## Step 4 — IPC Surface Cleanup and Extension

**Goal**: All station-related IPC routes through typed handlers. No legacy `ipcMain.handle` for station channels.

**Builds on Step 0-A.**

**Additional IPC handlers needed for Phase A**:

| Channel | Direction | Purpose |
|---|---|---|
| `engine:init` | renderer → main | Explicitly initialize engine for a station |
| `engine:deck-state` | renderer → main | Query deck state for a specific station |
| `stream:start` | renderer → main | Start ffmpeg stream for a station (payload: `{ stationId }`) |
| `stream:stop` | renderer → main | Stop ffmpeg stream for a station |
| `stream:status` | renderer → main | Current stream state for a station |
| `engine:station-switched` | renderer → main | Notify main of active station change |

Add to `electron/sync/handlers/` as `engine.js` and extend `index.js` `installAll`. Expose via `preload-handlers.js` typed bindings. Do not add new legacy handlers.

---

## Step 5 — Native Addon Assessment and Isolation

**Goal**: Determine whether the native addon's `OnceLock<GlobalState>` singleton blocks true per-station audio isolation, and if so, implement the JS-layer workaround.

**Discovery question**: Can `audio.initAudioEngine()` be called multiple times? If the `OnceLock` is already set, it returns the existing handle — no panic, but also no new instance. This means the Rust layer is permanently singleton.

**Likely outcome (JS-layer isolation)**:
- Native addon stays singleton — one Rodio audio thread, one set of physical decks
- JS layer maintains per-station *metadata and queue state* in `_engines` map
- Physical deck output is shared hardware; "per-station" means per-station queue management and metadata, not per-station audio device
- For a two-station facility sharing one physical output: this is acceptable. Each station's automation runs its own queue; the on-air station "owns" the physical output; station switch = ownership transfer

**If per-station physical output is required** (separate sound cards or CPAL devices per station):
- Extend `audio.rs` `AudioRouter` / `DeckRouting` to accept a CPAL device index per deck
- Add `#[napi] fn set_deck_device(deck: String, device_index: u32)` to `lib.rs`
- Wire through IPC so each station can be assigned a device

**Verification**: Document which isolation model is implemented; confirm with operator which physical output configuration is deployed.

---

## Step 6 — `station_config_kv` Engine State

**Goal**: Persist per-station engine configuration through `station_config_kv` using the existing typed handler.

**Keys to add**:

| Key | Value type | Purpose |
|---|---|---|
| `stream_enabled` | `'true'/'false'` | Whether this station's stream should auto-start on boot |
| `monitor_mix_level` | float string | Studio monitor output level for this station |
| `active_on_boot` | `'true'/'false'` | Whether this station's engine initializes at boot |

Read at boot via `stationConfigKv.get(stationId, key)`. Write via `stationConfigKv.upsert(stationId, key, value)` — already wired through `withMutation`.

---

## Step 7 — Integration Verification

Full end-to-end test across both stations.

**Checklist**:
- [ ] Both stations in DB with distinct `icecast_mount` values
- [ ] No duplicate handler registration errors at boot
- [ ] `ether.stations.list()` returns both stations
- [ ] Station 1 engine initializes at boot; station 3 engine initializes on first switch
- [ ] Deck play on station 1 does not affect station 3 queue
- [ ] Stream start for station 1 spawns ffmpeg to `/live-1`; stream start for station 3 spawns ffmpeg to `/live-3`
- [ ] Two ffmpeg processes visible in process list while both streams are live
- [ ] Switching active station in UI does not stop either stream
- [ ] Switching active station in UI does not stop decks
- [ ] `play_log` writes carry correct `station_id` for each station
- [ ] `mutations` table entries carry correct `station_id` for station-scoped writes
- [ ] Peer sync (if enabled) replicates station-scoped rows only to appropriate station peers

---

## Execution Order

```
Step 0-A (duplicate handlers)
Step 0-B (unique mounts)       } ship as separate commits, in any order
Step 0-C (INSERT audit gate)   }

Step 1 (engine map)
Step 2 (stream state map)      } can overlap; both touch main.js
Step 3 (renderer switch)

Step 4 (IPC surface)           } depends on Step 0-A
Step 5 (native assessment)     } informs Step 1 design; do before Step 1 is finalized

Step 6 (kv engine state)       } depends on Step 1

Step 7 (integration test)      } final; depends on all above
```

---

## Files Expected to Change

| File | Steps | Nature of change |
|---|---|---|
| `electron/main.js` | 0-A, 1, 2, 0-C | Remove legacy handlers; add engine map; add stream state map; audit INSERT callsites |
| `electron/preload.js` | 0-A, 4 | Route stations.* through typed handler bindings |
| `electron/preload-handlers.js` | 4 | Add engine.* handler bindings |
| `electron/sync/handlers/stations.js` | 0-A | Add `stations:get-active` alias if needed |
| `electron/sync/handlers/engine.js` | 4 | New: engine IPC typed handlers |
| `electron/sync/handlers/index.js` | 4 | Add installEngine call |
| `native/src/lib.rs` | 5 | Add per-device deck functions if physical isolation required |
| `native/src/audio.rs` | 5 | Add device parameterization if required |
| `src/App.tsx` | 3 | Remove stop() calls from handleStationSwitch |
| `src/hooks/useActiveStation.tsx` | 3 | Minor: confirm no stop side-effects |
| DB (stations rows) | 0-B | UPDATE icecast_mount to unique values |
| DB (station_config_kv) | 0-C | Set multistation_insert_audit_complete after gate lifted |
