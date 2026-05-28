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

## State ownership — the Phase-1 design call

Today playout state is split: the **Rust** addon owns the live mixer/deck audio state; **`engine-rodio.ts`** (renderer) owns the JS-side queue, deck status mirror, auto-advance/rotate logic, and end-detection; the **scheduler** (`loggen.ts`) + the now-playing push live in the renderer/`App.tsx`. For a daemon that survives UI restarts, **the queue + rotate/advance logic must move into the daemon** (else a UI restart loses the queue). Open question for Phase 1: does `loggen` (clock/rule/random fill, reads the SQLite library) also move into the daemon, or does the daemon request fills from a connected client? Leaning: move the queue + advance into the daemon; keep `loggen` callable in the daemon (it only needs DB read access — the daemon can open the same `openair.db` read path). The now-playing push to the backend can stay in the app (it's just an HTTP POST off the daemon's state events).

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
- [ ] Lock the state-ownership decision (queue/advance → daemon; loggen location) before Phase 1 — the only remaining Phase-0 item

**Phase 0 verdict:** the daemon approach is technically validated — the engine runs fully headless in standalone Node. Remaining before Phase 1 is the one design lock (state ownership).
