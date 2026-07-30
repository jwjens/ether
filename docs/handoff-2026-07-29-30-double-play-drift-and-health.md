# Handoff — 2026-07-29 → 07-30

**For the architecture/planning chat and for memory.** Everything since the last handoff, written to be read
cold. Receipts are `file:line` against the tree at 4.4.107.

**Versions cut this window:** 4.4.105 (liveDeck observer) · 4.4.106 (revert) · 4.4.107 (health two-column +
Live Activity). All built locally, `--publish never`. **Nothing pushed, nothing tagged.**

---

## 1. The live double-play on Christmas In July (station 4) — root cause found

**Symptom:** two songs audible at once for ~85 s, then deck C stuck `active AND paused` for 54 minutes.
Nothing in the product said so.

**Root cause — the daemon identifies the live deck by ALPHABETICAL SCAN:**

```js
audiod/engine.js:1299
const P = ["A","B","C"].find(d => this._deckState(d).status === "playing");
```

Deck C was live. Deck A started **outside the advance chain**. `P` flipped C→A instantly (A sorts first), the
engine carried on with A, and **C was never any rotate's `fromId`** — so the deferred stop was never armed and
the Bug-A guard, which only inspects a rotate's own `fromId`, had nothing to inspect. It caught A three
minutes later precisely *because* A went out through a real rotate.

**How a deck starts outside the chain:** renderer deck commands are forwarded straight into the daemon's Rust
engine — `electron/main.js:3059-3078` (`audio:load` / `audio:play` → `audiodClient.cmd`) — and `load`/`play`
are excluded from the daemon's command log (`audiod/ether-audiod.js:188`), so it leaves no trace.

**Why station 4 and not 1-3:** it is the only station with `is_active = 1`, i.e. the only one whose renderer
`AudioEngine` is `init()`-ed. `src/App.tsx:1084-1086` says so explicitly — non-active stations' engines "are
created but never init()-ed". **One brain each on 1-3; two on station 4.** Everything else is at parity
(rotate counts by letter, deck occupancy, overlap run-lengths, content durations, `clock_breaks`).

Signals unique to s4, zero on 1/2/3: one sustained `active=2` run (85 s); **635** mix samples of `a=1 p=1`;
**3** `watchdog: STALL — no deck playing` while Rust had a deck active.

Docs: `station4-double-play-live-capture-`, `station4-double-play-root-cause-`,
`station4-vs-working-stations-diff-2026-07-29.md`.

### Shipped: the liveDeck OBSERVER — 4.4.105, observation-only

`audiod/engine.js` — additive only, four hunks: `liveDeck` set in `_play()` (`:247`, the single funnel all
eight go-live paths use), a pure `_foreignPlayingDecks()`, a derived grace `_foreignGraceMs()` =
`(segueOverlap + crossfadeDuration)*1000 + 1500` = 7500 ms, and `_liveDeckObserverTick()` called from
`poll()` at `:298` — **placed immediately after the deck-state rebuild and BEFORE any decision work**, so a
throw later in the tick can never skip the report.

**`P` is untouched.** Nothing reads `liveDeck` but the observer. It logs and stops nothing. Bench
`audiod/smoke-seam-stop.js` extended 5 → **27 tests, all pass**, including a scope invariant that wires
tripwires to `_stop`/`_play`/`_load`/`handleRotate` and asserts none fires.

**Known limit:** it keys on `status === "playing"`, so it would have caught the 85 s double-play (~7.5 s in)
but **not** the 54-minute `a=1 p=1` tail — that deck reads *paused* to the engine. Catching that needs the
mixer's `active` count, a different sense.

**Minor defect found later, flagged not fixed:** it logs `foreign deck cleared after 2.1s` on ordinary segue
overlaps — `_foreignSince` is set before the grace and the clear branch logs regardless. Log noise only.
One-line fix: only log the clear when `_foreignLastLogAt` was set.

---

## 2. The short-track premise — REFUTED, and what is actually true

Proposed root cause was "station 4's tracks are ~30 s, so the segue/stop timing breaks". **Measured, it goes
the other way:**

```
       n     mean     median    min      under 60s    under 30s
 s2   117   160.1s   166.3s   11.5s     27 (23%)     17 (15%)
 s3   124   153.1s   167.7s   11.5s     21 (17%)     21 (17%)
 s4   132   140.1s   140.9s   18.1s     22 (17%)     22 (17%)
```

s4 averages **140 s**; its shortest item (18.1 s, the spot) is **longer** than s2/s3's (11.5 s); station 2 —
which never fails — has the **most** short content. The incident tracks were 205.98 s, 162.82 s, 136.83 s.
`songs.duration_ms = 162821` for Kana Kaloka matches the decode exactly.

**The frozen countdown showed `0:18 / 0:18` under a title whose real duration is 162.82 s** — 18.13 s is the
*spot's* duration. That is state mixed across tracks (§4), not a clamp at a true short duration.

**There IS a real no-floor family, but the floor is ~3 s:** `segueOverlap = 3` (`engine.js:102`) with
`remaining > 0 && remaining <= segueOverlap` means a ≤3 s item rotates at position 0; the stop is a **fixed
3500 ms timer** (`cfMs + 500`, `:617`); and `skip-reloaded` is a live silent path at any length — preload
lands *inside* that window (`preload:B` at 22:03:43.347, `stop:B` armed for 22:03:44.77) and a skipped stop
logs nothing.

**Fix shape (§3 of `short-track-timing-premise-check-2026-07-29.md`), not built:** (a) `effectiveOverlap =
min(segueOverlap, duration × fraction)` + require `position > 0` — provably identical 3 s above ~9 s; (b) make
`cfMs+500` the *earliest* moment and re-evaluate each 250 ms poll so the stop lands at the actual end and
`skip-reloaded` can't silently persist; (c) the engine owns `liveDeck` — **(c)-observe is what shipped as
4.4.105.**

**Agreed sequencing, one per release:** (c)-observe ✅ → (a) → (b) → (c)-enforce. `smoke-seam-stop.js`
extended before each.

---

## 3. Countdown oscillation — a regression I shipped, reverted in 4.4.106

**Symptom:** on every daemon-driven station the countdown jumped to 0:00, climbed for a couple of seconds,
jumped back — for the whole song. Working stations broken by a fix meant for the broken one.

**Cause:** 4.4.104 (`29640ef`) made `resyncDaemonDecks` re-anchor deck position from `daemon("getState")`
every 5 s. **`getState` returns RAW RUST state** (`audiod/ether-audiod.js:112` → `A.audioGetState`), and
Rust's per-deck payload is:

```rust
native/src/audio.rs:82-92   DeckInfo { id, status, title, artist, file_path, volume, is_finished }
```

**No `position_sec`, no `duration_sec` — ever.** So `makeState()` yielded `positionSec === 0` on every call.
The duration write was guarded (`> 0`) and correctly skipped; **the position write was not** —
`typeof 0 === "number"` passes.

**Reverted in 4.4.106**, verified as an exact behavioural revert against `29640ef^` (only difference: an
inline comment relocated). The `daemonDeckPollN` counter and the periodic call were removed too — they
existed only to drive the re-anchor. `resyncDaemonDecks` is volume-only and one-shot on attach again.

**Standing rule from this:** position and duration come ONLY from the daemon's `onDeck` event stream, which
delivers the whole state atomically. **No daemon command exposes `DaemonEngine.stateA/B/C`** — adding one is
the prerequisite for any future drift-bound work. Saved to memory as
`reference_daemon_getstate_no_position`.

**Process failure worth naming:** 4.4.104's build report claimed the resync bounded drift. It was never
verified on air, and one grep of `DeckInfo` would have caught it.

---

## 4. Renderer deck state mixed across tracks — the animation bug. STILL UNFIXED.

**`src/audio/engine-rodio.ts:438-440`** rebuilds title/artist/filePath/status from Rust each poll tick, then
**overwrites `durationSec` with the previous tick's value**:

```ts
:427  const durA = this.stateA.durationSec;                 // PREVIOUS tick
:438  this.stateA = this.daemonDriven
        ? { ...this.stateA, positionSec: posA }                                    // daemon — atomic
        : { ...makeState("A", s.deckA), durationSec: durA, positionSec: posA, … };  // in-process — MIXED
```

The correct duration is inside the object being spread and is discarded on the same line. Self-perpetuating:
next tick `durA` is read back out of what this line just wrote.

**Consequence chain:** track changes → title flips, duration doesn't → `Math.min(pos + elapsed, durA || 9999)`
clamps at the wrong (usually shorter) duration → `stateChanged` (`:476-485`) sees nothing move → **no listener
fires and the UI stops repainting entirely.** That is "animation does not work".

Observed on all three decks at once: `1:12/1:12` for a 3:33 track, `1:47/1:48` for a 0:18 spot,
`3:31/3:32` for a 2:12 track.

**Two narrower sites, same class:** `loadToDeck`'s async `get_file_duration` (`:692-698`) stamps the old
file's duration on the new track if the deck moved on during the await; `resyncDaemonDecks` keeps `cur`'s
title while taking `auth`'s duration.

**⚠ The §3 fix recommendation in `deck-state-mixed-across-tracks-2026-07-29.md` is WITHDRAWN** — it assumed
`audio_get_state` supplies a fresh `duration_sec`. It does not (§3 above). A corrected approach must source
duration from `loadToDeck`/`get_file_duration` **keyed to track identity**, following the 4.4.93 identity-keyed
pattern already established. Not designed yet.

**Corroboration:** the defect exists only in the in-process branch — the daemon branch is atomic and cannot
produce a persistent three-deck mismatch. So that station's renderer engine was running **in-process**,
independent support for the two-brains finding in §1. Strong inference, not proof; the receipt is the `[ROT]`
line, which still goes to a dead path (`electron/main.js:3299` → `__dirname/../tmp-userdata/rotation.log`,
absent in a packaged install, inside a silent try/catch). **That repair is authorised and still not built.**

---

## 5. ★ Spot anchors drift — generated right, played without enforcement

**The headline finding of this window.** A spot anchored at 07:38:53 aired at 07:44:57 — **6m04s late** — and
the row that aired was not even that row.

**Generate was CORRECT.** The music row before the spot ended at *exactly* 07:38:53. The arithmetic is right.

**Playout never looks at the clock.** `refillIfNeeded` (`audiod/engine.js:739`) takes the legacy path →
`loggen.fillQueue` → `readGeneratedSchedule` (`audiod/loggen.js:188-205`):

```sql
WHERE gs.id > ?                     -- _schedCursor: a monotonic ROW-ID cursor
  AND gs.station_id = ?
  AND gs.scheduled_at >= ? - 300    -- only a floor to skip ancient rows
ORDER BY gs.scheduled_at LIMIT ?
```

Twenty rows are pulled by **id**, then played back-to-back as fast as each track ends. **`scheduled_at` is
never consulted again.** A long song pushes everything after it, compounding.

Proof the log is consumed out of time order: the 07:38:53 SPOT row was still `state='pending'` at 07:46 while
a row scheduled **08:19:58 was already `played`**.

**The ONLY runtime re-anchor is the top of the hour.** `_checkTopOfHour` → `_hardCutTopOfHour`
(`engine.js:365-395`) hard-stops A/B/C with no fade, clears the queue, and re-queues **20 rows from the hour
boundary** via `loggen.fillFromHour` (`loggen.js:209-227`) — which has **no `state` filter**, so already-played
rows come along. That is why only the `:00` spots land and the `:20`/`:39` anchors slide.
`_segueTick`/`handleRotate` never read `scheduled_at`.

**Systemic, not station 4.** Shadow drift: s2 ±31-66 s, s3 ±16-64 s, s4 ±13-136 s. s4 is just further along —
its aired row runs ~15 rows AHEAD of the row-for-now and its `missed` count climbs every track (1313→1318)
while s2/s3 hold steady at 1358/1434.

**⚠ NEW BUG, not chased:** `_schedCursor` is **module-level** (`loggen.js:185`) — **shared by all four
stations** in the one daemon process, so each station's refill advances the others' cursor. Most plausible
source of the permanent ~1300-1400 `missed` backlogs. Also `fillQueue` (`:414`) resets the cursor to 0 on
exhaustion and replays the log from the start.

**Also filed:** spots are written to `play_log` with `content_class = 'MUSIC'`, not `'SPOT'` — the
affidavit/reporting layer won't see them as spots.

Doc: `spot-anchor-drift-generated-vs-playout-2026-07-30.md`.

### The enforcement is BUILT and switched OFF

`_logReaderOn()` (`engine.js:722-734`) gates `_refillFromLog` → `loggen.readLogAnchored` →
**`selectRowForNow`** (`loggen.js:242-273`), which is exactly the model: take the wall clock, return the row
that *should* be on air, classify `behind`/`on-time`/`ahead`, stamp elapsed rows `missed`. Live daemon, all
four stations:

```
log-reader flip: ETHER_LOG_READER=0 (OFF — legacy playout + §2.7 shadow only)
```

### ⚠ OPEN: the canary toggle does not stick

Health Monitor → "Log-Reader Flip — Canary" → per-station button. Clicking it **writes `'0'`, never `'1'`**.

- The write path works — `station_config_kv.updated_at` for s4 moves on every click (15:22:21 → 15:31:22 →
  15:34:24), same DB my read-only connection sees (reads are WAL-current).
- The **shipped** 4.4.106 bundle matches the tree — extracted from `app.asar`:
  `se[ge.stationId]=!!(pe&&pe.ok&&(pe.value==="1"||pe.value==="true"))` and
  `set-local, X, "log_reader_flip", ne?"1":"0"`, with `onClick={() => toggleFlip(sid, !on)}`.
- So a single click writing `'0'` means the running app's `get-value` returned `"1"` while the row reads
  `'0'`. **Not reconciled.** Handlers are real (`electron/sync/handlers/station_config_kv.js:284,290`),
  `log_reader_flip` is in `LOCAL_ONLY_KEYS` (`:26`), no duplicate rows.
- **Next step (zero risk, no restart):** DevTools console →
  `await window.ether.invoke("station_config_kv:get-value", 4, "log_reader_flip")`. If it prints `"1"`, main
  reads a different row/DB than the file; if `"0"`, the button state is stale and re-rendering is the bug.
- **Deterministic workaround:** launch with `ETHER_LOG_READER=1` (`engine.js:34`) — forces the flip ON for
  **all four stations**, needs a full close+reopen (daemon does not hot-reload).

**Also note:** the flip engages at the next refill, and `engine.js:524` only *calls* the refill when
`queue.length < 5`. With a queue of 8 it takes ~4 songs (~15 min) to engage. **There is no SKIP button on the
main surface** — skip exists only as a macro action (`MacroEngine.tsx:51`) and a remote command
(`App.tsx:1104`).

### ★ Jeff's stated requirement — the AUTO-FITTER

> "i used xfade to skip 2 songs to play the spot on time but i wont always be around — i need ether to watch
> that."

What he did by hand is precisely what the auto-fitter is specified to do (§2.7 ruling, already approved):
deterministic look-ahead, **no LLM**, projects arrival at the next hard anchor, **swaps** upcoming pending
rows for shorter same-category songs on overshoot or **inserts** short fills on undershoot, stamped
`source='autofit'`, written to the log minutes ahead, health-evented, visible on the calendar before air.
Boundary DROP is **last resort only**.

**Not built.** Prerequisite is the flip: the fitter works by writing corrections into the log ahead of air,
and on the legacy path playout ignores the log's timing entirely. **Flip first, then fitter.** Next step is
its own design doc for approval before any code — look-ahead window, what it may swap, what it may never
touch (spots, top-of-hour), how it reports what it changed.

**Important expectation:** the flip alone does **not** do what Jeff did by hand. It plays the row for *now*
and stamps skipped rows `missed` — so the song in progress is **cut**, not shed gracefully. Hitting the anchor
*and* keeping the music intact is the fitter.

---

## 6. Health Monitor — two columns + Live Activity terminal (4.4.107)

Display-only. **No daemon changes, no new writers, no new event channel** — it tails the log
`audiod/daemon-log.js` already writes.

- **Layout:** `HealthMonitor.tsx:9-27` (`TWO_COL_MIN_PX = 1000`, `useTwoColumn`), `:453-461` (flex-row
  wrapper; left column keeps Live Events → Legacy Diagnostics → Core Systems → High Availability in order),
  `:790-800` (right column — 460 px + left border wide; 340 px band + top border narrow). Columns scroll
  independently.
- **Tail:** `electron/main.js:2792-2831`, `activity:tail`. Reads only `[offset, size)`; **the renderer holds
  the cursor** so main is stateless and panel + popout tail independently. 256 KB cap per call. Rotation
  (`daemon-log.js:23,51`, 5 MB → `.log.1`) detected as `prev > size` → restart at head, return `reset`.
  Consumes only to the last `\n`, so no split lines. Verified live: seeds to exactly EOF, **follow returns 0
  new lines** (proves no re-read), shrink → `reset=true`, 0 partials.
- **Terminal:** `src/components/LiveActivityTerminal.tsx` — monospace, newest at bottom, auto-scroll; Pause
  **plus automatic scroll-lock on scroll-up**, and the tail keeps running while paused; per-station colour +
  All/s1-s4 filter (stations discovered from the stream); Decisions (default) / All activity / Warnings;
  `MAX_LINES = 800`, `POLL_MS = 1000`.
- **Measured on 1,646 real lines:** routine 1339 · decision 299 · warning 8 — the default hides **81%**.
  Station attribution 1646/1646.
- **Help entry:** `docs/help-live-activity.md` (`tour: true`), flat in `docs/`, to the `help-jingles.md`
  template, with a table translating log lines into plain language.

**Not verified on screen** — tail and classification are proven against real data; the rendering is not.

---

## 7. State of the tree

**Uncommitted** (all local, nothing pushed, nothing tagged):

```
audiod/engine.js                            liveDeck observer (4.4.105)
audiod/smoke-seam-stop.js                   bench 5 → 27 tests
src/audio/engine-rodio.ts                   the 4.4.106 revert
electron/main.js                            activity:tail
electron/preload.js                         activity.tail bridge
src/components/HealthMonitor.tsx            two-column layout
src/components/LiveActivityTerminal.tsx     new
package.json                                4.4.107
docs/…                                      the reports below + help-live-activity.md
```

Installer: `C:\openair\dist-electron\Ether Setup 4.4.107.exe`. Installed on the box: **4.4.106**.
`tsc --noEmit` at the standing baseline throughout (2 pre-existing errors, `OnboardingFlow.tsx:2039` +
`PhoneDesk.tsx:777`).

## 8. Open items, ranked

1. **Auto-fitter** — design doc, then build. The stated requirement. Blocked on the flip.
2. **Canary toggle writes `'0'`** — one DevTools line settles it. Blocks the flip, blocks everything above.
3. **`_schedCursor` shared across stations** (`loggen.js:185`) — fix with or before Phase 3.
4. **Renderer duration mixing** (§4) — animation bug, unfixed, §3 fix withdrawn, needs a new design.
5. **`_rotationLogPath` repair** (`main.js:3299`) — authorised, still not built. Would settle
   daemon-driven vs in-process per station.
6. **(a) then (b)** of the no-floor timing family (§2).
7. Observer's noisy `foreign deck cleared` line — one-line fix.
8. Spots logged to `play_log` as `MUSIC` — affects affidavit reporting.
9. Show+ startup crash when no mic is present (`useLevelMeter`, unfixed by instruction).
10. Health Monitor reports s4 at 13k/s while the mixer shows parity with s2 — reported numbers wrong, actual
    output fine. Filed, not chased.

## 9. Docs written this window

```
station4-double-play-live-capture-2026-07-29.md
station4-double-play-root-cause-2026-07-29.md
station4-vs-working-stations-diff-2026-07-29.md
short-track-timing-premise-check-2026-07-29.md
build-report-livedeck-observer-2026-07-29.md
deck-state-mixed-across-tracks-2026-07-29.md        ← §3 WITHDRAWN, see §4 above
countdown-oscillation-regression-2026-07-30.md
build-report-revert-position-resync-2026-07-30.md
spot-anchor-drift-generated-vs-playout-2026-07-30.md
build-report-health-two-column-live-activity-2026-07-30.md
help-live-activity.md
```
