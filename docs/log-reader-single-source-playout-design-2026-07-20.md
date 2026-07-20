# The Log-Reader Flip — `generated_schedule` as the single source of playout

**Design doc — Roadmap doctrine. APPROVED 2026-07-20** (§6 answers: per-row state + derived playhead;
`seq REAL`; RESET semantics confirmed; lifecycle columns local-authoritative / never CRDT-merged;
CLEAR-regenerate window confirmed; one CLEAR button → two-verb choice).

**LIVE STATUS (updated 2026-07-20):**
- ✅ **Phase 0 — schema** — SHIPPED v4.4.68. Migration v33 adds `state`/`played_at`/`seq` (local-only,
  §5); backfill verified on a copy. `docs/log-reader-phase-0-schema-2026-07-20.md`.
- ✅ **Phase 1 — shadow playhead writer** — SHIPPED v4.4.69, **burn-in acceptance MET** (playhead
  matches Play History exactly on all 3 stations, exactly one playhead each). On-log baseline
  = **60% / 20% / 90%** (st.1/2/3) — but this is **contaminated by legitimate operator inserts** (Jeff
  live-adds via the deck loader) and is NOT the Phase 3 yardstick. Phase 3 acceptance = *every air is a
  log row* (machine-placed or operator-inserted), queue==calendar by construction (see §7 Phase 3).
  `docs/log-reader-phase-1-shadow-2026-07-20.md` + `docs/log-reader-phase-1-burn-in-acceptance-2026-07-20.md`.
- ⏭ **Phase 2 — read-path unification (behind flag)** — NEXT, awaiting Jeff's go. Flag stays OFF until
  Phase 3's shadow burn-in is clean. STOP at each phase boundary.
- Phases 3-6: pending (see §7).

> Jeff's directive, verbatim: *"it should not be two parallel representations… the song sitting
> there should be the exact data that's always read in both places, 1 file sending info to both."*

Goal: `generated_schedule` IS the single source. Playout is a **log-reader** with a **persisted
playhead**. No independent queue structure that can diverge. The deck panel/up-next, the calendar,
and the ▶ marker render the **same rows**. Operator edits (skip / reorder / insert) write to the
**log**; playout follows because playout only reads. Clock-refill becomes an **emergency floor** that
fires only on log exhaustion — loudly, never as a button's silent behavior.

This doc is design + migration + blast radius. Receipts are `file:line` from a full read-only sweep
of the current machinery.

---

## 1. Current state — two parallel representations (the problem, with receipts)

### 1.1 The two representations
- **The log:** `generated_schedule` — a persisted, station-scoped, calendar-visible DB table. Columns:
  `id, scheduled_at, song_id, title, artist, file_key, file_path, duration_s, category_id, clock_id,
  generated_at, station_id, uuid, created_at/updated_at/deleted_at`, plus jingle placement columns
  `content_class('MUSIC'|'JIN'|'SWP'|'SPOT'), channel('CART'), lead_in_sec, underlap_sec,
  jingle_category_id` (schema: `scripts/schema-v0-baseline.js:517-533`, jingle migration
  `scripts/migrate-generated-schedule-jingle-placement-phase-sync-31.js:36-44`).
  **Critically: NO `position`/`sequence` column and NO `played`/`status` column.** Order is derived
  purely from `scheduled_at` (tie-break `id`). "Consumed" is tracked *nowhere in the table*.
- **The queue:** an in-memory JS array. Daemon-authoritative `this.queue` (`audiod/engine.js:47`),
  renderer mirror `this.queue` (`src/audio/engine-rodio.ts:88`), and in in-process fallback the
  renderer's array becomes authoritative. Deck side-tables (`deckSched/deckReady/boundQids/manualCue`,
  `engine.js:52-69`) track "on air / cued" separately from both queue and log.

### 1.2 The bridge, and why it diverges
`loggen` is the one bridge: `readGeneratedSchedule` pulls rows forward via an **ephemeral,
process-local cursor** `_schedCursor` (daemon module-global `audiod/loggen.js:144`; renderer
per-station Map `src/audio/loggen.ts:58`), `WHERE id > cursor AND scheduled_at >= now-300 LIMIT n`
(`loggen.js:154-161`, `loggen.ts:451-478`). Queue items are **detached copies** carrying only
`scheduledAt` as a back-link (`loggen.ts:523`; `engine-rodio.ts:656`).

**No persisted playhead exists anywhere.** On daemon respawn / app relaunch the queue is re-derived
from scratch: `_schedCursor` resets to 0, `_started=false` (`engine.js:92`), and "resume" means
"nearest schedule row to *now*" (`scheduled_at >= now-300`, `loggen.js:159`) — **not** "resume where
the deck left off." What *is* persisted is automation *intent* (which stations air —
`automation-intent.json`, `main.js:284-300`, `daemon-auto-resume.js`), never a position. A restart
can skip or repeat the currently-playing song depending on timing.

**Divergence inventory (why the two representations disagree today):**
1. Queue holds **non-log items** — live-picked Tiers 1-3 when the log is empty (`loggen.js:240-279`,
   `loggen.ts:542-593`), operator `addToQueue`/cue/watchdog picks (`engine.js:675-691`). These carry
   no `scheduledAt` and are invisible to the calendar.
2. **`purgeUnscheduled` reconcilers exist precisely because of this** (`engine.js:594-599`,
   `engine-rodio.ts:661-666`, `loggen.ts:529`) — they drop non-log items on the next log fill.
3. **Three independent readers, three filters:** the calendar reads `schedule:get`
   (`main.js:6378-6405`, cross-station `NOT EXISTS` guard, **no `content_class` filter** → JIN/SWP
   rows render as tracks); the queue reads `getFormatCategoryIds` on-format (`loggen.ts:456`); the
   daemon reads its own `content_class != 'JIN'` clause (`loggen.js:160,180`). Not equivalent sets.
4. **Mutable queue never written back:** UpNext drag/reorder/remove/insert (`UpNext.tsx:218-295`),
   JockStrip splice (`JockStrip.tsx:174-181`) mutate the queue only — the calendar has no idea.
5. **Two producers** (renderer `loggen.ts` vs daemon `audiod/loggen.js`) with slightly different SQL.
6. **Resolution drops:** queue silently omits rows whose file won't resolve (`loggen.ts:508-526`); the
   calendar still shows them.

### 1.3 The three UI readers (where views can disagree)
- **Calendar:** `schedule:get` → `generated_schedule` directly (`BroadcastCalendar.tsx:113-140,205-212`).
- **Up Next / deck "next":** `engine.getQueue()` (`UpNext.tsx:98`, `slice(2,52)`) + live deck status
  (`UpNext.tsx:314-320`) — **never queries the table.**
- **▶ now-playing marker:** exactly one, `BroadcastCalendar.tsx:339`, driven by
  `nowPlaying.scheduledAt` = the `generated_schedule.scheduled_at` of the row on the playing deck,
  carried through deck state (`App.tsx:1894-1895`, `engine-rodio.ts:656`), with a wall-clock fallback
  (`scheduled_at <= now`) when the engine hasn't reported identity. So the ▶ *already* keys on a log
  row identity — the good bone to build on.

---

## 2. Target architecture — one file, a playhead, read-through playout

### 2.1 The invariant
`generated_schedule` (per station) is the **only** authoritative sequence. Playout holds no
independent queue; it holds a **persisted playhead** and a **read-through working set** that is, by
construction, always `generated_schedule` rows at/after the playhead. Anything that isn't a log row
cannot be on air — operator ad-hoc content is **written to the log first**, then played.

### 2.2 Playhead + per-row lifecycle (schema)
Add to `generated_schedule` (additive, backfilled, sync-safe — see §5 for the sync decision):
- **`state TEXT DEFAULT 'pending'`** — `pending | playing | played | skipped`.
- **`played_at INTEGER`** — when the row actually aired (stamped by the engine on load-to-deck).
- **(decision, §6.2) `seq REAL`** — an explicit monotonic play-order that decouples sequence from
  wall-clock `scheduled_at`, so reorder/insert don't corrupt scheduled times.

The **playhead** is derived, not a second structure: the row with `state='playing'` (or, on cold
start, the earliest `pending` row within tolerance of now). Because it's a column in the one file,
restart resume is trivially correct — **there is nothing to re-derive**: resume at the `playing` row.

### 2.3 Read-through playout
The daemon's advance loop reads the log directly:
`SELECT * FROM generated_schedule WHERE station_id=? AND state IN ('pending','playing') ORDER BY
seq (or scheduled_at) LIMIT N`. Decks load from the next rows; **advancing = stamp current row
`played`, stamp next `playing`** (persisted). The in-memory list becomes a *cache of log rows* with a
hard invariant (every entry has a `generated_schedule.id`), not an authoritative queue. `_schedCursor`
and the `purgeUnscheduled` reconcilers are **deleted** — there is nothing off-log to purge.

### 2.4 One read path, two views
UpNext and the calendar both render `generated_schedule` rows ≥ playhead via **one shared query**.
The ▶ marker becomes `WHERE state='playing'` — the live decks and the calendar cannot disagree
because they are the same datum. JIN/SWP rows get a shared `content_class` display policy (calendar
labels them as imaging, doesn't count them as deck tracks) so both surfaces classify identically.

### 2.4a Cued decks are ALWAYS the log's next rows (Jeff, 2026-07-20)
Under the flip's normal operation (Phase 3), the non-playing decks are, **by construction**, cued from
the log's next `pending` rows after the playhead — never a separately-sourced pick. The whole playout
surface (queue AND cued decks) reflects the calendar; only the currently-playing deck is "committed."
Consequently **RESET TO SCHEDULE (§3.2) re-cues the non-playing decks** from the log's next rows: reset
snaps the entire surface — queue *and* cued decks — back to the calendar, leaving only the on-air deck
untouched. This is the same rule Phase 5's RESET verb and Phase 3's steady state both obey.

### 2.5 Operator edits write to the log
- **Skip:** stamp the row `skipped`, playhead advances to next `pending`. (Replaces
  `engine.skip()`/`jumpToNextSong` mutating the array.)
- **Reorder:** rewrite `seq` on the affected rows (§6.2). Playout re-reads → follows.
- **Insert:** write a new `generated_schedule` row (resolved file, `content_class`, `seq`/scheduled_at)
  → playout picks it up.
- **Live deck load (FIRST-CLASS — Jeff 2026-07-20):** a jock loading a track to **Deck A/B/C** or
  cue-to-deck (`StudioSendBar`, Library A/B/C, `deck:cue`, `noteManualCue`) WRITES a
  `generated_schedule` row at the playhead position, stamped operator-inserted (`source='operator'`).
  Live radio is not an off-log exception — the loaded track IS placed on the log, so queue/calendar
  reflect it and it airs as a log row.
- **Remove:** soft-delete (`deleted_at`) or stamp `skipped`.
All of these already have UI; they get **re-pointed from queue-intents to log-writes**. Playout only
reads, so it follows automatically.

### 2.6 Clock-refill = emergency floor only
Normal advance **never** calls the clock selector. The runway auto-extend (`_autoExtendTick`,
`main.js:6269-6336`) keeps the log ahead of the playhead by appending generated rows (still one file).
**Only if the playhead reaches the end of the generated rows (log exhausted)** does the emergency
floor fire: append clock/SmartRule/on-format rows **to the log** AND emit a **loud Health event**
(`health` ledger + Health Monitor). The Priority-2+ clock selector is removed from the silent advance
path entirely (today it fires via `refillIfNeeded` because `continuous` stays true —
`engine.js:581-598`, `engine-rodio.ts:550-558`).

---

## 3. CLEAR, redefined — two honest verbs

### 3.1 What CLEAR does today (full behavior + the silent third sequence)
Button `src/App.tsx:2683-2691`. onClick (`:2685`): daemon → `queueClearPending()`
(`engine-rodio.ts:334` → `audiod/engine.js:725` `intentClearPending`, clears **pending only**, keeps
bound head so audio never stops); in-process → `clearQueue()` (`engine-rodio.ts:650-654`, `this.queue
= []`). **Then, because `continuous` stays true, `refillIfNeeded` silently repopulates from the clock
selector** (Priority 2, `loggen.ts:543-547` / `loggen.js:251`) — off-calendar, unpersisted,
`purgeUnscheduled`-able content. **This is the invisible third sequence** the directive kills. The
same clear-then-clock-refill machinery also runs on the top-of-hour hard cut (`showClock.ts:84,92`;
`audiod/engine.js:281,272`).

Priority order in both fillers: **generated_schedule → active-show clock → SmartRule → on-format
random** (`loggen.ts:500-568`, `loggen.js:232-279`). The clock selector picks one random
rotation-eligible song per clock music slot, unpersisted, no `scheduledAt` (`loggen.ts:377-426`).

### 3.2 The two verbs (UI: two buttons or a choice — Jeff picks in review)
- **(a) RESET TO SCHEDULE** — discard local/in-memory deviation, re-point playout at the log from the
  playhead. **Log untouched;** views snap back to truth. (Under the target model the queue *is* the
  log, so this is the belt-and-suspenders "re-sync to the file" button — always safe, never invents
  content.)
- **(b) CLEAR & REGENERATE** — wipe the log's **forward** rows for this station (`scheduled_at`/`seq`
  beyond the in-progress hour boundary, honoring the existing hard-top-of-hour rule) and run
  `schedule:generateDay` to refill them deterministically. The change lives in the one file → queue
  view and calendar update together because they ARE together.
- **Never:** clear → clock-selector repopulation. The clock/SmartRule path survives **only** as the
  §2.6 emergency floor on true log exhaustion, with a Health event.

### 3.3 Every queue-mutation caller (blast radius for the CLEAR/edit rework)
Each must be re-pointed to read/write the log, or retired:
- **Clear/wipe:** `App.tsx:2685` (button), `:648` (crossfade drop-head), `:1366` (all-station driver),
  `:1456/:1458` (schedule-regen resync), `:1521,1541,1710,1735,1776,1803` (startup/dead-air/AUTO),
  `JockStrip.tsx:177-178`, `showClock.ts:84`, `audiod/engine.js:677,725,281`.
- **Repopulate/fill/insert:** `App.tsx:1296,1145,1337,1358,1459,1522,1716,1778,1537,1731,1797,1682,
  1840-1844,4745`, `JockStrip.tsx:59,207`, `Spots.tsx:241`, `VoiceTracker.tsx:741,784`,
  `VoiceTrackInbox.tsx:91`, `AIVoiceStudio.tsx:311`, `UpNext.tsx:291`, `loggen.ts:600-607`,
  `audiod/engine.js:691`.
- **Reorder/remove:** `UpNext.tsx:218,250-281`, `App.tsx:1158-1198` (remote), `engine-rodio.ts:332,683`,
  `audiod/engine.js:694,705,718`.
- **Skip/advance:** `App.tsx:1078-1085` (remote), `engine-rodio.ts:300,697,508-565`,
  `audiod/engine.js:1108,607,365,523,540,766`.
- **deck:cue (implicit dequeue):** `App.tsx:1132,1827`, `PopoutRenderer.tsx:81`, `StudioSendBar.tsx:65`,
  `audiod/engine.js:736`.
- **Emergency on-format seeds (the floor to formalize):** `App.tsx:1526-1537,1721-1731,1786-1797`,
  `showClock.ts:99-123`.

---

## 4. Blast radius per consumer (what becomes log-native)

| Consumer | Today | Change needed |
|---|---|---|
| **Jingle/sweeper seams** | **Already log-native** — JIN/SWP are `generated_schedule` rows; daemon is a pure log-reader (`audiod/loggen.js:188-226` `findSeamJingle`; `audiod/engine.js:848-1102` overlay SM; consumed via `_noteFiredRow`, `:911`) | None structurally. Gains a `state` stamp on fire (already `_noteFiredRow`). |
| **Spots** | **Log-native classification** — `content_class='SPOT'` rows, gated out of music slots (`audiod/loggen.js:38-40`), classified in play-log (`audiod/playlog.js:32`). Break-fill **unimplemented** (dormant `spotBreaks` flag, `loggen.ts:31`, no consumer). | None. Break-mode fill, if ever built, writes SPOT rows to the log like everything else. |
| **Drift / time** | **Mixed** — daemon seam/catch-up anchors on `generated_schedule.scheduled_at` via queue items (`engine-rodio.ts:89,656`; `engine.js:1025-1058`). But `showClock.ts` top-of-hour is **wall-clock + `shows` table** and clears+refills from the clock (`showClock.ts:44-60,84,92`). | Convert `showClock.ts` top-of-hour to read the boundary/next-row from the **log** (the row whose `scheduled_at` crosses the hour), not `getHours()` + clock-refill. |
| **Web remote (listener PWA, dashboard, cast)** | **Display-only** over a pushed snapshot: `station_now_playing.queue` (JSONB) ← `engine.getQueue().slice(0,12)` (`App.tsx:426-478`; backend `ether-backend/src/index.js:4721-4787`, served `:5015`; consumed `ether-listener/.../UpNext.tsx`, `ether-dashboard/StationDetail.tsx:81-99`). | **Free** once the pushed `queue` is sourced from the log ≥ playhead — the surfaces render whatever array they're handed. **One write-path to reconcile:** dashboard admin `queue:reorder` command (`StationDetail.tsx:99` → `App.tsx:1150-1171`) must write the **log**, not the live array. |

---

## 5. The sync decision (must resolve before Phase 1)

`generated_schedule` is a **synced, station-scoped** table. Making the daemon stamp `state`/`played_at`
on every advance means the playhead mutates rows continuously → sync churn, and worse, **CRDT
last-write-wins could let a second device fight over the playhead** — exactly the class of bug in
[[project_peer_sync_station_uuid]] (routes/merges by local integer, "convergence proven" is false).

**Recommendation:** the lifecycle columns (`state`, `played_at`, playhead) are **local-authoritative
playout state, NOT CRDT-merged** — the always-on local engine for a station owns them; they are
**pushed for display** (like now-playing), never pulled back as truth. The **plan** columns
(`scheduled_at`, `song_id`, ordering, jingle placements) remain synced as today. This keeps "one
station = one engine owns its playhead" and avoids resurrecting the peer-sync divergence. Jeff to
confirm — this is the load-bearing decision.

---

## 6. Open decisions for Jeff (before any code)

1. **Lifecycle model:** per-row `state`+`played_at` with a *derived* playhead (recommended — makes the
   ▶ marker and resume first-class in the one file) vs a single station playhead pointer row. 
2. **Reorder ordering:** add a `seq REAL` column so reorder/insert don't restamp meaningful
   `scheduled_at` times (recommended) vs keep `scheduled_at` as the sole order and restamp on reorder.
3. **RESET TO SCHEDULE semantics under one-file:** confirm it means "re-sync playout to the log from
   the playhead" (discard only in-memory drift), since the log is already truth.
4. **Sync ownership of lifecycle columns:** confirm local-authoritative-push-for-display (§5).
5. **CLEAR & REGENERATE window:** confirm "forward rows beyond the in-progress hour," reusing the
   existing hard-top-of-hour generate rule (never regenerate the on-air hour).
6. **UI for the two verbs:** two buttons vs one CLEAR that opens a Reset / Regenerate choice.

---

## 7. Migration path (phased, flagged, shadow-first — matches the repo's migration doctrine)

Each phase is additive and independently shippable; playout only flips behind a flag after a shadow
burn-in. Canary on `ovowjensj` before customer boxes (auto-update caveat: the daemon does not reload
on update — full close/reopen).

- **Phase 0 — Schema (no behavior change). ✅ SHIPPED v4.4.68.** Added `state`, `played_at`, `seq` to
  `generated_schedule`; backfill (`state='played'` where `scheduled_at < now`, else `pending`; `seq` =
  dense rownumber over `scheduled_at`, re-numbered every run for idempotency). Sync: new columns
  local-authoritative (§5). Verified on a copy (28,615→17,288 played / 11,327 pending).
- **Phase 1 — Playhead writer (shadow, observational). ✅ SHIPPED v4.4.69, burn-in acceptance MET.**
  The engine stamps `state='playing'/'played'` + `played_at` as it advances, WITHOUT changing how the
  queue is sourced. Live burn-in: playhead matches `play_log` exactly on all 3 stations, exactly one
  playhead each; on-log baseline 60/20/90%. Restart-resume still old behavior.
- **Phase 2 — Read-path unification (behind flag). ⏭ NEXT.** Point UpNext + the ▶ marker at the same log
  query the calendar uses (rows ≥ playhead). Shadow-compare the log-derived up-next against
  `engine.getQueue()` and log divergences to the Health ledger. No playout change yet.
- **Phase 3 — Playout flip (ETHER_LOG_READER, shadow→canary).** Daemon consumes `generated_schedule`
  directly; the in-memory list becomes a validated cache of log rows; advance = move the persisted
  playhead; restart resumes at `state='playing'`. Delete `_schedCursor` + `purgeUnscheduled`. Canary
  ovowjensj; compare on-air audio to expected log; only then widen.
  **ACCEPTANCE (Jeff 2026-07-20): NOT "on-log rate → 100%".** Jeff live-adds songs via the deck loader
  as normal operation, so the Phase 1 on-log baseline (60/20/90) is *contaminated by legitimate
  operator inserts* and is not the yardstick. The real acceptance is: **everything that airs IS a log
  row** — machine-placed OR operator-inserted — i.e. `queue == calendar by construction`, zero off-log
  airs. (A live-picked item with no `generated_schedule` row is the failure; an operator insert that
  WROTE a log row is a pass — which is exactly why Phase 4's live-deck-load path must land no later
  than the flip.)
- **Phase 4 — Operator edits write the log** (incl. the LIVE DECK LOAD path — Jeff 2026-07-20).
  Re-point skip/reorder/remove/insert (`UpNext.tsx`, `JockStrip.tsx`, remote `queue:*` in
  `App.tsx:1150-1198`) to mutate `generated_schedule`; retire the array-only intents. **Explicitly in
  scope: the live deck load — Deck A/B/C loads and cue-to-deck (`StudioSendBar`, Library A/B/C,
  `deck:cue`, `noteManualCue`) WRITE a `generated_schedule` row at the playhead position, stamped
  operator-inserted (e.g. `source='operator'`).** Live radio is FIRST-CLASS in the one file, not an
  off-log exception: a jock loading a track to a deck is placing it on the log at the current
  position, so the queue/calendar reflect it immediately and it airs as a log row.
- **Phase 5 — CLEAR redefinition + emergency-floor-only refill.** Ship the two verbs (§3.2); remove
  the silent Priority-2 refill from advance; wire the log-exhaustion Health event. Convert
  `showClock.ts` top-of-hour to log-anchored (§4 drift row).
- **Phase 6 — Web remote log-native.** Source the pushed `station_now_playing.queue` from the log ≥
  playhead; reroute dashboard `queue:reorder` to write the log. Listener/cast/dashboard need no change
  — they render whatever array they're handed.

**Rollback:** the flag returns playout to the array-sourced queue at any phase ≤ 3; Phases 4-6 are
behind the same flag's "edits target the log" branch.

---

## 8. What this fixes (the receipts that vanish)

- The ▶ marker and the live decks **cannot disagree** — both are `state='playing'` on one row.
- Restart is **trivially correct** — resume at the `playing` row; nothing to re-derive; no
  wall-clock skip/repeat (kills the §1.2 restart hazard).
- The calendar and up-next are **the same rows** — the §1.2 divergence inventory (JIN/SWP filter,
  scoping guards, mutable-queue-never-written-back, resolution drops) collapses to one query + one
  classification policy + log-writes for edits.
- CLEAR stops minting a third sequence; the clock selector only ever fires **loudly, on exhaustion**.

---

*Design only. No schema applied, no code written, nothing built. Awaiting Jeff's decisions in §6 and
the §5 sync ruling before Phase 0.*
