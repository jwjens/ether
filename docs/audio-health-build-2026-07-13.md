# Audio-Health / Health Monitor — BUILD checkpoint (2026-07-13)

**Status: BUILT, compiles clean (node --check + vite build green). NOT committed, NOT installed.
STOP for Jeff's review.** Display + event-logging only; no watchdog/recovery/playout/native/daemon
changes; renderer is one-way display; identity by station UUID.

---

## What was built

**One source of truth** — a new main-process module that is a *pure consumer* of signals main.js
already receives from the daemon, plus a read-only ping. It computes per-station health once/second,
logs every level transition as a structured JSONL event (Iris feed), and broadcasts a snapshot that
**both** surfaces render (no duplicate logic).

### New files
- `electron/audio-health.js` — the state machine (GREEN/YELLOW/RED/GREY), JSONL event writer, and
  per-second snapshot broadcaster. All fs/compute guarded; can never throw into the event handler or
  playout.
- `src/audio/health.tsx` — shared renderer module: `useAudioHealth()` hook (subscribes to
  `audio:health` + initial `health:snapshot`), color/label helpers, `HealthDot`, `MeterBar`, and the
  full `<LiveHealthMonitor/>` view. MINI and FULL both consume this — one feed, no recomputation.

### Wiring (additive only)
- `electron/main.js`
  - `:433+` health setup inside `if (AUDIO_DAEMON_DESIRED)`: instantiate `createHealthMonitor` with
    `broadcast=sendToAllWindows`, a 2 s-timeout `ping` via `audiodClient.cmd("ping")`, a **read-only
    64 KB tail** of `ether-audiod.log` for the two display signals the daemon only logs (per-station
    `drain B/s`, daemon `pid`), `uuidOf=_stationUuidById`, and a cached `stationName` via
    `getDb()`. `.start()` + `ipcMain.handle("health:snapshot", …)`.
  - Inside the **existing** daemon-event handler (`:436-:474`): guarded `_health.note*()` calls added
    to the `levels`/`deck`/`queue`/`enginestate`/`playstart` branches, plus a new
    `else if (m.event === "error" && m.where === "play-skip")` branch. No existing behavior changed.
- `src/components/MasterOutput.tsx` — MINI collapsible **directly under Show Progress** (`ether_health_mini_collapsed` key, same pattern as the siblings): per-station dot + name + `"231k/s pk .61"` + reason when not green.
- `src/components/HealthMonitor.tsx` — `<LiveHealthMonitor/>` injected at the top of the page as the
  primary content; the old session/HA panels kept but **clearly relabeled "Legacy diagnostics — may
  be stale."** Title renamed **System Health → Health Monitor** (header + popout).
- `src/App.tsx` — Tools-menu item renamed **System Health → Health Monitor** (`:2962`).
- `src/lib/haRollup.ts` — comment rename for consistency.
- **No preload change** — the generic `ether.on/off/invoke` bridge already covers `audio:health` +
  `health:snapshot`.

## State machine (exactly per spec)
GREY = automation off · GREEN = automation on + frames >90% full rate (>39,690/s) + peak >0.01 in
last 10 s · YELLOW (any) = queue <5, next-deck not ready with <30 s left, silent 10–30 s while
playing, degraded frame rate (>5 s), ping >500 ms · RED (any) = frames frozen ≥3 s, play-skip,
silent >30 s while playing, engine restart (pid change), queue empty. Precedence RED>YELLOW>GREEN>GREY.

## Three surfaces
1. **Station badge (MINI)** — right panel, under Show Progress: dot + name + rate/peak + reason; dot
   pulses on YELLOW/RED.
2. **Full page (Tools ▸ Health Monitor)** — LIVE, updating every second: per-station rows (dot, frames
   meter, peak meter, queue depth, next-deck ✓/…, current track + `-m:ss` remaining, stream ▲ drain
   kB/s or "stream off"); Engine section (uptime, pid, restarts + "engine restarted", event-loop ping
   ms); rolling last-20 YELLOW/RED event feed (newest first, updating in place). Legacy panels below,
   labeled stale.
3. The Iris feed (JSONL) is the machine surface — see below.

## Iris event feed
`%APPDATA%/Ether/logs/health-events.jsonl`, one line per level transition:
`{ts, stationUuid, stationName, level, prevLevel, reason, metrics:{framesPerSec,peak,activeDecks,queueDepth,nextDeckReady,trackLeftSec,enginestate,streaming,drainBps,pingMs,enginePid}}`.

## The 3 open design questions — resolved (my call, per instruction)
1. **JSONL location + rotation:** `logs/health-events.jsonl`. **No rotation in this build** — events
   are logged only on *transitions* (not per tick), so volume is low. Follow-up: add the same
   size-cap `.1` rotation as `daemon-log.js` if it ever grows. (Noted so it isn't forgotten.)
2. **"Degraded frame rate" threshold:** < 90% of full rate (39,690/s) sustained > 5 s → YELLOW;
   ≤ ~0 for > 3 s → RED (frozen). Distinct thresholds so a brief dip warns before a freeze reds.
3. **Tools monitor = page, not window:** live view injected into the existing Health Monitor page
   (not a new window), legacy sections relabeled. "Last 20 events" is an in-memory ring in the
   snapshot (mirrors the JSONL tail) — no file read from the renderer.
4. **drain B/s + daemon pid** (not emitted as events): read from a read-only 64 KB tail of the daemon
   log in main (≤1×/s) — display-only, no daemon change.
5. **"refill returned 0 playable"** isn't emitted as an event by the daemon, so that YELLOW is covered
   by the queue-depth signals (depth <5 → YELLOW, empty → RED), which fire in exactly that scenario.

## Blast-radius audit
- **No playout/watchdog/recovery/scheduler/advance/native/daemon code touched.** The module only
  reads existing event payloads + a read-only ping + a read-only log tail; it calls nothing that
  mutates audio state.
- **Renderer can never affect playout:** data flow is strictly main→renderer (`sendToAllWindows`);
  both surfaces are display-only and issue **no** commands. A surface crash is isolated to its window.
- **Health module can never affect playout:** the tick, ping, JSONL append, and every `note*` are
  wrapped so a failure (disk full, bad payload) is swallowed — never propagates into the daemon event
  handler (already `try/catch` at `main.js:474`) or the audio path. `setInterval` timer is `unref`'d.
- **Identity by UUID** end-to-end (`uuidOf=_stationUuidById`; snapshot + JSONL keyed by `stationUuid`).
- **Additive only:** no existing IPC channel semantics changed; new channels `audio:health`
  (broadcast) + `health:snapshot` (invoke). New files + relabels + one menu-label rename.
- **Untouched:** silent-wedge watchdog, daemon-reload, stage-engine, native, the daemon itself.

## Verify (green)
- `node --check electron/audio-health.js` → OK; `node --check electron/main.js` → OK.
- `npm run build` (vite) → **✓ built, exit 0** (renderer compiles with all new components).
- Bug-A watcher (pid 75092) + s3 stream left running throughout, untouched.

## To review then ship (on GO)
Not committed. On your review + GO: bump version, commit, `electron-builder` installer, STOP before
install. On install: Tools ▸ **Health Monitor** shows live per-station rows updating each second; the
MINI appears under Show Progress; `health-events.jsonl` begins logging YELLOW/RED transitions.

**STOP — built, not committed. Awaiting Jeff's review.**
