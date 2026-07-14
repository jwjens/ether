# Audio-Health System — Design + Blast-Radius (2026-07-13)

**Status: DESIGN ONLY. No code written. STOP for Jeff's GO.**

One source of truth for per-station audio health, an early-warning state machine, a structured
event feed (Iris's future sensory input), and three read-only surfaces. **Display + event-logging
only — zero changes to watchdog / recovery / playout. A renderer failure can never affect playout.
Identity by station UUID.**

---

## 1. Core principle — one computation, many surfaces

The main process **already receives every per-station signal** we need, and already re-broadcasts it
UUID-scoped to renderers. The health system is a **pure consumer** of that existing stream plus one
cheap liveness probe — it introduces **no new coupling to playout**.

Existing intake (receipts, `electron/main.js`):
- `:436` `m.event === "levels"` → the daemon's `audioGetLevels` payload, which since v4.4.46 carries
  `frames_total`, `active_decks`, `mon_vol`, per-deck `decks[]`, plus `a/b/c/master` peaks. Already
  UUID-scoped via `scopeLevelsFrame(m, _stationUuidById)` (`:438`).
- `:450` `enginestate` (`live|stalled|off`) → also kept in `_daemonEngineState` (`:263`).
- `:447` `deck` event with `{ ready }` (next-deck-preloaded indicator).
- `:449` `queue` event with `{ items }` (queue depth).
- `:457/:466` `playstart` / `stream:status`.
- `:424` `_stationUuidById(id)` — the UUID identity map (spec requirement).
- Per-station wedge signals already computed by the watchdog (`:360-:410`): cpal-callback staleness,
  levels staleness — **read-only reuse; the health module does not touch the watchdog.**

Proposed new, self-contained module **`electron/audio-health.js`** (main process): maintains a
per-station health record, ticks once/second, computes the level, logs transitions, and broadcasts
the current state. Every surface renders **the same broadcast** — no surface recomputes anything.

```
daemon events ──▶ main.js intake (existing) ──▶ audio-health.js (NEW, consumer)
                                                   │  per-second tick + ping RTT
                                                   ├─▶ health-events JSONL   (Iris feed)
                                                   └─▶ sendToAllWindows("audio:health", snapshot)
                                                          ├─▶ station badges
                                                          ├─▶ right-panel monitor
                                                          └─▶ tools-menu monitor
```

## 2. Signals (all already available in-process)

| Signal | Source | Notes |
|---|---|---|
| frames/sec | Δ`frames_total` between `levels` events ÷ Δt | full rate ≈ 44100; “>90%” = ≥ ~39,690/s |
| peak | `master` (and per-deck) from `levels` | “silent” = peak ≤ 0.01 |
| automation on/off | `enginestate` (`off` ⇒ GREY) + `active_decks` | |
| queue depth | last `queue` event `items.length` | |
| next-deck ready | `deck` event `ready` flag + current track time-left | |
| refill returned 0 | `queue` event `source` + zero-add (or a daemon `error` "0 playable") | |
| engine restart | daemon pid change (already tracked for stale-daemon reload) | RED |
| play-skip | daemon `error` `where:"play-skip"` (added in 4.4.48) | RED |
| event-loop lag | main→daemon `ping` round-trip, sampled each tick | YELLOW if > 500 ms |

## 3. State machine (exactly per spec)

Computed per station, once/second:
- **GREY** — automation off (`enginestate=off`).
- **GREEN** — automation on **and** frames > 90% full rate **and** peak > 0.01 within last 10 s.
- **YELLOW** (early warning — "close to stopping"): any of — queue depth < 5; next deck not ready
  when current track has < 30 s left; a refill returned 0 playable; peak silent 10–30 s while
  playing; degraded frame rate; ping RTT > 500 ms.
- **RED** — frames frozen ≥ 3 s; play-skip event; peak silent > 30 s while playing; engine restart
  (pid change); or queue empty.

Precedence RED > YELLOW > GREEN > GREY. Hysteresis: a level holds for a min dwell (e.g. 2 s) before
downgrading GREEN←YELLOW to avoid flapping; RED is immediate.

## 4. Event feed (Iris's input) — same pattern as the Iris Watch ledger

On **every level transition**, append one line to
`%APPDATA%/Ether/logs/health-events.jsonl`:
```json
{"ts":"2026-07-13T23:41:00.000Z","stationUuid":"…","level":"YELLOW","prevLevel":"GREEN",
 "reason":"queue depth 3 < 5","metrics":{"framesPerSec":44100,"peak":0.31,"queueDepth":3,
 "nextDeckReady":true,"trackLeftSec":47,"enginestate":"live","pingMs":12,"enginePid":46048}}
```
Deterministic + structured + one event per transition (not per tick) → directly consumable by Iris
as an event stream, mirroring the existing daemon/watchdog ledger style. A snapshot of *current*
state for all stations is also broadcast each tick for the live surfaces (not logged).

## 5. Three surfaces (all render the same `audio:health` broadcast — no duplicate logic)

1. **Station badges** — colored dot + `"230k/s pk .61"`; YELLOW/RED pulse (CSS animation).
2. **Right-panel health monitor** — per-station rows: live frames/peak, reason string, queue depth,
   next-deck-ready indicator, engine uptime.
3. **Tools-menu health monitor** — same rows **+ last 20 health events** with timestamps (tail of the
   JSONL, read-only).

All three subscribe to `window.ether.on("audio:health", …)`; none computes health.

## 6. Blast-radius audit

- **No playout/watchdog/recovery/scheduler/advance code touched.** `audio-health.js` only *reads*
  existing event payloads + issues a read-only `ping`. It calls nothing that mutates audio state.
- **Renderer can never affect playout.** Data flow is strictly main→renderer (`sendToAllWindows`); the
  surfaces are display-only and issue no commands. If a renderer surface throws/crashes, it's isolated
  to that window and cannot reach the daemon or the audio path.
- **Health module can never affect playout.** The per-second tick and the transition/JSONL writes are
  wrapped so a failure (e.g. disk full on the JSONL append) is swallowed and never propagates into the
  daemon event handler or anywhere on the playout path — same guard discipline as `daemon-log.js`.
- **The `ping` probe** reuses the existing daemon client; RTT sampling once/second is negligible and
  identical to the liveness the watcher already does — it does not gate or trigger any recovery.
- **Identity by UUID** throughout (`_stationUuidById`); no station-index assumptions.
- **New files only** for the core: `electron/audio-health.js` + the JSONL log. Renderer surfaces are
  additive components subscribing to one new IPC channel. No existing IPC channel semantics change.
- **Not touched:** the silent-wedge watchdog, reload logic, stage-engine, the daemon, native code.

## 7. Files (proposed — for GO)

- **New:** `electron/audio-health.js` (the state machine + JSONL writer + per-tick broadcast).
- **New:** renderer components for the 3 surfaces (badge dot, right-panel rows, tools-menu window),
  each subscribing to `audio:health`.
- **Touched (additive only):** `electron/main.js` — one `require` + wire the health module into the
  *existing* daemon-event intake (it reads the same `m` objects already handled at `:436-:466`) and a
  `sendToAllWindows("audio:health", …)` each tick; `electron/preload*.js` — expose the `audio:health`
  subscribe + a `health:recent-events` read. No changes to any existing handler's behavior.

## 8. Open questions for Jeff (before GO)

1. JSONL location — `logs/health-events.jsonl` under userData (proposed), and rotation policy (size
   cap + `.1` like `daemon-log`)?
2. Exact "degraded frame rate" YELLOW threshold (proposed < 90% for > 5 s, distinct from the 3-s RED
   freeze)?
3. Tools-menu monitor as a separate window vs. a panel — and should "last 20 events" tail the JSONL or
   an in-memory ring?

---

**STOP — design only, no code. Awaiting your GO to build.** (Not committed.)
