# Audio Daemon (`ether-audiod`) — Phase 0 Findings & Design

Roadmap **Item 10 — Out-of-Process Audio Engine**. Phase 0 = de-risk + design before the heavy extraction (Phase 1). This doc is the Phase-0 deliverable; it locks decisions before any extraction code lands (two-commit boundary).

## Finding 1 — the engine runs outside Electron ✅ (de-risked)

`native/ether-audio.node` is a **pure N-API (Node-API v10) module** — ABI-stable across Node/Electron versions. Proven by `scripts/spike-audiod-load.js`: it `require()`s and exposes **all 29 exports (incl. the 10 core engine fns)** in **bare system Node v24**, despite `NODE_MODULE_VERSION` 137 ≠ node-24's native ABI. N-API is version-independent — which is precisely why this loads where the V8-ABI `better-sqlite3` does not.

**Conclusion:** `ether-audiod` can be a **standalone Node process** loading this addon directly — no Electron, no `ELECTRON_RUN_AS_NODE`, no per-node-version rebuild. The scariest unknown for Item 10 is resolved positively.

## Finding 2 — the full engine runs headless ✅ (de-risked)

`scripts/spike-audiod-run.js` (bare node, throwaway station id 99, gated `--i-am-off-air`) proved that `initAudioEngine` → `audioLoad` a local MP3 → `audioPlay` → `audioGetLevels` works **with no Electron**: cpal opened the output device (Realtek, 48000 Hz 2ch), the file decoded and mixed (`Mixer peak 0.57, active_decks=1`), **real** post-fader levels reported (`levelA 0.52 → 0.95 → 0.20` — genuine audio dynamics), and the **program-bus stream source** stood up (`TCP port 54809`, drain at ~89,486 samples/sec ≈ the 88,200 target). The cpal callback fired ~101×/sec (correct 10 ms buffers).

The only stream piece not exercised is **ffmpeg → Icecast**, but ffmpeg is spawned by the *app* today (Electron `child_process` of `ffmpeg-static`), not by the addon — an ordinary child process that runs in any Node and reads the program-bus TCP port. So there is no remaining addon-side stream risk.

**Note for Phase 1:** `position_sec` stayed 0 in `audioGetState` during the spike — playback position is interpolated by the JS engine (`engine-rodio` poll), not the Rust meta. That state-tracking is part of what moves into the daemon (see State ownership).

## IPC transport — decided: **Windows named pipe**

`\\.\pipe\ether-audiod` (single pipe; `station_id` carried in each message, matching the addon's per-station engine map). Rationale: local-only (never network-exposed), low-latency, multi-client (the UI plus future headless/observer clients), and already a proven pattern in this codebase (the HA `ha-setup.exe` uses a named pipe for the LSA-secret password handoff). Framing: newline-delimited JSON (one object per line) — simple, debuggable, sufficient for command rate. Levels (~30 Hz) are small JSON; fine over a pipe.

## Command / event protocol (draft) — mirrors `engine-rodio`

The goal is that the renderer's existing `window.ether.audio.*` surface barely changes — the preload/main `audio:*` IPC handlers become thin forwarders to the pipe.

**Client → daemon (commands)** — `{ id, cmd, stationId, ...args }`, daemon replies `{ id, ok, result?|error? }`:
- decks: `load` (deck, filePath, title, artist, gainDb, durationMs), `play`, `pause`, `stop`, `setVolume`, `setEq`, `loadToDeck`, `jumpToNextSong`, `triggerPreload`, `getState`, `getFileDuration`
- queue: `addToQueue`, `replaceQueue`, `getQueue`, `clearQueue`, `setQueueItemChainType`, `setAutoAdvance`/`setContinuous`/`setShuffle`
- stream: `startStream` (server/port/mount/password), `stopStream`, `setOutputDevice`, `listOutputDevices`, `getProgramBusPort`
- broadcast delay: `setBroadcastDelay`, `dump`, `broadcastDelayState`
- watchdog/health: `watchdogSet`, `lastCallbackMs`

**Daemon → client (events, broadcast to all connected clients)** — `{ event, ... }`:
- `deck` — per-deck state (the 250 ms poll the renderer engine does today moves into the daemon; clients subscribe instead of polling)
- `levels` — ~30 Hz VU/master peaks (replaces `audio:levels`)
- `queue` — queue changed (len + items)
- `nowplaying` — derived now-playing (or keep that in the client; see open question)
- `stream` — stream connect/disconnect/error

## State ownership — LOCKED (2026-05-27)

Today playout state is split: the **Rust** addon owns the live mixer/deck audio; **`engine-rodio.ts`** (renderer) owns the JS-side queue, deck-status mirror, auto-advance/rotate logic, and end-detection; the **scheduler** (`loggen.ts`) + the now-playing push live in the renderer / `App.tsx`.

**Decision:** the **daemon owns the queue + the rotate/advance/preload logic + the scheduler (`loggen`)** — everything required to keep playing unattended. A UI restart must not lose the queue or stop advancement, so none of that can live in the renderer. The renderer keeps only *view* concerns and operator actions (which become commands).

**Consequent constraint (important):** the daemon is **bare Node**, so it **cannot use `better-sqlite3`** (V8-ABI — won't load there, the same reason the diag scripts need Electron's node). `loggen` reads the SQLite library, so the daemon needs an **N-API / ABI-stable SQLite binding** — **Node 24's built-in `node:sqlite`** is the candidate (ships with the runtime, no native rebuild). **Phase-1 spike:** confirm `node:sqlite` opens `openair.db` (WAL) read-only and runs loggen's queries while the app also has it open. (Fallback if it can't: a thin "fill request" command where the still-running daemon asks any connected client to run loggen — but that reintroduces a UI dependency for refills, so `node:sqlite` is strongly preferred.)

**Stays in the app:** the now-playing push to the backend (an HTTP POST driven off the daemon's state events — no DB or engine needed), and all UI.

## Lifecycle & supervision

- **Start:** the app launches `ether-audiod` on boot if not already running; longer term the installer can register it (Windows service or the existing per-user logon Scheduled Task used by HA).
- **Supervise:** extend the **HA watchdog** (already supervising the app) to also start + restart the daemon if it dies. The daemon is small and stable, so its own restart is rare — but it's the one residual gap, optionally covered by a backup-audio bridge (Phase 4).
- **Update:** the daemon is versioned + updated **separately** from the app, so an app auto-update relaunches only the UI while the daemon streams through it. A daemon update applies only at a safe moment.
- **Shutdown:** the daemon persists queue/deck state and may exit when no station is active **and** no client has been attached for N minutes (or run always-on as a service for unattended stations).

## Phase 0 status

- [x] N-API addon loads + full API in bare Node (Finding 1) — `scripts/spike-audiod-load.js`
- [x] Run spike: cpal device + decode + mix + real levels + program-bus from bare Node (Finding 2) — `scripts/spike-audiod-run.js`
- [x] IPC transport decided (named pipe) + protocol drafted
- [x] Lifecycle/supervision plan drafted (extend HA watchdog)
- [x] State-ownership decision LOCKED — queue + advance + `loggen` move into the daemon; DB access via `node:sqlite` (not `better-sqlite3`); now-playing push stays in the app

**Phase 0 COMPLETE.** The engine runs fully headless in standalone Node (Findings 1 + 2), transport + protocol + lifecycle are designed, and state ownership is locked. One Phase-1 spike is pre-identified: confirm `node:sqlite` can read `openair.db` so `loggen` can run inside the daemon.

## Phase 1 entry plan (additive, does NOT touch the live app's audio path)
1. ~~node:sqlite spike~~ ✅ **DONE** — `scripts/spike-nodesqlite.js`: Node 24's `node:sqlite` opened `openair.db` read-only (WAL) from bare node and ran loggen-style queries (417 songs, clock categories, 11 shows) while the app held the DB open. loggen can run in the daemon. (Experimental-warning only; no flag needed on Node 24.)
2. ~~Scaffold `ether-audiod`~~ ✅ **DONE** — `audiod/ether-audiod.js`: standalone Node daemon, loads the addon, serves `\\.\pipe\ether-audiod` (newline-JSON command/reply), broadcasts `levels` (~10 Hz) + `deck` (~4 Hz) events, lifecycle (SIGINT stops decks + closes pipe), single-instance (EADDRINUSE → exit). Wraps the addon command surface (init/load/play/pause/stop/volume/eq/state/levels/delay/dump/output-device/program-bus-port/watchdog). Smoke-tested via `audiod/smoke-test.js`: a client init'd + played a file and received **27 `levels` events at peak 1.000 entirely over the pipe** — engine driven + metered end-to-end through the daemon. ADDITIVE: the live app does not talk to it yet.
3. ~~Move queue + advance + loggen~~ ✅ **DONE** — the daemon now owns the queue, the A→B→C rotate/preload/end-detection, and the `node:sqlite`-backed scheduler:
   - `audiod/loggen.js` — node:sqlite port of `src/audio/loggen.ts`'s fill (generated_schedule → active clock → on-format random), preserving the Christmas-leak fix (every fallback restricted to active-show clock categories). SmartRules (renderer localStorage) and cloud-only schedule entries (need the app's `r2:fetch`) are intentionally not ported; local entries are honored.
   - `audiod/engine.js` (`DaemonEngine`) — faithful port of `engine-rodio.ts`'s queue + rotate + preload + `checkEnd`, with synchronous addon calls and `emit()` (pipe broadcast) replacing the renderer's listeners. Refill calls `loggen.fillQueue`. Emits `deck` / `queue` / `playstart` / `chainstop` events. **Read-only DB** — play-logging stays in the app to avoid double-writing while both run; the daemon already emits `playstart`, so the cutover takes over logging cleanly.
   - `ether-audiod.js` — added the engine commands (`automationStart`/`automationStop`/`fill`/`getQueue`/`enqueue`/`replaceQueue`/`clearQueue`/`setAutoAdvance`/`setContinuous`/`setShuffle`); opens the library read-only via `node:sqlite` on first automation start; the generic event loop now skips the full-state `deck` emit for engine-owned stations (the engine emits richer per-deck events).
   - **Proven:** `audiod/smoke-loggen.js` (read-only) — the in-daemon scheduler produced **20 on-format tracks from OV's real library** (station 1), zero seasonal leak, no renderer. `audiod/smoke-automation.js` (gated `--i-am-off-air`, station 99) — `automationStart` drove **deck A live + `playstart` + 9 `deck` events + queue consumption + B preload entirely over the pipe**.
   - **Schema finding (important):** `songs` has **no `station_id` column** — it's a single shared library; stations differentiate via clocks/shows/schedule (which are station-scoped). `loggen.ts`'s `buildBaseConditions` referenced `s2.station_id`, so its **live-pick paths (P2–P4) threw in production and silently fell through to generated_schedule** (caught by `fillQueueFromSchedule`'s try/catch → returns 0). The daemon port uses correct SQL (no song-level station filter). **App fix shipped** (`f36fc8b`): the bad `s2.station_id` reference was removed from `loggen.ts`, so the renderer's live-pick fallback now actually runs (still on-format — the `formatCats` guards are unchanged).
4. (Phase 2) Re-point the app's `audio:*` IPC + `engine-rodio` at the daemon over the pipe (the only step that touches live audio — needs off-air testing). The daemon takes over play-logging + streaming here. **Scoped below.**

**All daemon de-risks green:** N-API addon loads in bare node (Finding 1) · engine plays + streams headless (Finding 2) · `node:sqlite` reads the library (this spike). Phase 1 is fully unblocked.

---

## Phase 2 — Cutover (scope)

**Goal:** re-point the live app at the daemon so the **mix AND the Icecast stream survive a UI/main-process restart** (an app auto-update relaunches only the UI; the daemon keeps streaming). This is the **only phase that touches live audio**, so every sub-step is proven off-air (throwaway station 99 / a non-broadcast machine) before the live app is pointed at the daemon, and the whole path sits behind a rollback flag until proven on OV.

### Step 0 — Runtime decision (GATE) ✅ DONE — CLEARED (2026-05-27)
How does the daemon run in the *packaged* app? Dev uses system Node 24; a packaged install has no guaranteed system node. The daemon needs (a) the N-API addon and (b) `node:sqlite`.
- **Decision:** spawn the daemon via the **app's own Electron binary** — `ELECTRON_RUN_AS_NODE=1 <Ether.exe> audiod/ether-audiod.js` — **detached** so it outlives the app. **No standalone node binary, no `better-sqlite3` fallback needed.**
- **Spike result** (`scripts/spike-electron-node-sqlite.js`, run under BOTH `node_modules/electron/dist/electron.exe` AND the packaged `dist-electron/win-unpacked/Ether.exe`): **identical pass.** Electron **41.1.0 bundles Node 24.14.0** (ABI `modules:145`), so `require('node:sqlite')` loads **flag-free**, opens `openair.db` read-only (417 songs) **and** read-write (TEMP-table write proven), and `ether-audio.node` loads (29 exports, all core fns) under Electron's node ABI — the Phase-0 N-API finding holds under Electron too.
- **Fuse safety:** the packaged binary's `RunAsNode` fuse is **ENABLED** (verified by reading the embedded fuse wire — the project pulls `@electron/fuses` only transitively and configures no `electronFuses`, so Electron defaults apply). So `ELECTRON_RUN_AS_NODE` is honored and launching the exe with it does **not** boot the GUI. **Phase-2 caveat:** if a future build ever disables `RunAsNode` (a hardening step), the spawn line breaks and we'd need a shipped node binary — keep this in mind if fuses are ever configured.
- The Step-4 (write-contention) and Step-5 (ffmpeg-in-daemon) spikes are now **also done** — see those steps below. All three Phase-2 de-risk spikes are green.

### Step 1 — Addon ownership → daemon; main becomes a forwarder — ✅ DONE (`3bd3718`)
Behind `ETHER_AUDIO_DAEMON` (default **off** = original in-process path, unchanged):
- `electron/audio-daemon-client.js` (new): main-process pipe client. `ensure()` spawns the daemon **detached** via the app's own Electron (`ELECTRON_RUN_AS_NODE`, Step-0-proven) so it outlives a UI restart; id-correlated `cmd()`; re-broadcasts daemon events; auto-reconnect + respawn if the daemon dies; asar-unpacked path fixup for packaged builds.
- `electron/main.js`: `AUDIO_DAEMON` flag. When on, main does **not** `initAudioEngine` (no competing output device) — the addon is kept only for stateless utils (analyze\*, getFileDuration, getLocalIp). `audio:load` (after local existsSync + R2 resolution), play/pause/stop/setVolume/getState/getLevels/watchdogSet/setBroadcastDelay/dump/broadcastDelayState/setEq/listOutputDevices/setOutputDevice all forward to the daemon; the 30 Hz local levels poll is skipped (daemon `levels` events re-emitted as `audio:levels`). `stream:go-live` refuses when on (encoder moves in Step 5).
- **Validated** by `scripts/spike-audiod-client.js` (no GUI): spawn + connect, ping/init/getState round-trip, **14 forwarded events**, and reconnect/respawn after the daemon is killed.
- With Step 1 alone the renderer still runs its own poll + advance *through the forwarded calls*, so the **mix + program bus already survive a main/UI restart** (they live in the daemon); only the advance brain is still in the renderer (→ Step 2).

### Step 2 — Renderer engine → remote proxy — ✅ DONE (`3bd3718` foundation + this commit)
- Main forwards the daemon's `deck`/`queue`/`playstart` events to renderer channels (`audio:daemon-deck`/`-queue`/`-playstart`); adds `audio:daemonEnabled` + a generic `audio:daemon` command bridge. Preload exposes `daemonEnabled()`, `daemon(cmd,args)`, and `onDeck/onQueue/onPlayStart`.
- `engine-rodio` `daemonDriven` mode (queried once at init via `daemonEnabled()`): local **advance/preload/refill are disabled** (the poll still reads forwarded `getState` for deck-card display, so it can't race the daemon); it **mirrors** the daemon's queue (`onQueue` → `getQueue()` for the Up Next UI) and **relays** `playstart` (→ `notifyPlayStart`, so App.tsx's now-playing push + play log keep firing); `addToQueue`/`clearQueue`/`replaceQueue` forward to the daemon; `startDaemonAutomation()`/`stopDaemonAutomation()`/`skip()` added.
- **App.tsx wiring done:** the startup autofill + the AUTO toggle both hand the whole fill+play+advance to the daemon via `startDaemonAutomation()` when `daemonDriven` (AUTO-off → `stopDaemonAutomation()`); the command-bus `skip`/`automation_on`/`automation_off` route to the daemon; `jumpToNextSong` (show-clock transitions) forwards to a new daemon `skip` command. The renderer's `loggen` fill is suppressed in one place (`fillQueueFromSchedule` early-returns when `daemonDriven`) so the daemon's `continuous` self-refill is the sole queue source — no double-fill.
- **Daemon `skip` command** (`audiod/engine.js` + `ether-audiod.js`): force-advances to the next deck in rotation. **Proven** by `audiod/smoke-automation.js` (gated, station 99): autonomous start played deck A, then `skip` advanced to deck B (`playstarts 1→2`, queue `3→2`) — all over the pipe.
- **Still requires the full off-air app run to ACCEPT:** launch with `ETHER_AUDIO_DAEMON=1` on a dev machine and confirm playout + advance + queue + VU + now-playing all run through the daemon, then kill the UI and confirm audio continues. (Cart load/play already route via the Step-1 `audio:*` forwarders.)

### Step 3 — Scheduler: daemon self-fills; renderer loggen leaves the hot path
The daemon's `continuous` + `loggen.js` keep the queue full. `fillQueueFromSchedule`/`refillFromSchedule` no longer drive live refills; a manual "regenerate queue" UI action becomes a `fill` command. (`loggen.ts` may remain for UI preview but is off the live path.)

### Step 4 — Play-logging → daemon (read-WRITE `node:sqlite`) — ✅ DONE
The **daemon** writes the play log on its own track-start, so Play History keeps filling even while the UI + main process restart during an app update. (NB: the app never updated `songs.last_played_at`/`play_count` on play — `logPlay` only inserts a `play_log` row — so the daemon matches that exactly.)
- **`audiod/playlog.js`** writes a `play_log` row **and** the sync mutation byte-for-byte like `electron/sync/handlers/play_log.js`, by reusing the app's own `mutation-writer` (`logMutation` + `serializePayload`) inside a manual `BEGIN IMMEDIATE/COMMIT` (node:sqlite has no `db.transaction()`). `engine.js` calls it on every `_fireStart`; `ether-audiod.js` now opens the library **read-write** (`WAL` + `busy_timeout=5000` + `foreign_keys=ON`). `App.tsx` gates the renderer's `logPlay` off when `daemonDriven` (no double-log); the now-playing emits stay in the app.
- **Spike** (`scripts/spike-write-contention.js`): two processes / two bindings hammered a **copy** of `openair.db` — node:sqlite (daemon) + better-sqlite3 under `ELECTRON_RUN_AS_NODE` (app), 2000 inserts each — **0 busy/0 hard errors, `integrity_check: ok`, cross-visible**.
- **Verified** (`audiod/smoke-playlog.js`, gated, station 99, against a temp DB copy): the daemon played + skipped and wrote **2 `play_log` rows** (deck A + B, `played_at`/`session`/`uuid` set) plus their insert mutations. Real DB untouched.

### Step 5 — Streaming → daemon (the gapless-stream win) — ✅ DONE
The **daemon** runs the ffmpeg → Icecast encoder off its **own** program bus, so the stream survives a UI/app restart (the daemon keeps mixing AND streaming while the app relaunches). (The Rust `StartStream`/`StopStream` are stubs — `audio.rs:450-453` — so this external ffmpeg is the real encoder.)
- **`audiod/stream.js`** (`StreamSupervisor`) is a faithful port of `main.js` `_spawnStream` + `_parseStreamLine` + the 3×/10 s respawn/backoff, with the `ffmpeg-static` asar-unpacked fixup; status is emitted as a `stream` event. `ether-audiod.js` adds `startStream`/`stopStream`/`streamStatus` (one supervisor per station, reading `audioGetProgramBusPort`). `main.js`: `stream:go-live` (when `AUDIO_DAEMON`) resolves the Icecast config from the `stations` table and hands it to the daemon's `startStream`; `stream:stop-live` → `stopStream`; the daemon's `stream` events are forwarded to the renderer's existing `stream:status` / `stream:status:dest` channels (StreamManager + on-air badge unchanged).
- **Verified:** encode-from-bus by `scripts/spike-ffmpeg-from-programbus.js` (**97 KB of valid mp3** off the bus); the supervisor lifecycle by `audiod/smoke-stream.js` (gated) — pointed at a dead local Icecast, it **spawned ffmpeg off the bus, emitted `connecting`, and respawned** (the 3×/10 s backoff). The terminal give-up is identical to the proven main.js code (its exact timing is ffmpeg's OS connect-fail latency, so the test doesn't gate on it).

### Step 6 — Lifecycle + supervision — ✅ DONE
- **Spawn:** the app already spawns the daemon **detached** on boot via `audio-daemon-client.ensure()` (outlives the app), and respawns it on reconnect if it dies while the app is up.
- **Watchdog supervision** (`watchdog/watchdog.js`): when `ETHER_AUDIO_DAEMON=1`, the HA watchdog independently probes the daemon's pipe every 5 s and (re)spawns it (`ELECTRON_RUN_AS_NODE`, detached) if dead — so the daemon survives **even while the app itself is mid-restart** (crash/update), the resilience the daemon path exists for. Two spawners are safe (the daemon single-instances on its pipe via `EADDRINUSE`). On a clean **user-quit** (`.ether-clean-exit`) the watchdog sends the daemon a `shutdown` command so it stops with the station; an **update/relaunch** (`.ether-expected-restart`) deliberately leaves it running for gapless audio. New `shutdown` command added to `ether-audiod.js`.
- **Packaging** (`electron-builder.json`): `audiod/**` added to `files` (it wasn't shipped at all); `asarUnpack` extended with `audiod/**`, `native/**/*.node`, and `electron/sync/mutation-writer.js` + `synced-tables.js` — the daemon runs under `ELECTRON_RUN_AS_NODE` (no asar layer), so every file it `require`s must be unpacked. The `audio-daemon-client` already does the `app.asar`→`app.asar.unpacked` path fixup.
- **Verified:** all 21 watchdog tests still pass (the supervision is gated off when `ETHER_AUDIO_DAEMON` is unset); `audiod/smoke-shutdown.js` confirms the daemon exits on the `shutdown` command.
- **Remaining (still TODO):** daemon **versioned/updated separately** from the app, and an idle self-exit (no client + nothing playing for N min) for unattended stations — both deferrable; the watchdog covers the resilience case now.

### Step 7 — Now-playing push STAYS in the app (locked)
The app keeps POSTing now-playing to the backend, driven by forwarded `playstart`/`deck` events. A brief pause during a UI update is cosmetic and resumes on relaunch. (Could move to the daemon later if unattended now-playing matters.)

### Acceptance + rollback
- **Acceptance (the Item 10 success criterion):** with a station live **through the daemon**, kill + relaunch the app → **audio, stream, and logging continue uninterrupted**.
- **Rollback:** keep the in-main addon path behind a flag (e.g. `ETHER_AUDIO_DAEMON=0`) until the daemon path is proven on OV, so any regression flips back to the in-process engine instantly.
- **Sequencing:** Steps 0–7 are ✅ **DONE** (runtime gate; main forwarders; renderer proxy + App.tsx wiring; play-logging; streaming; lifecycle/watchdog supervision + packaging; now-playing stays in the app) — all behind `ETHER_AUDIO_DAEMON`, default off. **Only the off-air ACCEPT run remains** before shipping to OV: launch `ETHER_AUDIO_DAEMON=1` (`npm run electron:dev`), verify playout/advance/queue/VU/now-playing/stream/play-log all flow through the daemon, then kill the UI → audio + stream + logging continue. (Deferred niceties: daemon versioned/updated separately from the app; daemon idle self-exit for unattended stations.)
