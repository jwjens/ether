## [4.4.60] — 2026-07-15

### Fixed — daemon-respawn resume: all on-air stations come back audibly (silent-while-playing incident)

- **Persisted on-air intent.** The auto-resume intent map was in-memory, so an app relaunch (every version
  update) reset it — a daemon reload then replayed only the renderer's boot-started active station while the
  others sat silent (the 4.4.59-update incident: only Open Format resumed). Intent is now persisted to disk
  on every automationStart/Stop and seeded back on boot **before** the first command, so the reload replays
  **every** station that was intentionally airing — no privileged/active station, no inference. Additionally,
  any station the daemon reports genuinely **live** registers its intent from observed reality (covers the
  first install of this fix, where prior versions never persisted).
- **automationStart no longer adopts a silent deck.** A deck can report `status="playing"` while output is
  dead silent (cpal/source wedge, or a stale deck adopted after a respawn). Adopting it left the station
  silent forever. `automationStart` now verifies audio is **actually flowing** (samples the master peak over
  ~400ms — observed, not claimed) before adopting; otherwise it hard-clears and force-starts a fresh deck.
- **Health frames double-count fixed.** The in-process levels interval survived the boot-fallback→daemon
  handover and double-fed the Health Monitor (frames/s read ~2×, e.g. Open Format ~81k). It now bails the
  moment the daemon is authoritative — one levels writer wins.

> **Install verification IS the acceptance test (irony gate):** installing 4.4.60 triggers the very
> stale-daemon reload it fixes. With 3 stations airing, all 3 should be **audibly playing within seconds of
> the update, no AUTO presses needed.**

## [4.4.59] — 2026-07-15

### Changed — JINGLES push-up: one imaging home

- **New JINGLES button in the bottom bar** (next to CATEGORIES) opens a push-up panel that is the **single
  home for the whole imaging workflow**: JIN/SWP **pools** (create, fill, per-pool timing), per-**category
  assignments** (overlay dropdown + active hours) + station **fallback**, and the **Reel Splitter** as an
  "Add imaging — cut a reel" tab — drop a full reel OR a single cut, auto-cut, keyboard review, batch commit
  (tag JIN/SWP → pool), all in one place.
- **Consolidated entry points**: removed the Settings → Programming "Jingles & Sweepers" section and the
  Tools → Reel Splitter menu item. This push-up is the one home. The live-screen "Set up jingles →"
  affordance now opens it.
- **Fixed a latent crash** surfaced by the typecheck gate: the Phone push-up's close button called
  `setProgPanel` from outside its scope (same class as the 4.4.55 boot crash) — now routed through a proper
  `onCloseDock` callback. tsc dropped 7 → 3 pre-existing errors (4 fixed, 0 new).
- CLAUDE.md records the surface architecture: JINGLES push-up = the imaging management home; StudioPro = the
  single production surface; one region engine worn by both; no new standalone editors. Help docs updated.

### Coming next (this directive, split for speed)
- StudioPro DAW refocus (import → chop → send to Deck/Jingle/Sweeper/Library; radio-first chrome; shared
  region engine) and the imaging fast-follows (Categories-row dropdown, seam chip, Up-Next connector,
  OnAirDeck indicator) land in the immediately-following release.

## [4.4.58] — 2026-07-15

### Added — Reel Splitter (jingle/sweeper reel → library)

- A dedicated one-screen workflow (**Tools → Reel Splitter…**, and **Cut a reel →** on the Jingles &
  Sweepers panel) to slice a long imaging reel into individual, tagged, pooled library items — not a DAW.
- **Open** (drag-drop / file-pick) → decode → **auto-cut** on silence (a JS RMS silence-gap detector,
  `src/audio/silenceRegions.ts`) into numbered waveform regions → **keyboard-first review** (Space =
  audition, ←/→ = move, Delete = remove; drag region edges; split / merge / delete) → **batch commit**
  (Jingles/Sweepers + optional pool + editable per-region names).
- Each region is rendered (`OfflineAudioContext`-free slice → `encodeWav` → `ffmpeg.writeAudio`, the verified
  write path) and registered through the **normal shipped import** (`songs.create` + `updateById`) — tagged
  JIN/SWP and pooled in one step. No side doors.
- **Built on verified rails only.** A read-only capability inventory (in the build report) confirmed what
  actually works vs. renders-only before any code: `ffmpeg.writeAudio` writes (used), `ether.fs.writeFile`
  is a dead stub (avoided), the native cue detector can't emit regions (built the JS one), and StudioPro's
  export-to-disk is dead (its "Export selection to Library" is **deferred** to the honest-UI cleanup, per
  its own "only if the export path verifies as real" condition). Dead controls the inventory exposed are
  logged in `docs/backlog.md` to be wired or removed.
- Content-hash identity remains the deferred `songs_v2` cutover; Reel Splitter imports use the shipped
  file_path pipeline and will join that cutover when it lands (backlog).
- Help: `docs/help/reel-splitter.md` — "Cutting a jingle reel."

## [4.4.57] — 2026-07-15

### Changed — JINGLES/SWEEPERS v2: category-assignment model (supersedes cadence)

- **Sweepers (`SWP`)** join jingles (`JIN`) as a first-class overlay class — "Mark as Sweeper (SWP)" in the
  Library, excluded from music/affidavit math exactly like JIN. SWP color = deep indigo `#4F46E5` (distinct
  from JIN teal, SPOT amber, and brand purple).
- **Assignment replaces cadence.** Each **music category** now names its overlay: a **specific** jingle/
  sweeper ("THIS exact cut for THIS category") **or** a **rotating pool** (least-recently-played, burnout-
  safe), with per-assignment **lead-in/underlap** (jingle 5/2, sweeper 2/1) and **active hours** (daypart
  gating). Some categories get imaging, some don't. The old "every N songs" cadence is retired.
- **Optional station fallback pool** for unassigned categories; none set = **clean dead segue** — silence is
  a deliberate programming choice, never an error.
- **Generate** resolves each song's category assignment (specific item, pool rotation, or fallback) + the
  active-hours gate and attaches the same transition-attached placement rows as v1 — a **selection-rule
  change only**, still ONE-scheduler. The daemon orchestration, Bug-A guards, and observed FIRING are
  unchanged, now **class-aware** (SWP fires and logs identically to JIN).
- **UI**: the Jingles panel is now an overlay-library manager with **JINGLES/SWEEPERS tabs**, per-category
  **assignment table** (dropdown + active hours) and the fallback selector; per-deck WHITE=armed/YELLOW=firing
  indicator names the class; color audit extended to SWP. Schema **v32** (`jingle_categories.type` +
  `categories.overlay_*`), verified on a copy.
- **Deferred by design:** trailing links (v2 is *Leading* imaging); produced/semi/dry variants (a production
  practice — one pool, rotation handles variety). Help rewritten: `docs/help/jingles.md`.

## [4.4.56] — 2026-07-14

### Fixed — renderer crash on boot (`jingleOverlay is not defined`)

- The 4.4.55 jingles per-deck indicator read `jingleOverlay` inside `LivePanel`, but that state lives in the
  top-level `App` component and was never passed down — a `ReferenceError` on first render (white screen).
  Fix: thread `jingleOverlay` from `App` into `LivePanel` as a prop (type + destructure + call-site).
- **Process gate:** added `npx tsc --noEmit` to the release checklist (`CLAUDE.md`). `vite build` uses
  esbuild, which strips types without typechecking, so it never caught this; the typecheck does. The bar is
  zero NEW type errors in changed code (pre-existing App.tsx/Scheduler.tsx/OnboardingFlow/PhoneDesk errors
  are known).

### Fixed — jingles were undiscoverable

- The **JINGLES fader** now shows a subtle **"Set up jingles →"** affordance when the station has no jingle
  pool, deep-linking to **Settings → Programming → Jingles**.
- That panel's **empty state** now walks the three steps in plain words: create a pool → tag songs "JIN" in
  the Library → set the cadence and Generate.
- Added **`docs/help/jingles.md`** — the first entry in the built-in help corpus (plain-language,
  step-by-step; the template the Iris tour layer will consume). New checklist rule in `CLAUDE.md`: every
  feature ships with its `docs/help/<feature>.md` entry, and a feature its owner can't find is a bug.

## [4.4.55] — 2026-07-14

### Added — JINGLES overlay v1 (jingles rotate + fire as a CART overlay on the song seam)

- **Jingles are a first-class overlay.** A JIN-tagged song rotates least-recently-played within a **jingle
  pool** and fires on the existing **CART channel** (over master, slot 6) at a song transition — never
  consuming a deck or advancing rotation. Per-pool timing: **lead-in** (jingle starts this long before the
  outgoing song ends) and **underlap** (next song starts this long before the jingle ends); **cadence**
  fires one every N transitions. Managed under **Settings → Programming → Jingles** (schema v30
  `jingle_categories`).
- **ONE scheduler (log-reader architecture).** Selection lives in **Generate**: it applies the cadence and
  writes transition-attached JIN placement rows into `generated_schedule` (schema v31). The daemon stays a
  log-reader that only orchestrates the real-time overlay fire — no in-daemon jingle selector.
- **Bug-A immune orchestration.** Arming/firing is **poll-driven with no naked timers**, serialized on the
  advance chain, and generation-guarded like the 4.4.48 fix: if the armed transition is superseded by any
  advance / skip / manual action / top-of-hour cut, the jingle **cancels silently and re-arms** the next
  segue. The seam bridge is watchdog-aware so it is never mistaken for a stall.
- **Observed, not claimed.** ARMED = scheduled; **FIRING = samples actually flowing on CART** (`level_cart`).
  The play-log stamps `content_class='JIN'` **only on real fire**; an armed-but-cancelled jingle leaves no
  log row and emits an `ARMED_CANCELLED` health event. Jingle plays are excluded from music/affidavit math
  (Phase-1b isolation re-verified through the new path).
- **Visibility.** Per-deck indicator under the deck (WHITE = armed, YELLOW = firing); a jingle cell + ledger
  events in the Health Monitor; and a class-color audit standardizing **JIN = teal `#14e0c8`** / **SPOT =
  amber `#fbbf24`** across the queue, up-next, spots, and clock editor.
- The v1 overlay rides the CART **logical channel** and is routing-agnostic, leaving a clean seam for the
  future B1–B5 separate-bus work rather than building against it.

## [4.4.54] — 2026-07-14

### Fixed — single now-playing poster (kills dashboard ghost/flicker)

- **Moved the `/api/now-playing` heartbeat out of the per-window renderer loop into one
  main-process poster fed by the elected primary window.** The heartbeat effect lives in the
  shared `App` component, so the main window AND every popout each ran their own 3s poster off
  their own engine mirror → last-write-wins ping-pong on the single backend now-playing row,
  surfacing a **ghost track that never aired** and flickering Deck A on the dashboard.
- The renderer now only **forwards** each station's payload to main over a new `nowplaying:state`
  IPC channel. Main accepts payloads from the **elected primary window only** (popouts ignored),
  accumulates the latest per `station_uuid`, and runs the single dedup + 20s keepalive
  `[NOWPLAY] POST` loop (`x-license-key` from the account license). Exactly one poster per machine,
  surviving popout/window churn. Backend unchanged (single-row `ON CONFLICT` upsert was already correct).

## [4.4.53] — 2026-07-14

### Changed — categories/programming mirror moved onto the proven rails

- **Desktop→web CC push now fires on edit + a 60s refresh.** The license-keyed `pushCcTable` →
  `POST /api/account/data/sync` → `station_cc_data` push (the same rail as the now-playing heartbeat /
  library snapshot, read by the dashboard's `/data`) previously only ran on station/user switch, so
  dashboard categories/programming went stale (backend 9 vs install 11). It now re-fires immediately
  after every CC-table `db:apply` (`execCmd`) and on a light 60s interval.
- Pairs with the dashboard change (`ether-dashboard`) routing category/programming edits over the live
  command bus (`db:apply` create/update/delete via `/api/cmd` → SSE) instead of the staged pipeline.

### Deprecated

- The **staged pipeline** (`importStagedProgramming`, `/api/account/station/:uuid/staged*`) and the
  `sync_enabled` mutation push are **deprecated for categories / programming / clocks**. The staged pull
  forced `op:"create"` (updates/renames no-op'd, rows marked-imported unapplied → silent loss). Left in
  place, not flipped; superseded by command-bus (web→desktop) + license-keyed CC push (desktop→web).



### Fixed — stale-alert lifecycle (item 1)

- **Stream errors now clear on recovery.** The per-station stream-status cache (`App.tsx`) only recorded
  failures ("sticky: kept until a newer error") and never cleared them, so a transient Icecast blip left
  the web-remote "Auth failed (401)" / "Streaming failed…" banner stuck for hours. A confirmed-live
  `stream:status` now nulls `lastError`/`lastErrorAt`.
- **The stream supervisor no longer permanently disarms itself.** After 3 rapid ffmpeg restarts, both the
  daemon (`audiod/stream.js`) and the in-process encoder (`electron/main.js`) used to set `armed=false`
  and stop — so no "recovered" event could ever fire and the banner was immortal. They now surface the
  error, stay armed, and retry on a 30 s cooldown so a transient outage self-heals (and clears the banner).
- **HealthMonitor last-error TTL + auto-clear.** A persisted `last_error` older than 15 min (or older than
  90 s once core subsystems are healthy again) is auto-removed instead of showing forever behind a manual
  Dismiss — this also retires the stale `onSpeaking` TypeError left on the box.

### Added — remote transport controls wired (item 4)

- **Five remote commands now act instead of falling through to `default`:** `deck:cue`, `deck:crossfade`,
  `queue:remove`, `queue:move`, `queue:clear`. They route daemon-direct to the target station over the
  existing command path (SSE license-key auth → `execCmd` → `audio:daemon` → pipe → daemon), so they work
  for a non-active station too. Daemon verbs and `STATION_SCOPED` routing already existed — no protocol
  change; renderer wiring only.

## [4.4.51] — 2026-07-14

### Fixed / tuned — Health Monitor maintenance (5 items)

- **Streaming status now reaches the monitor.** The daemon `stream` event branch now calls
  `_health.noteStreamStatus`, so live streams show ▲ + drain B/s instead of "stream off".
- **Drain-rate tailing survives log rotation.** After a daemon-log rotation, Rust stderr (the inherited
  fd) keeps writing to the renamed `.1` file. The health tail now reads **both** the current log and
  `.1` (daemon-side fd re-open isn't feasible in pure Node on Windows), so drain B/s doesn't go blind.
- **Quiet ≠ no data.** A station no longer flaps to YELLOW on a single frames/s sampling dip while
  audio is demonstrably flowing (levels stream fresh). Plus a **5 s hysteresis** before a worse level
  surfaces in the UI (recovery is immediate) — the `health-events.jsonl` feed keeps every raw
  transition at full fidelity.
- **Banner wording corrected:** in-process fallback **airs all stations**; only the metering is
  single-station. Banner now reads "All stations are still airing; the Health Monitor meters only the
  active station."
- **Engine uptime/pid are robust.** The daemon now reports `{pid, startedAt}` in its `ping` reply; the
  health module uses that when connected (no more log-tail scrape that broke after rotation), falling
  back to the log tail only in in-process mode. Restart detection (pid change) comes along free.

## [4.4.50] — 2026-07-14

### Fixed — silent in-process fallback + Health Monitor blind spot

- **The daemon-client fallback is no longer terminal.** On boot, if the daemon isn't reachable within
  the window the app falls back to the in-process engine (as before, no dead air) — but it now **keeps
  probing** for the daemon instead of calling the terminal `audiodClient.stop()`. The spawn cap
  (`MAX_SPAWN_ATTEMPTS`) still prevents a PID storm (it stops *spawning* but keeps *probing*). This
  fixes the case where a slow post-install daemon restart stranded the app in-process for the whole
  session even after the daemon came up.
- **Automatic in-process → daemon handover at a song boundary.** When the daemon attaches after a
  fallback, playout hands over to it **at the next song boundary (never mid-song)**: the daemon is
  primed, audio routing flips, and the (already-ended) in-process decks are released.
- **Health Monitor is fed from the in-process path too** — never blind. Where daemon-only fields are
  absent it degrades gracefully (peak + engine activity). In-process meters only the active station.
- **Impossible-to-miss RED banner** on the Health Monitor page and mini panel whenever playout is on
  the in-process fallback ("PLAYOUT ON IN-PROCESS FALLBACK — daemon not attached").
- **Permanent observability of the backend decision.** The daemon-client's connect/spawn/give-up
  decisions and `setupAudioBackend`'s daemon-ACTIVE-vs-FALLBACK choice now log to `ether-startup.log`
  (they were `console.*`-only, which hid the silent fallback). See
  `docs/inprocess-fallback-rootcause-2026-07-14.md`.

## [4.4.49] — 2026-07-13

### Added — Health Monitor (live audio-health system; display + event-logging only)

- **One source of truth for per-station audio health**, computed in the main process every second
  from the signals it already receives (the v4.4.46 `frames_total`/per-deck telemetry, enginestate,
  deck/queue events, a read-only ping, and a read-only tail of the daemon log for drain B/s + pid).
  Four states: GREEN / YELLOW (early warning) / RED / GREY, per the agreed thresholds.
- **Every level transition is appended as a structured event** to `logs/health-events.jsonl`
  ({ts, stationUuid, level, prevLevel, reason, metrics}) — the sensory feed for Iris.
- **Three surfaces, one feed:** a MINI collapsible in the right panel under Show Progress
  (dot + name + "231k/s pk .61" + reason); the **Health Monitor** page under Tools, now **live and
  updating every second** (per-station frames/peak meters, queue depth, next-deck-ready, current
  track + time remaining, streaming + drain B/s; engine uptime/restarts/ping; rolling last-20
  YELLOW/RED event feed) with the old static panels relabeled "Legacy diagnostics — may be stale."
- Renamed **"System Health" → "Health Monitor"** everywhere (page, popout, Tools menu).
- Display + event-logging only: no watchdog/recovery/playout/native/daemon changes; strictly
  main→renderer; identity by station UUID. See `docs/audio-health-build-2026-07-13.md`.

## [4.4.48] — 2026-07-13

### Fixed — Bug A: source-wipe race caused silent dead air at song rotation

- **A deck could go silent mid-rotation** ("`[RUST] Play deck X: source=None, path empty — skipping`").
  In `handleRotate`, the outgoing deck's stop was a floating off-chain `setTimeout(_stop(fromId),
  cfMs+500)` that, under event-loop delay, could fire *after* that deck was re-preloaded — nulling the
  fresh audio source while the JS `deckReady` flag stayed set. The next rotation trusted the stale
  flag and played an empty deck → dead air. Fixes:
  - The deferred stop now runs **on the advance chain** (serialized with preload) and is **guarded by a
    per-deck load generation** (`deckGen`) — it no-ops if the deck was re-loaded since, so it can never
    wipe a fresh source.
  - The stop now **clears `deckReady`/`endTriggered`**, so a nulled Rust source can never be left
    marked "ready."
  - A rotate into a deck with no ready source now emits a **loud error event + reloads the deck**
    instead of silently skipping to dead air.
- Native audio engine unchanged (daemon JS only). Diagnosed live via the v4.4.46 `[mix]`/`[RUST]`
  telemetry. Separate from the streaming lock-wedge (still under investigation).

## [4.4.47] — 2026-07-13

### Fixed — sign-in loop after update on an already-provisioned machine

- **Reinstalling/updating on a set-up station no longer traps you at sign-in.** In 4.4.46 the
  post-sign-in path was rerouted to force a cloud DB restore (`cloudSync`) for every account with
  stations. On a machine whose stations are already present locally, that restore is unnecessary and
  never completes, so `first_run_complete` was never set and the app re-gated to sign-in on every
  launch. `routeAfterAuth` now checks whether the account's stations are already local and, if so,
  completes locally via `provisionAttached` (the 4.4.45 behaviour) instead of the restore gate. A
  genuinely fresh machine still gets the cloud restore. Audio was never affected (the daemon airs
  independently of sign-in).

## [4.4.46] — 2026-07-13

### Added — native-layer observability (diagnostic only; no playout behaviour change)

- **Native Rust stderr is now captured** into `ether-audiod.log`. The daemon is spawned with its
  stderr set to an inherited append-fd on the log (chosen over a parent pipe, which goes EPIPE on app
  exit and would panic Rust `eprintln!` → dead air on every gapless update — proven empirically). The
  `[cpal]` / `[RUST]` diagnostics (deck-finished, source-exhausted, reload-skipped) are no longer lost.
- **Per-station `[mix sN]` mix-telemetry heartbeat** every 5 s while a deck is playing: active-deck
  count, frames-consumed-since-last-line, post-mix peak, monitor volume, and per-deck
  source/active/paused/volume/gain. Published from the mixer callback with no new lock and no RT-path
  allocation. See `docs/v4446-observability-build.md`.

## [4.4.45] — 2026-07-11

### Fixed — stations are now fully independent (no more cross-station dead air)

- **Each station now runs as its own separate sound card.** One station's failure can no longer affect
  another. Previously a single station stumbling at a song transition could silence a *different*
  station's air — the stations shared hidden internal state (one output-liveness clock, one
  stream-connection flag) that let one drag down the others. That shared state is gone: every station
  has its own audio output, its own liveness clock, and its own recovery path.
- **Stalled stations self-recover in under a second.** If a station's audio output ever stalls, it now
  reopens its own output automatically — no operator toggle, and without touching the other stations.
  Measured recovery: ~0.5 s.
- **The dead-air watchdog is now per-station and honest.** It judges each station on that station's own
  real output signal (not rotation bookkeeping, which could falsely read "live" during a wedge), and
  recovers only the affected station instead of reloading the whole engine.
- Validated: a 2-hour, 3-station soak — 121 song-to-song transitions survived across the stations with
  zero dead air, including a deliberately injected mid-run output kill that recovered without disturbing
  the other two stations.

## [4.3.29] — 2026-06-01

### Security — dependency advisories cleared

- Resolved **12 of 16** Dependabot advisories via dependency upgrades — including the **vitest**
  critical and all the **axios** runtime advisories (SSRF / prototype pollution / response
  tampering), plus vite, follow-redirects, @xmldom/xmldom, and **uuid → 14**. Most were transitive
  (lockfile-only); uuid was a direct major bump (we only call `v4()`, so the advisory never applied —
  bumped purely to clear the alert). Build verified.
- The remaining 4 advisories are all in the on-device ML stack (`@xenova/transformers` →
  `onnxruntime-web` → `onnx-proto` → `protobufjs`) — low real-world risk for a packaged desktop app,
  and a non-trivial upgrade, tracked separately.

## [4.3.28] — 2026-05-31

### Fixed — no more dead air from a wedged audio engine (auto-recovery)

- **Silent-wedge auto-recovery** — if the audio engine's output stream dies (an audio-device change,
  or the audio thread starved under heavy system load) a deck could read "playing" with no actual
  sound. Ether now detects this (a deck playing but output silent for several seconds) and
  automatically reloads the engine, recovering the audio without operator intervention.
- **Stale-engine auto-reload on update** — an app update could leave the previous audio engine
  running old code, occasionally wedged. Ether now detects a version mismatch and reloads the engine
  to match — at a song boundary when audio is flowing, or promptly if it isn't.

### Added — "Stop & Quit" so quit actually quits

- Closing the window (X) now asks: **Keep Playing in Tray**, **Stop & Quit Ether**, or **Cancel** —
  instead of silently hiding to the tray while still running and on air. Stop & Quit stops automation
  + the stream, shuts the engine down, and exits cleanly (no auto-restart).
- New tray item **"Stop Keeping On Air…"** — an emergency switch that stops the keep-alive watchdog
  so Ether stays closed when you need to fully shut it down (e.g. the system is under load).

### Changed — header legibility + queue

- **Header** — quick search is now black and blends into the bar with a rich white, bold icon + text;
  the station badge, account button, **AUTO** and **ON AIR** are bigger and bold; the top-left show
  name is tinted with **its own color from the Show Scheduler**.
- **Queue** opens **wide by default** (and remembers your preferred width across launches) so the
  artwork-forward deck rows have room.

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
