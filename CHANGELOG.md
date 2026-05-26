## [4.2.8] — 2026-05-26

Live update notifications — find out about updates without restarting.

### Added — periodic update check while running

Ether already had an in-app update banner (Update Now / progress / Restart & Update),
but it only checked once at startup, so an update published *while you were on the air*
wouldn't surface until you happened to restart. It now also checks **every 30 minutes
while running**, so a new version pops the banner **live**. You still choose when to
download and when to restart — nothing interrupts playout until you click. Only re-checks
while idle, so an in-progress download or a dismissed banner is never clobbered.

## [4.2.7] — 2026-05-26

Fix: Control Center remote edits (and companion commands) never reached the install.

### Fixed — SSE command channel never connected on boot

The desktop's remote-command stream — which carries dashboard edits *and* companion-app
commands to the install — checked for the license key once at startup and gave up if it
wasn't loaded yet. The key loads asynchronously a moment after boot, so the channel never
connected, and no dashboard command (e.g. a Control Center category create/edit) ever
applied. It now retries until the key is available.

Unblocks the Control Center write path (Phase 2b) and remote/companion commands generally.

## [4.2.6] — 2026-05-25

Fix: Control Center categories push sent zero rows (wrong return shape).

### Fixed — categories push mishandled the list result

`ether.categories.list()` returns `{ rows: [...] }` (the IPC list convention), not a
bare array, so the categories push was sending the wrapped object as `rows`; the
backend saw "not an array" and stored nothing — the dashboard Categories panel
stayed empty. (The users push was unaffected — it reads via `query()`, a real array.)

- `ccData.ts` now unwraps `.rows` from list results before pushing.
- Added a `[CCPUSH]` console line (row count + sync HTTP status) so the push is
  self-verifying in the field.

## [4.2.5] — 2026-05-25

Fix: Control Center categories never pushed to the dashboard.

### Fixed — CC categories push gated on the wrong license source

The categories push was inside the boot block gated on the *current station's*
`license_key` config value — but the key lives under station 1's config, so on a
station whose active id ≠ 1 the block (and the push) was skipped. The dashboard
Categories panel stayed empty even though the install had categories. (The users
push and now-playing were unaffected — they use the persisted `apiKeyRef`.)

- Moved the categories push to a dedicated effect keyed on `firstRunChecked` that
  uses `apiKeyRef.current` (the same reliable source as now-playing) + the active
  station UUID, firing once both are known and on station switch.

## [4.2.4] — 2026-05-25

Control Center Phase 2 — remote category editing (write-back channel).

### Added — Control Center data mirror + command bus

First slice of remote *editing* from the dashboard. The install now mirrors its
categories up so the dashboard can view them, and applies remote edits sent back
over the command bus — proving the general write-back channel on the smallest domain.

- `src/lib/ccData.ts`: pushes a table's live rows to `POST /api/account/data/sync`
  (license-key authed; categories wired) on boot + on station switch; and an
  `applyDbMutation` that routes a remote `db:apply` command to the existing typed
  sync handlers (`categories.create/update/delete` → withMutation → HLC mutation →
  syncs), then re-pushes the changed table so the dashboard reflects it.
- App.tsx `execCmd` gains the `db:apply` command (whitelisted tables only).
- Backend-paired (ether-backend): generic `station_cc_data` mirror, `/api/account/data/sync`
  (push) + `/api/account/station/:uuid/data` (read), `/api/cmd` now JWT-admin-capable,
  and the command offline-queue is now per-license.

## [4.2.3] — 2026-05-25

Control Center (Roadmap Item 5) — install users can sign in remotely.

### Added — push local console users to the Control Center

This install's local users (Settings → Users & Security) now mirror up to the
backend so the same people can sign into the dashboard (app.ether-technologies.com)
with their same name + PIN.

- New `src/lib/syncUsers.ts`: pushes local users (those with a PIN) to the backend
  `POST /api/account/users/sync`, license-key authenticated (same as now-playing).
  No-PIN console logins stay local-only. One-way (install → backend), best-effort.
- Fires on boot (once the license key is loaded) and after any change in
  Settings → Users & Security (add / edit / delete / set / remove PIN).
- The backend stores the PIN in this app's existing `salt:sha256` format, so a remote
  login verifies identically; it reconciles deletions (a user removed, or whose PIN
  is cleared, is revoked from the dashboard) and never touches dashboard-created users.

## [4.2.2] — 2026-05-25

Listener page queue ordering fix.

### Fixed — now-playing queue includes the cued standby-deck songs

The public listener page's "Up Next" skipped the two songs already cued onto the
standby decks (e.g. the song sitting on Deck C), jumping straight from the on-air
track to the deeper queue — so the displayed order was off by the two deck slots.

- The now-playing payload's `queue` now uses `engine.getQueue().slice(0, 12)` (the
  full upcoming order) instead of `slice(2, …)`. `queue[0]`/`queue[1]` are the songs
  cued onto the standby decks — the genuine next 1–2 tracks; the engine dequeues the
  now-playing song so it never appears in the queue (no duplication).
- The in-app Next Up panel keeps `slice(2, …)` because it shows those two on the deck
  strips; the listener page has no deck strips, so it must include them.

## [4.2.1] — 2026-05-25

Fix for the public listener page publishing wrong now-playing data.

### Fixed — now-playing payload (Listener Platform P1 follow-up)

The `/public/station/:slug` page showed `playing:false` / `title:null` with a queue
that didn't match the on-screen Next Up panel, even while a deck was clearly on air.

- **Decks read live, not from a React snapshot.** The payload's `playing`/`title`/`artist`
  now come from `engine.getDeck().getState()` (the same source the `[ROT]` logs read)
  instead of React deck state that was only sampled at title-change moments. This was
  publishing a stale "handoff gap" value (no deck momentarily "playing") and never
  refreshing it until the next song.
- **Heartbeat + self-correct.** The backend POST now runs on a 3s heartbeat (deduped on a
  content signature so steady playback and idle don't spam), so any transient corrects
  within one tick. The local companion + Icecast/Shoutcast metadata fan-out stay on the
  per-track cadence.
- **Queue matches Next Up.** The published `queue` is now `engine.getQueue().slice(2, …)`,
  mirroring the operator's visible Next Up panel (the two already-cued standby-deck items
  are excluded), instead of the raw, offset, stale snapshot.

## [4.2.0] — 2026-05-25

A major reliability + reach release: the full High Availability arc and the first
four phases of the Listener Platform, plus the onboarding redesign and the
customer-facing tier rename shipped since 4.1.x.

### High Availability — "Keep My Station On Air" (Phases 1–5, complete)

Ether now supervises itself end to end so a station survives crashes, hangs, and
reboots unattended.

- **Health signal (P1):** lock-free `GET /health` on :3400 + an atomic audio-liveness getter (engine-thread heartbeat).
- **Watchdog (P2):** a separate supervisor process restarts Ether on crash or hang (~15s hang detection), with a crash-loop guard + alarm marker.
- **Mutual supervision (P2.5):** Ether relaunches a dead watchdog; each process outlives the other (detached spawn).
- **Startup registration (P3):** per-user logon Scheduled Task (`EtherHAWatchdog`), no admin, via `--enable-ha` / `--disable-ha`.
- **Auto-logon installer (P4):** opt-in Settings → "Keep My Station On Air" configures Windows auto-logon via a tiny native helper (`ha-setup.exe`: HKLM Winlogon + LSA `DefaultPassword` secret), one UAC prompt, full teardown on disable.
- **Health dashboard + runbook (P5):** GREEN/AMBER/RED rollup in the System Health panel (watchdog, startup task, mutual supervision, alarm, uptime, audio, memory), popout-able; operator runbook at `docs/ha-runbook.md`.

### Listener Platform — public listener pages (Phases 1–4)

Foundation for branded, installable listener pages at `listen.ether-technologies.com/<slug>`.

- **Per-station now-playing (P1):** `station_now_playing` live cache; the now-playing push now carries `station_uuid` so the backend keys state per station.
- **Station metadata service (P2):** `station_metadata` + `station_slug_history`; authenticated endpoints for branding (slug, display name, logo, colors, description, socials) with slug validation + reserved denylist; logo upload via a public R2 bucket. New Settings → Station → "Public Listener Page".
- **Public read + realtime (P3):** unauthenticated `GET /public/station/:slug` (metadata + now-playing) and an SSE `…/stream` that pushes now-playing on each song change; renamed slugs 301-redirect.
- **Tier 1 listener PWA (P4):** new `ether-listener` app (Vite + React, installable PWA) — branding, now-playing with progress, up-next, social links, live audio with a big play button. Per-station Icecast `stream_url` configured in Ether; the live listener URL is shown in Settings with copy/open.

### Onboarding & tiers

- **Onboarding redesign:** reworked connect path + Manage Stations delete; local stations mirror backend create/bind (EB16/EB17 server-registration fixes).
- **Tier rename (customer-facing):** Free→Solo, Creator/Pro→Studio, Station→Network, Operator→Enterprise (internal plan values unchanged).
- **Dev:** Phase 1 debug panel (tier override, reset onboarding, jump-to-screen).

### Notes

- Schema changes are additive only (HA needs none; Listener Platform adds `station_now_playing`, `station_metadata`, `station_slug_history`, and a `stream_url` column — all idempotent in the backend's `initDB`).
- Updates are operator-controlled: download anytime (no audio impact), restart to apply when off-air; the HA watchdog treats the update restart as expected (no respawn fight).

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
