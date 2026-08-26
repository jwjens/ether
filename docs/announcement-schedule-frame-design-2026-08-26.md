# The announcement schedule frame — design (2026-08-26)

**Status: BUILT IN ONE PASS (2026-08-26). The two-pass plan and the compatibility mirror were SCRAPPED.**

Jeff's rulings on §9: (1) weekday fallback accepted, no explicit-silent-date marker; (2) no per-entry
active toggle — delete the entry; (3) calendar option (c), clicking a date opens a page showing both
its closing-time override and its announcement list; (4) `days` as a set string (`'56'`).

**(5) was reversed.** The two-pass split was scrapped: this is dev, nothing is on air, and the old
panel did not need to keep working. So the model split AND the new panel shipped together, and the
old announcement scheduling UI was **deleted rather than wrapped**:

- **The compatibility mirror is gone** — `mirrorLegacySchedule` / `mirrorLegacyDelete` and their call
  sites. What remains in its place is `deleteEntriesForAnnouncement`, a real CASCADE: deleting an
  asset takes its entries with it. That is referential cleanup, not a bridge.
- **The tick's pre-v47 fallback is gone.** `announcements.trigger_time` / `days` are dead columns now;
  nothing writes them, so firing from them would mean firing a schedule nobody can see or edit. A
  missing table is reported loudly in the panel instead, and the migration chain retries on every
  launch, so the recovery is automatic.
- **The old panel's trigger picker and Active Days checkboxes are deleted**, not hidden. The panel is
  now an ASSET list plus a SCHEDULE (weekday lists + per-date lists).

Kept exactly as designed: the v47 backfill, the per-entry `last_played_at` guard, second precision,
the existing fire path and the real ducker.

Requirement (Jeff, 2026-08-26): an announcement schedule is a **list of (announcement, time) entries
attached to days**. Attach by WEEKDAY (repeating, days sharing a lineup checked together) or by
SPECIFIC DATE (one-off). A date's list overrides the weekday list for that date. Same underlying
entry shape for both.

**ANNOUNCEMENTS ONLY.** Nothing here touches spots, jingles, song rotation, clocks, the log
generator, the top-of-hour hard cut, or the daemon's 250 ms poll. The only scheduler that changes is
`announceTick()` in `electron/main.js`.

Builds on: slice 5 (`docs/aux-channel-ducker-announcements-design-2026-08-21.md` §C.2), the 250 ms
second-accurate tick (`debd05a`), and the date-closing calendar (`db30ffb`).

---

## 1. The actual change: an announcement stops being its own schedule

Today, one `announcements` row is **both** the audio asset **and** its schedule:

```
announcements: id, title, file_path,          ← the ASSET
               trigger_time, days,
               trigger_type, close_offset_min, ← the SCHEDULE
               is_active, last_played_at, ...
```

That is why an announcement can only ever have **one** time and **one** set of days. Jeff's model
needs "closes in 30" at 8:30, "15 minutes" at 8:45, "closing" at 9:00 — and the same audio reusable
at a different time on a different day. So the schedule has to come off the asset and become its own
row.

**That single split is the whole design. Everything below follows from it.**

```
announcements            → the ASSET.    title, file_path, is_active. What it is.
announcement_schedule    → the ENTRY.    which announcement, what time, which day(s)-or-date.
                                          When it plays. Many per asset.
```

## 2. Storage — `announcement_schedule` (v47)

```sql
CREATE TABLE announcement_schedule (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id         INTEGER,
  uuid               TEXT,
  announcement_uuid  TEXT NOT NULL,   -- WHICH announcement. By uuid, never the integer id.
  scope              TEXT NOT NULL,   -- 'weekday' | 'date'
  days               TEXT,            -- scope='weekday': '56' = Fri+Sat. NULL for scope='date'.
  date               TEXT,            -- scope='date': 'YYYY-MM-DD'. NULL for scope='weekday'.
  trigger_type       TEXT NOT NULL DEFAULT 'absolute',   -- 'absolute' | 'close_offset'
  trigger_time       TEXT,            -- 'HH:MM:SS' when absolute
  close_offset_min   INTEGER NOT NULL DEFAULT 0,         -- minutes before close when close_offset
  sort_order         INTEGER NOT NULL DEFAULT 0,
  last_played_at     INTEGER,         -- the double-fire guard, PER ENTRY (see §4)
  created_at         TEXT,
  updated_at         TEXT,
  deleted_at         TEXT
);
CREATE INDEX idx_ann_sched_station_scope ON announcement_schedule(station_id, scope) WHERE deleted_at IS NULL;
CREATE INDEX idx_ann_sched_date          ON announcement_schedule(station_id, date)  WHERE deleted_at IS NULL;
```

**`announcement_uuid`, not `announcement_id`.** Routing by the local integer is the defect already
recorded for peer-sync (`project_peer_sync_station_uuid`): two installs diverge because the integer
means different things on each. The uuid is the identity the fire path already keys on.

**`trigger_type` / `trigger_time` / `close_offset_min` move onto the ENTRY.** They are scheduling
properties, not properties of an audio file. This is what makes "the same closing chime at 8:45 on
Friday and 7:45 on Sunday" expressible at all.

**`days` as a SET string ('56'), not one row per weekday.** It mirrors the existing `days` column
exactly, the tick already does `days.includes(dow)`, and it directly represents Jeff's "days that
share a lineup are checked together". *Tradeoff, stated:* later un-checking Saturday from a Fri+Sat
entry is a row edit rather than a row delete, and the UI has to handle that (edit the set, or split
the entry). One-row-per-weekday would make that trivial but turns "check Fri+Sat, add 3 entries" into
6 rows that must be kept in step. **I recommend the set string** — fewer rows, and it is the shape
the scheduler already reads.

## 3. Precedence — one resolver, again

```
entries for TODAY'S DATE exist  →  use exactly those, and ONLY those
otherwise                       →  weekday entries whose `days` include today's dow
otherwise                       →  nothing
```

A date's list **replaces** the weekday list wholesale, exactly as Jeff specified — Oct 31 runs its
own entries instead of the normal Friday ones, not in addition to them.

Implemented in **one** function, `scheduleForDate(stationId, dateStr, dow)`, the same discipline as
`closingTimeForDate` from v46: precedence lives in a single place so there is no second site for it
to drift.

## 4. The double-fire guard MOVES to the entry — and this is load-bearing

Today the guard is `announcements.last_played_at` — 120 s, keyed on the **asset**.

Under the new model that breaks the feature outright: "closes in 30" at 8:45 and "closing" at 9:00
may be the *same audio file*, and a guard on the asset would let the first fire suppress the second.
Worse, at 250 ms the guard is what makes the second-accurate match safe at all.

So: **`announcement_schedule.last_played_at`, guarded per ENTRY, same 120 s window, same comparison.**
Two entries for the same audio at different times both fire, which is the point.

`fireAnnouncement(stationId, uuid)` gains an optional entry uuid:

- The **asset** stamp stays (`announcements.last_played_at`) — it is a genuinely useful "when did this
  audio last play" for the list UI, and the hand-fire ▶AIR path has no entry to stamp.
- The **entry** stamp is new, and is the one the tick guards on.

Everything else in `fireAnnouncement` is untouched: same deck lookup, same materialization gate, same
engine calls, same honest error returns. The fire path is reused, not rewritten.

## 5. How the 250 ms tick changes

Today it iterates announcements. It will iterate **entries**. Structurally the same loop:

```js
for (const stationId of stations) {
  const close = closingTimeForDate(stationId, dateStr, dow);   // v46, unchanged
  const plan  = scheduleForDate(stationId, dateStr, dow);      // NEW — once per station per tick
  for (const e of plan) {
    const due = dueTimeFor(e, close);                          // unchanged, entry has the same fields
    if (!due || due !== hhmmss) continue;
    if (e.last_played_at && (nowEpoch - e.last_played_at) < 120) continue;   // now the ENTRY's
    fireAnnouncement(stationId, e.announcement_uuid, e.uuid);
  }
}
```

**What is deliberately identical:** the 250 ms cadence, the `HH:MM:SS` equality match, the 120 s
window, `dueTimeFor`, `minusMinutes`, the backwards midnight wrap, and the absence of any grace
window, catch-up, or suppression logic. This changes **what the tick iterates**, not how firing works.

**Cost.** `scheduleForDate` is resolved **once per station per tick**, never per entry — the same
discipline v46 used. It is one indexed "does this date have entries" lookup plus one list read, both
prepared once in the existing `annStmts()` cache and both prepared **defensively** so a DB the v47
migration has not reached degrades instead of taking the scheduler down (the same guard shipped for
`date_closing_times` in `db30ffb`).

The active-day check (`days.includes(dow)`) moves from the row loop into `scheduleForDate`'s query,
so it is done once in SQL rather than per row in JS.

## 6. Migration v47 — and it must change nothing on upgrade

`scripts/migrate-announcement-schedule-phase-sync-47.js`, idempotent, `payloadTransformer` +
`applyMigration` exports (the chain verifier asserts both).

1. Create `announcement_schedule`.
2. **Backfill.** For every live `announcements` row, insert exactly one entry:
   `scope='weekday'`, `days` = its current `days`, `trigger_type` / `trigger_time` /
   `close_offset_min` copied across, `last_played_at` copied across.

**Every existing station therefore keeps firing precisely what it fires today, at the same times, on
the same days, with its double-fire state intact.** The upgrade is invisible until someone opens the
panel and adds a second entry.

**The old columns are left in place and stop being read.** Not dropped: SQLite drops are disruptive,
and an older build rolled back onto the same DB would still read them and behave sanely. They are
marked dead in the schema comment. *Flagged honestly:* that is two places holding a trigger time,
with only one of them live. The alternative — dropping them — is worse.

## 7. UI

The Announcements panel becomes two clearly separated halves. Same panel, same door.

**A. Announcements (the library).** What exists: title, file, ▶Test / ▶AIR, active toggle, delete.
The per-row trigger time and day checkboxes **leave this list** — they are now schedule entries.

**B. Schedule.** Two tabs over one shared entry-list editor:

- **By weekday** — the seven day checkboxes (kept, as Jeff specified). Check one or more; below,
  that selection's list of entries. Each entry: `[announcement ▾] at [HH:MM:SS]` or
  `[announcement ▾] [30 ▾] minutes before closing`, plus a delete. **+ Add another** underneath.
- **By date** — the month calendar already built in `db30ffb`. Click a date → that date's own entry
  list, edited identically. A date with its own list is marked on the grid, and the panel states
  plainly *"Oct 31 runs its own 3 announcements instead of the Friday list."*

**Reused, not rebuilt:** the month calendar component, the `HH:MM:SS` pickers (`step={1}`), `fmtTime`,
and the existing closing-time editors.

**One real UI question (§9.3):** that calendar now carries two different date-keyed concepts — a
closing-time override and an announcement list. Both are "this date is special", but they are
independent, and one grid showing both risks being unreadable.

**Help entry required before ship:** `docs/help-announcement-schedule.md`, and
`docs/help-date-closing-times.md` needs updating.

## 8. Sync

`announcement_schedule` is station-owned scheduling config, so it syncs like the rest:

- `synced-tables.js` REGISTRY entry (`scope: 'station'`, all scalar) **and** the `SYNCED_TABLES` name
  list — both, since they are separate and a missing name is a silent sync gap.
- `electron/sync/handlers/announcement_schedule.js` — writes through `withMutation`, `uuid` NOT NULL,
  the `station_config_kv` no-op guard, soft delete via `deleted_at`.
- `announcement_uuid` is a cross-row reference; it needs a `refs` entry so causal ordering does not
  apply an entry before its announcement exists on a peer.

## 9. Open questions — Jeff rules on these before I build

1. **An explicitly SILENT date.** If a date's list exists and is then emptied, the rules above fall
   back to the weekday list. So there is no way to say "Oct 31 runs NOTHING." Same blank-vs-absent
   distinction v46 solved with a blank value. **Add a marker row so an empty date list means silence,
   or accept that "no entries" means "use the weekday list"?** My recommendation: accept the fallback
   for v1 — the operator can already achieve silence by leaving the audio inactive — and add the
   marker only if it is actually wanted.

2. **Entry-level active toggle?** `announcements.is_active` stays (switch the asset off everywhere). I
   propose **no** separate per-entry toggle in v1 — deleting the entry is how you take it off a day,
   and two toggles is two places to look when something does not fire. Say if you want it.

3. **The calendar showing two things.** Closing-time overrides and announcement lists on one month
   grid. Options: (a) one grid, two markers per cell; (b) two tabs, each with its own grid;
   (c) one grid, and clicking a date opens a panel with both sections. **I recommend (c)** — one
   calendar, and the date's page tells you everything special about that date.

4. **`days` as a set string vs one row per weekday** (§2). I recommend the set string; it is the one
   choice here that would be genuinely annoying to reverse later.

5. **Scale of the change.** This is a data-model split plus a migration plus a panel rebuild —
   materially bigger than the last three commits. Worth confirming you want it in one pass rather
   than as: v47 + backfill + tick (invisible, no UI change) first, then the panel rebuild second. **I
   recommend two passes** — the first is provable by the acceptance run alone, and if the panel work
   goes wrong nothing that is already on air is at risk.

## 10. What does NOT change — the guarantee

Spots, jingles, carts, song rotation, clocks, `loggen`, `autofit`, the top-of-hour hard cut, the
daemon's 250 ms poll, `generated_schedule`, and the log-reader flip are **all untouched**. Within
announcements, the fire path, the second-precision match, the 250 ms cadence, the 120 s guard and the
board-is-the-sole-gate ruling are untouched. The change is *what the tick iterates* and *where a
trigger time is stored* — nothing else.
