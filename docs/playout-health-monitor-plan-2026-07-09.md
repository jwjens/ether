# Playout Health Monitor + dead-air watchdog + daemon logging — build plan (2026-07-09)

GO'd. Discovery-first; **no code yet, HOLD for GO on this plan.** Fixes the class of failure in
`docs/overnight-rotation-stop-forensics-2026-07-09.md` (playout froze / never-started while a full schedule
existed, invisibly). Ships the watchman's screen as a **detached standalone window**.

## Discovery — what already exists (receipts)
- **Panel to extend:** `src/components/SchedulerHealthPanel.tsx` (185 lines; tabs `health`/`generate`; reads
  `schedule:categoryHealth` + `schedule:runway`). Host `SchedulerHealthHost` opens on `ether:open-scheduler-health`.
- **Live daemon→renderer events ALREADY flow** (this is the spine of the monitor):
  - `audio:daemon-playstart` = **song landed** — `main.js:382` `{stationId, deck, title, artist, filePath}`.
  - `audio:daemon-deck` — `main.js:373` `{stationId, deck, state, ready}` (deck `state` carries `scheduled_at`, `engine.js:51`).
  - `audio:daemon-enginestate` — `main.js:380`; preload subs `onPlayStart/onDeck/onEngineState` (`preload.js:33-41`).
  - `onLevels` UUID-scoped from v4.4.40 (`electron/levels-scope.js`) → per-station VU, reusable.
- **Broadcast hits ALL windows:** send helpers use `BrowserWindow.getAllWindows().forEach(w => …send)` (`main.js:3461,3469,3573`). **A second window auto-receives every daemon event** and owns its own subscriptions — the survival property the monitor needs.
- **Detached-window precedent:** Producer Desk window `main.js:3441-3461` (`new BrowserWindow` → `#desk` hash route, multi-monitor via `screen.getAllDisplays()` `:3504`); popout pattern `:1449-1460` (`#popout/<panel>`). Same renderer bundle, hash-routed. `alwaysOnTop` (`:1234`) and `frame:false` (`:1452`) are already used → toggle + kiosk are available.
- **Launch points:** native menu **Tools** submenu `main.js:1511`; **tray** menu `createTray()` `:1406-1409`.
- **Daemon automation + existing watchdog** (`audiod/engine.js`): `poll()` 250ms (`:108`); `_started` gate (`:80`); `_watchdog()` (`:242-275`) — `STALL_MS=1000` (`:29`), `WEDGE_MS=3000`; **it is gated `if (!this._started) return` (`:245`)** and only kicks an *in-flight* stall. `_log(...)` is **console-only** (`:96`). `_recoverStall` (`:280`).
- **Auto-resume** replays `automationStart` per station on daemon reconnect (`main.js:402-415`), keyed by stored automation intent.
- **NOT found: any window bounds/size persistence** → must be built for "remembers position/monitor."

## Root cause the watchdog must newly cover (receipt-backed)
The existing `_watchdog` is inert unless `_started===true` (`engine.js:245`). **halloVeen consumed 0/3028 because `_started` was never true for st2** (automation never started) — the watchdog by-design won't touch it. And it only recovers an *in-flight* wedge, not a station that stopped/never-advanced. The new dead-air watchdog is a **broader** check.

## Build plan

### Part 1 — Daemon safety net (the 2 AM saver; build FIRST)
1. **Dead-air watchdog** (`engine.js`, new check in `poll()` alongside `_watchdog`): condition = *a schedule
   exists for this station (generated_schedule has a current/next event) AND no advance completed in > N min
   (track `_lastAdvanceAt`, set on every successful playstart) AND automation is supposed to be engaged.*
   → (a) `_log` loudly; (b) **conservative recovery: only kick a stalled advance** (`_recoverStall`) — never
   skip content; (c) emit a health event with RED. **Scheduling-tier (autonomous, logged).** Does NOT
   auto-go-on-air a never-started station (that's transport) — instead surfaces RED + logs "automation not
   started" so the panel screams and #3 gets root-caused.
2. **Rotating `ether-daemon.log`** in `userData` (hook `engine.js:_log` `:96` + stream.js ffmpeg + scheduler
   picks → a shared appender with size-based rotation). station_id + ISO ts on every line. This is what was
   missing overnight — the next stall gets fingerprints.
3. **halloVeen 0-plays — tracked root-cause:** instrument/inspect why `automationStart` was never issued for
   st2 (was it not in the auto-resume intent set `main.js:402-415`? not on-air at launch? file paths?).
   Deliver a receipt, then a targeted fix (ensure every on-air station's automation actually starts).

### Part 2 — Honest playout-health status (daemon → renderer)
New `audio:daemon-playout-health` event per station: `{stationId, status, lastAdvanceAt, lastTitle,
onAirDeck, deckElapsed/Remaining, nextScheduledAt, scheduleHasEvents, watchdogState, lastWatchdogAction}`.
Status derived **only from songs advancing**: GREEN advanced within expected window; AMBER overdue; RED
schedule exists but nothing consumed > N min. Encoder/mount state travels on the **separate** `stream`
event and is never folded into `status`.

### Part 3 — Standalone Health Monitor window (Electron)
- New `BrowserWindow` on hash route `#health-monitor`, modeled on Producer Desk (`main.js:3441-3461`):
  own window, multi-monitor placement via `screen.getAllDisplays()`.
- **Launch:** Tools submenu (`:1511`) + tray (`:1406`), via a new `open-health-monitor` path.
- **Options:** always-on-top toggle (`:1234` pattern), frameless/kiosk (`frame:false` `:1452`), click-through OFF.
- **Bounds persistence (NEW):** save `{bounds, displayId}` to `installConfigKv` (per machine) on move/resize/close; restore on open; clamp to a currently-connected display.
- **Survival:** separate BrowserWindow = separate renderer → survives main-window **minimize + close + renderer-crash**, and keeps receiving events (broadcast hits all windows). Requires: **don't quit the app on main-window close while the monitor is open** (gate the existing close/quit decision `main.js:1364`). **Honest limit:** if the whole Electron *main process* dies, all windows die — only the *daemon* is a truly separate process; true process-independence would need the monitor as its own process (bigger; call it out, not in v1).

### Part 4 — Monitor UI (per station × 3 side-by-side; big-type, dark, glanceable)
Per station column: proof-of-life GREEN/AMBER/RED (from Part 2) as the dominant element; on-air deck + track
+ elapsed/remaining; last play_log entry + **age**; next scheduled event; **live scrolling play-log tail**
(rows appear on `onPlayStart`); **schedule-consumption tail** (upcoming events checked off as consumed);
**encoder/mount strip clearly labeled "DISPLAY — not proof-of-life"**; per-station VU (UUID-scoped `onLevels`);
runway hours (`schedule:runway`); silence-watch; daemon heartbeat; dead-air watchdog status + last action.
DB-verified on refresh (own `query()` reads of play_log/generated_schedule). Red states unmissable.
**One-click** from a station tile → main window jumps to that station (reuse station-switch IPC).

### Two-tier (honored)
Watchdog kick-advance = **scheduling-tier** (autonomous, logged). Encoder start/stop, going on-air, and the
one-click station jump acting as transport = **operator-gated**. The monitor *reports* transport; it doesn't
seize it.

## Suggested phasing (each its own GO)
1. **Part 1** (watchdog + `ether-daemon.log` + halloVeen receipt) — highest value, smallest surface, saves
   the next night even with no UI.
2. **Part 2** (health event) + minimal Playout tab in the existing `SchedulerHealthPanel` — proves the data.
3. **Part 3+4** (standalone window + full wall UI).

## Receipts / limits
- Everything in Parts 2–4 rides existing event plumbing + the Producer-Desk window pattern; the only net-new
  Electron mechanism is **bounds persistence** (none exists today).
- The 19:34 *why* is still unproven (no persisted daemon log) — Part 1.2 fixes that going forward; Part 1.1
  makes it self-heal + visible regardless of cause.

**No code changed. HOLD for GO** (per-phase gates yours).
