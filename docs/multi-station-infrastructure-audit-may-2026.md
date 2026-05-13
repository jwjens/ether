# Multi-Station Infrastructure Audit — May 2026

**Date:** 2026-05-13  
**Scope:** Read-only ground-truth snapshot of what multi-station infrastructure is actually implemented. No source files were modified.  
**Trigger:** Station-switch playback bug investigation — revealed the need for a clear picture of what is production-ready, what is gated, and what is partially built before Phase A work begins.

---

## Purpose

This document captures the actual state of multi-station support in Ether as of May 13, 2026. It distinguishes between components that are genuinely production-ready, components that are blocked by a deliberate gate, and components that exist but have known gaps.

Phase A (multi-station rollout) uses this as its starting point. Any work that lifts the station-creation gate must address the GATED and PARTIAL items documented here before going live.

---

## 1 — Verified READY Components

These components are implemented correctly and will work correctly with a second station today.

### Rust engine — genuinely multi-instance

**File:** `native/src/lib.rs`, lines 16–48

```rust
static ENGINES: std::sync::OnceLock<Mutex<HashMap<u32, SharedAudioState>>> =
    std::sync::OnceLock::new();
```

The engine HashMap is keyed by `station_id: u32`. A `get_or_create_engine(station_id, device_name)` function lazily initializes one `SharedAudioState` per station on first access. Each `SharedAudioState` maintains independent deck states (A–F), independent PCM buffers, and independent level meters.

All 9 audio functions (`audio_load`, `audio_play`, `audio_pause`, `audio_stop`, `audio_set_volume`, `audio_get_state`, `audio_get_levels`, `audio_set_output_device`, `watchdog_set`) accept `station_id: Option<u32>` and default to station 1 if not provided. Two stations can run fully independent audio simultaneously without any additional engine changes.

**Verdict: READY.** The Rust layer is multi-station by design and has been so since the engine was written.

---

### Icecast push — per-station config, per-station ffmpeg process

**File:** `electron/main.js`, lines 3737–3776 (`stream:go-live` handler)

```js
const stationId = args.stationId ?? getActiveStationId();
const station   = db.prepare("SELECT * FROM stations WHERE id=?").get(stationId);
const server    = station.icecast_server_url?.trim() || '44.244.52.207';
const pw        = station.icecast_password?.trim()   || 'hackme';
const mount     = station.icecast_mount?.trim()      || '/live';
```

The handler reads Icecast configuration directly from the `stations` table row for the requested station. The `stations` table has three per-station columns added in the v6 migration: `icecast_server_url TEXT DEFAULT '127.0.0.1'`, `icecast_mount TEXT DEFAULT '/live'`, and `icecast_password TEXT DEFAULT 'hackme'`.

Spawned ffmpeg processes are tracked in a `_stationStreams` map keyed by `stationId`. Station A and Station B can each push to a different Icecast server/mount with a separate ffmpeg process.

**Verdict: READY.** Icecast streaming is per-station end-to-end.

---

### Audio device routing — per-station config, per-station engine call

**File:** `src/components/AudioRoutingPanel.tsx`, lines 121–137

```ts
await ether.stationConfigKv.upsertByKey(selectedStation, 'audio_output_device', selectedDevice);
const result = await ether.audio.setOutputDevice(selectedStation, selectedDevice);
```

When the operator applies an audio output device, the selection is persisted to `station_config_kv` with the station's `station_id` as part of the composite key, and passed explicitly to the Rust engine via `setOutputDevice(stationId, deviceName)`. On startup, each station reads its own `audio_output_device` key from `station_config_kv WHERE station_id = ?`.

**Verdict: READY.** Audio routing is correctly per-station.

---

## 2 — GATED Components

These components are deliberately blocked until a prerequisite audit is complete. Do not lift the gate until the work described in Section 5 is done.

### Station creation — blocked by `multistation_insert_audit_complete` flag

**File:** `electron/main.js`, lines 3851–3865

The `stations:create` IPC handler checks the count of existing stations before inserting. If `existingCount >= 1`, it reads a feature flag from `station_config_kv`:

```js
const flag = db.prepare(
  "SELECT value FROM station_config_kv WHERE key = 'multistation_insert_audit_complete'"
).get();
if (!flag || flag.value !== 'true') {
  return { ok: false, error: 'multistation_insert_audit_complete gate is not set' };
}
```

The gate exists because approximately 40 renderer INSERT callsites still hardcode `station_id = 1` or rely on the SQLite column DEFAULT. Inserting a second station with those callsites live would silently assign data to station 1 regardless of which station the operator is working on.

**Unlock SQL (do not run until Section 5 audit is complete):**

```sql
INSERT OR REPLACE INTO station_config_kv (station_id, key, value, uuid, created_at, updated_at)
VALUES (1, 'multistation_insert_audit_complete', 'true',
        lower(hex(randomblob(16))), unixepoch(), unixepoch());
```

**Verdict: GATED.** Correct to be gated. Lifting the gate without completing the callsite audit will produce silent data corruption on station 2.

---

## 3 — PARTIAL Components

These components exist and partially work but have known gaps that need to be resolved before multi-station is reliable.

### Station switching — no Rust engine teardown, no rollback on failure

**File:** `src/App.tsx`, lines 1150–1156

```ts
engine.getDeck("A")?.stop(); engine.getDeck("B")?.stop(); engine.getDeck("C")?.stop();
engine.clearQueue(); setQueueLen(0);
window.dispatchEvent(new CustomEvent('ether:queue-changed'));
const r = await (window as any).ether.stations.switch(id);
if (!r?.ok) return false;
window.dispatchEvent(new CustomEvent("station-switched", { detail: { id, name } }));
```

The switch function stops decks A/B/C in the JS audio engine, clears the queue, updates the active station in the database, and dispatches a `station-switched` event. There are two gaps:

1. **No Rust engine teardown.** The old station's `SharedAudioState` entry stays alive in the Rust ENGINES HashMap after a switch. It holds onto its PCM buffers and output device handle. This is a resource leak and could cause the old station's engine to continue writing to its audio output device after the switch.

2. **No rollback.** If the IPC call at line 1154 fails, the function returns `false` but the deck stops and queue clear have already happened. The UI and the database are now out of sync — the JS engine is stopped and empty, but the database still says the old station is active.

**Verdict: PARTIAL.** Works for the happy path but neither safe nor clean. Needs a teardown call to the Rust engine and a state-machine rollback before multi-station is production-worthy.

---

### Crash recovery — no `station_id` column, single-station assumption

**File:** `electron/main.js`, crash_recovery CREATE TABLE (lines 440–450 approx.)

The `crash_recovery` table stores deck state so Ether can resume a playing song after an unexpected restart. The current schema stores only Deck A state (`deck_a_path`, `deck_a_title`, `deck_a_artist`, `deck_a_position`, `deck_a_was_playing`) with no `station_id` column.

On a single-station install this works fine. With two stations, crash recovery would always restore station 1's Deck A state regardless of which station crashed or which station is active when Ether restarts.

**Verdict: PARTIAL.** `crash_recovery` needs a `station_id` column and all read/write paths need to scope by station before multi-station crash recovery is reliable.

---

## 4 — The 40 INSERT Callsites

These are the renderer callsites that the `multistation_insert_audit_complete` gate is protecting. Each one either hardcodes `station_id = 1`, omits `station_id` entirely (relying on a column DEFAULT that no longer exists after the v8 migration), or passes the station ID inconsistently.

### Already audited — safe to use today

| File | Line | Table | Status |
|---|---|---|---|
| `src/db/client.ts` | 128 | `play_log` | Passes `station_id` explicitly — clean |
| `src/audio/showClock.ts` | 121 | `play_log` | Passes `station_id` explicitly — clean |

### Remaining callsites — need audit

Each remaining callsite needs three things: (1) access to the active `stationId` from React context or a parameter, (2) the INSERT updated to pass that `stationId` explicitly, and (3) verification that the typed IPC handler path is used rather than the raw `db:execute` channel.

| Table | Files with open callsites |
|---|---|
| `categories` | `src/App.tsx`, `src/components/CreateShowWizard.tsx`, `src/components/ImportDialog.tsx`, `src/components/LibraryImport.tsx`, `src/components/Scheduler.tsx` |
| `shows` | `src/components/ProgramLog.tsx`, `src/components/CreateShowWizard.tsx`, `src/components/Scheduler.tsx` |
| `clocks` | `src/components/CreateShowWizard.tsx`, `src/components/Scheduler.tsx` |
| `clock_slots` | `src/components/GSelectorImport.tsx`, `src/components/Scheduler.tsx` |
| `songs` | `src/components/ImportDialog.tsx`, `src/components/LibraryImport.tsx`, `src/components/NexGenImport.tsx`, `src/components/TrackEditor.tsx` |
| `artists` | `src/components/TrackEditor.tsx` |
| `spots` | `src/components/Spots.tsx` |
| `announcements` | `src/components/Announcements.tsx` |
| `voice_tracks` | `src/components/BroadcastEditor.tsx`, `src/components/VoiceTracker.tsx` |
| `liner_cards` | `src/components/ShowPrep.tsx` |
| `prep_notes` | `src/components/ShowPrep.tsx` |
| `macros` | `src/components/MacroEngine.tsx` |
| `play_log` | `src/components/CloudBackup.tsx` (DELETE all), `src/components/Logs.tsx` (DELETE WHERE station_id) |
| `scheduled_log` | `src/components/ProgramLog.tsx` (multiple INSERTs and DELETEs) |
| `pinned_songs` | `src/components/PDPicks.tsx` |
| `operators` | `src/components/OnShiftScreen.tsx` |
| `station_config_kv` | `src/canvas/CanvasEngine.tsx`, `src/utils/timezone.ts`, `src/components/MasterOutput.tsx`, `src/components/MicDeck.tsx`, `src/components/NowPlayingSettings.tsx`, `src/components/OnAirDeck.tsx`, `src/components/OnShiftScreen.tsx`, `src/components/SettingsPanel.tsx`, `src/components/ShowPlus.tsx`, `src/components/ClipEditor.tsx` |

**Note on `station_config_kv`:** Five keys written from `src/components/ShowPlus.tsx` (`video_audio_input`, `video_audio_output`, `video_self_monitor`, `video_mic_volume`, `video_monitor_volume`) are hardware-scoped preferences that belong in `install_config_kv` rather than `station_config_kv`. These should be moved rather than updated to carry `station_id`. See the Phase 3.5 Status Audit for the full breakdown.

---

## 5 — Verdict Summary

| Component | File(s) | Verdict |
|---|---|---|
| Rust engine (multi-instance) | `native/src/lib.rs:16–48` | **READY** |
| Icecast push (per-station) | `electron/main.js:3737–3776` | **READY** |
| Audio device routing | `src/components/AudioRoutingPanel.tsx:121–137` | **READY** |
| Station creation (second station) | `electron/main.js:3851–3865` | **GATED** — 40 callsites |
| Station switching | `src/App.tsx:1150–1156` | **PARTIAL** — no teardown, no rollback |
| Crash recovery | `electron/main.js` crash_recovery table | **PARTIAL** — no station_id column |

---

## 6 — Path Forward

Complete these five steps in order. Do not unlock the gate at Step 4 until Steps 1–3 are done.

**Step 1 — Fix the station-switch bug.**  
Add a Rust engine teardown call when switching stations so the departing station's `SharedAudioState` is released. Add a rollback path in `switchStation()` (`src/App.tsx:1150`) so that if the IPC call fails, the deck stops are reversed and the UI reflects the correct state.

**Step 2 — Audit all 40 INSERT callsites.**  
Work through the table in Section 4. For each callsite: verify the active `stationId` is accessible, update the INSERT to pass it explicitly via the typed handler, and check that the raw `db:execute` path is not being used for synced-table writes. Mark each subsystem done as you go. The Phase 3.5 Status Audit (`docs/phase-3.5-status-audit.md`) has the full per-file, per-line detail.

**Step 3 — Migrate `crash_recovery` to include `station_id`.**  
Add a `station_id INTEGER NOT NULL DEFAULT 1` column to the `crash_recovery` table. Update all read and write paths to scope by station. This is a schema migration — follow the existing migration pattern in `scripts/`.

**Step 4 — Unlock the gate.**  
Once Steps 1–3 are verified, run the unlock SQL from Section 2. Create and test a second station end-to-end on a dev database before doing this on any live install.

**Step 5 — Smoke-test a two-station configuration.**  
Create Station 2 in the UI. Assign a separate audio output device and Icecast mount. Play audio on both stations simultaneously. Trigger a station switch and verify the Rust engine tears down cleanly. Restart Ether while Station 2 is active and verify crash recovery resumes the correct deck for the correct station.

---

*Last updated: May 13, 2026*  
*Related: [`docs/multi-station-broadcast-architecture.md`](multi-station-broadcast-architecture.md) (April 2026 architecture design), [`docs/phase-4-library-architecture.md`](phase-4-library-architecture.md) (April 2026 library scoping), [`docs/phase-3.5-status-audit.md`](phase-3.5-status-audit.md) (May 4, 2026 — full callsite inventory)*
