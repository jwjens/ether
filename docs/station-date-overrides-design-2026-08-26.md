# Station date overrides — the calendar exception layer (design, 2026-08-26)

**Status: RULED AND BUILT (2026-08-26). This doc is the record; the build is the simple version.**

Jeff ruled: **no `is_closed`, no suppression logic, no notes field.** Date-keyed closing times only —
"extend the closing-time picker to specific DATES". So §0's Option A and Option C were REJECTED, and
what shipped is Option B arrived at from the other direction: a date whose closing time is set BLANK
has no closing time, so nothing closing-relative fires that day — the same thing a blank weekday
default already does. No new firing logic exists anywhere.

Also cut from the design as built: the `is_closed` column, the `note` column, and every reference to
a CLOSED marker. The table is `date_closing_times` (id, date, closing_time, station_id, uuid,
created_at, updated_at, deleted_at). Read §1's table and §0's Options A/C as history, not as the build.

Requirement (Jeff, 2026-08-26): a station-scoped calendar picker to select specific DATES that
override the normal weekly pattern. The park may be closed on certain dates, or open different hours
(holidays, special events, seasonal). The seven-per-day weekly closing times from slice 5 are the
recurring default; this is the date-specific exception layer on top.

Builds on: `docs/aux-channel-ducker-announcements-design-2026-08-21.md` §C.2 (slice 5) and
`docs/scheduler-tick-blast-radius-2026-08-26.md` (the 250 ms second-accurate tick, commit `debd05a`).

---

## 0. STOP — this contradicts a ruling that is one day old. Jeff must rule again.

Jeff's requirement says: **"mark a date CLOSED (no announcements fire)."**

That is closed-day suppression, and slice 5 forbade it — not incidentally, but as a stated ruling,
written into the code *and* into the shipped migration:

`electron/main.js` (the scheduler header):
> **FIRING IS NOT AIRING (Jeff's ruling, 2026-08-25).** This decides WHEN an announcement fires onto
> the Announcement source channel. Whether anyone hears it is the board's business — fader up,
> channel ON — exactly like every other channel. There is deliberately **NO closed-day logic, no
> suppression, no special case**: an announcement firing onto a channel that is down is simply nobody
> hearing it, the same as muting any source. **One rule, no exceptions to remember.**

`scripts/migrate-announcement-triggers-phase-sync-45.js` (shipped yesterday):
> FIRING vs AIRING, per Jeff's ruling (2026-08-25) … **There is no "closed day" suppression anywhere
> in this feature**: a channel that is down is simply a channel that is down.

Per CLAUDE.md (ARCHITECTURE BEFORE CODE) I am surfacing this rather than building over it. **Three
ways to satisfy "the park is closed that day". Jeff picks one.**

### Option A — overturn the ruling. CLOSED suppresses everything on that date.
Exactly what the requirement says. Mental model is dead simple: *park closed → nothing fires.*

- **Cost:** reintroduces the "exception to remember" the ruling was written to prevent, and it
  suppresses **absolute-time** announcements too — including a **legal station ID**, which is the one
  category of announcement you must never silently drop. Whoever marks Dec 25 CLOSED will not be
  thinking about the top-of-hour ID.

### Option B — CLOSED means "this date has NO closing time", and nothing more.  ← recommended
A CLOSED date simply carries no closing time. `dueTimeFor` **already** returns null when a day has no
closing time (`main.js`, slice 5) — so every `close_offset` row naturally has no due time that date
and fires nothing.

- **Zero new suppression logic.** Not one line. The behaviour Jeff wants for closing announcements
  falls out of code that already shipped.
- **Preserves the ruling** exactly as written.
- **Cost:** an *absolute* 10:00 announcement still fires on a CLOSED date. Someone who marked the day
  closed may not expect that — though on Option B's own terms it is correct: the board is the gate.

### Option C — B, plus a per-row opt-in.
Option B, plus one column on `announcements`: `skip_when_closed` (default 0). An operator marks the
park-info announcements skip-when-closed and leaves the legal ID alone.

- **Cost:** one more column and one more concept in the announcement editor. But suppression becomes
  an explicit per-row operator choice rather than a hidden global rule, which is the honest version
  of Option A.

**My recommendation: B now, C only if Jeff finds in practice that absolute rows firing on closed
dates is a real problem.** B is the minimal correct change, it needs no new firing logic at all, and
it does not overturn a ruling that is a day old. But the requirement as literally stated is A, and
this is Jeff's call, not mine — **everything below is written to work under any of the three**, since
only the CLOSED branch differs.

---

## 1. What a date can override (Q1)

Both things Jeff named, as one row per date:

| Field | Meaning |
|---|---|
| `is_closed = 1` | The park is closed this date. Under B/C: this date has no closing time. Under A: nothing fires this date. |
| `closing_time = 'HH:MM:SS'` | This date closes at a time other than the weekday default. Closing-relative announcements shift to it. |
| `closing_time = NULL`, `is_closed = 0` | An explicitly *normal* day — useful to cancel an override without deleting history, and to annotate ("Normal hours, extra staff"). |
| `note` | Free text: "Christmas Day", "Halloween Horror Nights". Shown on the calendar cell and in the fire log. |

`is_closed = 1` **and** a `closing_time` is contradictory — the UI makes them mutually exclusive, and
the resolver treats `is_closed` as winning if a synced row ever carries both.

## 2. Data model — new table, v46 numbered transformer

```sql
CREATE TABLE station_date_overrides (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id    INTEGER NOT NULL,
  uuid          TEXT NOT NULL,          -- sync identity. NOT NULL, and written by the sanctioned
                                        -- writer — the designation-upsert bug was an omitted uuid.
  date          TEXT NOT NULL,          -- 'YYYY-MM-DD', LOCAL calendar date
  is_closed     INTEGER NOT NULL DEFAULT 0,
  closing_time  TEXT,                   -- 'HH:MM:SS', or NULL = fall through to the weekday default
  note          TEXT,
  created_at    INTEGER,
  updated_at    INTEGER,
  deleted_at    INTEGER
);
CREATE UNIQUE INDEX idx_sdo_station_date
  ON station_date_overrides(station_id, date) WHERE deleted_at IS NULL;
```

**`date` is TEXT `'YYYY-MM-DD'`, deliberately, not an epoch.** A calendar date is not an instant. An
epoch would need a timezone to become "Dec 25" again and would drift across a DST boundary; the text
form is unambiguous, and it sorts lexically in chronological order for free.

**Why a table and not `station_config_kv`.** KV would ride existing sync with no migration
(`closing_date_2026-12-25` = `'21:00:00'`), and that is genuinely tempting. Rejected: a date override
is a *row* with four fields including a note, KV cannot be range-queried for "this month", and the
keyspace would grow forever with no lifecycle. The seven weekday defaults stay in KV — they are seven
fixed keys, which is what KV is for.

**Migration:** `scripts/migrate-date-overrides-phase-sync-46.js`, following the v45 template exactly —
idempotent, `tableExists` / `isAlreadyMigrated` / `applyMigration`, **and a `payloadTransformer`
export**, because `verify:schema` asserts both exports are present and callable on every migration in
the chain. Numbered transformer only; no unnumbered schema edits.

## 3. Precedence — ONE resolver, so it cannot drift (Q4)

```
date override  >  weekday default  >  nothing
```

Implemented in exactly one function. `closingTimeFor(stationId, dow)` becomes:

```js
function closingTimeForDate(stationId, dateStr, dow)
//  1. station_date_overrides row for (stationId, dateStr), not deleted
//       is_closed → null (B/C)  |  closing_time → that value
//  2. station_config_kv 'closing_time_<dow>'
//  3. null — the row simply has no time today, which slice 5 already handles
```

**The single-resolver property is the point.** Precedence lives in one place, so there is no second
site for it to be implemented differently. Everything else — the tick, `dueTimeFor`, `minusMinutes` —
is unchanged.

## 4. How it meets the scheduler (Q3)

- **Custom-hours date:** falls out for free. `dueTimeFor` calls the resolver, gets that date's
  closing time, and `minusMinutes` computes off it. Closing 21:00:00 overridden to 18:00:00 →
  the "15 minutes before" row fires at 17:45:00 that date. No new code in the tick.
- **CLOSED date:** under B/C the resolver returns null → `dueTimeFor` returns null → nothing fires,
  again with no new code. Under A the tick gains one early `continue` per station per tick.
- **Untouched:** the 250 ms cadence, the `HH:MM:SS` equality match, the 120 s `last_played_at` guard,
  the backwards midnight wrap. This layer changes *what closing time is*, never *how firing works*.

**Cost on the hot path.** The tick runs at 250 ms. The override lookup must not run per-row: resolve
each station's closing time **once per tick** into a local map, not once per announcement. The
statement itself joins the existing `annStmts()` prepared-statement cache from `debd05a`. One indexed
lookup per station per tick, on a table with a handful of rows — the same shape as what is already
there.

## 5. UI — inside the Announcements panel, NOT a new surface (Q2)

**Reuse checked first.** `src/components/BroadcastCalendar.tsx` carries month-grid maths
(lines 845–852) but its `viewMode` is hardcoded week-only — *"month removed (unnecessary); week only"*
(line 120). It is the **schedule** calendar: it generates a day's log. Closing hours are a different
concern and must not be bolted onto it.

**Put the month view in the Announcements panel, directly beside the seven weekday closing times that
slice 5 already put there.** DOORS BEFORE ROOMS: the exception belongs next to the default it
overrides, and that panel already has the door. No third calendar surface, no new room to discover.

- Month grid, `‹ ›` to change month, station-scoped via `useActiveStation` like everything else.
- Click a date → small popover: **Open (default hours)** / **Closed** / **Custom closing time**
  (`<input type="time" step={1}>`, matching the `HH:MM:SS` pickers from `debd05a`) + optional note.
- Cell treatment: default days plain; custom-hours dates carry the time; CLOSED dates visually
  distinct. Today outlined.
- **The header always shows the RESOLVED closing time for the selected date** and where it came from
  ("18:00:00 — date override" / "21:00:00 — Tuesday default" / "no closing time set"). Honest state,
  observed not claimed: "what actually happens that day" must never require reasoning about
  precedence.
- Empty state explains itself: "No date overrides. Every date uses its weekday's closing time."

If Jeff later wants it as its own window, the component is standalone and drops into the existing
`PopoutRenderer` `TITLES` map — one line, no rework.

**Help entry required before it ships:** `docs/help-date-overrides.md`, per CLAUDE.md.

## 6. Sync — yes, station-scoped, exactly like announcements (Q5)

It is station-owned scheduling config, so it syncs:

- `electron/sync/synced-tables.js` — new entry, `scope: 'station'`, `primaryKey: ['id']`, every column
  `'scalar'` (no blob-refs here).
- `electron/sync/handlers/station_date_overrides.js` — modelled on `handlers/announcements.js`, with a
  `PATCHABLE` list of `date, is_closed, closing_time, note, updated_at, deleted_at`.
- **`uuid` NOT NULL and written through the sanctioned writer.** The designation-upsert bug was an
  omitted `uuid` on a NOT NULL column; a hand-rolled INSERT here would fail the same way, or worse,
  write a row no peer ever sees.
- Soft delete via `deleted_at`, so removing an override propagates instead of resurrecting from a peer.
- Conflict resolution is the existing last-write-wins on `updated_at` — no special case. The unique
  index is `(station_id, date)` on live rows, so two machines editing the same date converge on one row.

## 7. Horizon and history (Q6)

**How far ahead: no cap.** A holiday or season calendar is routinely set a year out, and the data is
trivial — worst case 365 rows per station per year, realistically dozens. An artificial limit would
be a rule to discover and work around. The UI opens on the current month; `‹ ›` goes as far as anyone
wants in either direction.

**Past overrides STAY. They never auto-clear.** Two reasons:

1. **They are the record.** "Why did nothing announce on Dec 25?" is answerable only if the row
   survives. This repo already treats the play log and affidavit as evidence; station scheduling
   config that governed a day's output is evidence of the same kind.
2. **Auto-deleting is a silent mutation of station config.** A background sweep quietly destroying
   history is exactly the standing-diagnostic-persistence pattern CLAUDE.md rules out, and it would
   be indistinguishable from data loss.

They do not clutter anything: the month view only ever shows the viewed month, so month navigation
*is* the history browser. No extra UI concept, no "archive" tab. An operator can still soft-delete a
row by hand, like anything else.

---

## What this design deliberately does NOT do

- **It does not touch rotation, clocks, spots, the log generator, or the daemon's 250 ms poll.** A
  CLOSED date affects **announcements only**. If Jeff wants a CLOSED date to also stop rotation or
  change what Generate produces, that is a much larger change to the scheduler proper — naming it
  here so it is a decision, not an assumption.
- No recurring-holiday rules ("every 4th Thursday in November"). Explicit dates only. Recurrence is a
  second feature and a second set of edge cases; a year of explicit dates is minutes of clicking.
- No import of a public holiday calendar.
- No change to `close_offset_min` (still INTEGER minutes — precision comes from the closing time).

## Known edges, stated not hidden

- **Midnight wrap is a PRE-EXISTING defect and this makes it more visible.** A `close_offset` that
  wraps backwards past midnight (close 00:15, offset 30 → 23:45) already resolves against *today's*
  clock rather than the previous calendar day (filed in `docs/backlog.md`). Keying hours to a DATE
  makes that inconsistency easier to notice. Behaviour is unchanged by this design; the backlog item
  simply matters more once dates are explicit.
- **DST.** A date's closing time is a local wall-clock time, and on a transition date the wall-clock
  time is still what is meant. Storing `'HH:MM:SS'` and matching against local `now` is correct and
  sidesteps the trap; an epoch column would not have.

## Open question back to Jeff

**§0 is the only one that blocks: A, B, or C for CLOSED dates.** Everything else in this document is
independent of that choice and can be built as written. My recommendation is B.
