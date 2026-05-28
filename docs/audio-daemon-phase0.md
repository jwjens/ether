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

### Step 0 — Runtime decision (GATE, do first)
How does the daemon run in the *packaged* app? Dev uses system Node 24 (has `node:sqlite`); a packaged install has no guaranteed system node. The daemon needs (a) the N-API addon — loads in any node/Electron, already proven; and (b) `node:sqlite` — Node 22.5+ (experimental).
- **Candidate:** spawn the daemon via Electron's bundled node — `ELECTRON_RUN_AS_NODE=1 <electron.exe> audiod/ether-audiod.js` — **detached** so it outlives the app.
- **Spike (blocking):** in a packaged build, confirm `require('node:sqlite')` works under `ELECTRON_RUN_AS_NODE` (i.e. the shipped Electron bundles a Node ≥ 22.5 with `node:sqlite`). If not → ship a small standalone `node` binary with the app, **or** give the daemon a `better-sqlite3` rebuilt for the daemon's node ABI (heavier; loses the "no native rebuild" win). **No cutover code lands before this is decided.**

### Step 1 — Addon ownership → daemon; main becomes a forwarder
Today `electron/main.js:190` `require`s `ether-audio.node` in the **main** process; the `audio:*` handlers (`main.js:1581-1668`) call it directly; a levels poll (`1126-1130`) emits `audio:levels`.
- After: the **daemon** owns the addon. Main keeps a single pipe **client**; each `audio:*` handler becomes a thin forwarder (`cmd(...) → pipe`). Keep the existing no-addon stub (`main.js:204`) as the "daemon down" fallback.
- Levels: main subscribes to the daemon's `levels` events and re-emits `audio:levels` to windows — **renderer VU code unchanged**.
- Main spawns the daemon on boot if the pipe isn't answering; the daemon's `EADDRINUSE` guard already prevents duplicates.

### Step 2 — Renderer engine → remote proxy
`src/audio/engine-rodio.ts` stops running the 250 ms poll + advance locally. Instead it **subscribes** to forwarded `deck`/`queue`/`levels`/`playstart` events and renders them; operator actions (deck load/play/pause/stop, enqueue, reorder, skip, chain-type, volume/EQ, broadcast-delay, dump, **cart** load/play) become daemon **commands**. The `DaemonEngine` is the queue/advance authority; the renderer queue is a mirror. In `App.tsx`, `setRefillCallback` is removed (daemon self-refills via `continuous`); `onPlayStart`/`on` become subscriptions.

### Step 3 — Scheduler: daemon self-fills; renderer loggen leaves the hot path
The daemon's `continuous` + `loggen.js` keep the queue full. `fillQueueFromSchedule`/`refillFromSchedule` no longer drive live refills; a manual "regenerate queue" UI action becomes a `fill` command. (`loggen.ts` may remain for UI preview but is off the live path.)

### Step 4 — Play-logging → daemon (read-WRITE `node:sqlite`)
Today `App.tsx` logs on `onPlayStart` (`logPlay` → write `play_log` + `last_played_at`/`play_count`). After: the **daemon** writes the play log on its own `playstart`, so logging continues headless during a UI update. The daemon's `last_played_at` writes are exactly what its own loggen separation reads → self-consistent.
- **Spike (blocking for this step):** daemon writes `play_log` via read-write `node:sqlite` while the app holds the DB open (better-sqlite3, WAL). SQLite serializes writers cross-process via OS locks — confirm no lock-timeout/corruption under playout cadence. Until proven, leave logging in the app (current additive state).

### Step 5 — Streaming → daemon (the gapless-stream win)
Today `stream:go-live` (`main.js:4102`) reads Icecast config from the `stations` table, gets the program-bus port via `audio.audioGetProgramBusPort()`, and spawns ffmpeg reading `tcp://127.0.0.1:<port>` → Icecast, with 3×/10 s respawn (`4078-4097`) + status events. (The Rust `StartStream`/`StopStream` are stubs — `audio.rs:450-453` — so the encoder really is external.)
- After: the **daemon** spawns ffmpeg reading its **own** program-bus port → Icecast, porting the same respawn/backoff + status events (re-emitted to windows via the pipe). Icecast config from the `stations` table via the daemon's `node:sqlite` (read), or passed in a `startStream` command. Resolve the `ffmpeg-static` path in the daemon's process context (the `app.asar.unpacked` fixup at `main.js:2571` differs for the daemon). Main's `stream:*` handlers become forwarders. **This is what keeps the stream up across a UI restart.**

### Step 6 — Lifecycle + supervision
App spawns the daemon **detached** on boot if not running (outlives the app). Extend the **HA watchdog** (`watchdog/watchdog.js`) to also start/restart the daemon. Daemon is versioned + updated **separately** from the app (a daemon update applies only at a safe moment). On graceful station-off with no client for N minutes the daemon may exit; unattended stations run it always-on (Scheduled Task / service, like the HA setup).

### Step 7 — Now-playing push STAYS in the app (locked)
The app keeps POSTing now-playing to the backend, driven by forwarded `playstart`/`deck` events. A brief pause during a UI update is cosmetic and resumes on relaunch. (Could move to the daemon later if unattended now-playing matters.)

### Acceptance + rollback
- **Acceptance (the Item 10 success criterion):** with a station live **through the daemon**, kill + relaunch the app → **audio, stream, and logging continue uninterrupted**.
- **Rollback:** keep the in-main addon path behind a flag (e.g. `ETHER_AUDIO_DAEMON=0`) until the daemon path is proven on OV, so any regression flips back to the in-process engine instantly.
- **Sequencing:** Step 0 gates everything. Steps 1–2 are the bulk of the rewiring (no live-audio risk if exercised on station 99 first). Steps 4 and 5 each need their own spike (DB write; ffmpeg-in-daemon) before shipping. Steps 6–7 are small. Ship to OV only after the off-air acceptance test passes.
