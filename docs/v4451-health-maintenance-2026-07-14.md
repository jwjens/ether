# v4.4.51 — Health Monitor maintenance (5 items) — BUILD (2026-07-14)

**Status: BUILT, compiles clean (node --check ×3 + vite build green). Committed + pushed. NOT built to
an installer, NOT installed. STOP for review.** Display + event-logging only; no playout changes.

---

## 1. BUG — streaming shows "stream off" while live
`main.js` stream-event branch: added `_health.noteStreamStatus(m.stationId, m.state)`. The monitor now
shows ▲ + drain B/s for a live stream. (Drain B/s comes from item 2's tail.)

## 2. BUG — drain-rate tail goes blind after log rotation
After `daemon-log.js` rotates (`…log → …log.1`, fresh `…log`), the Rust stderr **inherited fd keeps
writing to the renamed `.1`** while JS writes to the fresh log. `main.js:_healthReadTail` now reads the
last 64 KB of **both** `ether-audiod.log` and `ether-audiod.log.1` (`.1` first, then current; last
`Station N drain: real=` match per station wins — post-rotation the fresh drain is in `.1`, pre-rotation
in the current). **Chosen over daemon-side stderr re-open** because in-process `dup2` on fd 2 isn't
available in pure Node on Windows (same reason the original stderr capture used an inherited fd), so the
two-file read is the provably safe one. Read-only; guarded. Residual: after ≥2 rotations the Rust fd's
inode can be orphaned — rare (rotation is MB-scale/rare), and item 5 removes the pid's dependence on the
tail entirely.

## 3. TUNING — quiet ≠ no data + 5 s UI hysteresis (`audio-health.js`)
- **Quiet ≠ no data:** if the levels stream is still arriving (`framesAt` within 2.5 s), the station is
  GREEN even if this sample's frames/s dipped (getLevels delta jitter) or the peak is merely low. This
  kills the "starting / no fresh audio" single-sample false positives that produced ~150 flapping
  yellows (correlation showed peak stayed healthy 0.3–0.98). Real freezes are still caught by the
  frames-frozen RED (`lastFramesAdvanceAt`) and silent RED (peak stale >30 s).
- **5 s display hysteresis:** the record now tracks a `displayLevel` — a WORSE level must hold ≥5 s
  before it surfaces in the UI (per-station level + the on-screen event ring); recovery surfaces
  immediately. **`health-events.jsonl` keeps every RAW transition at full fidelity** (logged the moment
  it happens); only the UI is debounced.

## 4. Banner wording (`src/audio/health.tsx`)
In-process fallback **airs all stations** — only the metering is single-station. Banner now:
"⚠ IN-PROCESS FALLBACK — daemon not attached. All stations are still airing; the Health Monitor meters
only the active station. Relaunch to restore daemon telemetry." (Compact: "IN-PROCESS FALLBACK —
metering active station only".)

## 5. Engine uptime/pid "—" — ask the daemon, don't scrape the log
- `audiod/ether-audiod.js`: `ping` now returns `{ pong:true, pid: process.pid, startedAt: DAEMON_STARTED_AT }`
  (approx from `process.uptime()`). No consumer depended on the old `"pong"` string (health uses RTT,
  the watcher ignores content).
- `main.js`: `_healthPing` captures `{pid, startedAt}` from the reply into `_daemonPingInfo`;
  `enginePidProvider` returns the daemon-reported pid when `AUDIO_DAEMON` (else the log tail — fallback
  mode only); new `engineStartedAtProvider` gives the module the real start for uptime.
- `audio-health.js`: snapshot uptime prefers the reported `startedAt`. **Restart detection (pid change)
  comes free** — the module bumps `restartCount` when the reported pid changes.

---

## Blast-radius
- Display + event-logging only; no watchdog/recovery/playout/native changes. The `ping` reply change is
  additive (object instead of a string; no consumer parsed the old value).
- Hysteresis/quiet tuning only relaxes YELLOW surfacing — the RED wedge/silence signals are unchanged,
  and JSONL fidelity is preserved.
- Two-file tail is read-only (`.log` + `.1`), guarded.

## Verify
- `node --check` green: `main.js`, `audio-health.js`, `ether-audiod.js`.
- `npm run build` (vite) → **✓ built, exit 0**.
- Live box untouched (no restart/install).

## Commit / push
Committed 4.4.51 and pushed to origin. **No installer built, nothing installed.** STOP for review.
