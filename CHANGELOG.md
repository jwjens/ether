## [4.3.27] — 2026-05-31

### Changed — dark "Ether" default + full UI redesign (all theme-token driven)

- **New dark/flat "Ether" default theme** — the flagship preset's tokens and material layer are now
  black + flat (no skeuomorphic gradients/shadows), with RGB decks (`--deck-a/b/c` = red/blue/green)
  and teal/green/amber/red accents. All redesign colors route through theme tokens, so the Theme
  Studio and every preset control them.
- **Header** — thin 56px bar; time-only clock at 46px that **glows the on-air deck's color** (A red /
  B blue / C green, teal when idle); show name (top-left) replaces the logo; AUTO/MANUAL + On-Air +
  station badge unified to one height; hamburger moved far right.
- **Queue / Up Next** — bigger artwork-forward rows, bold white title + artist, single duration;
  the playing deck shows a **solid bright color fill** with bold white text over it (no ON AIR badge
  needed); category strips/badges and the per-row pulse removed; header removed.
- **Mixer** — flat faders (motorized-board friendly), thin rail, slim solid green/orange/red meters
  that only light on signal, flat ON/PFL, no dB scale/readout; idle channel knobs dimmed.
- **Footer** — DELAY/DUMP/XFADE restyled to match the tabs; tabs brightened + teal active; Clear All
  moved here; floating keyboard-shortcut button removed (Shift+/ still opens the overlay).

## [4.3.26] — 2026-05-31

### Added — AUTO / MANUAL toggle button next to On-Air

- The header now has an **AUTO / MANUAL** toggle beside the On-Air badge. On-Air only starts/stops
  the Icecast stream; this new button starts/stops **automation** (fill + play + advance) — green
  **● AUTO** when rotation is running, **MANUAL** when the operator drives the decks. It's wired to
  the existing `toggleAuto` (also the Alt/Cmd-A shortcut); previously automation could only be
  toggled by the keyboard shortcut or the command bus, with no visible control.

## [4.3.25] — 2026-05-31

### Fixed — dashboard A/B/C deck send no longer auto-plays

- Clicking A/B/C on a song in the **web dashboard** library now **cues** the song to that deck in a
  ready (not playing) state so it waits its turn in rotation — matching the desktop library
  (JockStrip / library A/B/C, which cue without playing). The install's `deck:load` command handler
  (`src/App.tsx`) was calling `engine.getDeck(deck).play()` right after cueing, which force-started
  audio on send. Removed that stray play; Q (`queue:enqueue`) was already correct.

## [4.3.24] — 2026-05-31

Item 10 — daemon **observability + self-healing**, plus a **rate-independent VU meter** fix.

### Added — durable daemon logging

- The out-of-process engine (detached, `stdio:"ignore"`) now tees its console to
  `<userData>/logs/ether-audiod.log` (rotates, never goes silent) — lifecycle, automation cmd
  receipts, `_started` transitions, advance/refill/deck-end, watchdog/stall, and a `deck X LIVE`
  line on every path that puts a deck on air.

### Fixed — daemon-respawn auto-resume (no more dead air after a respawn)

- When the daemon respawned (crash / gapless update / restart) it came up idle and the app never
  re-issued `automationStart` → silence. The app now caches per-station automation intent and
  replays `automationStart` on every fresh daemon (re)connect; a surviving, still-playing daemon
  takes the existing idempotent no-op (audio untouched). A deliberate `automationStop` clears the
  intent, so an operator stop is never auto-resumed.

### Fixed — VU meter no longer jumpy at the daemon's 10 Hz feed

- `MasterVU` and the per-deck `VUMeter` smoothing is now **delta-time based** (time constants in ms
  via `lib/vuMeter`), independent of the level-feed rate, so the meter glides the same whether levels
  arrive at 10 Hz, 30 Hz, or irregularly. The daemon level rate is unchanged (10 Hz). Taus are tunable
  in one place. Synthetic/theater meters untouched.

## [4.3.23] — 2026-05-30

Item 10 — **Stage 2b**: closes the last hole in the daemon↔renderer migration. The renderer can no
longer push its whole queue mirror back to the daemon.

### Changed — renderer can no longer clobber the daemon's queue

- `engine-rodio.replaceQueue` is now a **guarded no-op in daemon mode** (warns on any stray caller).
  That whole-queue echo was the original "clobber" behind the duplicate/played-song bugs; all
  daemon-mode queue edits already go through the id-addressed intents (Stage 2a), so nothing legit
  calls it anymore. In-process mode is unchanged.
- Note: `loadToDeck` is intentionally left as-is — it's still the live manual-load path for the
  Jock/Spots/PhoneDesk/Deck-Configurator panels (routes to the daemon `load` + `noteManualCue`),
  not an echo. Migrating those panels to `deck:cue` is a separate future cleanup.

## [4.3.22] — 2026-05-30

Item 10 — **Stage 3 (3a + 3b together)**: fixes the A→B→C rotation stall (Bug 2) at the root **and**
makes a stall structurally unable to persist. Daemon-only; the in-process engine is untouched.

### Fixed — rotation no longer stalls into dead air (3a: root cause)

- **`preload` is serialized on the advance chain.** Deck preloads (from the self-heal and after a
  crossfade) now run on the SAME `advanceP` chain as `handleRotate`/`handleLoadNext`, so a preload
  can never overlap a rotate — the race that left `handleRotate` reading a half-loaded deck / a
  transient `deckReady` and bailing into a stall. `checkEnd` now always sees settled state.
- **Freshened `checkEnd` guards.** The rotate-vs-load-next decision re-reads **live native state**
  instead of the per-tick `this.stateX` snapshot, so a momentarily-stale "playing" flag can no
  longer make the engine skip an advance.
- Wedge detection (below) now also covers the serialized preload ops.

### Fixed — and can no longer stall into dead air (3b: backstop)

- **Watchdog invariant:** content present + nobody playing ⇒ somebody playing within ~1 s. The poll
  loop now checks each tick: if no deck has been playing for >1 s while automation is engaged and
  there's content (a cued/loaded deck or a non-empty/refillable queue), it forces an advance. (The
  v4.3.6 self-heal only topped up idle decks *while one was already playing*, so an "all decks
  stopped" state had no recovery path — that was the Bug 2 dead-air stall.)
- **Respects manual cues:** recovery plays an already-cued deck (a hand-cued `deck:cue` deck first)
  rather than loading a different track over it; only when nothing is loaded anywhere does it pull
  the next track from the queue onto deck A.
- **advanceP-wedge reset:** advance ops (`handleRotate`/`handleLoadNext`) now run through a wrapper
  that records when each starts. If the serialized chain is stuck >3 s, the watchdog resets it
  (`advanceP = Promise.resolve()`) so recovery can actually run — a hung chain can't cause dead air.
- **Fires once per stall** (re-arms when a deck plays again), with a bounded retry if a recovery
  can't find content, and is **gated to on-air automation only** — it never auto-starts a fresh,
  idle daemon.

Stage 3a (next) serializes `preload` on the advance chain + freshens `checkEnd` guards to make the
stall *rare*; this watchdog makes it *unable to persist*.

## [4.3.20] — 2026-05-30

Item 10 — **Stage 2a** of the daemon↔renderer state-coordination fix: the UI now **drives the daemon
through the Stage-1 intent commands** instead of pushing its queue mirror back. Daemon-mode branches
only — the in-process engine (`ETHER_AUDIO_DAEMON=0`) is untouched.

### Changed — renderer writes go through intents, not the mirror echo

- **Up Next** queue edits (drag-reorder, move up/down/top/bottom, remove) now send id-addressed
  intents by `qid` (`queueReorder`/`queueMove`/`queueRemove`); cart-drop → `queueEnqueue`; Clear All →
  `queueClearPending` (cued decks survive, audio doesn't drop). No local splice + `replaceQueue`.
- **A/B/C deck buttons** → `deck:cue`; the **XFADE** button → `deck:crossfade` (it actually
  crossfades in daemon mode now, via the daemon); dashboard `deck:load`/`queue:enqueue`/`queue:reorder`
  remote commands route through the same intents.
- **Responsiveness:** `engine-rodio` re-emits the app-standard `ether:queue-changed` event on every
  daemon queue event, and Up Next subscribes — so intent-driven edits reflect within ~50 ms (not the
  1 s poll), without the renderer ever pushing its mirror.

The legacy `replaceQueue`/`loadToDeck` daemon send-paths **still exist** but are no longer called in
daemon mode; **Stage 2b** strips that dead echo-back. In-process mode is byte-for-byte unchanged.

## [4.3.19] — 2026-05-30

Item 10 — **Stage 1** of the daemon↔renderer state-coordination fix: the daemon gains explicit
**intent-command endpoints**, added alongside the existing commands (additive — nothing removed, the
renderer does not call them yet; that's Stage 2).

### Added — id-addressed queue/deck intent commands (daemon)

- New daemon commands: `queue:enqueue`, `queue:remove`, `queue:reorder`, `queue:move`,
  `queue:clear`, `deck:cue`, `deck:crossfade`. Each is id-addressed (by the Stage-0 per-entry
  `qid`), **idempotent and tolerant** — a stale or unknown intent is a quiet no-op, never an error
  or a corrupting mutation.
- **`boundQids`**: the daemon now tracks which queue entries are loaded on a standby deck and
  protects them — `queue:*` edits treat cued entries as no-ops (change a deck via `deck:*`). It's
  updated synchronously (added in `preload`, removed in `dequeue`, the single point every
  rotate/advance path funnels through) so there's no window where a qid is briefly unbound.
- Typed renderer wrappers (`queueEnqueue`/`queueRemove`/`queueReorder`/`queueMove`/
  `queueClearPending`/`deckCue`/`deckCrossfade`) added to the engine — **not yet called by any UI**.
- No `main.js`/preload changes — the existing generic `audio:daemon` bridge already forwards
  commands by name.

## [4.3.18] — 2026-05-30

Item 10 (out-of-process audio engine) — **Stage 0** of the daemon↔renderer state-coordination fix.
Locks in the daemon as the single source of truth for deck + queue state, read path first
(additive only — no write-path changes, nothing removed).

### Changed — the renderer mirrors the daemon's deck state instead of deriving its own

- The daemon stamps a stable **per-queue-entry id (`qid`)** on every item as it enters the queue and
  includes it in queue events (the same song can appear twice, so this is the slot's identity, not
  the song's), and it now emits **`deckReady`** (cued) in every deck event.
- The renderer **subscribes to the daemon's `deck` events** and treats them as authoritative for
  A/B/C status/title/duration/cued state; `poll()` only advances the countdown locally between
  events instead of deriving deck status from its own native read.
- The **XFADE button is gated to its existing no-op in daemon mode** — the renderer-side crossfade
  would race the daemon. Stage 2 replaces it with an explicit `deck:crossfade` intent to the daemon.

This stage proves the read path; the write-path flip (renderer stops echoing its queue mirror back
to the daemon) comes in Stage 2.

## [4.3.12] — 2026-05-29

### Fixed — fader colors match the rest of the app

The vertical A/B/C deck faders showed the wrong colors (A appeared green, B blue) because they
used the deck-*type* color — every music deck shares green — instead of the per-deck color. The
rotation faders now always use the canonical A = blue, B = green, C = purple, matching the Up Next
deck rows and the library A/B/C buttons.

## [4.3.11] — 2026-05-29

A bigger, clearer on-air view: stacked deck rows up top, taller faders, fewer-but-bigger queue rows.

### Changed — Up Next shows the live A/B/C decks, WideOrbit-style

The Up Next panel now leads with three stacked, color-coded deck rows (A cyan / B green / C purple) —
the on-air track is badged ON AIR with a filling progress bar, and the two cued decks show what's
loaded next. **Each deck row flashes during the final 10 seconds** so you know exactly when to talk
over the outro. Below them, the queue rows are bigger with larger song-title, artist, and time fonts,
so you see fewer at once but read them at a glance (scroll for the rest).

### Changed — taller, color-coded faders

The DECK A/B/C title strip above the mixer is gone; the faders now stretch to fill that space. Each
deck fader carries a slim color-coded accent (no text label needed) that fills with the play progress,
so you can still tell A from B from C at a glance. The per-row SEG button was removed from the queue.

## [4.3.10] — 2026-05-29

The Song Library is now a push-up panel in the bottom row — reach it without leaving Live.

### Added — LIBRARY push-up panel next to CATEGORIES

The bottom row gains a **LIBRARY** tab beside CATEGORIES. It slides the full Song Library up over
the decks (the on-air queue keeps playing untouched), so you can search, filter, import, edit
metadata, and load tracks straight to a deck or the queue without switching off the Live view.
Drag the divider to size it, click LIBRARY again to tuck it away. Same library, same controls as
the full-screen page — just one click from the console.

### Fixed — release pipeline no longer races itself

The CI publish step could intermittently fail with a 422 ("release already exists") when the
Windows/Mac/Linux builds raced to create the same GitHub release. The matrix now publishes one
platform at a time so the first run creates the release and the rest upload into it. (No app
behavior change — this only makes releases land reliably. v4.3.9 was lost to this race.)

## [4.3.8] — 2026-05-29

Deck displays match what's actually on air — on the desktop and the web dashboard.

### Fixed — cued decks show on the desktop again

In background-engine mode the two standby decks could display blank even though songs were
loaded and ready. The deck strip now shows a deck as cued whenever it's holding a track, so
DECK A/B/C always reflect what's playing and what's next. The Up Next list also re-syncs with
the engine the moment the window (re)connects — and periodically after — so it's never stale
after a reload or restart.

### Fixed — web dashboard shows each song on its real deck

The Control Center dashboard always pinned the on-air song to "Deck A," so as tracks rotated
they appeared to shift up. It now reads the actual physical deck (A/B/C) for the on-air track
and shows the two cued decks' real songs — nothing shifts up, and the progress bar fills against
the live deck. (Requires the matching backend update so the per-deck data reaches the dashboard.)

## [4.3.7] — 2026-05-29

No more double-play when automation restarts.

### Fixed — automation won't start a deck over one already on air

After a gapless update/restart, the app could re-start automation and load a new song into an
open deck *on top of* the track already playing — two songs at once. The engine now adopts
whatever is already on air instead of starting a second deck. (Includes the 4.3.6 self-healing
playout: idle decks stay cued and the queue stays topped up.)

## [4.3.6] — 2026-05-29

Decks stay cued and the queue never runs dry.

### Fixed — automation keeps the next tracks pre-loaded

The background engine could end up with the upcoming decks blank and the play queue empty — so
no songs pre-loaded into the next decks, no crossfade, and the next-track progress bar had no
duration to fill against (most likely right after a restart). The engine now continuously keeps
the queue topped up and the two idle decks pre-loaded with the upcoming songs, so each deck always
shows what's next, the progress bar fills, and tracks roll A→B→C without gaps.

## [4.3.5] — 2026-05-28

Automation no longer stalls on a missing or unreadable track.

### Fixed — auto-advance skips dead files instead of stopping

If a scheduled track's file was missing (deleted after it was scheduled) or unreadable, the
background engine could get stuck "playing" the dead track and stop advancing decks — silence on
air. The engine now verifies each track is actually playable before airing it and skips any it
can't read, moving straight to the next one, so the rotation keeps going.

## [4.3.4] — 2026-05-28

Closing Ether now stops the broadcast.

### Fixed — a deliberate close stops playout

Closing Ether is a decision to go off air, so it now stops the broadcast. Previously the
background audio engine could keep streaming after the window was closed. It still keeps playing
straight through an **auto-update** or a **crash** — that's the whole point of the background
engine — but a manual close shuts it down instead of leaving it on air in the background.

## [4.3.3] — 2026-05-28

Gapless updates are back — with clean stream audio.

### Fixed — stream crackle eliminated; background engine re-enabled

The low crackle that affected the live stream is fixed. Its cause was in the broadcast
encoder feed: it was paced by the system clock and inserted tiny bits of silence whenever it
ran ahead of the audio — a steady trickle of clicks. The encoder is now paced by the audio
itself, so the stream is clean.

With that resolved, the **background audio engine is the default again**, so your station keeps
playing through restarts and auto-updates. The ON-AIR indicator also reliably tracks the live
stream. Set `ETHER_AUDIO_DAEMON=0` to force the legacy in-process engine if ever needed.

## [4.3.2] — 2026-05-28

Cleaner live audio and a reliable ON-AIR indicator.

### Fixed — back to the in-process audio engine by default

The out-of-process background audio engine (shipped default-on in 4.3.0/4.3.1 for gapless
updates) introduced a low crackle on the live stream and a flickering ON-AIR button that could
stick on "OFF AIR" while actually broadcasting. The proven in-process engine is the default
again, so live audio is clean and the ON-AIR indicator tracks the real stream. The background
engine (and its gapless-update behavior) is still available opt-in via `ETHER_AUDIO_DAEMON=1`
while its audio path is being retuned.

## [4.3.1] — 2026-05-28

Gapless updates now on macOS and Linux too.

### Fixed — cross-platform background audio engine

v4.3.0 shipped the out-of-process audio engine (gapless updates) on **Windows only**. It now
runs on **macOS and Linux** as well: the engine↔app link uses a Unix domain socket on those
platforms (a Windows named pipe on Windows). So every desktop station — including macOS — keeps
playing through a restart or auto-update, with the same automatic fallback to the built-in
engine if the background engine ever can't start.

## [4.3.0] — 2026-05-28

Your station stays on air through updates and restarts.

### Added — out-of-process audio engine (gapless updates)

Ether's audio engine now runs as a **separate background process** (`ether-audiod`), so the
music keeps playing even when the app window restarts — including during an **auto-update**.
Previously, updating or restarting Ether caused a brief gap of dead air; now playout, the
Icecast stream, and the play log all continue uninterrupted while the app relaunches.

- **Playout, scheduling, the Icecast stream, and play logging** live in the background engine,
  so a UI restart or an app update no longer takes you off air.
- The desktop UI, VU meters, queue, and now-playing all drive the background engine live.
- **Automatic safety net:** if the background engine can't start for any reason, Ether silently
  falls back to the built-in engine — worst case is exactly the old behavior, never dead air.
- The HA watchdog supervises the background engine and restarts it if it ever stops.

On by default (Windows). Set `ETHER_AUDIO_DAEMON=0` to force the legacy in-process engine.

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
