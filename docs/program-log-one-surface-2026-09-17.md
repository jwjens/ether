# Program Log as the ONE log surface — proposal (2026-09-17)

**Proposal only. Nothing built.** Source: `docs/program-log-wiring-2026-09-17.md` (Part 1 = the
findings this builds on). Tree `C:\openair` HEAD `4a7261b` (4.6.45). Line numbers are that tree.

**Jeff's ruling:** keep the Program Log window and its view (mini month, TODAY'S SHOWS, hour rows,
CSV / Print / PDF Report / Fill Day / Clear Day). Repoint it from the dead `scheduled_log` to
`generated_schedule` — the log the engine airs and the Calendar reads. It becomes the one log surface;
the Calendar goes away; Program Log works docked and as a pop-out.

---

## 1. Repointing the read — every `scheduled_log` read in `ProgramLog.tsx`

### The shape to read
What the engine airs and the Calendar shows is `generated_schedule`: `station_id INTEGER`,
`scheduled_at INTEGER` (Unix epoch, `NOT NULL`), `state TEXT` (`pending | playing | played | missed`,
stamped by the daemon at `audiod/engine.js:1774-1781` and `:1342`), `played_at INTEGER`, `uuid`,
`title, artist, song_id, duration_s, category_id, source, content_class, channel, file_key, file_path`.
The Calendar reads it through **`schedule:get(fromTs, toTs, stationId)`** (`electron/main.js:10531-10556`):
`WHERE g.station_id = ? AND g.scheduled_at >= ? AND g.scheduled_at < ? AND g.deleted_at IS NULL …
ORDER BY g.scheduled_at`, returning `id, uuid, scheduled_at, song_id, title, artist, file_key,
file_path, duration_s, category_id, source, state, content_class, channel` (`:10548-10556`). The
log-reader's own predicate is `loggen.js:330-332` (same table, same station id, epoch window).

**Use the handler, not raw SQL.** `db:query` is unscoped by design (`main.js:5410-5417`); `schedule:get`
carries the station and the day window. One addition: `g.played_at` to its SELECT (`:10548`) — the only
column the Program Log needs that the Calendar didn't.

### The reads, one by one
| Today | Becomes |
|---|---|
| `:91-92` `SELECT DISTINCT log_date FROM scheduled_log` (mini-month dots) | `SELECT DISTINCT date(scheduled_at,'unixepoch','localtime') d FROM generated_schedule WHERE station_id = ? AND deleted_at IS NULL` bound `[stationId]` via `queryScoped(..., stationId, {skipScoping:true})` — the very query `BroadcastCalendar.tsx:204-207` runs, **with the `[stationId]` binding it forgot** (the filed "Too few parameter values" defect dies here). |
| `:110-112` `SELECT * FROM scheduled_log WHERE log_date=? ORDER BY hour, position` (the day) | `ether.invoke("schedule:get", dayStart, dayStart + 86_400, stationId)` where `dayStart = Math.floor(new Date(y, m-1, d).getTime()/1000)` from `selectedDate` (`:74`, `YYYY-MM-DD`) — **local midnight, the same construction `schedule:generateDay` uses** (`main.js:9552-9553 dayBase.setHours(0,0,0,0)`), so the window the panel shows is the window Generate fills. |
| `:100-102`, `:114-116` shows (unscoped) | see §2 |
| `:169-178` shows for the generator | goes with §3 (the local generator is deleted) |
| `:180-192` `clock_slots`, `:194` `scheduling_rules` (0 rows) | go with §3 |
| `:1225-1230` `UPDATE scheduled_log SET song_id=…` (swap song) | `schedule:editRowFields(uuid, {song_id, title, artist, duration_s, file_path, category_id})` (`main.js:9440`) after `schedule:checkRow` (`:9465`) — the Calendar's edit path |
| `:1244` `scheduledLog.batchUpdatePosition` (drag) | `schedule:moveRow(uuidA, uuidB)` (`main.js:9381`) — the Calendar's drag path |

### Timezone and day boundary
- Rows come back with epoch `scheduled_at`. The hour row = `new Date(scheduled_at*1000).getHours()` —
  **local wall-clock hour, never `(ts - dayStart)/3600`**: on the two DST days a local day has 23 or 25
  hours and integer division would put an hour in the wrong row. Position = index within the hour after
  `ORDER BY scheduled_at`.
- The day window `[dayStart, dayStart+86400)` is what `generateDay` writes (`:9553`); on DST days it is
  23/25 wall hours, and the panel simply shows what exists. `todayStr()` (`:62`) stays local.
- The current row: `state === 'playing'` (one per station, `engine.js:1774-1775`). No `ether:now-playing`
  DOM event needed (that event is main-window only, `BroadcastCalendar.tsx:469-474`).

### What the row display gains, and whether the row UI can show it
`ScheduledEntry` (`:11-21`) maps: `song_title ← title`, `song_artist ← artist`, `duration_ms ←
duration_s*1000`, `category_code ←` a `categories` map keyed by `category_id` (the Calendar builds one),
`status ← state`, plus new `uuid, scheduled_at, played_at, source, content_class`. The hour-row markup
already renders `entry.status` in the right-hand cell with a colour (`:1119-1121`: green for `played`)
— so `played / playing / pending / missed` show **with no new markup**; add two colours (`playing`
accent, `missed` red). The left `32px` cell (grid `"32px 48px 1fr 160px 56px 52px"`, `:1125`) that held
`position` becomes the **time**: scheduled `HH:MM:SS` (the Calendar's seconds column, `e322fef`), and
when `played_at` is set, the actual time underneath in mono — that is the as-run receipt the operator
reads. `hoursScheduled`/`totalDayMs` (`:735-736`) and the footer (`:1128-1135`) follow the new entries;
"⚠ N slots need more songs" (`status === "unfilled"`, `:450`, `:496`) has no equivalent in
`generated_schedule` — replace with `missed` counts (`SPOT DID NOT AIR`, `engine.js:1300-1318`).
CSV (`:407-420`) and Print/PDF (`:428-…`) read `hourBlocks` and follow automatically; the CSV gains
`scheduled_at`, `state`, `played_at` columns.

---

## 2. The station bug — TODAY'S SHOWS

`:100-102` and `:114-116` load `shows` with **no `station_id`**; the DB has one all-day show per station
(`shows`: 1 Open Format/st.1, 3 HalloVeen/st.2, 2 Christmas/st.3, 4 Summer Christmas/st.4, all
`start_hour 0 → end_hour 0`), so `find()` returns station 1's "Open Format" for every hour on every
station (`:118-125`). `stationId` is already in scope (`:85 useActiveStation()`).

**Correct read:** `SELECT s.*, c.name AS clock_name FROM shows s LEFT JOIN clocks c ON c.id = s.clock_id
WHERE s.station_id = ? AND s.deleted_at IS NULL ORDER BY s.start_hour` bound `[stationId]`, in both
places — or the typed `shows.list(stationId)` the ShowsTab uses (`scheduler/ShowsTab.tsx`). The
TODAY'S SHOWS list (`:853 shows.map`) then shows this station's show(s); the hour row header
(`block.show_name / clock_name`) follows. The summary "N hours · N of 24 hours scheduled"
(`:821`, `:934`) reads 0 only because the entries are empty — it is fixed by §1, not here. The Shows
modal (`:1466-1503`) also needs `station_id` on its `shows` query and on `shows.create` (`:1485`).

---

## 3. Generate / Fill Day / Clear Day

**Today** (`:166-358` `scheduleOneHour`): clears `scheduled_log` for the hour (`:208`), runs its own
picker over `songs` (`:231-239`) with its own separation (`:251, :270`), **stamps
`songs.last_played_at` in the future** (`:294`, `:350` — a synced column the real generator reads as its
rest fallback, `generate-core.js:173`), and inserts into `scheduled_log` (`:355`). `fillDay` (`:372-389`)
= that per hour. `clearHour/clearDay` (`:391/:397`) delete `scheduled_log`.

**Must become:** the Calendar's real path.
- `schedule:generateDay(dayTs)` (`main.js:9548-…`): station = `getActiveStationId()` (`:9551` — the
  handler takes NO station; it is the active one, which is also what the docked panel and the pop-out
  show), day = local midnight of `dayTs`, **`effStart = max(dayStart, next top-of-hour)` — never the
  past** (`:9555-9556`); it deletes the future rows and regenerates them through `generate-core.js`
  (`buildScheduleCtx`, `:9560`), emitting `schedule:generate-progress` (`:9233`) which
  `<GenerateProgressBar/>` already renders (`GenerateProgressBar.tsx:106`; the Calendar hosts it at
  `BroadcastCalendar.tsx:944`). **Fill Day maps onto it directly:** `generateDay(dayStartOf(selectedDate))`.
- **Week fill is possible with the same call:** `schedule:generateDays(tsList)` (`:9498`, used by the
  Calendar's week Generate at `:229` with seven `dayStart` values). Same station rule, same progress.
- **Per-hour Generate:** does not exist in the real path — `generateDay` regenerates from the next
  top-of-hour to the end of the day. Two honest options: (a) the hour button disappears and the day/week
  buttons remain; (b) a `fromTs` parameter on `generateDay` (`effStart = max(fromTs, next top-of-hour)`)
  so an hour row's button means "regenerate from this hour to end of day" — a small `main.js` change, and
  it can never touch aired rows. Past hours: never regenerable (correct — they aired).
- **Clear Day:** no handler clears a day today (`schedule:deleteRow(uuid)` is per row, `:9418`).
  Proposed `schedule:clearDay(dayTs)` = `generateDay`'s own delete step without the regenerate: delete
  `pending` rows `>= effStart` for the active station (played/playing/missed untouched, so the as-run
  record is never erased). Or drop Clear Day — Generate already replaces the future.
- The local picker, its rules query, and **both `last_played_at` stamps go**.

**Button naming — Jeff picks:** day: *Fill Day* (keep) · *Generate Day* · *Build Today's Log*; week:
*Fill Week* · *Generate 7 Days* · *Fill Through Sunday*; hour (if (b)): *Regenerate from :00* · *Refill
from here* · *Fill this hour →*; clear: *Clear Day* (keep, meaning "clear what hasn't aired") · *Clear
Rest of Day* · remove.

---

## 4. Deleting the Calendar — what goes, and what must move first

**Move to Program Log first** (each exists only in `BroadcastCalendar.tsx` today):
| Feature | Calendar receipt | Lands in Program Log as |
|---|---|---|
| drag reorder | `:404-408` → `schedule:moveRow` (`main.js:9381`) | the existing `draggable` rows (`:1310-1311`) call `moveRow(uuidFrom, uuidTo)` instead of `batchUpdatePosition` (`:1244`) |
| edit a row's fields | `:424-428` → `schedule:editRowFields` (`:9440`) | `swapSong` (`:1223-1230`) |
| delete a row | `:432-436` → `schedule:deleteRow` (`:9418`) | a row ✕ (new in this panel) |
| separation warning before an edit | `:394-398` → `schedule:checkRow` (`:9465`) | before swap/move |
| YOURS badge / `source` (operator vs auto) | `:410-414 setRowSource`, `:635` badge; help `docs/help-log-editing.md` ("where: Calendar → click a day", `:5`) | a badge on the row; help doc `where:` line updated |
| seconds in Time + Length column | `e322fef`, `:589` | §1's time cell |
| on-air highlight | `ether:now-playing` listener `:469-474` (main-window DOM event) | `state === 'playing'` from the row itself (works in the pop-out too) |
| week Generate | `:222-231` `generateDays` | Fill Week (§3) |
| progress bar host | `:944 <GenerateProgressBar/>` | same component mounted in Program Log |
| auto-days markers | `:200-209` (the `[]`-binding bug) | the mini-month dots (§1, fixed) |
| empty-state text | `:861` | the hour-row empty text (`:1148-1149`, reworded) |
| 30 s clock tick | `:456` | keep (the "now" line) |
Voice-track insert is **not** in the Calendar — it lives in `VoiceTracker.tsx:767` →
`schedule:insertVoiceTrack` (`main.js:8909`); nothing to move. `DataGrid` / `grid/csv`
(`BroadcastCalendar.tsx:13-14`) are shared — keep.

**Then delete:**
- `src/components/BroadcastCalendar.tsx` (1,201 lines).
- Doors: bottom tab CALENDAR (`App.tsx:2681`) — **relabel to PROGRAM LOG** rather than remove (§5);
  dock case (`:4355-4356`); workspace panel (`:3152`); hamburger entry (`:2917`); PopoutRenderer map
  and case (`PopoutRenderer.tsx:79`, `:283`); `ether:open-calendar` listener (`App.tsx:1267-1273`) and
  its senders → re-target to the Program Log; `setPanel("calendar")` (`:2298`, the "go build it" jump);
  `HealthDashboard.tsx:214 openPanel("calendar")` (the Runway card) → Program Log; the `Panel` /
  `progPanel` union members (`App.tsx:139`, `:780`, `:3854`).
- Help: `docs/help-log-editing.md` (`where:` → Program Log), and the Calendar mentions in
  `help-windows.md`, `help-imaging.md`, `help-spots.md`, `help-sweepers.md`, `help-traffic.md`,
  `help-announcement-schedule.md`, `help-deleting-songs.md`, `help-health-monitor.md`,
  `help-multi-machine-sync.md` (grep receipt) → "Program Log".
- **IPC handlers: none deleted.** `schedule:get / generateDay / generateDays / moveRow / editRowFields
  / deleteRow / checkRow / setRowSource / insertVoiceTrack` all stay — Program Log is their new caller.
- `src/lib/scheduleData.ts`, `scheduleDiff.ts` are NOT the Calendar's (imported by Announcements,
  ScheduleWorkspace, ScheduleManager, useScheduleHub) — keep.

---

## 5. Docked panel + pop-out window

**Does the app open a second OS window today? Yes.** `openPopoutWindow(panel)` (`electron/main.js:6494-6600`)
creates a `new BrowserWindow` (`:6536`) per panel, deduped by title tag `popout:<panel>` (`:6495-6497`),
sized from `POPOUT_SIZES` (`:6500`; **`programlog` is already in the list**), bounds remembered in
`popout-bounds.json` and validated on-screen (`:6501-6504 boundsOnScreen`), loaded as
`#popout/<panel>` (`:6566-6567`), with the same preload (`:6546`). `PopoutRenderer.tsx:306-307` already
mounts **`<ProgramLog onClose={() => window.close()} />`**, and the hamburger's "Program Log" opens it as
a window (`App.tsx:2908-2916`). The Health Monitor's WALL VIEW (`HealthMonitor.tsx:1212`) is an
in-window layout toggle, not a window; its real pop-out is Tools → Monitors → Station Health
(`main.js:2915 popout("health")`). **Pop-out is not new work; the pattern to reuse is
`openPopoutWindow` + `PopoutRenderer`.**

What IS work:
- **Docked:** add `"programlog"` to the dock union (`App.tsx:780`, `:3854`), make the CALENDAR tab
  (`:2681`) open it (label PROGRAM LOG), render `<ProgramLog embedded/>` in the dock switch (`:4355`)
  in place of `<BroadcastCalendar/>`. The workspace route `schedulebuilder` (`:3090`), which replaces the
  dashboard, can go — the ruling is dock or window, never over the dashboard.
- **Live updates in the pop-out:** the pop-out is its own React tree; `main.tsx` mounts
  `<AudioEngineProvider>` over every window (`PopoutRenderer.tsx:201`), so engine state is available,
  but DB changes are not pushed anywhere today (the Calendar re-reads on edit and ticks 30 s, `:456`).
  Proposed: the `schedule:*` write handlers (`main.js:9381-9465`, `:9498`, `:9548`, `:8909`) and the
  daemon's state stamps (via the existing `logreader-*` / `playstart` events main already receives)
  call `sendToAllWindows("schedule:changed", { stationId, dayTs })`; both the docked and the pop-out
  Program Log subscribe and re-run `schedule:get` for their day. The 1 s "now" line is the existing
  tick (`:456`, tightened to 1 s only for the current hour's row).
- **State preservation:** `selectedDate` / `currentMonth` are component state (`:74`); pop-out and dock
  are separate trees, so they don't share — a `localStorage` key `ether_programlog_date_<stationId>`
  seeds both (the Calendar does nothing here). Station follows the active station in both
  (`useActiveStation`, `PopoutRenderer.tsx:105/120`).
- **Closing:** pop-out `onClose={window.close}` (exists); dock close = `setProgPanel(null)` (exists).
- **Both open at once:** allowed — two readers of the same table; `schedule:changed` keeps them equal;
  `openPopoutWindow` refuses a second pop-out of the same panel (`:6496-6497`).
- **Menu:** Schedule → Program Log (`main.js:2874`) keeps opening the window; a docked "Program Log"
  entry is the bottom tab.

---

## 6. The other `scheduled_log` readers, and dropping the table

| Reader | Recommendation |
|---|---|
| Schedule Preview (`SchedulePreview.tsx:9, :97, :171, :180`; panel `schedpreview`, 397 lines, also reads `pinned_songs` = 0 rows) | **Delete.** Its purpose — the next N hours of the log — is the Program Log's hour rows from "now". |
| Voice Tracker's prev/next context (`VoiceTracker.tsx:483-486`, station-scoped `scheduled_log` by hour) | **Repoint** to `schedule:get(hourStart, hourStart+3600, stationId)` — the rows the voice track will be inserted between (`schedule:insertVoiceTrack` already targets `generated_schedule`, `main.js:8909`). |
| Listener Analytics "scheduled vs played" (`ListenerAnalytics.tsx:8, :238-242`) | **Repoint** the scheduled side to `generated_schedule` counts by `state` (`played` vs `missed` vs `pending`) for the range — or delete that one panel; the play side (`play_log`) is right. |
| Cloud Backup restore into `scheduled_log` (`CloudBackup.tsx:264-334`) | **Delete** that section — it restores a table nothing reads; `generated_schedule` is regenerated per machine by design and is not restored. |

**Can `scheduled_log` and its writers be dropped?** The code, yes, once the four above are done:
`electron/sync/handlers/scheduled_log.js`, the `scheduledLog` preload namespace (`preload.js:438-…`,
`preload-handlers.js:242`), its `synced-tables.js` registry entry, the `main.js:2125` table list, the
`ipc-contract`/`preload-bridge` smoke expectations. The **table** should not be dropped in the same
slice: migrations are append-only and gated (`verify-transformer-chain`, the pre-commit hook), and a
machine mid-update must open any prior DB — leave the DDL, drop it in a later migration (v61) once no
build references it. It holds 0 rows on every install ever measured, so nothing is lost either way.

---

## 7. Slice order — smallest first; Jeff sees real songs before anything is deleted

| # | Slice | Files | Jeff verifies on screen |
|---|---|---|---|
| 1 | **Repoint the reads** (§1 day rows via `schedule:get` + `played_at`; mini-month dots; §2 station filter on shows). No writes touched. | `ProgramLog.tsx:91-125, :735-736, :853`; `main.js:10548` (+`played_at`) | Open Program Log on halloVeen → Thu 09-17 hour rows show today's real songs; "HalloVeen" (not "Open Format") on the hour headers and in TODAY'S SHOWS; summary reads "24 of 24 hours"; mini-month dots on the generated days. |
| 2 | **State + time in the rows** (played/playing/pending/missed colours; scheduled `HH:MM:SS`; actual `played_at`; missed count in the footer). CSV/Print/PDF gain the columns. | `ProgramLog.tsx:1100-1135, :407-420, :428+` | The row on air is highlighted; past rows green with the real air time; a red missed spot; export shows the same. |
| 3 | **Generate → the real path**: Fill Day → `generateDay`, Fill Week → `generateDays`, progress bar, Clear Day → `clearDay` (new) or removed; delete the local picker and the `last_played_at` stamps. | `ProgramLog.tsx:166-397`, `main.js` (+`clearDay`, optional `fromTs`) | Fill Day on a future day → rows appear in Program Log AND the engine airs them (daemon log `logreader refill`); Fill Day on today leaves aired hours alone; `SELECT count(*) FROM songs WHERE last_played_at > now` stays 0. |
| 4 | **Move the Calendar's editing** (drag → `moveRow`, swap → `checkRow`+`editRowFields`, delete row, YOURS/source badge, help `where:`). | `ProgramLog.tsx:1223-1250, :1310+`; `docs/help-log-editing.md` | Drag a pending row up → the Up Next order changes on the dashboard; swap a song → the engine plays the swap; a hand-placed row wears YOURS and survives a Fill. |
| 5 | **Dock + pop-out**: CALENDAR tab → PROGRAM LOG docked; pop-out via the existing window; `schedule:changed` broadcast; shared selected day. | `App.tsx:780, :2681, :3854, :4355`; `main.js` handlers (+broadcast); `PopoutRenderer.tsx:306` | Press the tab → Program Log in the dock, dashboard still visible; hamburger → it opens in its own window; edit in one, the other updates within a second; both close cleanly. |
| 6 | **Delete the Calendar** (§4 list), including `BroadcastCalendar.tsx:204-207` by deletion. | §4 | No CALENDAR anywhere; every former door (Runway card, "go build it" jump, help) lands on Program Log. |
| 7 | **The other dead readers** (§6) and the `scheduled_log` code removal; table drop deferred to a later migration. | `SchedulePreview.tsx` (delete), `VoiceTracker.tsx:483`, `ListenerAnalytics.tsx:238`, `CloudBackup.tsx:264-334`, `sync/handlers/scheduled_log.js`, preload | Voice Tracker shows the real neighbours for the hour; Listener Analytics' scheduled numbers are non-zero; no `scheduledLog.*` on the bridge; smokes green. |

Slices 1–2 change nothing that writes; 3 is the first write change and it routes through the path the
Calendar has used since 4.4.x; nothing is deleted until 6.

Proposal only. Stop.


---

## Slice 1 — built (2026-09-18, reads only; local commit on `log-reader-flip`)

No push, no tag, no version bump, no install. Neither live DB opened. **No write changed**: Generate /
Fill Day / Clear Day (`ProgramLog.tsx:209, :356, :392`) and the hour modal's swap / drag (`:1232`,
`:1249`) still target `scheduled_log` exactly as before — slices 3/4. Line numbers are post-change.

### What changed
**1. The day rows come from `generated_schedule` via `schedule:get`** — `ProgramLog.tsx:116-146
loadDayData`: `dayWindow(selectedDate)` (`src/lib/programLogRows.ts:46-52`) builds `[local midnight,
+86 400)` the way `schedule:generateDay` does (`main.js: dayBase.setHours(0,0,0,0); dayEnd = dayStart +
86_400`), then `ether.invoke("schedule:get", dayStart, dayEnd, stationId)` (`:123`). Rows map to the
markup's entry shape in `toEntries` (`programLogRows.ts:82-112`): `song_title ← title`, `song_artist ←
artist`, `duration_ms ← duration_s×1000`, `status ← state`, `category_code/color` from this station's
`categories` (`:127-130`, `queryScoped`), `slot_type` from `content_class` (song_id fallback, the
Calendar's rule), plus `uuid, scheduled_at, played_at, source, content_class`. **Hour = `getHours()` of
the row** (`programLogRows.ts:55-57`), position = order within the hour. The old `ScheduledEntry`
interface is now `ProgramLogEntry` (`:20`) with every legacy field kept, so CSV / Print / PDF and the
modals compile unchanged. On a handler error the panel logs and shows empty (`:142-145`); a station with
no log for the day gets `data: []` → its show hours render with no rows.
- `electron/main.js:10550`: `schedule:get` now selects `g.played_at` (v33 column, engine-stamped).
- `todayStr()` (`:62`) is now the LOCAL date (`localDateStr`, `programLogRows.ts:39-41`). The old
  `toISOString().slice(0,10)` was the UTC date — after 17:00 Pacific the panel opened on tomorrow. The
  wiring doc's "local calendar date" was wrong on this point; the day window is local midnight, so the
  two had to agree. (`makeDate` for the mini-month already built local strings.)

**2. Mini-month dots** — `:97-106 loadScheduledDates`: `SELECT DISTINCT date(scheduled_at,'unixepoch',
'localtime') d FROM generated_schedule WHERE station_id = ? AND deleted_at IS NULL` bound `[stationId]`
via `queryScoped(…, stationId, { skipScoping: true })`. **Confirmed fixed here:** the binding is
present; `scripts/smoke-programlog-reads.js` runs this exact string with `[2]` (passes) and with `[]`
(throws `Too few parameter values` — the filed error, reproduced on purpose). The `source = 'auto'`
filter of the Calendar's copy is dropped: a dot means "this station has a log that day". **The
Calendar's own copy (`BroadcastCalendar.tsx:204-207`) is NOT touched** — it still binds `[]` and dies
in slice 6 by deletion (one line, `[]` → `[stationId]`, if Jeff wants it before then).

**3. Station scoping on shows** — `SHOWS_SQL` (`:65-66`, `WHERE s.station_id = ? AND s.deleted_at IS
NULL`) used by `loadShows` (`:108-114`) and `loadDayData` (`:133`); the generator's lookup (`:170`,
`WHERE station_id = ? AND is_active = 1 …`); the Shows modal (`:1472`). `shows.create` already passed
`station_id: stationId` (`:1497`) — unchanged. All three loaders re-run on a station switch
(`useCallback([stationId])`, `:151`).

**4. State + time in the rows** — status cell (`:1124`): `played` green (as before), **`playing`
accent + bold, `missed` red** (alongside the legacy `unfilled` red). The first cell (`:1100-1104`,
header `Time` at `:1083`) shows scheduled `HH:MM:SS` (accent while playing) and, when `played_at` is
set, the actual air time underneath in green. The three grids widen the first column `32px → 64px`
(`:1079, :1094, :1133`); no other markup added.

**5. Summary from real rows** — `totalDayMs` / `scheduledHours` (`:736-737`), the sidebar "N hours",
the header "N of M hours scheduled", the per-show `n/24h` and the hour headers' "N tracks · m:ss" all
derive from `hourBlocks`, which now hold the airing rows. Nothing else was needed.

### Deliberately NOT built (named so it is not mistaken for forgotten)
- CSV / Print / PDF columns for `scheduled_at / state / played_at`; the `missed` count in the footer and
  hour header (the footer still says "✓ Complete" — `unfilled` is always 0 now) — slice 2.
- Generate / Fill Day / Clear Day / hour-Generate → the real path — slice 3. They still write
  `scheduled_log` and stamp `songs.last_played_at`; **the "Click Generate…" empty-hour text is still a
  lie** until then.
- The hour modal's swap and drag: `UPDATE scheduled_log … WHERE id=?` and `batchUpdatePosition` now
  receive `generated_schedule` ids, hit 0 rows on the empty table, and the modal still repaints as if
  saved — a false success that pre-dates this slice (it wrote to the dead table before too). Slice 4
  routes them through `schedule:checkRow / editRowFields / moveRow`.
- `BroadcastCalendar.tsx:204-207` (the `[]` binding) — slice 6.

### Tests
`src/lib/programLogRows.test.ts` (vitest, `process.env.TZ = "America/Los_Angeles"` so the DST cases
run in a zone that has DST whatever the box is set to):
```
✓ dayWindow — is [local midnight, +86400) on an ordinary day
✓ dayWindow — is NOT the UTC date: localDateStr of a late-evening Pacific instant names the local day
✓ DST — spring forward (2026-03-08, 23 local hours): 03:00 files under 3, not under the missing 2
✓ DST — fall back (2026-11-01, 25 local hours): both 01:30s file under hour 1; 23:00 is hour 23, not 24
✓ toEntries — maps title/artist/duration/state/played_at and the category badge; positions restart per hour
✓ toEntries — an empty day is an empty list, not an error; show hours still render
✓ toEntries — hoursToRender = show hours ∪ row hours; overnight shows wrap
✓ toEntries — slotTypeOf: content_class is authoritative; song_id is the fallback
✓ toEntries — fmtClock is HH:MM:SS local; blank for null
Tests  9 passed (9)
```
One finding from the DST test, recorded not changed: the generator's window is a flat 86 400 s, so on
the fall-back day it ends at **22:59:59 PST** — the local 23:00 hour belongs to the next day's window —
and on the spring-forward day it runs to **00:59:59 of the next day**. The panel shows the window the
generator fills, by design (§1 "the panel simply shows what exists"); the hour it files each row under
is always the row's own wall-clock hour.

`scripts/smoke-programlog-reads.js` (`npm run test:programlog-reads`; in-memory SQLite under
`ELECTRON_RUN_AS_NODE=1 electron`; reads the `schedule:get` SELECT **out of `electron/main.js`** so it
tests the shipped string), verbatim:
```
PASS  mini-month query runs with its [stationId] binding
PASS  dots = the station's days (deleted row and other station excluded)
PASS  the same query WITHOUT the binding is the filed bug: 'Too few parameter values'
PASS  a station with no log → no dots, no error
PASS  schedule:get SELECT located in electron/main.js
PASS  schedule:get selects g.played_at
PASS  today for station 2 = the two live rows in the window (deleted + tomorrow + other station excluded)
PASS  played_at comes back on the played row and null on the pending one
PASS  every column the Program Log maps is present
PASS  a station with no log for the day → [] (no error)
PASS  the window is half-open: a row at dayEnd + 10 s is tomorrow's
=== 11 passed, 0 failed ===
```

### Gates
`npx tsc --noEmit` → exit 0 (zero errors). `npx vitest run` → **31 files, 415 passed**.
`node --check electron/main.js` ok. `test:ipc-contract`, `test:preload-bridge`, `test:undefined-calls`
→ PASS. `node watchdog/test/run-tests.js` → 32 passed, 0 failed. audiod smokes (exit 0 each): autofit
47 · autopost-arm 21 · cmd-routing 7 · deck-identity 22 · deck-position 16 · deck-snapshot 25 ·
enginestate-wire 15 · enginestate 19 · logreader-anchor 18 · manual-mode 30 · meter-contract 15 ·
orphan 4 · queue-classes 8 · seam-stop 60 · xfade-contract 33 · dead-air 50.

### Runtime receipt owed (not done — no install, no launch)
Open Program Log on halloVeen → today's hour rows show the real songs; "HalloVeen" (not "Open Format")
on the hour headers and in TODAY'S SHOWS; the summary reads "24 of 24 hours"; the row on air is accent +
bold with its scheduled time; aired rows show the green actual time; mini-month dots on the generated
days; switching station re-reads. Jeff confirms on screen.


---

## Slice 2 — built (2026-09-18, writes; local commit on `log-reader-flip`)

No push, no tag, no version bump, no install. Neither live DB opened. Jeff confirmed slice 1 on screen
before this was started. Line numbers are post-change.

### What changed
**1. Fill Day → `schedule:generateDay(dayStart)`** — `ProgramLog.tsx:191-212 fillDay`: `dayWindow(selectedDate)`
(the same local-midnight window slice 1 reads) → `ether.invoke("schedule:generateDay", dayStart)`
(`:199`). Station = the active one (the handler takes no station, `main.js:9589`), exactly as the
Calendar. The result is reported by name (`✓ N rows generated` / `↷ Nothing to fill — the day has
aired` / `↷ Generate cancelled` / `✗ <error>`), then the day and the mini-month re-read.
**The local picker is deleted** (`scheduleOneHour`, its `scheduling_rules` read, its `clock_slots` walk,
its `songs` candidate query with its own separation) **and with it BOTH future `last_played_at` stamps**
(the per-pick `songs.updateById(picked.id, { last_played_at: hourStartTs + slot.position })` and the
overflow `+3600` one). `scheduledLog.clearByHour / clearByDate / batchInsert` are no longer called from
this file. The `Rules` interface went with them.
**Grep receipt** (`smoke-programlog-writes.js` (g), verbatim below): the only `last_played_at` mentions
left in `ProgramLog.tsx` are the HourModal's song-search `SELECT … s.last_played_at` (`:1052`) and the
`Song` type (`:41`) — reads. No `UPDATE`/`updateById`/`markPlayed`/`execute(` line touches it.

**2. Per-hour Generate: KEPT, with `fromTs`** (proposal §3 option b). Decision: the ruling keeps the
window's view, and the hour row's button is part of it; option (b) is one guard in one handler and
makes the button mean exactly what it says.
- `main.js:9586 schedule:generateDay(dayTs, fromTs?)`: `fromTs` is snapped DOWN to its local hour start
  (`f.setMinutes(0,0,0)`, `:9596-9597`) so the delete window in `_commitDayRows` and the hour walk in
  `generateDayRows` (`generate-core.js:223 if (hourStartTs < minTs) continue`) agree on one boundary;
  refused by name if outside the day (`:9598`) or **if that hour has already started** (`:9599`:
  `fromHour < nextTop` → `"that hour has already started — it is a record now, not a plan; regenerate
  from the next hour"`) — it is never silently moved forward. `effStart = Math.max(dayStart, nextTop,
  fromHour)` (`:9601`): `fromTs` can only NARROW the window. Callers without `fromTs` (the Calendar,
  `BroadcastCalendar.tsx:445`) are byte-for-byte unchanged (`fromHour = 0`).
- `ProgramLog.tsx:169-189 generateHour`: `hourStartTs(selectedDate, hour)` (`:161-164`, `new Date(y,
  m-1, d, hour)` — local, DST-safe, never `h*3600`) → `invoke("schedule:generateDay", dayStart,
  hourStart)` (`:178`); status `✓ N rows from 3 PM to end of day`. `hourLocked` (`:166-167`, the same
  `next top-of-hour` rule as main) disables the button on an hour that has started — it reads **aired**,
  opacity 0.35, tooltip says why (`:872-882`); an open hour's button is **▶ Generate →** / **⟳ Regen →**
  with the tooltip "Regenerate from 3 PM to the end of the day (earlier hours untouched)". The
  empty-hour text (`:990-994`) now says what the button does instead of "Click Generate to fill this
  hour". The `generating` per-row state is kept (it is the button's own spinner).

**3. Clear Day → new `schedule:clearDay(dayTs, { fromTs?, toTs? })`** — `main.js:9372-9390`.
Window `[max(dayStart, next top-of-hour, fromTs), min(dayEnd, toTs))` for the active station; rows go the
way the log editor deletes them — **soft**, `deleted_at = now` (`:9384`, the same UPDATE shape as
`schedule:deleteRow :9418`), so `schedule:get` and the log-reader stop seeing them at once and the next
Generate's gap-fill (`_commitDayRows`, `deleted_at IS NULL`) treats the slot as free. **Only
`state = 'pending'` rows are touched.** What it does with the rest, and why:
- **played / playing — never touched.** The log is a record of what happened, not a plan
  (`_guardEditable`, `_EDIT_LOCKED = {played, playing}`, `:9365`).
- **missed — never touched.** "SPOT DID NOT AIR" is evidence; clearing it would erase the only trace
  that a spot was scheduled and did not run.
- **the current hour — never touched** (`from ≥ next top-of-hour`): the same guard Generate has, so the
  rows the reader is airing from right now are never pulled from under it, and Clear + Fill act on the
  same window. A window entirely in the past returns `skipped` with the reason.
- **operator rows — cleared.** Unlike Generate (which must not silently destroy a jock's placement),
  Clear Day is the operator's own explicit act on the whole day. Stated, not hidden.
- A `log-edit` health event `{ action:'clear-day', stationId, from, to, cleared }` is written (`:9386`).
`ProgramLog.tsx:214-236`: `clearRange(fromTs?, toTs?)` → `invoke("schedule:clearDay", dayStart, { fromTs,
toTs })` (`:217`); **Clear Day** = the whole day (`:231`), the hour row's **✕** = that hour (`:224`,
hidden on an aired hour, `:901`). The Clear Day button's tooltip says what it does (`:746`).
`scheduledLog.clearByHour / clearByDate` are gone from this file.

**4. Naming.** Fill Day stays **Fill Day**. Hour button: **▶ Generate →** / **⟳ Regen →** (the arrow is
the "to end of day"). Clear Day stays **Clear Day** (meaning "clear what hasn't aired", per its
tooltip). **Fill Week — not built.** It would be one call: `ether.invoke("schedule:generateDays",
[dayStart, dayStart+86400·1 … ·6])` (`main.js:9498`, what the Calendar's week Generate already sends at
`BroadcastCalendar.tsx:222-231`), same station rule, same progress bar, cancel at every hour boundary,
each day committed atomically; the seven `dayStart`s should be built with `dayWindow()` per date
(local midnight each), not `+86400` arithmetic, so a DST week stays aligned.

**5. Nothing else changes.** The hour modal's **swap** (`:1071 UPDATE scheduled_log SET song_id=… WHERE
id=?`) and **drag** (`:1088 scheduledLog.batchUpdatePosition`) still write `scheduled_log`. **They are
now inconsistent with what the panel reads**: the ids they receive are `generated_schedule` ids, the
UPDATE hits 0 rows on the empty table, and the modal repaints as if saved. Slice 4 routes them through
`schedule:checkRow / editRowFields / moveRow`. Said in the file header (`:17-20`) and in the help.

### Guardrail: the generate path still refuses the past — from this window too
- `main.js:9594 nextTop = Math.ceil(nowTs / 3600) * 3600`; `:9601 effStart = Math.max(dayStart,
  nextTop, fromHour)`; `:9602 if (effStart >= dayEnd) return { ok:true, count:0, skipped:true }`.
- `_commitDayRows` deletes only `scheduled_at >= effStart` (`:9307-9330`); `generateDayRows` skips
  hours with `hourStartTs < minTs` (`generate-core.js:223`).
- The Program Log passes only `dayStart` (Fill Day) or `dayStart + hourStart` (hour button); it cannot
  lower `effStart`. Smoke receipts: (a) "no row before the next top-of-hour (11:00)"; (b) played /
  playing / missed / current-hour rows untouched by Fill Day; (c) `fromTs` in an aired or current hour
  → refused by name; (f) an aired day → `skipped`.

### Progress bar
`<GenerateProgressBar/>` is mounted once at App top-level (`App.tsx:3298`) and listens to
`schedule:generate-progress`, so a Fill Day from the docked/main-window Program Log shows the bar the
Calendar shows. The **pop-out** Program Log is its own React tree without `<App/>`, so it has no bar —
the status line in the panel header is its only progress until slice 5's live-update work.

### Help
`docs/help-program-log.md` (new — the panel had no entry): reading the day, Fill Day, Generate → on an
hour, Clear Day / the hour ✕, export, and a plain "what is not wired yet" paragraph naming the swap and
drag. Pointer comment at `ProgramLog.tsx:3`.

### Tests
`scripts/smoke-programlog-writes.js` (`npm run test:programlog-writes`; `ELECTRON_RUN_AS_NODE=1
electron`). A fresh in-memory schema = `schema-v0-baseline` + all 60 migrations + the 63 `alterSafe`
ALTERs main.js applies at startup (read out of main.js). The handlers under test are **read out of
`electron/main.js`** (brace-matched source, not copies): `schedule:generateDay`, `schedule:clearDay`,
`schedule:get`, `_commitDayRows`, `_generateDayChunked`, evaluated with the real `generate-core.js`,
`log-edit-core.js` and `sync/handlers/generated_schedule.js` underneath; stubbed: `_genEmit`,
`_placeJingles`, `finishGenerateRun`, `retireStaleScheduleRows` (observation tails), `_healthEvent`
(captured), `getActiveStationId → 1`, and `Date` pinned to 10:30 local on the test day (tomorrow).
Verbatim:
```
PASS  fresh schema built: baseline + 60 migrations + 63 startup ALTERs
PASS  main.js: generateDay handler takes fromTs
PASS  main.js: clearDay handler exists and only touches state = 'pending'
PASS  main.js: clearDay is a SOFT delete (deleted_at), the editor's own delete
PASS  main.js: generateDay still refuses the past — effStart = max(dayStart, nextTop, fromHour)
PASS  handlers registered: generateDay, clearDay, get
PASS  a · the day is empty before Fill Day
PASS  a · generateDay ok
PASS  a · schedule:get returns the generated rows (156)
PASS  a · no row before the next top-of-hour (11:00) — the past and the current hour are never generated
PASS  a · rows span the rest of the day (13 hours: 11 → 23)
PASS  a · every row is pending with no played_at
PASS  a · nothing written to songs.last_played_at by the generate path
PASS  b · generateDay ok
PASS  b · played rows untouched (state, played_at, not deleted)
PASS  b · the missed spot untouched
PASS  b · the playing row untouched
PASS  b · the current hour's pending row untouched (10:40 < next top-of-hour)
PASS  b · the operator's future row survives Generate (log-edit-core NOT_OPERATOR_OWNED_SQL)
PASS  b · the machine's future row was replaced
PASS  b · the other station's row untouched
PASS  b · generated rows again start at 11:00; the day now has aired + generated rows
PASS  c · generateDay(fromTs=15:00) ok
PASS  c · rows before 15:00 byte-identical (uuids unchanged)
PASS  c · rows from 15:00 on were regenerated (9 hours: 15 → 23)
PASS  c · fromTs in an aired hour is REFUSED by name, not moved forward
PASS  c · fromTs in the CURRENT hour is refused too (it has started)
PASS  c · fromTs outside the day is refused
PASS  d · clearDay ok
PASS  d · schedule:get shows nothing from 11:00 on
PASS  d · the rows are SOFT-deleted (still in the table, deleted_at set)
PASS  d · played / playing / missed untouched
PASS  d · the current hour's pending row untouched
PASS  d · the operator's pending row IS cleared (Clear Day is the operator's own explicit act)
PASS  d · the other station untouched
PASS  d · a log-edit health event named the clear
PASS  d · clearing again clears 0 (idempotent)
PASS  e · hour clear removes exactly that hour's pending rows
PASS  e · the other hours keep their rows
PASS  e · clearing the CURRENT hour is skipped by name (it has started)
PASS  e · a Generate after the hour clear refills the gap
PASS  f · generateDay on an aired day → skipped, nothing written
PASS  f · clearDay on an aired day → skipped, 0 cleared
PASS  g · ProgramLog.tsx: no line writes songs.last_played_at
PASS  g · the remaining last_played_at mentions are the HourModal's song-search SELECT + its type (reads)
PASS  g · no scheduledLog.clearByHour / clearByDate / batchInsert call remains
PASS  g · no scheduling_rules / clock_slots picker query remains in ProgramLog.tsx
PASS  g · Fill Day and the hour button invoke schedule:generateDay; Clear invokes schedule:clearDay
PASS  g · the hour modal's swap and drag still write scheduled_log (slice 4, stated in the doc)
=== 49 passed, 0 failed ===
```
Two seed facts the smoke had to learn, recorded because they are true of the product too:
`generated_schedule.file_path` (and other columns) come from main.js's startup `alterSafe` list, not
the migration chain — a fresh DB is baseline + chain + those ALTERs; and a song with `daypart_mask 0`
is never a candidate — main.js backfills `16777215` at startup, which the seed mirrors.

### Gates
`npx tsc --noEmit` → exit 0. `npx vitest run` → **31 files, 415 passed**. `node --check electron/main.js`
ok. `test:ipc-contract`, `test:preload-bridge`, `test:undefined-calls` → PASS. `test:programlog-reads`
→ 11 passed. `node watchdog/test/run-tests.js` → 32 passed, 0 failed. audiod smokes (exit 0 each):
autofit 47 · autopost-arm 21 · cmd-routing 7 · deck-identity 22 · deck-position 16 · deck-snapshot 25
· enginestate-wire 15 · enginestate 19 · logreader-anchor 18 · manual-mode 30 · meter-contract 15 ·
orphan 4 · queue-classes 8 · seam-stop 60 · xfade-contract 33 · dead-air 50.

### Runtime receipt owed (not done — no install; the dev shell is running slice 1's build until relaunched)
On halloVeen: Fill Day on **tomorrow** → rows appear in the Program Log AND the daemon log shows
`logreader refill … from log` for them when their hour comes; Fill Day on **today** leaves the aired
hours alone (the green actual times stay) and rebuilds from the next hour; an hour's **Generate →**
rebuilds from that hour on and the earlier hours are unchanged; **Clear Day** empties from the next hour
on and the on-air row keeps playing; the progress bar appears for the docked panel;
`SELECT count(*) FROM songs WHERE last_played_at > strftime('%s','now')` on a DB **copy** stays 0.
Jeff confirms on screen.
