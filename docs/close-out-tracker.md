# Ether — Close-Out Tracker

> **Last updated:** 2026-05-09 (P2 MacroEngine performance — closed)
>
> Canonical list of every open arc, parked item, and known issue. Update this file at the start of each new arc, not at the end.

---

## Phase 3.5 — Sync follow-up (non-blocking, post-v4.1.0)

| # | Item | Notes |
|---|------|-------|
| S1 | **Group 4 — `published_episodes` typed handler** | Feature not yet built. Belongs to Show+ podcast publishing arc. Write handler when feature ships. |
| S2 | **Group 8 — `smart_schedule_rules` typed handler** | Schema audit needed first. SmartScheduler writes go through guard but not mutation log yet. |
| S3 | **Group 9 — CloudBackup restore protocol** | Privileged batch restore needs dedicated IPC channel (not db:execute). Own arc. |
| S4 | **main.js mutation log integration** | 9 synced tables written directly from main.js (`db.prepare().run()`) bypass the mutation log. Affected code paths: bootstrap, station config, metadata editor, RTMP destinations, Spotify import. Logging for future "main.js mutation log" arc. |
| S5 | **Lazy UUID backfill** | Rows that existed before sync was added retain integer-only state. Untouched rows generate no mutations so acceptable for sync, but worth a one-time bulk backfill before any audit-heavy use case. |

---

## Performance arc (P-series)

| # | Item | Measured cost | Notes |
|---|------|---------------|-------|
| P1 | **`detect_song_cue_points` IPC handler missing** | ~200 ms stall per autoCue click | Handler not registered in main.js. AutoCueSong calls fail silently. |
| ~~P2~~ | ~~**MacroEngine clock-trigger polling unindexed**~~ | ~~~150–565 ms DB hit per poll~~ | ~~Add composite index on `macros(station_id, trigger_type)` or similar.~~ ✓ 5532bc2 — indexes added, clock watcher converted to `useMacroClock` hook (pure-JS check, no DB hit per tick), hotkey watcher event-driven via `ether:macros-changed` |
| P3 | **`crash_recovery` saveQueue writes** | ~55 ms, one-shot on startup | Tracker description was wrong — `onQueueChange` is a no-op; writes fire every 30s via interval (benign) + one clear after crash restore. Real improvement is event-driven debounce via `ether:queue-changed` + 30s fallback. Parked — not actively broken, good engineering but not urgent. |
| P4 | **RemoteCmd polling** | 2 s poll / 4 s timeout | SSE migration planned. |

---

## Security arc

| # | Item | Notes |
|---|------|-------|
| SEC1 | **Backend command endpoints unauthenticated** | `/api/cmd` and `/api/pending-cmds` have no auth. Must address before external pilot promotion. |

---

## Library polish (L-series, parked from v4.0.0)

| # | Item | Notes |
|---|------|-------|
| Y1 | **Deck-direct loads with on-air lock (Y1-take-2)** | Proper discovery needed before implementation. Parked. |
| Y3 | **ON AIR slot polish** | Progress fill on ON AIR slot; marquee scroll on long titles in NEXT/AFTER slots. |
| X1.2 | **Library panel refinements** | Minor UX polish items identified during v4.0.0 build. |

---

## UX restoration (parked)

| # | Item | Notes |
|---|------|-------|
| U1 | **Schedule generation UI buttons** | "Generate Hour / Day / Week" buttons not rendered in Shows & Dayparts. Backend `scheduleOneHour`/`fillDay` functions intact and verified via DevTools. UI restoration is its own focused commit. |
| U2 | **MIDI mapping UI** | MIDI mappings table exists; UI review needed. |
| U3 | **Menu / nav rename pass** | MenuBar in App.tsx is dead code. Native Electron menu + inline header buttons drive nav. Review naming consistency. |

---

## PlayLog arc

| # | Item | Notes |
|---|------|-------|
| ~~PL1~~ | ~~**Manual plays silently unlogged**~~ | ~~All music-deck plays (manual + auto) now log via engine state-transition hook.~~ ✓ ba1cbfd |
| PL2 | **PlayLog typed handler migration** | play_log schema aligned in v4.1.0. Any remaining db:execute writes to play_log not yet audited. |
| PL3 | **`notifyPlayStart` / `onPlayStart` dead code** | Removed from all call sites in ba1cbfd. The `notifyPlayStart()`, `onPlayStart()`, and `playStartCallbacks` members in engine-rodio.ts are now unused. Remove in a cleanup commit. |

---

## Tablet / mobile polish arc

| # | Item | Notes |
|---|------|-------|
| T1 | **Responsive layout pass** | Touch targets, column layout at narrow widths. No spec yet. |

---

## Big arcs (future, no timeline)

| Arc | Description |
|-----|-------------|
| **Phase F — CRDT sync** | Full multi-client CRDT-based sync using mutation log. Foundation locked in Phase 3.5. Implementation arc is its own project. |
| **AUX / Live DJ deck** | Slot D (or configurable) set to type="music" and enabled. Infrastructure identical to A/B/C — no schema or engine changes needed. Play logging, sync, and PRO reporting all inherit automatically via deckConfig.type filter. UI work: deck-order display, crossfade behavior for live DJ handoff. |
| **AoIP console** | Dante / AES67 audio-over-IP integration. No spec. |
| **Multi-station operator tier** | Multiple simultaneous stations per install. Schema partially supports it (station_id everywhere). |
| **PD dashboard** | Program director analytics view over play_log / scheduled_log data. |
| **Show+ podcast publishing** | Published episodes pipeline (Group 4 handler belongs here). |

---

## How to use this file

1. **Starting an arc** — pull the relevant rows into the arc's working doc; mark them `[in progress]` here.
2. **Closing an arc** — strike through or delete resolved rows; add the version in the Notes column.
3. **New discoveries** — append to the relevant section immediately, not at session end.
4. **Priority** — rows have no inherent priority order. Prioritize in the arc planning doc, not here.
