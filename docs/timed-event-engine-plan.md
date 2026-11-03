# Timed-event engine — plan

**Date:** 2026-10-07 · **Type:** PLAN ONLY. No code changed.
**Tree read:** `release/build-fixes` (= `main` `5068390` + build fixes), so every receipt below is what ships today. The
announcement catch-up work (`wip/announce-catchup`: `549d207`, `e7e65fd`, `dd4f113`, `6f54afe`) is **not** shipping. Its
reusable parts are named in §6.
**Direction (Jeff, 2026-10-07):** no quick fixes. The catch-up was a patch over main-process stalls; build it right. One
engine **inside the audio daemon** owns every scheduled moment on air.

---

## 1. Goal (the bar)

**No UI or main-process stall can delay or skip an on-air event.**
- Every timed event fires from the audio daemon, on the audio clock, with sample accuracy.
- Events are pre-loaded and pre-buffered, so firing is instant.
- Their schedule is pushed to the engine, never polled.
- Their outcomes are persisted, so a crash or restart resumes exactly and nothing fires twice.
- Every outcome (fired, waited, missed and why) is logged and visible in the Health Monitor.
- Main only edits and pushes. Renderers and Screens only subscribe.

---

## 2. Inventory — every timed behaviour that exists today

| # | Behaviour | Where | Process / clock | Persistence & restart | DST / jumps / sleep | Vulnerable to UI/main stall? |
|---|---|---|---|---|---|---|
| 1 | **Fixed-time announcements** | `announceTick` `electron/main.js:4869-4957`; exact-second match `:4932`; 120 s guard `:4941`; tick 250 ms `:4637`, `:4995` | **main**, `setInterval` + `new Date()` | `announcement_schedule.last_played_at` (entry stamp, written by `fireAnnouncement` `:5031+`) | None. Local `getHours()` string compare. A DST fall-back hour repeats wall times (a second fire is guarded only by the 120 s window); spring-forward skips them (silent miss) | **YES**: a main stall over the due second skips it, silently |
| 2 | **Before-closing announcements** | `dueTimeFor` `:4845-4849` + `electron/announce-time.js`; closing time `closingCfgFor` `:4803` (2 s cache) / `resolveClosingCfg` `:4776` | main | KV `closing_time`; visible skip `skipped_at` `:4918-4930` | As #1 | **YES** |
| 3 | **Plays-in-a-row (×N)** | `_scheduleAnnounceRepeats` `:4969-4986` (`setTimeout` from file length) | main | **memory only**: lost on restart | n/a | **YES** (timers on main) |
| 4 | **Closing time** (Park Ops sets it) | KV `closing_time`; written by `ops:set-closing` in the renderer's `execCmd` (`src/App.tsx:1568-1593`) and the Announcements panel; invalidates `globalThis.__etherInvalidateClosing` | main + renderer | KV (synced) | n/a | Writer is in the renderer |
| 5 | **Rotation playout**: advance, preload, end detection, segue, refill | `audiod/engine.js`: poll 250 ms `:536`/`:621`; `checkEnd` `:939`; `_advance` `:1008`; `handleRotate` `:1130`; `refillIfNeeded` `:1306`; `_segueTick` `:2563` | **daemon**, `setInterval` + `Date.now()`; position from the **native sample clock** (`frames_played`, `native/src/audio.rs:128-133`, `:565-578`) | queue in daemon memory; `generated_schedule.state` | Wall clock only; no jump/sleep handling | No (separate process). Shares the DB (busy_timeout 5000) |
| 6 | **Time-anchored log reader** (picks the row for "now", stamps skipped rows `missed`) | `selectRowForNow` `audiod/loggen.js:266`; `readLogAnchored` `:335`; missed sweep + `logreader-missed` / `spot-missed` events `audiod/engine.js:1423-1447` | daemon, `Date.now()/1000` (`:1606`, `:1668`) | `generated_schedule.state` (`missed`/`played`) | None | No |
| 7 | **Hour join** (the new hour joins after the song crossing :00; the hard top-of-hour cut was removed 2026-10-04) | `audiod/hour-join.js` (pure) via `selectRowForNow` | daemon | derived from `generated_schedule` | Bounded by `MAX_JOIN_LATE_SEC` | No |
| 8 | **Auto-fitter** (make a seam land on a hard anchor) | `audiod/autofit.js` (pure, observation-only v1) | daemon | none (logs a decision) | n/a | No |
| 9 | **Spot breaks / timed clock breaks** | Placed at **generation** (`clock_breaks`, `electron/generate-core.js`); aired by #5/#6 as `generated_schedule` rows (`content_class 'SPOT'`) | generation in main; airing in daemon | `generated_schedule` | via #6 | Generation yes (#11); airing no |
| 10 | **Jingles / sweepers at seams** | `readJingleForSeam` (`audiod/loggen.js`), `_jingleTick` `audiod/engine.js:2593`, fire `:2816`; sweeper placements `schedule:sweeper-placements` | daemon (seam-relative, 250 ms tick) | `generated_schedule` JIN/SWP rows | n/a | No |
| 11 | **Schedule generation / auto-extend** | `_autoExtendTick` every 30 min (`electron/main.js` ~`:10489-10600`; `:11359`); chunked hour slices | **main** | `generated_schedule` | n/a | It *causes* main stalls (`generate-timing` health events) |
| 12 | **Jukebox next pick** | `src/components/Jukebox.tsx` (drive `:570-644`; 1 s / 3 s polls `:383-748`) | **renderer** (jukebox pop-out) | requests in DB; drive state in the window | Throttled when covered/minimised (UNVERIFIED) | **YES**: renderer |
| 13 | **Park Ops cart fire, web-remote commands** | `execCmd` inside an App.tsx effect (`src/App.tsx:1346-1759`) | **renderer** | none | n/a | **YES** |
| 14 | **Broadcast delay / DUMP** | stream path (`native/src/lib.rs` ~`:895`, delay buffer in `native/src/audio.rs`) | Rust audio thread | memory | n/a | No |
| 15 | **Sleep/resume** | only `powerMonitor` → the **sync** scheduler (`electron/main.js:3465-3468`) | main | — | Playout and announcements have **no** sleep/resume or clock-jump handling anywhere | — |

The **daemon** already has: a read-write node:sqlite handle (`audiod/ether-audiod.js:190`; it already writes `play_log`
through the app's own mutation writer, `audiod/playlog.js:16`), a push channel to main (`broadcast()`, `:155`; ~20 event
types today), command intake (`audiodClient.cmd` → the `cmds` table in `ether-audiod.js`, e.g. `load` `:417`), and the
native **sample clock** per deck (`frames_played`) and per bus (`frames_consumed`, `audio.rs:639`).

**The native engine has NO "start at sample N" command today.** `load`/`play` act on arrival (`native/src/lib.rs:78`,
`:104`). Sample-accurate firing needs one new real-time command (§4.3).

---

## 3. Architecture

```
  main (edits only)                         audio daemon (owns time)                         windows / Screens
  ─────────────────                         ──────────────────────────                         ─────────────────
  schedule / closing / KV writes ──push──►  Timeline compiler ──► Timeline (persisted) ──► Scheduler (sample clock)
  inbound sync (applyDbMutation) ──push──►        ▲                       │                       │ fire: play_at(frame)
                                                  │                       ▼                       ▼
                                           Clock discipline        Ledger (persisted)      native mixer (Rust)
                                                                          │
                                                       state stream ('timeline' event) ──► main relay / direct ──► Up Next, heads-up, countdowns
```

### 3.1 Timeline compiler (daemon)
- **Input:** the DB tables that define timed events (`announcement_schedule` + `announcements`, KV `closing_time`,
  `generated_schedule` anchors). Main never computes fire times.
- **Output:** a sorted list of **occurrences** `{ occurrenceKey, stationUuid, kind, dueWall (local), dueUtcMs,
  source refs, payload (file, play_count, …), policy }` for a horizon (today + the next 24 h).
- Recompiled **only when pushed** a change (§3.4), and at midnight / clock events (§3.6).
- `occurrenceKey = entryUuid @ dueUtc`: the same identity rule as today's entry stamp, made explicit.

### 3.2 Scheduler (daemon, on the audio clock)
- Maps each occurrence's due time onto the **program sample clock** (`frames_consumed`). The callback is the timebase:
  at 44.1 kHz one frame is 22.7 µs.
- **Lookahead (e.g. T−30 s):** resolve the file (R2 materialization gate, as `fireAnnouncement` step 3 does), decode
  into a deck's ring (the S4 ring path already exists), and arm a **`play_at(slot, frame)`** RT command.
- The audio thread starts it on the exact frame, so there is no main, no JS tick and no IPC on the firing path. A
  stalled daemon JS loop still fires, because the RT command is already in the audio thread.
- **Ordered play / stacking / ×N** (the rulings, §6) are scheduler rules. "Channel busy" becomes a sample-clock
  fact, not a wall-clock guess.

### 3.3 Ledger (daemon, persisted)
- One row per occurrence outcome: `fired` (frame, wall), `waited` (behind what, how long), `missed` (why: daemon down,
  file missing, channel unpatched, clock jump), `cancelled` (×N rule), `superseded` (if a rule ever allows it).
- **Written before** the RT command is armed (as "armed"), and updated on the callback's confirmation, so a crash
  between arm and fire resolves on restart to exactly one outcome.
- Restart reads the ledger: what is `fired` never fires again; `armed` with no confirmation is checked against the
  play log. Each outcome becomes a health event (§3.7).

### 3.4 Push, never poll
- Main gains a single post-commit hook on the writers that matter (the schedule IPC handlers, the KV writer, inbound
  sync `applyDbMutation`), and sends `timeline:changed { stationUuid, tables }` to the daemon.
  - The pattern already exists: `__etherInvalidateClosing` (`electron/sync/handlers/station_config_kv.js:376`).
- **Sync from other machines arrives through `applyDbMutation` → the same hook.** One path, whatever the source.
- The daemon recompiles that station's timeline, diffs it, re-arms only what changed and re-broadcasts state.

### 3.5 State stream (daemon → windows)
- One `timeline` event per change (not per second): `{ stationUuid, occurrences: [{ key, kind, title, dueUtcMs, state,
  queuePosition, playedAt, lateMs }] }`.
- Countdowns run in the renderer from `dueUtcMs` (the display rules already built, §6).
- Screens later reads the same stream directly from the daemon (the loopback stream in `docs/ether-screens-plan.md`
  §7.3), so main isn't in that path either.

### 3.6 Clock discipline (one module, `audiod/clock.js`, tested with an injected clock)
- **Wall vs monotonic:** due times are local wall times (operators schedule "21:30"). Firing uses the sample clock.
  Every second the module compares wall progress with the monotonic clock and the sample clock.
- **Time zone:** one resolved IANA zone per station (or the machine zone), never `toISOString` (UTC) for a local date.
  The existing code already warns about that.
- **DST:**
  - Spring-forward (02:00–02:59 doesn't exist): an occurrence in the gap fires at the first instant after it, logged
    `shifted (DST)`.
  - Fall-back (01:00–01:59 happens twice): each occurrence fires **once**, on the first pass. Its key is UTC-based, so
    the repeat is recognised.
- **Wall-clock jumps** (NTP correction, operator change):
  - A jump > 2 s forward: occurrences jumped over are evaluated by policy (fire late inside the window, else `missed
    — clock jumped`).
  - A backward jump: nothing re-fires (the ledger has them).
  - Logged and health-evented either way.
- **Sleep / resume:** on resume (detected by a monotonic gap, plus `powerMonitor` relayed by main), the same rule as a
  forward jump.
- **Tests:** a table of synthetic clocks (DST both ways in two zones, ±jumps, a 10-minute sleep, midnight rollover)
  against the compiler and scheduler. Pure, no audio.

### 3.7 Observability (built in, v1)
- **Health events:** `timed-fired`, `timed-waited`, `timed-missed` (with reason), `timed-cancelled`, `clock-jump`,
  `clock-dst`.
- **The Health Monitor gets a "Timed events" card:** next 5, last 5 outcomes, any miss in red.
- **The daemon log** carries one line per arm and fire, with the frame.

---

## 4. What changes where

### 4.1 Daemon (new: `audiod/timeline.js`, `audiod/clock.js`, scheduler in `engine.js` or its own module)
- Compiler, scheduler, ledger, state stream, the `timeline:changed` command, startup resume.

### 4.2 Main
- **Removed** (at cutover): `announceTick`, `_scheduleAnnounceRepeats`, the scheduled path of `fireAnnouncement`.
- **Kept:** hand-fire, which becomes a daemon command too, so a hand-fire and a scheduled fire share one channel model.
- **Added:** the post-commit push hooks.

### 4.3 Native (Rust)
- **New RT command `PlayAt { slot, frame }`.** The callback starts the deck when `frames_consumed` reaches `frame`
  (exact, inside the buffer).
- Plus a `Fired { slot, frame }` RT event back (the `RtEvent` channel already exists for underruns, `audio.rs:4129`).
- No allocation on the audio thread, the same discipline as the existing RT commands.
- Tests in `npm run test:rust` (offline render): starts on the exact frame; two `PlayAt`s on one channel serialise per
  the rules.

### 4.4 Renderer / Screens
- Up Next rows, the heads-up and countdowns subscribe to the `timeline` stream. No query per change.

---

## 5. Performance pass (parallel track) — `docs/ui-freeze-diagnosis.md`

Independent of the engine; it reduces stalls everywhere. **Measure first, then budget, then enforce:**
1. **Baseline (dev + local packaged build, a non-air machine):**
   - main event-loop lag (`/health` `eventLoopLagMs` / `eventLoopLagPeakMs`, `main.js:3962-3963`);
   - renderer frame time (Chrome `contentTracing` from main, or the Performance panel per the freeze doc §4);
   - each measured while opening and closing every pop-out, with a realistic library and decks playing.
2. **Fixes in the freeze doc's order:** #2 Up Next remount, #5 broadcast fan-out, #7 bounds I/O, the setState-only-on-
   change part of #1, then #3 library virtualisation, #4 pop-out lifecycle, #1 store restructure, #6 the 60 s push.
3. **Budgets enforced in CI:**
   - a `perf-smoke` that launches the packaged app with a test profile, scripts the pop-outs over IPC, and samples
     lag and frame time;
   - it **fails** above budget, e.g. main lag peak ≤ 100 ms and renderer p95 frame ≤ 33 ms. Numbers are set from the
     baseline, and they are Jeff's call.
   - It runs on the Windows CI runner on tags, and locally via `npm run perf:smoke`.

The engine does not depend on this track: once events are in the daemon, a main stall can't touch air. The track
makes the operator's UI responsive.

---

## 6. Reuse vs rebuild

| Piece (`wip/announce-catchup`) | Verdict |
|---|---|
| `electron/announce-catchup.js` `classify` / occurrence key / look-back | **Reuse** as the scheduler's restart/resume policy (what to do with an occurrence found past due after downtime). The 5 s window becomes the "resume-late" allowance, which is Jeff's number |
| `StationSequencer` (ordered play, waits, ×N cancel per the 2026-10-06 rulings) | **Reuse the rules and tests**; re-implement against the sample clock (busy = frames, not `Date.now`) |
| `upcomingView` (states upcoming/due/queued/played/missed/skipped) | **Reuse** as the shape of the `timeline` state stream |
| `src/lib/upcomingAnnouncements.ts` display rules, `AnnRow`, `AnnouncementHeadsUp`, Preferences lead setting | **Reuse**, switched from `announcements:upcoming` polling to the stream |
| `announcements:upcoming` IPC, `announce:event` broadcast | **Replaced** by the daemon stream |
| main's `announceTick` / repeats | **Removed** at cutover |
| `audiod/hour-join.js`, `autofit.js`, `selectRowForNow` | **Kept.** They are seam/anchor logic for music; the timeline exposes their anchors (top of hour, spot-break starts) as occurrences for display and "next hard event" |

---

## 7. Phases — each tested in dev AND with a local packaged build before any version bump

| Phase | Work | Blast radius | Exit test |
|---|---|---|---|
| **0** | Perf baseline + budgets (§5 step 1); clock module + its test table (§3.6), observation only | none (measure + pure code) | Budgets recorded; clock tests green |
| **1** | Timeline compiler + ledger in the daemon, **shadow**: compile, log what *would* fire, compare to main's actual fires (health event on any disagreement). Push hooks added | Daemon reads more; main unchanged on air | A week of shadow on a non-air machine with zero disagreements |
| **2** | Native `PlayAt` + `Fired`, with offline-render tests | Rust mixer (all stations): new code path, unused until phase 3 | `test:rust` exact-frame tests; packaged smoke |
| **3** | **Cutover, per station, behind a flag:** the daemon fires announcements (lookahead + `PlayAt`); main's `announceTick` stands down for that station. Ordered-play and ×N rules. Ledger live. Hand-fire through the daemon | On-air announcements for flagged stations | Dev + packaged runs of the full test doc (stall the main process: events still fire on the sample); restart mid-sequence; DST and jump simulations |
| **4** | State stream; Up Next / heads-up / countdowns switch to it; `announcements:upcoming` removed | UI only | Freeze-doc measurements: no new main load |
| **5** | Other timed things onto the timeline: closing-time edits from Park Ops via the push path; top-of-hour and spot-break anchors as display occurrences; the jukebox drive moves from the renderer into the daemon | Jukebox playout; Park Ops | Jukebox pop-out closed/minimised: picks still play |
| **6** | Remove the flag and the old main code paths | — | — |

**Zero dead air during migration:**
- The flag is per station, and it moves only at a quiet moment.
- In phases 1–2 the old path stays authoritative.
- In phase 3 the engine takes a station only after its shadow ledger has matched.
- The rollback is the flag (and old main code exists until phase 6).
- **Daemon changes need a full close and reopen** (the daemon never reloads on auto-update), so every phase that
  touches the daemon is staged on a non-air machine with a packaged smoke first.

---

## 8. Decisions for Jeff
1. The resume-late allowance after downtime (the old 5 s window): what number, per kind?
2. The lookahead horizon (proposed 30 s pre-buffer, 24 h compiled).
3. DST spring-forward: fire at the first instant after the gap (proposed), or mark missed?
4. Perf budgets (main lag peak, renderer p95 frame), set after the phase-0 baseline.
5. The order of phase 5 items (the jukebox drive is the most stall-prone today).

**Stop.** Plan only; awaiting review.
