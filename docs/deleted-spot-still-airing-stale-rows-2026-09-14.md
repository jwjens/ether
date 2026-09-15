# It keeps coming back — stale pending rows from a previous day

**Jeff, OVEVENTS 4.6.37, on air:** *"I deleted the Opportunity Village spot — it's gone from the
Library and the orphan cleared. I have already run Generate. It is STILL being scheduled and it's on
deck A right now."*

**Nothing is re-creating it. The rows have been there since 6 September and nothing has ever retired
them.**

## 1. Is the spots row tombstoned? YES

    spots #4  "Opportunity Village Spot"  station=2
      deleted_at  2026-09-14T16:15:09.518Z
      mutations   1 x delete, origin=remote, sync_status=synced

The delete is correct and complete. (Three other rows share the same audio file: #1/#2 "11 sec spot
hv" station 2, both deleted in July, and **#3 "11 sec test spot" on station 3, still live** — not the
cause here, but worth knowing the file is referenced by another station.)

## 2. Are there still log rows naming it? YES — and they predate everything

    id       scheduled_at            state     created_at
    418466   2026-09-13 20:00:00     pending   2026-09-06T17:48:12
    418472   2026-09-13 20:20:02     pending   2026-09-06T17:48:12
    418478   2026-09-13 20:40:11     pending   2026-09-06T17:48:12
    418487   2026-09-13 21:00:00     pending   2026-09-06T17:48:12
    …        title="Opportunity Village Spot"  artist="Opportunity Village"  dur=11

**Scheduled for 13 September — yesterday. Created 6 September.** Before the delete, before Generate,
before 4.6.36. Today's date has **zero** rows for that file:

    ANY row for that file scheduled TODAY? — NONE. The log is not scheduling it.

## 3. Does Generate clear pending spot rows? YES — but only TODAY's

`electron/main.js:9013`:

    DELETE FROM generated_schedule
     WHERE station_id = ? AND scheduled_at >= ? AND scheduled_at < ? AND <not operator owned>

The window is `effStart` (**the next top of the hour**) to `dayEnd` (**end of the day being
generated**). Measured now:

    rows before the next hour (Generate never touches):   3,210
    rows inside today's window (Generate cleared):            0
    rows after today:                                         0

Generate did exactly what it is written to do. **Yesterday is outside its window, and nothing else
ever retires a `pending` row whose slot has passed.**

## 4. Is sync re-creating it? NO

One mutation for that uuid, ever: `delete`, `origin=remote`, `synced`. No insert, no update. Nothing
arrived from OV and nothing was resurrected.

## So what puts it on deck A

The log-reader flip is **ON** for every station here (`log_reader_flip = 1`). `readLogAnchored` picks
the latest still-`pending` row whose slot has arrived. Yesterday's 8:00/8:20/8:40 PM rows are still
`pending` and their slots have very much arrived, so they remain eligible candidates — an 11-second
spot, which matches the 0:11 on deck A exactly.

## Why the retraction built today did not catch these

`retractSpotReferences` (4.6.36) retracts `state='pending'` rows matching the spot's `file_path`. It
would have caught these — but the delete **arrived from OV at 16:15 today, before 4.6.36 was
installed on this machine**, so no retraction ran. Deleting the Library orphan afterwards on 4.6.37
found no live `spots` row to retract for (correctly — it was already tombstoned) and so tombstoned
only the asset.

These are log rows orphaned by a delete that happened before the cascade existed.

## Two real defects, neither of them "the delete failed"

1. **Nothing retires a `pending` row whose slot has passed, across a day boundary.** Generate is
   day-scoped by design (it must never rewrite an aired hour). The anchored reader stamps `missed`
   but is day-bounded. So yesterday's unaired rows sit `pending` for ever and stay selectable. There
   were 1,110 such rows for a *different* path of the same file dating back to 23 July.
2. **The spot retraction is not retroactive.** A spot deleted before 4.6.36 leaves its placements
   behind, and installing 4.6.36 does not clean them up.

## What stops it tonight

**Now, no build:** remove those rows from the log grid in the calendar for 13 September — they are
the only thing selecting it.

**The repair:** a one-shot that tombstones `generated_schedule` rows which are `state='pending'`,
`content_class='SPOT'`, and whose `spots` row is deleted or absent — the same dry-run-first shape as
`repair-orphan-assets.js`. That is the retroactive half of 4.6.36.

**The durable fix:** a pending row whose slot passed more than N hours ago is not a candidate. Either
the anchored reader refuses it, or a daily sweep stamps it `missed`. This is the same class as the
stale-row debris cleaned out of station 4 on 2026-07-30, and it will keep producing symptoms that
look like resurrection until something retires them.

**NOT BUILT — read-only.**
