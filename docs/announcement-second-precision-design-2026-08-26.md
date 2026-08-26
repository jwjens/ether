# Announcements to the second — design (2026-08-26)

**Status: SUPERSEDED — most of this was NOT built, and deliberately so.**

Jeff ruled on 2026-08-26: **resolution only.** No grace window, no missed-fire/catch-up logic, no
change to how a manual press interacts with a scheduled fire, no midnight-wrap rework. Sections 2
(fire on a WINDOW), 3 (the exact once-per-due-instant guard) and the Open Questions below were all
REJECTED and are NOT in the build. They are kept here only as the record of what was considered.

**What was actually built is described in `docs/scheduler-tick-blast-radius-2026-08-26.md`** —
HH:MM:SS resolution, a 250ms tick, the prepare-hoist, and nothing else. The 120s `last_played_at`
guard stayed exactly as it was. Read that doc, not this one.

Requirement (Jeff, 2026-08-26): announcements must fire to the exact second, not rounded to the
minute. He runs :15 and :30 spots and needs a trigger set for 8:45:30 to fire at 8:45:30.

Governing doc: `docs/aux-channel-ducker-announcements-design-2026-08-21.md` §C.2. The BOARD-is-the-
sole-gate ruling is untouched by everything below: this changes only WHEN a row fires, never whether
it airs.

---

## What exists today (`electron/main.js:4304-4381`)

```js
const ANNOUNCE_TICK_MS = 15000;
...
const hhmm = String(now.getHours()).padStart(2,'0') + ':' + String(now.getMinutes()).padStart(2,'0');
if (!due || due !== hhmm) continue;
if (row.last_played_at && (nowEpoch - row.last_played_at) < 120) continue;
```

- **15 s tick**, matched on a `HH:MM` **string equality**.
- So a row set for 8:45 fires at whichever 15 s boundary first lands inside that minute — 8:45:00,
  :05, :10, :15, wherever the interval happens to sit. **Jitter of up to 15 s, and its phase is set
  by whenever the app happened to boot.**
- Double-fire is held off by a **120 s "time since last fire" heuristic** — needed precisely because
  four ticks land in the matching minute.

`trigger_time` is `TEXT` (`scripts/schema-v0-baseline.js:260`), so **seconds need no migration.**
`close_offset_min` stays INTEGER minutes — the precision comes from the closing time, not the offset.

---

## THE HAZARD in the obvious fix

Tick at 1 s and match `HH:MM:SS` equality. **Do not do this.** `setInterval` drifts, and main is not
an idle process — it carries DB work and the audio command path. If one tick lands 1.2 s late, the
target second is stepped over and **the announcement never fires at all.**

Trading "fires within 15 s" for "usually exact, occasionally silent" is a bad trade for broadcast.
Dead air at the exact moment someone is listening for a closing announcement is the worst outcome
available, and it would be intermittent and near-impossible to reproduce.

**Never match a clock by equality. Match a window, and remember what you already did.**

---

## Proposed design

### 1. Resolve each row to an EPOCH SECOND, not a string

`dueTimeFor` returns `'HH:MM'` today. It becomes `dueEpochFor(row, stationId, now)` returning the
epoch-second of that row's due instant **today**, built from local Y/M/D + H/M/S. All comparison
becomes integer arithmetic — no string equality anywhere, no timezone re-derivation.

`'HH:MM'` continues to parse as `HH:MM:00`, so **every existing row keeps its exact current
behaviour** and nothing needs rewriting on upgrade.

### 2. Fire on a WINDOW

```js
if (nowEpoch < dueEpoch) continue;                      // not yet
if (nowEpoch - dueEpoch > ANNOUNCE_GRACE_SEC) continue;  // too late — this instant has passed
```

- Normal case: the 1 s tick lands within 1 s of the target, so it fires **at 8:45:30**, ±1 s.
- Stalled loop: the next tick after the stall still fires it, **late but not lost**, and the log
  records how late.
- Grace also answers the case that has nothing to do with drift: the app was **closed** at 8:45 and
  opened at 9:30. Without the upper bound it would fire a 45-minute-stale announcement on air.

**`ANNOUNCE_GRACE_SEC = 30` proposed.** Judgment call, flagged for Jeff — see Open Questions.

### 3. Double-fire guard: EXACT, not a heuristic

Replace the 120 s window with the actual invariant — **fire once per (row, due-instant)**:

```js
if (row.last_played_at && row.last_played_at >= dueEpoch) continue;  // already fired for THIS instant
```

Why this is strictly better than `nowEpoch - last_played_at < 120`:

- **Cannot double-fire.** `fireAnnouncement` stamps `last_played_at = now` (main.js:4468) *after* the
  engine is told. Once stamped, `last_played_at >= dueEpoch` holds for every remaining tick in the
  grace window — and stays true until tomorrow's `dueEpoch`, 24 h later. With a 1 s tick and a 30 s
  window that is 30 suppressed ticks where the old code leaned on a magic number.
- **Cannot wrongly suppress.** The old 120 s window was blind to *which* instant fired. The new rule
  is keyed to the due instant itself, so two rows, two stations, or two days never interfere.
- **Self-clearing.** No state to reset, no module global, nothing to go stale. It is a comparison
  between two numbers already on the row.
- **Survives restart.** `last_played_at` is in the DB, so a restart inside the grace window still
  will not re-fire. The old heuristic had this property too and it is preserved.

**Behaviour change to note:** a HAND fire (▶AIR) at 8:44:50 stamps `last_played_at = 8:44:50`, which
is *before* `dueEpoch` 8:45:00, so **the scheduled fire still happens 10 s later**. Under the old
120 s guard the hand-fire would have swallowed it. The new behaviour is what the ruling actually says
— "a scheduled announcement always FIRES on (Active Day AND trigger time)" — but it is a change, and
Jeff should say so out loud before it ships.

### 4. Tick rate: 1000 ms, with the DB off the hot path

`ANNOUNCE_TICK_MS: 15000 → 1000`.

That is 15× the tick rate, and the tick currently runs `SELECT id FROM stations` plus one SELECT per
station **every time**. At 1 s with 4 stations that is 300 queries/minute on the main process, which
also carries the audio command path.

So the plan is **cached**: announcements + closing times are read into an in-memory array on a 15 s
refresh (the old tick cadence, reused as the *refresh* cadence), and the 1 s tick does pure integer
arithmetic over that array. The DB is touched only on the refresh and on an actual fire.

Net DB load is therefore **unchanged from today**, while the fire lands to the second.

Consequence to accept: a **newly saved** announcement arms within 15 s. Only a row saved less than
15 s before its own due instant could miss it — not a case anyone can schedule deliberately.

### 5. Closing time gains seconds

Required by Jeff's point 3 (closing 9:00:00, offset −15:00 → 8:45:00 exactly). Closing time is
currently validated `HH:MM` in two places and stored in `station_config_kv`:

- `main.js:4306` `closingTimeFor` — regex `/^\d{1,2}:\d{2}$/`
- `main.js:4392` `announcements:set-closing-time` IPC — same regex, error text `'expected HH:MM'`

Both relax to `/^\d{1,2}:\d{2}(:\d{2})?$/`, and a bare `HH:MM` reads as `HH:MM:00`. `minusMinutes`
becomes second-aware (carry the seconds through the subtraction unchanged). **No migration** — the
value is already a TEXT KV.

### 6. The two pickers

`src/components/Announcements.tsx`:

- line 240 — trigger time: `<input type="time" step={1}>` (Chromium renders HH:MM:SS at `step=1`).
- line 198 — the seven closing-time inputs: same `step={1}`.
- line 77 — the new-row seed `trigger_time: "17:30"` becomes `"17:30:00"`.
- line 29 — `fmtTime` currently does `t.split(":")` and drops everything after the minutes; it must
  render seconds. Proposed: show `8:45:30 PM` when seconds are non-zero and stay `8:45 PM` when they
  are zero, so the majority of rows that sit on the minute do not get noisier to read.

### 7. Make the precision OBSERVABLE (BUILD THE SENSE, NOT THE SCAFFOLD)

The scheduled-fire log line gains the measured lateness:

```
[announce] scheduled fire station 1 "Park closes in 15" due 20:45:00 fired +0.4s (absolute)
```

Without this, "did it fire on time?" is answerable only by ear. With it, a drifting main process is
visible in the log before it becomes an on-air complaint.

---

## What is NOT changing

- `trigger_type` / `close_offset_min` semantics; `close_offset_min` stays INTEGER **minutes**.
- **No schema migration.** `trigger_time` is TEXT; closing time is a TEXT KV. Nothing to transform.
- The sync handlers (`electron/sync/handlers/announcements.js`) — `trigger_time` is already a scalar
  string on the wire and a longer string rides unchanged.
- The BOARD-is-the-sole-gate ruling. No closed-day logic, no suppression, still.
- `fireAnnouncement` itself — untouched. Hand-fire and trigger stay the same code path.

---

## Open questions for Jeff — answer before I build

1. **`ANNOUNCE_GRACE_SEC = 30`?** This is the "how late is too late to still fire" bound. 30 s means a
   stalled main process still airs the announcement, but an app opened 5 minutes after the fact does
   not. Shorter (10 s) is tighter to the second and more likely to drop one on a stall; longer (120 s)
   never drops but can put a stale announcement on air after a restart. **30 s is my recommendation.**

2. **The hand-fire behaviour change in §3** — a ▶AIR press shortly before a scheduled time no longer
   suppresses the scheduled fire. I read the ruling as requiring this. Confirm.

3. **Midnight wrap — PRE-EXISTING BUG, in or out of scope?** `minusMinutes` already wraps backwards
   past midnight (`main.js:4317`), so closing 00:15 with a 30-minute offset resolves to `23:45` — but
   `announceTick` then compares it against *today's* clock, so it fires at 23:45 **tonight** rather
   than 23:45 last night. Moving to epoch arithmetic makes this explicit and easy to handle properly
   (resolve to the nearest due instant within ±12 h instead of assuming today). It is a real defect,
   it is not one Jeff reported, and fixing it is a slightly wider change. **Say the word either way** —
   otherwise I leave it behaving exactly as it does today and file it in the backlog.
