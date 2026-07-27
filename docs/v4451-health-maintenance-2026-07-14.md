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

---

## Overnight soak — validated (2026-07-14)

Formal receipt for the **4.4.48 → 4.4.51 arc** (source-wipe race fix → live Health Monitor →
non-terminal fallback + handover → health-maintenance tuning). Read-only analysis of
`ether-audiod.log(.1)` + `logs/health-events.jsonl`. All times local (UTC−7).

**Window:** 19:45 (7/13) → 06:42 (7/14), ~10h55m. Segmented by the startup log:
4.4.49 until 20:33, **4.4.51 from the 20:35 gapless engine reload → 06:42 (~10h07m steady-state)**.
The bulk of the soak is 4.4.51.

### Requested metrics (steady-state = window minus the 20:32–20:37 update reload)

| Metric | Target | Steady-state | Notes |
|---|---|---|---|
| play-skip alerts (`source=None, path empty`) | 0 | **0** | 1 in-window, during the 20:35 engine swap (expected teardown). Bug-A fix (4.4.48) holds. |
| `frames=+0` events | 0 | **0** | 8 in-window, all clustered 20:32–20:36 across the engine swap; none in the ~10h run. |
| engine restarts | 0 | **0** | engine **pid 31900 constant** the entire steady-state. One *intentional* gapless reload at 20:35 for the 4.4.51 install — not a crash. |
| daemon/engine uptime | — | **~10h07m unbroken** | engine 31900 up 20:35:08 (7/13) → 06:42+ (7/14). audiod supervisor/pipe continuously up since 2026-07-09T19:09Z (~4.5 days). |
| streaming drain continuity | — | **continuous** | halloVeen/Magical Forest/Open Format all streamed; drain steady ~354 kB/s; **0 drain=0 samples while streaming**. Open Format came online 20:44 and held. |

### YELLOW/RED transitions (health-events.jsonl)

- **Headline — 4.4.51 fix validated:** `starting / no fresh audio` = **589 before** the install
  (all in the 4.4.49 run) and **0 after**. The quiet≠no-data + 5 s hysteresis change eliminated
  the flapping artifact over ~10h in production.
- **RED: 0 in steady-state.** The one RED (halloVeen `silent 30s while playing`, 20:35:20) lands
  inside the 20:35 engine swap (`enginestate: off`) — the audible cost of the in-place engine
  reload during the update. Watchdog recovered (see below). This is exactly the transition the
  v4.4.50 song-boundary handover is meant to smooth — the flagged unsoaked item.
- **Steady-state YELLOW reasons:** `queue depth 4 < 5` ×18 (benign refill lag), `event-loop lag`
  0.5–0.9 s ×~19 (small GC/IO blips), and the Magical Forest silences below.
- **Watchdog STALLs:** 3 — two during the 20:35 swap (1.0 s + 8.3 s, `forcing advance`, recovered),
  and one steady-state micro-stall at 06:40:57 (s1, 1.0 s, auto-recovered, no RED).

### Separate finding (NOT a 4.4.48–4.4.51 regression)

**Magical Forest airs ~10–11 s of digital silence at :30 past every hour** (20:30, 21:30, 22:30,
23:30, 00:30) plus a few sporadic track-level silences (00:32, 03:15, 03:36, 05:19, 05:39). In
every case `peak=0` while **frames flow and the engine is `live`** — the decoder is emitting
silence, i.e. a **content/clock element**, not a pipeline stall. The clean hourly :30 cadence points
to a scheduled silent element on Magical Forest's clock. Flagged for a separate content review.

### Verdict

**4.4.48–4.4.51 validated.** Over ~10h steady-state on 4.4.51: 0 play-skips, 0 `frames=+0`,
0 engine restarts, 0 REDs, continuous stream drain, and the headline flapping fix confirmed
(589 → 0). The only disruption was the ~90-second in-place engine swap during the 4.4.51 update
itself (1 RED, halloVeen ~30 s silent, watchdog-recovered) — the known cost of a gapless reload,
and the case the v4.4.50 handover (still unsoaked) targets. The Magical Forest hourly silence is a
content/clock issue, tracked separately.
