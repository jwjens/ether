# Why 4.4.49 is running in-process (not daemon) — root-cause + fix proposal (2026-07-14)

**Playout is live on the in-process fallback. Read-only diagnosis of the running app; the code edits
below are observability-only (Priority 1) and take effect on the NEXT build/install — nothing was
committed, built, installed, or restarted.**

---

## Priority 1 — Root cause

### The decision logic (`electron/main.js`)
- `AUDIO_DAEMON_DESIRED = process.env.ETHER_AUDIO_DAEMON !== "0"` (main.js:230) — default **true**.
- `let AUDIO_DAEMON = false` (main.js:231) — flips true **only if the daemon connects**.
- `setupAudioBackend()` (main.js:562-585): if desired, `audiodClient.ensure()`, then
  `while (!isConnected() && Date.now()-t0 < 5000) …` — a **5-second** connect window. On success →
  `AUDIO_DAEMON=true`. On timeout → `AUDIO_DAEMON=false`, **`audiodClient.stop()` (TERMINAL — kills the
  reconnect loop)**, then `audio.initAudioEngine()` (in-process). Runs once at boot (main.js:592).
- The `if (!AUDIO_DAEMON)` 30 Hz in-process level poll (main.js:2194-2204) is what currently moves the
  deck VUs → confirms `AUDIO_DAEMON === false` in the running app.

### The timeline at the 4.4.49 install
- App booted **01:15:11.648Z** (pid 37776).
- Fresh daemon (pid **31096**) sink-open **01:15:11.653Z**, but **bound the pipe at 01:15:13.613Z**
  (+2.0 s after boot).
- The daemon has been **idle since** (no `[mix]` after 01:06 — the previous daemon; `setConnectedHandler`
  never fired to replay `automationStart`, so 31096 never started playing).

### The finding
The daemon bound the pipe at **+2.0 s**, *inside* the 5 s window — so on paper the app had ~3 s to
attach, yet it did not (`AUDIO_DAEMON` is false and the daemon is idle). The likely mechanism is a
connect race in `ensure()` after the fresh post-install daemon restart (probe fires before the pipe is
up → spawn/2 s-debounce → 800 ms-delayed retry → reconnect cadence just missing the +2.0 s pipe-bind),
compounded by the fatal design property: **the fallback is TERMINAL** — `audiodClient.stop()` sets
`stopped=true`, so once the 5 s expires the client **never reconnects**, even though the daemon is now
up and idle. A single boot-time race permanently strands the app in-process for the whole session.

**But the exact within-window failure is UNPROVABLE from the logs** — `ether-startup.log` has **0**
occurrences of "daemon ACTIVE" / "FALLING BACK" / "daemon unreachable" / "native addon loaded". Those
are `console.log/warn`, which main **never tees** to the startup log. That blind spot is precisely
what hid the silent fallback. Fixing it (below) is what lets us see the exact cause next boot.

### Console capture ADDED (observability-only; next build)
So the daemon-client decision trail lands in `ether-startup.log` permanently:
- `electron/audio-daemon-client.js`: added `setLog(fn)` + a durable `_log()` alongside `console` at the
  key decisions — spawn (with attempt N/5), connect (probe + after-spawn), post-spawn connect-fail →
  reconnect, and the terminal "unreachable after N spawns — giving up." Exported `setLog`.
- `electron/main.js` `setupAudioBackend`: `audiodClient.setLog(logStartup)` + `logStartup(...)` for the
  decision ("daemon desired → waiting ≤5s", "daemon ACTIVE (connected in Nms)", or "UNREACHABLE within
  5s → FALLING BACK; audiodClient.stop() TERMINAL").
- `node --check` green on both. Guarded (a logging failure can't affect the client or playout).

---

## Priority 2 — Proposals (STOP for review; nothing applied)

### (a) Restore daemon mode safely
- **This session cannot self-recover** — the client was terminally `stop()`-ed; it will not reconnect.
  Since playout is **live in-process and must not be interrupted**, there is no in-session hand-over I
  can do read-only.
- **Manual step (safe, when you have a moment):** the daemon (31096) is already up + listening + idle,
  so a **fresh app relaunch** will re-run `setupAudioBackend`, connect immediately (pipe already bound
  → no race), set `AUDIO_DAEMON=true`, and `setConnectedHandler` will replay `automationStart` to hand
  playout to the daemon. Brief transition, then daemon-driven again. (I did **not** do this — it
  restarts the app.)
- **Code fix to propose:** make the fallback **non-terminal** — drop the `audiodClient.stop()`, keep the
  reconnect loop alive so that if the daemon comes up after the boot window the client attaches and
  hands playout over **at a song boundary** (the app already has the `playstart`/song-boundary hook and
  `onConnected` auto-resume). Also widen/retry the boot window (e.g. keep polling with backoff instead
  of a hard 5 s one-shot). This turns a permanent strand into a self-healing catch-up.

### (b) Health module fed from the in-process path too (never blind)
- Add `_health?.noteLevels(sid, levels)` at the in-process emitter (main.js:2202) + the in-process
  deck/enginestate emitters. Requires promoting `_health` to a module-level `let _health = null`
  (guard `_health?.`). Where the in-process `audioGetLevels` JSON lacks `frames_total`/per-deck
  `decks[]`, the state machine falls back to peak + enginestate + queue. Note: in-process meters only
  the **active** station, so the monitor shows 1 row in fallback vs 3 on the daemon.

### (c) Impossible-to-miss RED banner on in-process fallback
- Add `mode: AUDIO_DAEMON ? "daemon" : "in-process"` to the health snapshot, and log a health event on
  the fallback decision. The Health Monitor (page + mini) renders a persistent **RED banner** whenever
  `mode === "in-process"`: e.g. *"⚠ PLAYOUT ON IN-PROCESS FALLBACK — daemon not attached; only the
  active station is airing. Relaunch to restore daemon mode."* This makes the exact state that hid for
  hours loud and unmissable — and directly actionable.

---

## State right now
- App: 4.4.49, **in-process** (`AUDIO_DAEMON=false`), playing the active station locally.
- Daemon: pid 31096, **up + listening + idle** (never driven this session).
- The other stations may **not be airing** (in-process is single-active-station) — worth confirming
  on-air status; the empty Health Monitor is (correctly) reflecting this.
- Bug-A watcher (pid 75092) still running.

**Nothing committed/built/installed/restarted. Awaiting review of (a)/(b)/(c).**
