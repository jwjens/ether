# Phase 3.5 Status Audit

**Date:** 2026-05-04  
**Scope:** Pre-close-out discovery audit for Phase 3.5. Read-only. No source files were modified.  
**Auditor:** Claude Code (automated), session triggered by Jeff.

---

## Registry Baseline

**File:** `electron/sync/synced-tables.js`

The SYNCED_TABLES array has **37 entries** (not 31 as the project notes state — the notes predate Phase 4 additions). Scope breakdown from REGISTRY:

| Scope | Count | Tables |
|---|---|---|
| `install` | 6 | albums, artists, install_config_kv, install_secrets_kv, mood_tags, songs |
| `station` | 30 | announcements, cart_slots, categories, clock_slots, clocks, deck_configs, format_clocks, generated_schedule, liner_cards, macros, metadata_definitions, metadata_vocabulary, operator_notes, operators, pinned_songs, play_log, prep_notes, published_episodes, rtmp_destinations, scheduled_log, separation_rules, shows, smart_schedule_rules, song_metadata_values, spots, station_config_kv, station_programming, station_programming_moods, stations, voice_tracks |
| `local-only` | 1 | monitor_routing |

Note: `install_secrets_kv` has `syncExcluded: true` — it is registered but never leaves the device. The project notes' "31 synced" / "4 install / 27 station" counts were accurate at Session A2 and are now superseded by Phase 4 additions.

---

## ITEM 1 — UUID INSERT Gap

**Claim:** New rows inserted through the renderer (`db:execute` / `dbExec` path) do not call `crypto.randomUUID()` for the `uuid` column before or in the INSERT statement.

### 1a — Typed handler coverage (the safe path)

All 37 tables in the REGISTRY have typed IPC handlers installed via `electron/sync/handlers/index.js` (lines 3–78). Every handler calls `crypto.randomUUID()` in its `*Create` function (e.g. `electron/sync/handlers/station_programming.js` line 57, `electron/sync/handlers/operators.js` line 56, `electron/sync/handlers/play_log.js` line 56). Writes through the typed path are UUID-safe.

### 1b — Renderer INSERT sites bypassing typed handlers

The following INSERT calls go through `execute()` or `dbExec()` (which map to `db:execute` IPC) or through `executeScopedInsert()` (which rewrites the SQL but never adds a `uuid` column). **None of these inject a UUID.**

#### Table: `categories`

| File | Line | SQL | UUID present? |
|---|---|---|---|
| `src/App.tsx` | 2905 | `INSERT INTO categories (code, name, color)` via `executeScopedInsert` | NO |
| `src/components/CreateShowWizard.tsx` | 169 | `INSERT INTO categories (code, name, color, spins_per_hour, priority)` via `executeScopedInsert` | NO |
| `src/components/ImportDialog.tsx` | 44 | `INSERT INTO categories (code, name, color)` via `executeScopedInsert` | NO |
| `src/components/LibraryImport.tsx` | 390 | `INSERT INTO categories (code, name, color)` via `executeScopedInsert` | NO |
| `src/components/Scheduler.tsx` | 310 | `INSERT INTO categories (code, name, color, spins_per_hour, priority)` via `executeScopedInsert` | NO |

#### Table: `shows`

| File | Line | SQL | UUID present? |
|---|---|---|---|
| `src/components/ProgramLog.tsx` | 1473 | `INSERT INTO shows (name, start_hour, end_hour, color, description)` via `execute` | NO |
| `src/components/CreateShowWizard.tsx` | 187 | `INSERT INTO shows (name, start_hour, end_hour, color, days, is_active, clock_id)` via `executeScopedInsert` | NO |
| `src/components/Scheduler.tsx` | 124 | `INSERT INTO shows (name, start_hour, end_hour, color, description, days, is_active)` via `executeScopedInsert` | NO |

#### Table: `clocks`

| File | Line | SQL | UUID present? |
|---|---|---|---|
| `src/components/CreateShowWizard.tsx` | 151 | `INSERT INTO clocks (name)` via `executeScopedInsert` | NO |
| `src/components/Scheduler.tsx` | 764 | `INSERT INTO clocks (name)` via `executeScopedInsert` | NO |

#### Table: `clock_slots`

| File | Line | SQL | UUID present? |
|---|---|---|---|
| `src/components/GSelectorImport.tsx` | 237 | `INSERT INTO clock_slots (clock_id, position, slot_type, category_id)` via `executeScopedInsert` | NO |
| `src/components/Scheduler.tsx` | 796 | `INSERT INTO clock_slots (clock_id, position, slot_type, category_id, duration_min, label)` via `executeScopedInsert` | NO |
| `src/components/Scheduler.tsx` | 811 | `INSERT INTO clock_slots (clock_id, position, slot_type, category_id, duration_min, label)` via `executeScopedInsert` | NO |
| `src/components/Scheduler.tsx` | 828 | `INSERT INTO clock_slots (clock_id, position, slot_type, category_id, duration_min, label)` via `executeScopedInsert` | NO |

#### Table: `songs`

| File | Line | SQL | UUID present? |
|---|---|---|---|
| `src/components/ImportDialog.tsx` | 120 | `INSERT INTO songs (title, file_path, artist_id, category_id, genre, created_at, updated_at)` via `executeScopedInsert` | NO |
| `src/components/LibraryImport.tsx` | 399 | `INSERT INTO songs (title, artist_id, album, duration_ms, ...)` via `executeScopedInsert` | NO |
| `src/components/NexGenImport.tsx` | 126 | `INSERT INTO songs (title, artist_id, genre, rotation_status, ...)` via `executeScopedInsert` | NO |
| `src/components/TrackEditor.tsx` | 90 | `INSERT OR IGNORE INTO songs (title, artist_id, file_path, duration_ms)` via `executeScopedInsert` | NO |

#### Table: `artists`

| File | Line | SQL | UUID present? |
|---|---|---|---|
| `src/components/TrackEditor.tsx` | 84 | `INSERT OR IGNORE INTO artists (name)` via `executeScopedInsert` | NO |

#### Table: `liner_cards`

| File | Line | SQL | UUID present? |
|---|---|---|---|
| `src/components/ShowPrep.tsx` | 278 | `INSERT INTO liner_cards (title, body, category, color, pinned)` via `executeScopedInsert` | NO |

#### Table: `prep_notes`

| File | Line | SQL | UUID present? |
|---|---|---|---|
| `src/components/ShowPrep.tsx` | 397 | `INSERT INTO prep_notes (title, body, category, show_date)` via `executeScopedInsert` | NO |

#### Table: `macros`

| File | Line | SQL | UUID present? |
|---|---|---|---|
| `src/components/MacroEngine.tsx` | 211 | `INSERT INTO macros (name, description, trigger_type, trigger_value, actions, hotkey, is_active, color)` via `executeScopedInsert` | NO |

#### Table: `spots`

| File | Line | SQL | UUID present? |
|---|---|---|---|
| `src/components/Spots.tsx` | 53 | `INSERT INTO spots (title, file_path, spot_type)` via `executeScopedInsert` | NO |
| `src/components/Spots.tsx` | 72 | `INSERT INTO spots (title, file_path, spot_type)` via `executeScopedInsert` | NO |
| `src/components/Spots.tsx` | 162 | `INSERT INTO spots (title, spot_type, advertiser, ...)` via `executeScopedInsert` | NO |

#### Table: `announcements`

| File | Line | SQL | UUID present? |
|---|---|---|---|
| `src/components/Announcements.tsx` | 106 | `INSERT INTO announcements (title, file_path, trigger_time, ...)` via `executeScopedInsert` | NO |

#### Table: `voice_tracks`

| File | Line | SQL | UUID present? |
|---|---|---|---|
| `src/components/BroadcastEditor.tsx` | 1305 | `INSERT INTO voice_tracks (title, file_path, duration_ms, recorded_by, recorded_at)` via `executeScopedInsert` | NO |
| `src/components/VoiceTracker.tsx` | 564 | `INSERT INTO voice_tracks (title, file_path, show_id, duration_ms, recorded_by, clock_slot_id)` via `executeScopedInsert` | NO |
| `src/components/VoiceTracker.tsx` | 565 | `INSERT INTO voice_tracks (title, file_path, show_id, duration_ms, recorded_by)` via `executeScopedInsert` (fallback) | NO |

#### Table: `play_log`

| File | Line | SQL | UUID present? |
|---|---|---|---|
| `src/db/client.ts` | 128 | `INSERT INTO play_log (station_id, title, artist, deck, duration_ms, session_id)` via `execute` | NO |
| `src/client.ts` | 128 | `INSERT INTO play_log (title, artist, deck, duration_ms, session_id)` via `execute` (legacy client, no station_id) | NO |
| `src/audio/showClock.ts` | 127 | `INSERT INTO play_log (station_id, title, artist, deck, session_id)` via `execute` | NO |

#### Table: `scheduled_log`

| File | Line | SQL | UUID present? |
|---|---|---|---|
| `src/components/ProgramLog.tsx` | 222 | `INSERT INTO scheduled_log (log_date,hour,position,slot_type,...)` via `execute` | NO |
| `src/components/ProgramLog.tsx` | 289 | `INSERT INTO scheduled_log (log_date,hour,position,slot_type,...)` via `execute` | NO |
| `src/components/ProgramLog.tsx` | 297 | `INSERT INTO scheduled_log (...) VALUES (...)` via `execute` (UNFILLED slot) | NO |
| `src/components/ProgramLog.tsx` | 338 | `INSERT INTO scheduled_log (...) VALUES (...)` via `execute` (overflow slot) | NO |

#### Table: `pinned_songs`

| File | Line | SQL | UUID present? |
|---|---|---|---|
| `src/components/PDPicks.tsx` | 240 | `INSERT INTO pinned_songs (song_id, slot_hour, slot_position, ...)` via `execute` | NO |

#### Table: `operators`

| File | Line | SQL | UUID present? |
|---|---|---|---|
| `src/components/OnShiftScreen.tsx` | 221 | `INSERT INTO operators (name, initials)` via `executeScopedInsert` | NO |

#### Table: `station_config_kv` (partial exception)

Most writes to `station_config_kv` from the renderer use `INSERT OR REPLACE INTO station_config_kv (key, value)` without a `uuid` column and without `station_id` (files: `src/components/ShowPlus.tsx` lines 143, 148, 175, 355, 1242, 1905, 1906, 2449–2453; `src/canvas/CanvasEngine.tsx` lines 13, 123, 226, 230, 241, 249, 256; `src/utils/timezone.ts` line 17; `src/components/MasterOutput.tsx` line 561; `src/components/MicDeck.tsx` line 80; `src/components/NowPlayingSettings.tsx` lines 74–79; `src/components/OnAirDeck.tsx` line 85; `src/components/OnShiftScreen.tsx` line 235; `src/components/SettingsPanel.tsx` line 242; `src/components/ClipEditor.tsx` line 201).

**One exception:** `src/components/AudioRoutingPanel.tsx` line 132–133 does call `crypto.randomUUID()` inline and passes it as the `uuid` column. This is the only renderer INSERT site that correctly generates a UUID.

### 1c — Summary

**~35+ INSERT sites across ~15 renderer files** target synced tables without providing a `uuid` value. The `executeScopedInsert` helper in `src/db/stationScoped.ts` (lines 93–112) only injects `station_id` — it has no UUID injection logic. The `execute` function in `src/db/client.ts` (lines 29–48) is a raw passthrough. All renderer INSERT paths except `AudioRoutingPanel.tsx` line 132 omit the `uuid` column. These rows will have `uuid IS NULL`, violating the sync protocol's row identity requirement.

**Blocking:** Must be fixed before v3.1.0 tag.

---

## ITEM 2 — migrate-timestamps payloadTransformer N-70 Violation

### 2a — Transformer location

**File:** `scripts/migrate-timestamps-phase-sync-2.js`, lines 135–147.

### 2b — Rule N-70 (from `docs/sync-protocol-v0.md`, line 341)

> **[N-70]** A payload transformer handles the full payload for any synced table affected by its migration. If a migration adds a column `foo` to table `bar`, the transformer for that migration SHALL, when transforming a payload from table `bar`, add `foo` with its default value.

The protocol document also notes at line 443 (open question Q-15):

> Real bug before any second client is onboarded against a v2+ schema.

### 2c — Current transformer code (lines 136–147 of `scripts/migrate-timestamps-phase-sync-2.js`)

```js
module.exports = {
  // TODO-SYNC(A2.4): [N-70] VIOLATION — identity transformer is non-compliant.
  // Migration 2 adds created_at/updated_at/deleted_at to all 27 synced tables.
  // Per [N-70], this transformer MUST add those fields with defaults when
  // transforming v1 payloads from any synced table.
  // Blocking question [Q-15]: default semantics for backfilled timestamps at
  // receive-time (wall-clock-now vs null-let-SQL-fill vs mutation's own HLC wall ms)?
  // Safe for now: no v1 peers exist in the wild. MUST be fixed before first v1 client
  // ever sends a mutation to a v2+ peer.
  payloadTransformer: function payloadTransformer(payload, fromVersion) {
    return payload;
  },
};
```

**What the violation is:** Migration 2 adds three columns — `created_at`, `updated_at`, and `deleted_at` — to all 27 tables that existed at schema_version 1. Per N-70, when a v2+ peer receives a mutation produced by a v1 peer (which predates these columns), the transformer for migration 2 must add these three fields with appropriate defaults before the payload is applied. The current transformer is an identity function that returns the payload unchanged. A v1 payload will therefore have no `created_at`/`updated_at`/`deleted_at` keys, and the v2+ peer will write rows missing those columns.

**Why it is currently safe:** The TODO comment (line 136) is accurate — no v1 peers exist in the wild. Schema version 1 was never deployed to a second client; all installs started at or above v2. The violation becomes a live data-corruption bug the moment any v1-era peer attempts to sync with a v2+ peer.

**Open question [Q-15]** (protocol doc line 443) must be resolved before writing the real transformer: three candidate default semantics for `created_at`/`updated_at` on backfill — wall-clock at receive time, the mutation's own HLC wall-ms component, or null. Until that decision is made, the transformer cannot be correctly implemented.

---

## ITEM 3 — Session C Renderer Migration

### 3a — Typed IPC handler files

All 37 synced tables have handler files in `electron/sync/handlers/`. The aggregator at `electron/sync/handlers/index.js` installs all of them via `installAll(ipcMain, db)`.

Key handlers:

| File | Table(s) | IPC namespace (preload) |
|---|---|---|
| `electron/sync/handlers/station_programming.js` | `station_programming` | `window.ether.stationProgramming.*` |
| `electron/sync/handlers/station_config_kv.js` | `station_config_kv` | `window.ether.stationConfigKv.*` |
| `electron/sync/handlers/operators.js` | `operators` | `window.ether.operators.*` |
| `electron/sync/handlers/songs.js` | `songs` | `window.ether.songs.*` |
| `electron/sync/handlers/play_log.js` | `play_log` | `window.ether.playLog.*` |
| `electron/sync/handlers/shows.js` | `shows` | `window.ether.shows.*` |
| `electron/sync/handlers/categories.js` | `categories` | `window.ether.categories.*` |
| `electron/sync/handlers/clocks.js` | `clocks` | `window.ether.clocks.*` |
| `electron/sync/handlers/clock_slots.js` | `clock_slots` | `window.ether.clockSlots.*` |
| `electron/sync/handlers/scheduled_log.js` | `scheduled_log` | `window.ether.scheduledLog.*` |
| `electron/sync/handlers/pinned_songs.js` | `pinned_songs` | `window.ether.pinnedSongs.*` |
| `electron/sync/handlers/spots.js` | `spots` | `window.ether.spots.*` |
| `electron/sync/handlers/announcements.js` | `announcements` | `window.ether.announcements.*` |
| `electron/sync/handlers/voice_tracks.js` | `voice_tracks` | `window.ether.voiceTracks.*` |
| `electron/sync/handlers/liner_cards.js` | `liner_cards` | `window.ether.linerCards.*` |
| `electron/sync/handlers/prep_notes.js` | `prep_notes` | `window.ether.prepNotes.*` |
| `electron/sync/handlers/macros.js` | `macros` | `window.ether.macros.*` |
| `electron/sync/handlers/artists.js` | `artists` | `window.ether.artists.*` |

### 3b — All db:execute / dbExec INSERT/UPDATE/DELETE occurrences in src/

The `execute()` function in `src/db/client.ts` (line 31) calls `window.ether.db.execute`, which maps to the `db:execute` IPC handler in `electron/main.js` (line 1186). The `dbExec()` alias used in `ShowPlus.tsx` and `ClipEditor.tsx` is imported from the same path.

Every renderer-side INSERT/UPDATE/DELETE call is listed below with its target table, classified:

**Classification key:**  
(1) = targets synced table with typed handler → needs migration  
(2) = targets synced table with no typed handler yet → not applicable (all tables have handlers)  
(3) = targets non-synced table → fine to leave  

#### `src/App.tsx`

| Line | SQL target | Classification |
|---|---|---|
| 791 | `crash_recovery` (UPDATE) | (3) non-synced |
| 814 | `crash_recovery` (UPDATE) | (3) non-synced |
| 2933 | `songs` (DELETE) | (1) synced, typed handler exists |
| 2939 | `songs` (DELETE) | (1) synced, typed handler exists |
| 2947 | `songs` (UPDATE gain_db) | (1) synced, typed handler exists |
| 2962 | `songs` (UPDATE file_path) | (1) synced, typed handler exists |
| 3028 | `songs` (UPDATE category_id) | (1) synced, typed handler exists |
| 3066 | `songs` (DELETE) and `songs_fts` (DELETE) | songs=(1) synced; songs_fts=(3) non-synced |
| 3215 | `songs` (UPDATE category_id) | (1) synced, typed handler exists |
| 3253 | `songs` (DELETE) and `songs_fts` (DELETE) | songs=(1) synced; songs_fts=(3) non-synced |

#### `src/db/client.ts`

| Line | SQL target | Classification |
|---|---|---|
| 128 | `play_log` (INSERT) | (1) synced, typed handler exists |

#### `src/client.ts` (legacy client — same channel)

| Line | SQL target | Classification |
|---|---|---|
| 128 | `play_log` (INSERT, no station_id) | (1) synced, typed handler exists |

#### `src/audio/showClock.ts`

| Line | SQL target | Classification |
|---|---|---|
| 127 | `play_log` (INSERT) | (1) synced, typed handler exists |

#### `src/canvas/CanvasEngine.tsx`

| Line | SQL target | Classification |
|---|---|---|
| 13 | `station_config_kv` (INSERT OR REPLACE `canvas_layout`) | (1) synced, typed handler exists |
| 123 | `station_config_kv` (INSERT OR REPLACE `canvas_layout_version`) | (1) synced, typed handler exists |
| 226 | `station_config_kv` (INSERT OR REPLACE `canvas_profiles`) | (1) synced, typed handler exists |
| 230 | `station_config_kv` (INSERT OR REPLACE `canvas_active_name`) | (1) synced, typed handler exists |
| 241 | `station_config_kv` (INSERT OR REPLACE `canvas_active_name`) | (1) synced, typed handler exists |
| 249 | `station_config_kv` (INSERT OR REPLACE `canvas_profiles`) | (1) synced, typed handler exists |
| 256 | `station_config_kv` (INSERT OR REPLACE `canvas_active_name`) | (1) synced, typed handler exists |

#### `src/utils/timezone.ts`

| Line | SQL target | Classification |
|---|---|---|
| 17 | `station_config_kv` (INSERT OR REPLACE `timezone`) | (1) synced, typed handler exists |

#### `src/components/AudioRoutingPanel.tsx`

| Line | SQL target | Classification |
|---|---|---|
| 132 | `station_config_kv` (INSERT with uuid) | (1) synced; this site already provides uuid — partially migrated |

#### `src/components/CloudBackup.tsx`

| Line | SQL target | Classification |
|---|---|---|
| 309 | `play_log` (DELETE all) | (1) synced, typed handler exists |
| 320 | `scheduled_log` (DELETE all) | (1) synced, typed handler exists |

#### `src/components/EASLogbook.tsx`

| Line | SQL target | Classification |
|---|---|---|
| 121 | `eas_tests` (DELETE) | (3) non-synced |

#### `src/components/Logs.tsx`

| Line | SQL target | Classification |
|---|---|---|
| 78 | `play_log` (DELETE WHERE station_id) | (1) synced, typed handler exists |

#### `src/components/MasterOutput.tsx`

| Line | SQL target | Classification |
|---|---|---|
| 561 | `station_config_kv` (INSERT OR REPLACE `eq_master`) | (1) synced, typed handler exists |

#### `src/components/MicDeck.tsx`

| Line | SQL target | Classification |
|---|---|---|
| 80 | `station_config_kv` (INSERT OR REPLACE `eq_deck_mic`) | (1) synced, typed handler exists |

#### `src/components/MidiEngine.tsx`

| Line | SQL target | Classification |
|---|---|---|
| 303 | `midi_mappings` (DELETE) | (3) non-synced |
| 314 | `midi_mappings` (DELETE) | (3) non-synced |

#### `src/components/NowPlayingSettings.tsx`

| Line | SQL target | Classification |
|---|---|---|
| 74–79 | `station_config_kv` (INSERT OR REPLACE `ig_handle`, `ig_enabled`, `now_playing_widget`, `weather_city`, `weather_lat`, `weather_lon`) | (1) synced, typed handler exists |

#### `src/components/OnAirDeck.tsx`

| Line | SQL target | Classification |
|---|---|---|
| 85 | `station_config_kv` (INSERT OR REPLACE) | (1) synced, typed handler exists |

#### `src/components/OnShiftScreen.tsx`

| Line | SQL target | Classification |
|---|---|---|
| 221 | `operators` (INSERT via executeScopedInsert) | (1) synced, typed handler exists |
| 235 | `station_config_kv` (INSERT OR REPLACE `last_operator_id`) | (1) synced, typed handler exists |

#### `src/components/PDPicks.tsx`

| Line | SQL target | Classification |
|---|---|---|
| 94 | `pinned_songs` (DELETE) | (1) synced, typed handler exists |
| 99 | `pinned_songs` (UPDATE consumed_at) | (1) synced, typed handler exists |
| 240 | `pinned_songs` (INSERT) | (1) synced, typed handler exists |

#### `src/components/ProcessingPanel.tsx`

| Line | SQL target | Classification |
|---|---|---|
| 50 | `songs` (UPDATE lufs/peak/gain reset) | (1) synced, typed handler exists |

#### `src/components/ProgramLog.tsx`

| Line | SQL target | Classification |
|---|---|---|
| 217 | `scheduled_log` (DELETE hour) | (1) synced, typed handler exists |
| 222 | `scheduled_log` (INSERT slot) | (1) synced, typed handler exists |
| 289 | `scheduled_log` (INSERT music slot) | (1) synced, typed handler exists |
| 293 | `songs` (UPDATE last_played_at) | (1) synced, typed handler exists |
| 297 | `scheduled_log` (INSERT UNFILLED slot) | (1) synced, typed handler exists |
| 338 | `scheduled_log` (INSERT overflow slot) | (1) synced, typed handler exists |
| 346 | `songs` (UPDATE last_played_at overflow) | (1) synced, typed handler exists |
| 385 | `scheduled_log` (DELETE hour) | (1) synced, typed handler exists |
| 391 | `scheduled_log` (DELETE date) | (1) synced, typed handler exists |
| 1239 | `scheduled_log` (UPDATE position) | (1) synced, typed handler exists |
| 1470 | `shows` (UPDATE) | (1) synced, typed handler exists |
| 1473 | `shows` (INSERT) | (1) synced, typed handler exists |
| 1480 | `shows` (UPDATE clock_id) | (1) synced, typed handler exists |
| 1485 | `shows` (DELETE) | (1) synced, typed handler exists |

#### `src/components/Scheduler.tsx`

| Line | SQL target | Classification |
|---|---|---|
| 843 | `clock_slots` (UPDATE position) | (1) synced, typed handler exists |
| 1056 | `clock_slots` (UPDATE duration_min) | (1) synced, typed handler exists |
| 1064 | `clock_slots` (UPDATE duration_min) | (1) synced, typed handler exists |

#### `src/components/SettingsPanel.tsx`

| Line | SQL target | Classification |
|---|---|---|
| 242 | `station_config_kv` (INSERT OR REPLACE `experience_mode`) | (1) synced, typed handler exists |
| 1134 | `separation_rules` (UPDATE field) | (1) synced, typed handler exists |
| 1511 | `songs` (UPDATE lufs/peak/gain reset) | (1) synced, typed handler exists |
| 2069 | `users` (INSERT) | (3) non-synced |
| 2076 | `users` (UPDATE) | (3) non-synced |
| 2084 | `users` (DELETE) | (3) non-synced |
| 2098 | `users` (UPDATE pin_hash) | (3) non-synced |
| 2105 | `users` (UPDATE pin_hash clear) | (3) non-synced |

#### `src/components/ShowPlus.tsx`

| Lines | SQL target | Classification |
|---|---|---|
| 143, 148, 175, 355, 1242, 1905, 1906, 2449–2453 | `station_config_kv` (INSERT OR REPLACE various keys) | (1) synced, typed handler exists |

#### `src/components/ClipEditor.tsx`

| Line | SQL target | Classification |
|---|---|---|
| 201 | `station_config_kv` (INSERT OR REPLACE `clipeditor_format`) | (1) synced, typed handler exists |

#### `src/components/SmartScheduler.tsx`

| Line | SQL target | Classification |
|---|---|---|
| 153 | `smart_schedule_rules` (DELETE station) | (1) synced, typed handler exists |

#### `src/components/StreamManager.tsx`

| Lines | SQL target | Classification |
|---|---|---|
| 111, 125 | `stream_settings` (UPDATE) | (3) non-synced |

#### `src/components/StudioPro.tsx`

| Lines | SQL target | Classification |
|---|---|---|
| 2887, 2896, 2932, 2944, 3013 | `studio_notes`, `studio_sessions`, `studio_session_versions` | (3) non-synced |

#### `src/components/ProgramLog.tsx` (via executeScopedInsert)

| Line | SQL target | Classification |
|---|---|---|
| (see above) | All covered above | — |

### 3c — Classification summary

- **Category (1) — synced table, typed handler exists, needs migration:** Approximately 60+ call sites across 20+ files. Key hot paths: all `station_config_kv` writes (ShowPlus, ClipEditor, SettingsPanel, MasterOutput, etc.), all `play_log` INSERTs (client.ts, showClock.ts), all `scheduled_log` INSERTs and DELETEs (ProgramLog.tsx), `songs` UPDATEs and DELETEs (App.tsx), `separation_rules` UPDATEs (SettingsPanel.tsx), `pinned_songs` writes (PDPicks.tsx).

- **Category (2) — synced table, no typed handler:** None. All 37 synced tables now have typed handlers.

- **Category (3) — non-synced table, leave as-is:** `crash_recovery`, `songs_fts`, `eas_tests`, `midi_mappings`, `stream_settings`, `users`, `studio_notes`, `studio_sessions`, `studio_session_versions`.

---

## ITEM 4 — Session D Handler Locking

### 4a — Current `db:execute` implementation

**File:** `electron/main.js`, lines 1186–1206.

```js
ipcMain.handle("db:execute", (_, sql, params) => {
  try {
    // Drop and recreate FTS triggers around deletes to avoid contentless table errors
    if (sql.trim().toUpperCase().startsWith("DELETE FROM SONGS")) {
      db.exec("DROP TRIGGER IF EXISTS trg_songs_fts_delete");
      const stmt = db.prepare(sql);
      const result = stmt.run(...(params || []));
      db.exec(`CREATE TRIGGER IF NOT EXISTS trg_songs_fts_delete
        AFTER DELETE ON songs BEGIN
          DELETE FROM songs_fts WHERE rowid = OLD.id;
        END`);
      return { data: result, error: null };
    }
    const stmt = db.prepare(sql);
    const result = stmt.run(...(params || []));
    return { data: result, error: null };
  } catch (e) {
    console.error("[DB execute error]", sql.slice(0, 100), e.message);
    return { data: null, error: e.message };
  }
});
```

### 4b — Guard assessment

**No guard exists.** The handler accepts arbitrary SQL strings. The only special-case logic is the FTS trigger workaround for `DELETE FROM SONGS`. Any renderer component can call `window.ether.db.execute` with any INSERT/UPDATE/DELETE targeting any table, including all 37 synced tables. There is no check against the SYNCED_TABLES list, no refusal of writes to synced tables, and no requirement to go through the typed handlers.

### 4c — Guard precedent

The typed handlers in `electron/sync/handlers/` (e.g. `station_programming.js` lines 24–35, `operators.js` lines 21–27) include a `validateScope()` function that checks the REGISTRY. The mutation writer at `electron/sync/mutation-writer.js` (used by all typed handlers) is the authoritative "safe write" path. There is no precedent in the existing codebase for a guard on the raw `db:execute` handler itself — no table lookup, no refusal.

**Where the guard would go:** `electron/main.js` line 1186, inside the `db:execute` handler, before `db.prepare(sql)` runs. The guard would:
1. Parse the SQL verb (INSERT / UPDATE / DELETE) from the SQL string.
2. Extract the table name from the SQL string.
3. Check the table name against `SYNCED_TABLES` imported from `electron/sync/synced-tables.js`.
4. If it matches, return `{ data: null, error: "ERR_SYNCED_TABLE_WRITE: use typed handler for table <name>" }`.

This guard is a precondition for declaring Session C migration complete — there is no point migrating renderer call sites if the raw escape hatch remains open.

---

## ITEM 5 — v8 Migration (`songs.station_id` drop blocker)

### 5a/5b — Live `songs.station_id` references

The v8 migration plan (`docs/phase-a-step-2-v8-migration-plan.md`) requires a renderer audit before songs can be reclassified as truly install-scoped (station_id dropped or made nullable). The following references in src/ read or filter on `songs.station_id` directly:

**Scheduler (`src/components/Scheduler.tsx`)**

- Line 263: subquery `SELECT COUNT(*) FROM songs WHERE category_id = c.id AND station_id = ?` — filters song count by station
- Line 728 (comment + query): `songs.station_id filters scope` on category preview query

**loggen.ts (`src/audio/loggen.ts`)**

- Line 153: `cond += " AND s.station_id = ?"` — station scoping applied to all song picks in the rotation engine
- Line 176: `WHERE s2.artist_id IS NOT NULL AND s2.station_id = ?` — artist separation subquery
- Line 403: `LEFT JOIN songs s ON s.id = gs.song_id AND s.station_id = ?` — schedule-to-song join in generated_schedule poll

**App.tsx (`src/App.tsx`)**

- Line 681: `WHERE s.file_path IS NOT NULL AND s.station_id = ?` — queue refill callback
- Line 836: same pattern — startup queue fill
- Line 867: same pattern — startup queue fill fallback
- Line 870: same pattern
- Line 2917: `WHERE s.station_id = ?` — library panel main load
- Line 2933: `DELETE FROM songs WHERE id=? AND station_id=?`
- Line 2939: `DELETE FROM songs WHERE station_id=?`
- Line 2947: `UPDATE songs SET gain_db=? WHERE id=? AND station_id=?`
- Line 2962: `UPDATE songs SET file_path=? WHERE id=? AND file_path!=? AND station_id=?`
- Line 3028: `UPDATE songs SET category_id=? WHERE id=? AND station_id=?`
- Line 3066: `DELETE FROM songs WHERE id=? AND station_id=?`
- Line 3215: `UPDATE songs SET category_id=? WHERE id=? AND station_id=?`
- Line 3253: `DELETE FROM songs WHERE id=? AND station_id=?`

**Other files with `songs.station_id` references:**

- `src/audio/songAnalysis.ts` lines 196–201: all 6 queries filter `WHERE station_id = ?`
- `src/canvas/widgets/Widgets.tsx` line 153: `WHERE s.station_id = ?`
- `src/components/CueEditor.tsx` line 250: `WHERE id=? AND station_id=?`
- `src/components/JockStrip.tsx` line 46: `WHERE s.station_id = ?`
- `src/components/ListenerAnalytics.tsx` line 190 (comment): `songs.station_id scoping noted`
- `src/components/OnAirDeck.tsx` line 56 (comment + query): `songs.station_id filters scope`
- `src/components/PodcastMode.tsx` line 425: `LEFT JOIN songs s ON ... AND s.station_id = ?`
- `src/components/SchedulePreview.tsx` lines 142, 163, 183: JOIN and filter on `songs.station_id`
- `src/components/Scheduler.tsx` line 261 (comment): `inner by songs.station_id`
- `src/components/SettingsPanel.tsx` line 1510 (comment): `WHERE station_id=?` on songs UPDATE
- `src/components/StationManager.tsx` line 219: `FROM songs WHERE station_id = ${s.id} OR station_id IS NULL`
- `src/components/TrackEditor.tsx` lines 95, 96, 205, 321: `WHERE s.station_id = ?`

### 5c — v8 blockers

The v8 migration (drop or nullify `songs.station_id`) is blocked by **every one of the references listed above**. The rotation engine (`loggen.ts` line 153) is the most critical: it uses `station_id` to scope song picks in the live scheduler. Until that scoping is rewritten to use `station_programming.station_id` instead of `songs.station_id`, dropping the column will break rotation globally.

The `separation_rules` component does not directly reference `songs.station_id` — its scoping is via `separation_rules.station_id` (see `src/audio/loggen.ts` line 111: `WHERE is_active = 1 AND station_id = ?`). However, the artist-separation subquery at `loggen.ts` line 176 does reference `songs.station_id` via `s2.station_id`, so separation_rules execution is indirectly blocked.

**Minimum path to unblock v8:**
1. Migrate `loggen.ts` song-pick queries to use `station_programming` as the filtering relation (Direction C architecture).
2. Migrate all App.tsx library-panel queries to filter by `station_programming.station_id` via a JOIN rather than `songs.station_id` directly.
3. Migrate `songAnalysis.ts` similarly.
4. Remove or nullify `songs.station_id` in the migration, then update remaining references.

---

## BONUS — `station_config_kv.station_id` NOT NULL Bug

### Ba — CREATE TABLE statement

**File:** `scripts/migrate-phase-a-v8.js`, lines 361–367 (the v8 migration creates the definitive table shape):

```sql
CREATE TABLE station_config_kv (
  station_id INTEGER NOT NULL,
  key        TEXT    NOT NULL,
  value      TEXT,
  uuid       TEXT    NOT NULL,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch()),
  ...
)
```

The composite PK table was first created inline in `electron/main.js` around line 587–592 with `station_id INTEGER NOT NULL DEFAULT 0`. The v8 migration (`migrate-phase-a-v8.js` line 362) drops the `DEFAULT 0` but keeps `NOT NULL`.

### Bb — station_id IS NOT NULL confirmed

Yes — `station_id INTEGER NOT NULL` with no default appears in the v8 migration at `scripts/migrate-phase-a-v8.js` line 362. Any INSERT that omits `station_id` will fail at the SQLite level.

### Bc — Key classification

The following keys are written to `station_config_kv` by renderer code **without providing `station_id`** (all use `INSERT OR REPLACE INTO station_config_kv (key, value) VALUES (?,?)` — no station_id column):

| Key | Write site | station_id in INSERT? | Correct scope |
|---|---|---|---|
| `canvas_layout` | `src/canvas/CanvasEngine.tsx` line 13 | NO | Station-scoped (per-station canvas layout) |
| `canvas_layout_version` | `src/canvas/CanvasEngine.tsx` line 123 | NO | Station-scoped (version bump is per-station) |
| `canvas_profiles` | `src/canvas/CanvasEngine.tsx` lines 226, 249 | NO | Station-scoped |
| `canvas_active_name` | `src/canvas/CanvasEngine.tsx` lines 230, 241, 256 | NO | Station-scoped |
| `last_operator_id` | `src/components/OnShiftScreen.tsx` line 235 | NO | Questionable — could be install-scoped (who last logged in) or station-scoped (last operator on THIS station). Current table requires station_id; install_config_kv would be more appropriate. |
| `video_audio_input` | `src/components/ShowPlus.tsx` line 2449 | NO | Install-scoped — device IDs are per physical machine, not per station. Should live in `install_config_kv`. |
| `video_audio_output` | `src/components/ShowPlus.tsx` line 2450 | NO | Install-scoped — same reasoning as above. |
| `video_self_monitor` | `src/components/ShowPlus.tsx` line 2451 | NO | Install-scoped — UI preference per machine. |
| `video_mic_volume` | `src/components/ShowPlus.tsx` line 2452 | NO | Install-scoped — device volume is per machine. |
| `video_monitor_volume` | `src/components/ShowPlus.tsx` line 2453 | NO | Install-scoped — same reasoning. |

**Impact:** All of these INSERTs will fail at runtime once the v8 migration is applied (station_id NOT NULL, no DEFAULT). They currently only work because the old pre-v8 table had `DEFAULT 0`. After v8 runs, all 10 write sites above will throw SQLite constraint errors unless they are either (a) updated to pass station_id, or (b) moved to `install_config_kv` for the install-scoped keys.

The five `video_*` keys from ShowPlus.tsx should be moved to `install_config_kv` because they represent per-machine hardware configuration (audio device IDs and volume levels do not change per station — they change per physical install). `last_operator_id` should be evaluated: if it means "last operator to log in on this machine regardless of station," it belongs in `install_config_kv`; if it means "last operator to work on this station," it stays in `station_config_kv` but the INSERT must supply station_id.

---

## Closure Order

Recommended sequence based on dependencies:

### Priority 1 — ITEM 1 (UUID INSERT gap) — **Before v3.1.0 tag**

All renderer INSERT sites that target synced tables must generate a UUID before writing. This is a data-integrity prerequisite for sync. No second client can ever onboard cleanly until rows have stable UUIDs.

**Suggested fix:** Add a `generateUUID()` helper to `src/db/stationScoped.ts` that calls `crypto.randomUUID()` and inject it into `executeScopedInsert` automatically, similar to how station_id is injected. Then audit all direct `execute(INSERT ...)` calls for synced tables and add UUID generation there.

### Priority 2 — BONUS (station_config_kv NOT NULL bug) — **Before v8 migration runs**

The five `video_*` keys in ShowPlus.tsx and `last_operator_id` in OnShiftScreen.tsx must be addressed before the v8 migration is run. The v8 migration (`migrate-phase-a-v8.js`) drops `DEFAULT 0` from `station_id` — after that, all write sites above will throw at runtime. This is a live correctness bug in the next migration commit.

### Priority 3 — ITEM 4 (Session D handler locking) — **Before Session C migration begins**

Add the synced-table guard to `db:execute` in `electron/main.js` line 1186 before beginning the renderer migration. Without the guard, migrated call sites can be bypassed and the migration cannot be declared complete.

### Priority 4 — ITEM 3 (Session C renderer migration) — **After Items 1 and 4**

Migrate all Category (1) renderer write sites to their typed `window.ether.*` equivalents. The `station_config_kv` writes are the largest cluster (~25 sites across 8 files). Start with `ShowPlus.tsx` as it has the most sites.

### Priority 5 — ITEM 2 (N-70 transformer violation) — **Before second client onboards**

Resolve open question [Q-15] (which timestamp default semantics to use), then implement the real transformer for migration 2. This is safe to defer as long as no v1 peers exist, but must be done before any cross-device sync is attempted.

### Priority 6 — ITEM 5 (v8 migration / songs.station_id drop) — **After Session C complete**

The v8 song scoping migration is the largest architectural change and requires the rotation engine (`loggen.ts`) and the library panel (`App.tsx`) to be rewritten to use `station_programming` as the filtering relation. This is a multi-commit effort and depends on Session C being complete (so renderer writes are properly mutation-logged).

---

*End of Phase 3.5 Status Audit — 2026-05-04*
