# Station-ID census — integer identity crossings (2026-07-07)

READ-ONLY facts. Receipts (file:line / commit) for every claim. Companion to
`vu-meter-station-scope-2026-07-07.md` (the bug that triggered this) and the redesign proposal
`station-identity-redesign-proposal-2026-07-07.md`.

**Headline:** the per-machine **integer** station id is the *sole* station identity on every audio
control/telemetry path (Rust NAPI, daemon, main↔renderer IPC). UUID exists everywhere in **persistence**
(SQLite dual-keyed; Postgres uuid-primary) and at exactly **one runtime choke point** (`cmd-routing.ts`),
but never on the audio channels. The stations table is the only place both keys are authoritative.

---

## 1. Rust NAPI engine — integer to the metal
- `native/src/lib.rs:16-19` — `static ENGINES: Mutex<HashMap<u32, SharedAudioState>>`. **Engines keyed by `u32`.**
- `native/src/lib.rs:23` — `fn get_or_create_engine(station_id: u32, …)`; `map.insert(station_id, …)`.
- **All ~17 `#[napi]` fns take `station_id: Option<u32>`** and do `get_or_create_engine(station_id.unwrap_or(1), …)`: `init_audio_engine`, `audio_load`, `audio_play`, `audio_pause`, `audio_stop`, `audio_set_volume`, `audio_set_monitor_volume`, `audio_get_state`, `audio_get_levels`, `audio_get_spectrum`, `audio_set_broadcast_delay`, `audio_dump`, `audio_broadcast_delay_state`, `watchdog_set`, `audio_set_output_device`, `audio_get_program_bus_port`, `audio_set_eq` (lib.rs:75 etc.).
- **Zero UUID anywhere in Rust.** No translation layer — the JS integer directly indexes the HashMap.
- JS mirror: `src/audio/engine-registry.ts:7` — `Map<number, AudioEngine>`.
- **Classification:** (a) in-memory/ephemeral *keying*, but the integer crosses the **JS↔Rust language boundary** in-process on every call. The `unwrap_or(1)` default means a missing id silently becomes station 1 — a latent multi-station hazard.

## 2. ether-audiod (daemon) — integer maps + the broadcast loop
- `audiod/ether-audiod.js:46` `const stations = new Set()` (integer ids); `:50` `engines = new Map()`; `:89` `streams = new Map()` — all keyed by integer `stationId`.
- Command handlers (`:99-117`) all read `m.stationId` (integer) → pass to `A.audio*(…, m.stationId)`.
- **Broadcast loop `:193-198`** — `for (const sid of stations) broadcast({ event:"levels", stationId: sid, ...getLevels(sid) })`; deck snapshot for engineless stations same shape. Frames **are** integer-tagged.
- `audiod/engine.js:44` per-engine `this.stationId` (integer); `:186` emits `enginestate {stationId}`.
- Icecast: `audiod/accept-offair.js:75` / `ether-audiod.js:87` `startStream({ stationId: SID, config:{mount,…} })`.
- **Classification:** (c) crosses the **daemon↔main named-pipe process boundary**, integer-tagged.

## 3. electron/main.js — relays + handlers
- `audio:*` IPC handlers pass integer `stationId` straight through (`main.js:2651-2718`), e.g. `audio:getSpectrum` (`:2659`) → `audiodClient.cmd("getSpectrum",{stationId})`.
- **Levels relay drops the tag:** `:349` `const lv = { a,b,c }` (+master) → `:351` `sendToAllWindows("audio:levels", lv)`. ❌ (the VU bug).
- **Deck/queue relays keep the tag:** `:359-361` `{ stationId: m.stationId, … }`.
- Stream status: `:378` `destId: "icecast:"+m.stationId` (integer).
- Icecast per-station config on the integer stations row: `:886-888` `icecast_server_url` / `icecast_mount` / `icecast_password`.
- Watchdog: `--ether-watchdog` handoff is **process-level, no station id** (`:72`); silent-wedge liveness logs per-station by integer `sid` (`:336`).
- **Classification:** (c) crosses the **main↔renderer IPC boundary**.

## 4. preload.js — the exposed API
- `preload.js:6-24` every `ether.audio.*` takes/returns integer `stationId` (`load/play/pause/stop/setVolume/getState/getLevels/getSpectrum/…`).
- `:26` `onLevels` = global `ipcRenderer.on("audio:levels")`, **no station filter**; `:27` `offLevels`.
- Deck/queue: `onDeck/onQueue` carry `{stationId}` (integer) downstream.
- **Classification:** (c) the process-boundary API surface; integer is the contract.

## 5. Renderer — holders/passers of integer id
- `src/hooks/useActiveStation.tsx:17` `ActiveStation { id: number; … uuid: string }` — **both present**; `:81-82` `getActiveStationIdSync(): number → _cached?.id ?? 1`; `:115` `stationId = station?.id ?? 1`.
- `src/audio/AudioEngineContext.tsx:6` `createContext<number>(1)`.
- `src/audio/engine-rodio.ts:68` `stationId: number`; `:14-21` passes to every audio IPC; **filters daemon deck/queue by integer** `:173,191` `if (m.stationId !== this.stationId) return`.
- **The one uuid↔integer choke point:** `src/audio/cmd-routing.ts:57-63` `resolveCommandTarget(stationUuid, activeStationId, localStations) → match.id` (integer); source `App.tsx:1028` `SELECT id, uuid FROM stations`.
- `src/App.tsx:495` `{ stationId, stationUuid } = useActiveStation()`; `:1836` iterates `SELECT id, uuid, name FROM stations`; `:1850` `if (st.id === stationId)`.
- `src/db/stationScoped.ts:61,78` scoped queries keyed by integer `stationId`.
- Components taking integer `stationId`: `DeckConfigurator.tsx:47,54,65`, `OnAirDeck.tsx:36,87`, plus every `onLevels` consumer (`VUMeter.tsx:222`, `MasterOutput.tsx:63`, `ConsoleStrip.tsx:133`, `BroadcastMonitor.tsx:407`, `DeckConfigurator.tsx:490`).
- **Classification:** (a) in-memory, but feeds (c) IPC and (b) DB scoping. UUID is available alongside but unused on audio paths.

## 6. Persistence
### SQLite (local) — fully DUAL-KEYED
- `stations` (parent): `scripts/schema-v0-baseline.js:349-372` — `id INTEGER PRIMARY KEY AUTOINCREMENT`, `uuid TEXT`; no `station_id`.
- **All ~35 station-scoped tables carry BOTH `station_id INTEGER NOT NULL DEFAULT 1` AND `uuid TEXT`** (registry `electron/sync/synced-tables.js`): categories, clocks, clock_slots, shows, play_log, scheduled_log, spots, separation_rules, generated_schedule, deck_configs, station_config_kv (PK `(station_id,key)`), operators, macros, announcements, voice_tracks, smart_schedule_rules, + spot_categories (`migrate-spot-categories-phase-sync-24.js`), clock_breaks (`migrate-clock-breaks-phase-sync-26.js`).
- UUID columns were added by **`9bfafee`** ("sync-ready 1/7 — add uuid to all 27 scoped tables", `migrate-uuids-phase-sync-1.js`) and **`c0f3c6d`** ("Phase 3.5 — UUID injection + station_config_kv scoping", `main.js:937-997`).
- **What that covered vs not:** it added `uuid` *columns* to every scoped table (row identity for sync). It did **not** change **station scoping** — scoped queries still filter by integer `station_id` (`stationScoped.ts:61,78`). So the row-uuid work is done; the *station-key* is still integer in every query.
- Install-scoped (no station_id, have uuid): songs, artists, albums, install_config_kv, install_secrets_kv, mood_tags.
- **Classification:** (b) persisted locally; (d) syncs to cloud — but dual-keyed, so uuid is available for cross-machine.

### Postgres (backend) — uuid-primary already
- `ether-backend/src/index.js:429-440` `stations (id SERIAL PK, uuid TEXT NOT NULL UNIQUE, …)`.
- `:455-466` `station_now_playing (station_uuid TEXT PRIMARY KEY REFERENCES stations(uuid))`; `:492-504` `station_metadata` same. **uuid-only keys.**
- `play_log` / `generated_schedule`: local-only (Postgres has no receiving side).
- **Classification:** (d) cross-machine; already uuid-keyed.

## 7. Iris / config surfaces
- **Iris:** cloud now-playing POST uses `station_uuid` (`App.tsx:462`); the **local** `iris:state` live-wire is integer `stationId`; `docs/iris-ether-contract.md` has **no station-identity clause** (uuid or integer) — a gap.
- **Icecast mount:** integer-keyed (see §2, §3).
- **Watchdog:** process-level PID; per-station liveness by integer `sid`.

---

## 8. Current transport model + message rates
- **Levels/deck/queue = broadcast-to-all-windows + consumer-side filter.** Daemon broadcasts per-station frames over the pipe → `main.js` relays via `sendToAllWindows` → every renderer window receives every station's frames.
  - **Deck/queue** are filtered consumer-side by integer stationId at `engine-rodio.ts:173,191`. ✅
  - **Levels** are consumed via `onLevels` in components with **no filter** and, worse, **no tag** (dropped at `main.js:349`). ❌ — this is the reported bug.
- **Rates:** daemon event loop ~**10 Hz levels**, ~**4 Hz** deck snapshot for engineless stations (`ether-audiod.js:188-198`). With N airing stations that's ~10·N levels frames/sec, each broadcast to every window. Non-daemon fallback pushes levels at **~30 Hz** (`main.js:2029` `setInterval(…,33)`), single-station only.
- **Spectrum differs — pull, not push:** `getSpectrum(stationId)` invoke (`preload.js:13` → `main.js:2659`), station-scoped by argument. No broadcast, no filter needed; correct by construction.

## 9. Crossing summary (classification)
| Crossing | Identity today | Class |
|---|---|---|
| JS↔Rust NAPI (all audio fns) | integer `u32` | (a)+language boundary |
| daemon↔main (pipe: levels/deck/queue/enginestate/stream) | integer, tagged (levels tag dropped at main) | (c) |
| main↔renderer (audio:* IPC + onLevels/onDeck/onQueue) | integer | (c) |
| SQLite station-scoped queries | integer `station_id` (uuid column present, unused as key) | (b), (d) via sync |
| Postgres now-playing/metadata | **uuid** | (d) |
| Icecast mount/config + stream status | integer | (b)/(c) |
| Iris local live-wire | integer | (c) |
| Iris cloud now-playing | **uuid** | (d) |
| cmd-routing (remote→local) | **uuid→integer mapping** (the one choke point) | (c) |

**Bottom line:** UUID is already the identity in persistence and cross-machine; integer is the identity on all local real-time audio paths. The re-key removes integer as an *identity class* on those paths, leaving it (if anywhere) only as a private DB auto-increment PK. Design + decisions: see the redesign proposal.
