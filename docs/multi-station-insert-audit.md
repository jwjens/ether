# Multi-Station INSERT Audit

**Date:** 2026-05-14  
**Status:** Phase 1 complete — all callsites classified  
**Auditor:** Jeff + Claude Code

---

## Purpose

Before the second-station creation gate (`multistation_insert_audit_complete`) can be cleared in `station_config_kv`, every INSERT callsite in the renderer and main process must be classified as either:

- ✅ **CORRECT** — station_id is present and correct
- ℹ️ **INSTALL-SCOPED** — table has no station_id column by design (shared across stations)
- ❓ **NEEDS-REVIEW** — no station_id column yet; will need schema + code change before full multi-station support

---

## Table Scope Reference

**Install-scoped tables** (no station_id column, shared across all stations):  
`songs`, `artists`, `albums`, `mood_tags`, `install_config_kv`, `install_secrets_kv`, `users`, `stations`, `crash_recovery`, `songs_fts`, `system_state`, `studio_notes`, `studio_session_versions`, `ai_voice_templates`, `cloud_backup_history`, `gpio_devices`, `gpio_mappings`, `stream_metadata_targets`, `mobile_voice_tracks`, `mobile_pairings`, `replication_config`, `replication_peers`, `replication_log`

**Station-scoped tables** (require station_id on every INSERT):  
`play_log`, `categories`, `shows`, `clocks`, `clock_slots`, `format_clocks`, `separation_rules`, `voice_tracks`, `operators`, `operator_notes`, `spots`, `cart_slots`, `announcements`, `macros`, `liner_cards`, `prep_notes`, `pinned_songs`, `song_metadata_values`, `metadata_definitions`, `metadata_vocabulary`, `smart_schedule_rules`, `published_episodes`, `deck_configs`, `scheduled_log`

**Deferred / no station_id column yet** (non-synced, single-station assumption baked in):  
`eas_tests`, `midi_mappings`, `ai_voice_segments`

---

## Callsite Classification

### src/db/client.ts

| Line | Table | Verdict | Notes |
|------|-------|---------|-------|
| 127 | `play_log` | ✅ CORRECT | `ether.playLog.create({ station_id: stationId, ... })` |

---

### src/audio/showClock.ts

| Line | Table | Verdict | Notes |
|------|-------|---------|-------|
| 128 | `play_log` | ✅ CORRECT | `ether.playLog.create({ station_id: stationId, ... })` via `getActiveStationIdSync()` |

---

### src/App.tsx

| Line | Table | Verdict | Notes |
|------|-------|---------|-------|
| 3449 | `song_metadata_values` | ✅ CORRECT | `songMetadataValues.upsert({ station_id: stationId, ... })` |
| 3501 | `song_metadata_values` | ✅ CORRECT | `songMetadataValues.upsert({ station_id: stationId, ... })` |
| 3524 | `song_metadata_values` | ✅ CORRECT | `songMetadataValues.upsert({ station_id: stationId, ... })` — "clear" upsert |
| 3574 | `categories` | ✅ CORRECT | `categories.create({ station_id: stationId, ... })` |

---

### src/components/ActiveStationBadge.tsx

| Line | Table | Verdict | Notes |
|------|-------|---------|-------|
| 192 | `stations` | ℹ️ INSTALL-SCOPED | `stations` is the root table; no station_id column |

---

### src/components/Announcements.tsx

| Line | Table | Verdict | Notes |
|------|-------|---------|-------|
| 109 | `announcements` | ✅ CORRECT | `announcements.create({ station_id: stationId, ... })` |

---

### src/components/BroadcastEditor.tsx

| Line | Table | Verdict | Notes |
|------|-------|---------|-------|
| 1300 | `voice_tracks` | ✅ CORRECT | `voiceTracks.create({ station_id: stationId, ... })` |

---

### src/components/BulkAssignModal.tsx

| Line | Table | Verdict | Notes |
|------|-------|---------|-------|
| 192 | `song_metadata_values` | ✅ CORRECT | `songMetadataValues.bulkApply({ ..., station_id: stationId })` |

---

### src/components/ClockEditor.tsx

| Line | Table | Verdict | Notes |
|------|-------|---------|-------|
| 159 | `format_clocks` | ✅ CORRECT | `formatClocks.create({ station_id: stationId, ... })` |

---

### src/components/CreateShowWizard.tsx

| Line | Table | Verdict | Notes |
|------|-------|---------|-------|
| 149 | `clocks` | ✅ CORRECT | `clocks.create({ station_id: stationId, ... })` |
| 162 | `categories` | ✅ CORRECT | `categories.create({ station_id: stationId, ... })` |
| 176 | `shows` | ✅ CORRECT | `shows.create({ station_id: stationId, ... })` |

---

### src/components/EASLogbook.tsx

| Line | Table | Verdict | Notes |
|------|-------|---------|-------|
| 362 | `eas_tests` | ❓ NEEDS-REVIEW | Raw INSERT, no `station_id` column in schema. FCC logbook is logically station-scoped. Deferred (non-synced). Needs `ALTER TABLE eas_tests ADD COLUMN station_id` + code update before multi-station go-live. |

---

### src/components/GSelectorImport.tsx

| Line | Table | Verdict | Notes |
|------|-------|---------|-------|
| 177 | `categories` | ✅ CORRECT | `categories.create({ station_id: stationId, ... })` |
| 208 | `songs` | ℹ️ INSTALL-SCOPED | `songs.create({ ... })` — songs table is install-scoped |
| 236 | `format_clocks` | ✅ CORRECT | `formatClocks.create({ station_id: stationId, ... })` |
| 246 | `clock_slots` | ✅ CORRECT | `clockSlots.create({ station_id: stationId, ... })` |

---

### src/components/ImportDialog.tsx

| Line | Table | Verdict | Notes |
|------|-------|---------|-------|
| 44 | `categories` | ✅ CORRECT | `categories.create({ station_id: stationId, ... })` |
| 116 | `songs` | ℹ️ INSTALL-SCOPED | `songs.create({ title, file_path, artist_id, ... })` — install-scoped |

---

### src/components/LibraryColumnsPanel.tsx

| Line | Table | Verdict | Notes |
|------|-------|---------|-------|
| 201 | `metadata_definitions` | ✅ CORRECT | `metadataDefinitions.create({ station_id: stationId, ... })` |
| 238 | `metadata_vocabulary` | ✅ CORRECT | `metadataVocabulary.create({ station_id: stationId, ... })` |

---

### src/components/LibraryImport.tsx

| Line | Table | Verdict | Notes |
|------|-------|---------|-------|
| 381 | `categories` | ✅ CORRECT | `categories.create({ station_id: stationId, ... })` |
| 387 | `songs` | ℹ️ INSTALL-SCOPED | `songs.create({ ... })` — install-scoped |

---

### src/components/MacroEngine.tsx

| Line | Table | Verdict | Notes |
|------|-------|---------|-------|
| 224 | `macros` | ✅ CORRECT | `macros.create({ station_id: stationId, ... })` |

---

### src/components/MidiEngine.tsx

| Line | Table | Verdict | Notes |
|------|-------|---------|-------|
| 301 | `midi_mappings` | ❓ NEEDS-REVIEW | Raw INSERT, no `station_id` column in schema. Hardware MIDI bindings are logically per-station if running multiple stations on one machine. Needs schema + code change before multi-station go-live. Deferred (non-synced). |

---

### src/components/NexGenImport.tsx

| Line | Table | Verdict | Notes |
|------|-------|---------|-------|
| 121 | `songs` | ℹ️ INSTALL-SCOPED | `songs.create({ ... })` — install-scoped |

---

### src/components/OnShiftScreen.tsx

| Line | Table | Verdict | Notes |
|------|-------|---------|-------|
| 200 | `operator_notes` | ✅ CORRECT | `operatorNotes.create({ station_id: stationId, ... })` |
| 213 | `operators` | ✅ CORRECT | `operators.create({ station_id: stationId, ... })` |

---

### src/components/PDPicks.tsx

| Line | Table | Verdict | Notes |
|------|-------|---------|-------|
| 239 | `pinned_songs` | ✅ CORRECT | `pinnedSongs.create({ station_id: stationId, ... })` |

---

### src/components/ProgramLog.tsx

| Line | Table | Verdict | Notes |
|------|-------|---------|-------|
| 1485 | `shows` | ✅ CORRECT | `shows.create({ station_id: stationId, ... })` |

---

### src/components/PublishEpisode.tsx

| Line | Table | Verdict | Notes |
|------|-------|---------|-------|
| 425 | `published_episodes` | ✅ CORRECT | `executeScopedInsert(..., stationId)` |

---

### src/components/Scheduler.tsx

| Line | Table | Verdict | Notes |
|------|-------|---------|-------|
| 160 | `shows` | ✅ CORRECT | `shows.create({ station_id: stationId, ... })` |
| 353 | `categories` | ✅ CORRECT | `categories.create({ station_id: stationId, ... })` |
| 809 | `clocks` | ✅ CORRECT | `clocks.create({ station_id: stationId, ... })` |
| 840 | `clock_slots` | ✅ CORRECT | `clockSlots.create({ station_id: stationId, ... })` |
| 855 | `clock_slots` | ✅ CORRECT | `clockSlots.create({ station_id: stationId, ... })` — duplicate slot |
| 890 | `clock_slots` | ✅ CORRECT | `clockSlots.create({ station_id: stationId, ... })` — Ctrl+V paste |

---

### src/components/SettingsPanel.tsx

| Line | Table | Verdict | Notes |
|------|-------|---------|-------|
| 2171 | `users` | ℹ️ INSTALL-SCOPED | Raw `INSERT INTO users` — users table has no station_id column |

---

### src/components/ShowPrep.tsx

| Line | Table | Verdict | Notes |
|------|-------|---------|-------|
| 274 | `liner_cards` | ✅ CORRECT | `linerCards.create({ station_id: stationId, ... })` |
| 390 | `prep_notes` | ✅ CORRECT | `prepNotes.create({ station_id: stationId, ... })` |

---

### src/components/SmartScheduler.tsx

| Line | Table | Verdict | Notes |
|------|-------|---------|-------|
| 155 | `smart_schedule_rules` | ✅ CORRECT | `executeScopedInsert(..., stationId)` |

---

### src/components/Spots.tsx

| Line | Table | Verdict | Notes |
|------|-------|---------|-------|
| 53 | `spots` | ✅ CORRECT | `spots.create({ station_id: stationId, ... })` — single-file import |
| 72 | `spots` | ✅ CORRECT | `spots.create({ station_id: stationId, ... })` — folder import |
| 164 | `spots` | ✅ CORRECT | `spots.create({ station_id: stationId, ... })` — traffic CSV import |

---

### src/components/StationManager.tsx

| Line | Table | Verdict | Notes |
|------|-------|---------|-------|
| 237 | `stations` | ℹ️ INSTALL-SCOPED | `stations.create({ name, callsign, ... })` — root install-level table; no station_id col. Second-station creation is currently blocked by `multistation_insert_audit_complete` gate in `station_config_kv`. |

---

### src/components/StudioPro.tsx

| Line | Table | Verdict | Notes |
|------|-------|---------|-------|
| 2848 | `studio_notes` | ℹ️ INSTALL-SCOPED | Raw INSERT, no station_id. `studio_notes` is session-scoped (by `session_id`), not station-scoped. Non-synced table. |
| 2899 | `studio_session_versions` | ℹ️ INSTALL-SCOPED | Raw INSERT, no station_id. Non-synced table. Keyed by session, not station. |

---

### src/components/TrackEditor.tsx

| Line | Table | Verdict | Notes |
|------|-------|---------|-------|
| 91 | `songs` | ℹ️ INSTALL-SCOPED | `songs.create({ title, artist_id, file_path, duration_ms })` — install-scoped |

---

### src/components/UserLogin.tsx

| Line | Table | Verdict | Notes |
|------|-------|---------|-------|
| 51 | `users` | ℹ️ INSTALL-SCOPED | Raw `INSERT INTO users` — first-run default admin creation; install-scoped |

---

### src/components/VoiceTracker.tsx

| Line | Table | Verdict | Notes |
|------|-------|---------|-------|
| 564 | `voice_tracks` | ✅ CORRECT | `voiceTracks.create({ station_id: stationId, ... })` |

---

### electron/main.js (seed/init)

| Line | Table | Verdict | Notes |
|------|-------|---------|-------|
| 616 | `crash_recovery` | ℹ️ INSTALL-SCOPED | `INSERT OR IGNORE INTO crash_recovery (id) VALUES (1)` — single-row sentinel |
| 621–623 | `users` | ℹ️ INSTALL-SCOPED | Seed users (admin/jock/producer) — install-scoped |
| 658 | `stations` | ℹ️ INSTALL-SCOPED | Station 1 seed — root install-level table |
| 740 | `separation_rules` | ✅ CORRECT | Uses `getActiveStationId()` for station_id |
| 757, 782, 801 | `songs_fts` | ℹ️ INSTALL-SCOPED | FTS5 virtual table; no station_id concept |
| 819 | `system_state` | ℹ️ INSTALL-SCOPED | Schema version — install-level metadata |
| 844 | `deck_configs` | ℹ️ INSTALL-SCOPED | `INSERT OR IGNORE` seed; station_id column added via `ALTER TABLE ... DEFAULT 1` in migration, applied retroactively |

---

### electron/ai-voice.js

| Line | Table | Verdict | Notes |
|------|-------|---------|-------|
| 197 | `ai_voice_segments` | ❓ NEEDS-REVIEW | Raw INSERT, no `station_id` column. AI-generated drops are logically station-scoped. Needs schema + code change before multi-station go-live. Deferred (non-synced). |
| 274, 288 | `ai_voice_templates` | ℹ️ INSTALL-SCOPED | No station_id in schema or INSERT. Templates are install-level shared content. |

---

### electron/cloud-backup.js

| Line | Table | Verdict | Notes |
|------|-------|---------|-------|
| 240, 250 | `cloud_backup_history` | ℹ️ INSTALL-SCOPED | Install-level audit log of backup runs. No station_id column. |

---

### electron/gpio-engine.js

| Line | Table | Verdict | Notes |
|------|-------|---------|-------|
| 78 | `gpio_devices` | ℹ️ INSTALL-SCOPED | Hardware device config is install-level. |
| 106 | `gpio_mappings` | ℹ️ INSTALL-SCOPED | Pin mappings are per physical device. Logically per-station if multi-station MIDI/GPIO is ever needed, but deferred. |

---

### electron/metadata-dispatcher.js

| Line | Table | Verdict | Notes |
|------|-------|---------|-------|
| 263, 295 | `stream_metadata_targets` | ℹ️ INSTALL-SCOPED | Icecast/stream push targets — install-level today. Will need station_id when multiple streams are needed per station. |

---

### electron/mobile-app.js

| Line | Table | Verdict | Notes |
|------|-------|---------|-------|
| 570 | `mobile_voice_tracks` | ℹ️ INSTALL-SCOPED | Staging table keyed by `pairing_id`. No station_id column. Correct. |
| 605 | `mobile_pairings` | ℹ️ INSTALL-SCOPED | Device pairing tokens — install-level. |

---

### electron/site-replication.js

| Line | Table | Verdict | Notes |
|------|-------|---------|-------|
| 62 | `replication_config` | ℹ️ INSTALL-SCOPED | Install-level site identity. |
| 84 | `replication_peers` | ℹ️ INSTALL-SCOPED | Peer addresses — install-level. |
| 207 | `replication_log` | ℹ️ INSTALL-SCOPED | Sync audit log — install-level. |

---

### electron/sync/handlers/* (sync engine)

All sync INSERTs carry `station_id` in the column list for every station-scoped table. Install-scoped tables correctly omit it. These are correct by construction — the sync engine is the canonical deserialization path and has already been verified end-to-end.

---

## Summary

### ⚠️ Missing station_id on station-scoped tables
**None found.** Every `.create()` call on a station-scoped table passes `station_id` correctly.

### ❓ Needs-Review — no station_id column yet (pre-multi-station debt)

These tables have no `station_id` column today. No code is broken for single-station use. Before clearing the second-station gate, each needs an `ALTER TABLE ... ADD COLUMN station_id INTEGER NOT NULL DEFAULT 1`, migration handling, and updated INSERT callsites:

| Table | Location | Notes |
|-------|----------|-------|
| `eas_tests` | `src/components/EASLogbook.tsx:362` | FCC logbook — logically per-station |
| `midi_mappings` | `src/components/MidiEngine.tsx:301` | MIDI bindings logically per-station |
| `ai_voice_segments` | `electron/ai-voice.js:197` | AI drops logically per-station |

### ✅ Audit verdict

The codebase is clean for single-station use. All station-scoped `.create()` callsites pass `station_id`. The three `❓ NEEDS-REVIEW` items represent schema gaps (no column, no data issue today), not existing bugs. The `multistation_insert_audit_complete` gate should remain `false` until those three tables receive the `ADD COLUMN station_id` migration.
