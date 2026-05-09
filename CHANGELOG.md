## [4.1.0] — 2026-05-08

### Phase 3.5 — Sync-Readiness Arc

**Multi-client sync foundation locked.** Every code path that writes to a synced table now goes through the sync layer. Direct writes from the renderer to synced tables are blocked at the IPC boundary. The codebase is sync-safe by construction.

**Item 1 — UUID INSERT gap (audit, no-op)**
- Audit confirmed every typed handler enforces `uuid = payload.uuid ?? crypto.randomUUID()`. No gap to fix.
- Mutation-writer throws on missing row_id — silent corruption is not possible.

**Item 2 — migrate-timestamps payloadTransformer**
- Identity transformer replaced with proper defaults injection for v1 payloads.
- `created_at`/`updated_at` default to wall-clock at receive time; `deleted_at` defaults to null.
- [Q-15] resolved in protocol doc with rationale.

**Item 3 — Session C: renderer migration to typed handlers**
- main.js initial schema aligned with live DB across 6 tables (play_log, scheduled_log, midi_mappings, studio_sessions, studio_session_versions, studio_notes). 14 columns added to scheduled_log; 9 to play_log; 4 new tables.
- New `npm run verify:schema` infrastructure validates main.js CREATE TABLE block against expected columns.
- 6 renderer DDL statements removed (5 CREATE TABLE, 4 ALTER TABLE) — schema now exclusively owned by main.js.
- shows CRUD migrated from db:execute to typed handlers (4 sites).
- songs.last_played_at writes migrated (2 sites).
- 4 new batch methods added to scheduled_log handler: clearByHour, clearByDate, batchInsert, batchUpdatePosition.
- ProgramLog scheduled_log writes migrated to batch handlers (8 sites).
- Each batched DB operation produces one mutation log entry per affected row (sync correctness preserved).

**Item 4 — Session D: db:execute guard hardening**
- IPC-layer guard rejects INSERT/UPDATE/DELETE/REPLACE against synced tables with descriptive error.
- Hardened against quoted identifiers, schema-prefixed names, leading SQL comments, and INSERT/UPDATE OR variants.
- Activation log fires at startup confirming guard is live.
- 31 synced tables locked from direct writes.

### Deferred (parked for future arcs)

- Group 4 (published_episodes typed handler) — feature not yet built. Belongs to Show+ podcast publishing arc.
- Group 8 (SmartScheduler smart_schedule_rules) — schema audit needed first. Will write through guard once migrated.
- Group 9 (CloudBackup restore protocol) — privileged batch restore needs dedicated IPC channel. Own arc.

### Known follow-up work (not blocking v4.1.0)

- 9 synced tables get written directly from main.js (`db.prepare().run()`) bypassing the mutation log. These are main-process trusted writes (bootstrap, station config, metadata editor, RTMP destinations, Spotify import). Logging this for a future "main.js mutation log integration" arc.
- Lazy UUID backfill: rows that exist but never get touched retain integer-only state. Acceptable for sync (untouched rows generate no mutations) but worth a one-time bulk backfill before any audit-heavy use case.
- Schedule generation UI buttons (Generate Hour, Day, Week) currently not rendered in Shows & Dayparts. Backend `scheduleOneHour`/`fillDay` functions intact and verified working via DevTools test. UI restoration is its own focused commit.

### Engineering bar held

Discovery before code on every commit. Foundation file changes (`electron/main.js`, `electron/sync/handlers/*`) gated by explicit per-commit approval. Smoke tests between commits, never chained. Cleanup commits separate from feature commits. No corners cut.

---

## [4.0.0] — 2026-05-07

### Library Arc Close-Out

**Library panel rebuild**
- Three-track CSS Grid layout: frozen left (checkbox + # + Title), middle paged columns, frozen right action zone (A/B/C/Q/Cue/×)
- Action zone always visible on every row (no more hover-conditional rendering)
- Inline metadata column rendering restored (no longer behind modal)
- Per-station Title column drag-resize with localStorage persistence
- Comfortable default column widths per data type

**Column paging**
- Adaptive column packing: middle columns paginate when they don't fit the available width
- Prev/next arrows in header (◀ Page X / Y ▶) with disabled state at boundaries
- ResizeObserver-driven page recalculation; clamps current page on shrink
- Per-station page index persistence

**Three-slot top bar (ON AIR / NEXT / AFTER)**
- Replaces single-slot NowPlayingPill with three queue-position slots
- Reads queue[0..2] for content; deck A state for ON AIR countdown
- Channel-color dots (cyan/green/purple) per slot
- Amber color shift on remaining time below 15s

**Button visual feedback**
- A/B/C/Q/Cue/× action buttons get hover brightness lift and active-state press feedback
- CSS-only, no React re-render overhead

**Vocab management**
- Right-click context menu on vocab values replaces dangerous inline × button
- Explicit confirmation dialog before deletion
- Outside-click and Escape dismissal

**Engine performance**
- Engine poll interval relaxed from 100ms to 250ms
- Listener fire change-detection prevents redundant React state updates on idle decks
- `loadToDeck` fires listeners synchronously for instant React updates

**Keyboard**
- A key toggles automation on/off (input field guard prevents firing while typing)

### Known Issues / Parked

- `detect_song_cue_points` IPC handler missing — autoCueSong calls fail silently with ~200ms stall per click
- MacroEngine clock-trigger polling unindexed — ~150-565ms DB hits per check
- crash_recovery saveQueue writes ~370ms unthrottled
- Backend command endpoints (/api/cmd, /api/pending-cmds) have no authentication — must address before external pilot promotion
- RemoteCmd polls every 2s with 4s timeout — SSE migration planned

### Deferred

- Y1-take-2: deck-direct loads with on-air lock (proper discovery needed)
- Y3 polish: progress fill on ON AIR slot, marquee scroll on long titles in NEXT/AFTER
