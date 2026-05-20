# Ether — Close-Out Tracker

> **Last updated:** 2026-05-10 (Item 10 — Tablet Polish arc — closed)
>
> Canonical list of every open arc, parked item, and known issue. Update this file at the start of each new arc, not at the end.

---

## Phase 3.5 — Sync follow-up (non-blocking, post-v4.1.0)

| # | Item | Notes |
|---|------|-------|
| ~~S0~~ | ~~**`songs.station_id` drop (Item 8)**~~ | ~~16 renderer SQL filters + 4 JOIN conditions removed. songs.js INSERT + Spotify import INSERT cleaned. `stationTables` alterSafe loop updated. Registry entry removed. Migration script v12 shipped. Live DB migrated (381 songs). schema_version = [1..12].~~ ✓ 8270bdc. Note: v11 schema_version row was missing (DDL ran via main.js startup but INSERT was never written); fixed via one-off script before v12 ran. Future DDL-only migrations must explicitly INSERT their version. |
| S1 | **Group 4 — `published_episodes` typed handler** | Feature not yet built. Belongs to Show+ podcast publishing arc. Write handler when feature ships. |
| S2 | **Group 8 — `smart_schedule_rules` typed handler** | Schema audit needed first. SmartScheduler writes go through guard but not mutation log yet. |
| S3 | **Group 9 — CloudBackup restore protocol** | Privileged batch restore needs dedicated IPC channel (not db:execute). Own arc. |
| ~~S4~~ | ~~**main.js mutation log integration**~~ | ~~All direct `db.prepare().run()` writes in main.js routed through typed handlers with `withMutation`/`logMutation`. Commit A: bootstrap + deck-configs reset + RTMP + playout server (4247b4d). Commit B: discogs + library track writes (486b861). Commit C: stations CRUD (6989985). Commit D: schedule:generate bulk clear + bulk insert (3f1280a).~~ ✓ |
| S5 | **Lazy UUID backfill** | Rows that existed before sync was added retain integer-only state. Untouched rows generate no mutations so acceptable for sync, but worth a one-time bulk backfill before any audit-heavy use case. |
| S6 | **UPDATE-fallback INSERT OR REPLACE can collide on integer pk** | `merge-engine.js` _applyToLiveTable: when a row is absent locally, an UPDATE mutation falls back to `INSERT OR REPLACE`. If the payload carries a concrete `id` (e.g. Mornings UPDATE id=1), that fallback INSERT OR REPLACE will displace any row that already occupies id=1 via autoincrement (e.g. "test show" landed at id=1 after its id=null INSERT). Observed live: test show displaced by Mornings on fresh-client drain. No live-data impact (test show is deleted in real DB), but the same collision class that caused the mid day / overnight6 bug (fixed N-108d). Fix: UPDATE-fallback path should INSERT with id excluded (or NULL), letting SQLite assign a fresh autoincrement, then apply the id via a follow-up UPDATE — same intent as the lazy-payload fix applied to showsCreate. |

---

## Performance arc (P-series)

| # | Item | Measured cost | Notes |
|---|------|---------------|-------|
| ~~P1~~ | ~~**`detect_song_cue_points` IPC handler missing**~~ | ~~~200 ms stall per autoCue click~~ | ~~Handler not registered in main.js. AutoCueSong calls fail silently.~~ ✓ 3180cfb |
| ~~P2~~ | ~~**MacroEngine clock-trigger polling unindexed**~~ | ~~~150–565 ms DB hit per poll~~ | ~~Add composite index on `macros(station_id, trigger_type)` or similar.~~ ✓ 5532bc2 — indexes added, clock watcher converted to `useMacroClock` hook (pure-JS check, no DB hit per tick), hotkey watcher event-driven via `ether:macros-changed` |
| ~~P3~~ | ~~**`crash_recovery` saveQueue event-driven debounce**~~ | ~~~30s recovery staleness today~~ | ~~`onQueueChange` was a no-op; writes fired every 30s via interval. Replaced with debounced `ether:queue-changed` event + `engine.on()` status-diff + 30s fallback. All 11 mutation sites wired.~~ ✓ 02bd358 |
| P4 | **RemoteCmd polling** | 2 s poll / 4 s timeout | SSE migration planned. |

---

## Security arc

| # | Item | Notes |
|---|------|-------|
| SEC1 | **Backend command endpoints unauthenticated** | `/api/cmd` and `/api/pending-cmds` have no auth. Must address before external pilot promotion. |

---

## ether-backend follow-ups

| # | Item | Notes |
|---|------|-------|
| EB1 | **`license_activations.license_key` should migrate to `license_key_id INTEGER` FK** | Match the mutations table pattern (`license_key_id INTEGER REFERENCES licenses(id)`). Today the column is `TEXT NOT NULL` carrying the raw key string, which works for legacy plaintext rows where `licenses.license_key` is non-null. For new bcrypt-only rows the `licenses.license_key` column is NULL, so `/account/create` falls back to the raw key from the request body to satisfy the NOT NULL + UNIQUE(license_key, machine_id) constraint — meaning license_activations stores plaintext for bcrypt rows. Behavior is correct (matches what `/validate` writes), but the underlying schema mismatch should be retired. Tracked, not blocking. |
| EB2 | **Station-count cap by tier should be enforced server-side** | `/account/add-station` (and `/account/create` for the first station) currently does not enforce a per-license station limit. Per onboarding-spec-v1.md "multi-station is a Pro+ feature; tier gating is existing behavior, not new work for this spec" — so today the cap relies on client UI cooperation (tier-gated "Add a station" button). A determined or buggy client calling `/account/add-station` directly can create arbitrary stations regardless of `licenses.plan`. Add server-side cap lookup (likely a `PLAN_STATION_LIMITS = { free: 1, pro: 1, station: N }` shape) inside the same transaction as the INSERT, returning 403 station_limit_reached. Tracked, not blocking. |

---

## Library polish (L-series, parked from v4.0.0)

| # | Item | Notes |
|---|------|-------|
| Y1 | **Deck-direct loads with on-air lock (Y1-take-2)** | Proper discovery needed before implementation. Parked. |
| ~~Y3~~ | ~~**ON AIR slot polish — progress fill**~~ | ~~Deck label bars (Deck A/B/C) animate left→right in deck color as song plays, representing duration. Rust backend survival case handled via `durQueried` + `setDeckDuration()`.~~ ✓ 9c70558. Marquee scroll on long titles deferred. |
| X1.2 | **Library panel refinements** | Minor UX polish items identified during v4.0.0 build. |

---

## UX restoration (parked)

| # | Item | Notes |
|---|------|-------|
| U1 | **Schedule generation UI buttons** | "Generate Hour / Day / Week" buttons not rendered in Shows & Dayparts. Backend `scheduleOneHour`/`fillDay` functions intact and verified via DevTools. UI restoration is its own focused commit. |
| U2 | **MIDI mapping UI** | MIDI mappings table exists; UI review needed. |
| ~~U3~~ | ~~**Menu / nav rename pass (Item 7)**~~ | ~~Schedule submenu: "Format Clock"→"Clocks", "Music Categories"→"Categories" (Zetta-style). ✓ 5aecebe. ClocksTab v1 upgraded with TYPE/CATEGORY/CHAIN inline editing, 10-column grid, `chain_type` schema column. ✓ 51ffe7d. ClocksV2 beta deleted, v1 canonical. ✓ 9ec5a7e.~~ |

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
| ~~T1~~ | ~~**Responsive layout pass (Item 10)**~~ | ~~5-phase arc: P1 pointer events (f890ce2) → P2+P3 touch targets + global touch CSS (818e94d) → P4 tablet layout breakpoint / isTablet / header 96→64px (26bd017) → P5 swipe gestures, Scheduler tab swipe + queue toggle swipe (0cf8932).~~ ✓ |

---

## Startup arc (SP-series)

| # | Item | Notes |
|---|------|-------|
| SP1 | **Splash screen progress is fake — runs on setTimeout, not real startup events** | Splash runs two independent 10-second setTimeouts (`electron/main.js:1061-1065` and `splash.html:236`) with no connection to real startup events. Status lines and schema version are hardcoded strings (says "schema v5 OK" while actual schema is v16). Real boot work runs in parallel but doesn't drive the splash. Should be reworked to watch actual startup events (DB open, migrations complete, IPC handlers registered, audio engine ready). Cleanup arc after OnboardingFlow ships — the `onProgress` pattern built for Screen 4 is the model. |

---

## Onboarding arc (OB-series)

| # | Item | Notes |
|---|------|-------|
| OB1 | **`ETHER_BACKEND_URL` inlined in four components — hoist to `src/lib/etherBackend.ts`** | The Railway base URL is duplicated as a string constant in `OnboardingFlow.tsx`, `SubscriptionPanel.tsx`, `CloudBackup.tsx`, and `ShowPlus.tsx` — four copies of the same Railway URL. Should hoist to `src/lib/etherBackend.ts` after onboarding ships. Not blocking. |

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
