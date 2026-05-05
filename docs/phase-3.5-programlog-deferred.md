# Phase 3.5 — ProgramLog / scheduled_log deferred

**Status:** Deferred  
**Files:** `src/components/ProgramLog.tsx` (9 write sites), `src/components/CloudBackup.tsx` lines 327–339  
**Commit:** phase-3.5 Session C cluster C (deferral)

---

## The problem

### Layer 1 — Schema mismatch (writes have always been broken)

The live `scheduled_log` table schema (from `electron/main.js` DDL + alterSafe migrations) has these columns:

```
id, log_date, hour, position, song_id, title, artist, category_id,
duration_ms, clock_id, created_at, overflow, fade_out_at_ms,
fade_duration_ms, chain_type, station_id, uuid, updated_at, deleted_at
```

`ProgramLog.tsx`'s four INSERT statements (lines 222, 289, 297, 338) reference columns that **do not exist**:

| Used in ProgramLog INSERTs | Actual DB column | Status |
|---|---|---|
| `song_title` | `title` | Wrong name |
| `song_artist` | `artist` | Wrong name |
| `slot_type` | — | Not in DB |
| `category_code` | — | Not in DB |
| `category_color` | — | Not in DB |
| `label` | — | Not in DB |
| `status` | — | Not in DB |

SQLite throws `table scheduled_log has no column named song_title` on the first INSERT. `scheduleOneHour` wraps the entire function body in `try { ... } catch { return false }`, silently swallowing the error. The schedule generator appears to succeed (returns `false` for "no show found" vs `true` for "scheduled") but never writes a row.

**Confirmed by direct DB inspection (2026-05-04):**

```
rows: 0
distinct log_dates: 0
```

The table has been empty since the feature was written.

The `ScheduledEntry` TypeScript interface also declares `song_title: string | null` and `song_artist: string | null` instead of `title` and `artist`, so the rendered display would show `undefined` for song information even if rows existed.

### Layer 2 — Typed-handler migration blocked by Layer 1

Phase 3.5 Cluster C intended to migrate all `scheduled_log` writes from raw `execute()` to `window.ether.scheduledLog.create/update/delete`. That migration is straightforward once the column names are correct — the generated handler already uses `title` and `artist`. But migrating broken INSERTs to the typed handler would produce broken typed-handler calls; the column-name fix must land first.

### Layer 3 — Two new handler methods needed regardless

`clearHour` (ProgramLog line 385) and `clearDay` (line 391) do bulk DELETEs by `log_date+hour` and `log_date` respectively. The typed handler has only per-row `delete(uuid, stationId)`. New methods `clearByHour(stationId, date, hour)` and `clearByDate(stationId, date)` are required, following the `playLogClearByStation` pattern (`db.transaction()` + per-row `logMutation`).

### Layer 4 — Missing stationId in ProgramLog component

The main `ProgramLog` component does not call `useActiveStation`. The schedule generator, `clearHour`, and `clearDay` have no `stationId` in scope. This must be added before any typed-handler migration.

---

## User-facing impact today

The Program Log panel (Schedule → Program Log) is reachable from the production UI and renders an empty-state "No entries found." Its subtitle reads "Historical record of every song played on air" — that copy is wrong. The panel targets `scheduled_log` (a planned, pre-rendered hour-by-hour schedule), not `play_log` (the actual historical record of what played). The Play Log panel — separate component — is what shows actual historical playback and works correctly.

A user discovering this panel today will see "No entries found" permanently regardless of how much music has played. The panel should either be:

**(a) Hidden from navigation** until `scheduled_log` is populated by a working schedule generator. Hiding the nav entry is a 5-line change in whatever component renders the Schedule menu — outside Phase 3.5 scope.

**(b) Re-pointed at `play_log`** with wording matching what it actually shows — effectively a duplicate of Play Log, which already exists and works. Probably not desired.

**(c) Left visible as a "feature in development" placeholder** — low cost, but the misleading subtitle erodes trust.

**(d) Built out properly:** fix the schema mismatch, repair the schedule generator's INSERTs, populate `scheduled_log` via Format Clocks → Dayparts → planned slots, and have the panel show the planned schedule for upcoming hours/days.

**Recommended:** (a) immediately — hide the nav entry — with (d) as the eventual proper fix. Hiding unblocks user trust at near-zero cost while the real feature is being built.

---

## Work required before Cluster C can land

In order of dependency:

1. **Fix the DB schema mismatch in ProgramLog.tsx** — rename `song_title→title`, `song_artist→artist` in the four INSERTs; drop the seven non-existent column references (`slot_type`, `category_code`, `category_color`, `label`, `status`). Update the `ScheduledEntry` interface to match. Verify `scheduleOneHour` produces rows.

2. **Add `useActiveStation` to ProgramLog** — provides `stationId` to `scheduleOneHour`, `clearHour`, and `clearDay`.

3. **Add `uuid` to `ScheduledEntry` interface** — needed so `HourModal.swapSong` and `HourModal.reorderEntries` can call `scheduledLog.update(uuid, patch)`.

4. **Add `scheduledLogClearByHour` and `scheduledLogClearByDate` to the handler** — following `playLogClearByStation` pattern; wire through `preload-handlers.js` and `preload.js`.

5. **Add `scheduledLog: handlers.scheduledLog` to `preload.js` contextBridge** — currently missing (same gap as playLog was before Cluster B).

6. **Migrate all nine write sites** — INSERTs → `create`, UPDATEs → `update`, DELETEs → `clearByHour`/`clearByDate`.

7. **CloudBackup.tsx scheduled_log restore path** — same as play_log (see `docs/phase-3.5-cloudbackup-restore-deferred.md`); needs a dedicated restore IPC. The column mismatch there is an additional problem on top of the restore-architecture issue.

Steps 1–2 are prerequisites; steps 3–7 are the Cluster C migration proper.

---

## After this commit

The Commit 2 `db:execute` lock will fire for any `scheduled_log` write under normal app use. Since `scheduleOneHour` currently never successfully writes a row (error swallowed in catch), there is no behavioral regression — the lock makes the existing silent failure visible in the console as `[db:execute LOCKED]`. The clearHour / clearDay DELETEs would also trigger the lock if called, but they operate on a table that has no rows, so the user-visible result is unchanged.
