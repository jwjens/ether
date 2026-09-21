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

---

## Slice 2a — built (2026-09-19; local commit on `log-reader-flip`)

**Jeff's ruling: Fill Day is the only fill.** No push, no tag, no bump, no install, no live DB.

### What changed
- **The per-hour ▶ Generate → / ⟳ Regen → button is gone** from the hour rows (`ProgramLog.tsx`), with
  `generateHour`, the `HourBlock.generating` spinner state and the `locked` disabling on the button.
  The Shows & Dayparts modal's `onDone` no longer triggers a generate — it reloads the shows and the day.
  The empty-hour text now reads `Fill Day fills this hour with <clock>` / `No clock for this hour —
  assign one under ⚙ Shows & Dayparts, then Fill Day` (`:942-947`).
- **The per-hour ✕ clear is KEPT** — it was already `schedule:clearDay` windowed to the hour
  (`clearHour`, `:203-208`), no extra code. One line of the `hourLocked` helper survives for it
  (`:167-168`): an hour that has started has nothing to clear (the handler would return `skipped`), so
  the ✕ is not offered there (`:854`) and the empty-hour text says "it has aired".
- **Clear Day kept**, unchanged.
- **`schedule:generateDay(dayTs, fromTs?)` is NOT touched** (`main.js:9586`) — the parameter stays for
  the handler's callers and tests; this window simply never sends it. Receipt: smoke (g) asserts
  `invoke("schedule:generateDay"` occurs exactly once in `ProgramLog.tsx`, as `(…, dayStart)`, and that
  `generateHour` / `Regen` / `Generate →` / `generating:` are absent.
- Help `docs/help-program-log.md`: the "Generate → on one hour" section is replaced by "Fill Day is the
  only fill — to rebuild part of a day, ✕ the hours and press Fill Day; it fills the gaps".

### Tests / gates
`smoke-programlog-writes.js` → **50 passed, 0 failed** (section (c) still exercises the handler's
`fromTs`; the (g) grep contract is the slice-2a one above). `npx tsc --noEmit` exit 0. `npx vitest run`
→ 31 files, 415 passed. `node --check electron/main.js` ok. `test:ipc-contract` / `test:preload-bridge`
/ `test:undefined-calls` → PASS. `test:programlog-reads` → 11 passed. watchdog → 32 passed. audiod
smokes (exit 0 each): autofit 47 · autopost-arm 21 · cmd-routing 7 · deck-identity 22 · deck-position
16 · deck-snapshot 25 · enginestate-wire 15 · enginestate 19 · logreader-anchor 18 · manual-mode 30 ·
meter-contract 15 · orphan 4 · queue-classes 8 · seam-stop 60 · xfade-contract 33 · dead-air 50.

### Runtime receipt owed
Hour rows show ✎ Edit and ✕ only (no Generate/Regen); ✕ absent on aired hours; Fill Day still fills
from the next hour. Jeff confirms on screen after the relaunch.

---

## Slice 3 — built (2026-09-20, dock + pop-out; local commit on `log-reader-flip`)

No push, no tag, no bump, no install, no live DB. Jeff confirmed slices 1–2a on screen first.
Existing mechanisms only — no new window path, no new dock. The Calendar is untouched. Line
numbers are post-change.

### 1. Pop-out — the existing path, confirmed, one door fixed
- Path: `openPopoutWindow(panel)` (`electron/main.js:6494-6600`) → `POPOUT_SIZES.programlog`
  `{1180×820}` (`:6364`) → `new BrowserWindow` titled `popout:programlog`, deduped by title
  (`:6496-6497`), bounds remembered in `popout-bounds.json` on `moved`/`resized` and restored when
  still on a display (`loadPopoutBounds / savePopoutBounds / boundsOnScreen`, `:6427-6448`) → loads
  `#popout/programlog` → `PopoutRenderer.tsx:306 case "programlog": <ProgramLog onClose={window.close}>`.
- **Hamburger → Program Log**: `App.tsx:2916 { label: "Program Log", panel: "programlog" }` →
  `openPopout("programlog")` → `window:popout`. Already correct.
- **Schedule → Program Log — was broken, fixed.** `main.js:2874 menuNav("nav:programlog","programlog")`
  only opened the pop-out when invoked FROM a pop-out; from the main window it sent `nav:programlog`,
  and `App.tsx` answered by opening the **Schedule Manager** and focusing its "log" pane — a different
  document under the menu entry's name. Now `App.tsx:1215 if (cmd === "nav:programlog") {
  openPopout("programlog"); return; }` — the same window the hamburger opens. (The
  `ether:focus-schedule-pane` listener in ScheduleWorkspace is left in place; nothing else was removed.)
- Receipts: `scripts/smoke-programlog-popout.js` (`npm run test:programlog-popout`, plain node) reads
  `openPopoutWindow` + the three bounds helpers out of main.js and runs them with a fake
  BrowserWindow / fs / screen — verbatim below: first open sized from POPOUT_SIZES and placed so the
  live screen stays visible; a second open reuses (show+focus, ONE window); a move/resize persists
  under `programlog`; close + reopen restores `{300,200,1000,700}`; off-screen saved bounds fall back;
  a second monitor gets the first open; dedupe is per panel.

### 2. Docked panel
- `App.tsx:780` / `:3854` — `"programlog"` added to the dock union; `:2678-2680` a **PROGRAM LOG** tab
  beside CALENDAR (the Calendar tab and component untouched — slice 6 retires them); `:4356-4357`
  `progPanel === "programlog" ? <ProgramLog embedded onClose={onCloseDock} />` — the same push-up,
  divider and persisted `dockHeight` (default 320, min 110) the Calendar uses.
- `ProgramLog.tsx` `embedded` prop (`:86-91`): the 220px sidebar scrolls as a whole (`:620
  overflowY: embedded ? "auto" : "hidden", minHeight: 0`) and TODAY'S SHOWS stops claiming all the
  height (`:702 flex: "0 0 auto", maxHeight: 180`), so at dock height the mini month, the day summary,
  Fill Day, CSV / Print / PDF and Clear Day are all reachable by scrolling the left column; the hour
  rows keep their own scroll. **Nothing is hidden.** The ✕ in the header closes the dock (`onCloseDock`).
- Receipt: `src/components/ProgramLog.layout.test.tsx` (vitest; react-dom/server markup — there is no
  DOM environment in this suite, so this asserts the layout RULES, not pixels; pixels are Jeff's
  receipt): root `height:100%` flex; sidebar `width:220px flex-shrink:0`, `overflow-y:auto` embedded /
  `hidden` standalone; shows block `flex:0 0 auto; max-height:180px` embedded / `flex:1` standalone;
  rundown `flex:1; overflow-y:auto`; every control present; no `min-width` > 320px.

### 3. Shared state — `schedule:changed`
- `main.js:9320 _scheduleChanged(stationId, reason, extra)` → `sendToAllWindows("schedule:changed",
  { stationId, reason, at, …extra })`. Fired from **every writer of `generated_schedule`**:
  `_commitDayRows` (`:9361` — so every Generate caller: `generateDay`, `generateDays`, `_generateRange`
  / auto-extend), `clearDay` (`:9404`), `moveRow` (`:9445`), `setRowSource` (`:9463`), `deleteRow`
  (`:9477`), `editRowFields` (`:9510`), `insertVoiceTrack` (`:8935`), the stale sweep → missed
  (`:8836`), and the daemon's stamps relayed by main: `playstart` (playing/played, `:954`) and
  `logreader-missed` / `spot-missed` / `logreader-operator-write` (`:890`).
- `ProgramLog.tsx:184-200`: ONE `ether.on("schedule:changed")` per mount, filtered to this station,
  **coalesced into one re-read per 400 ms burst** (`CHANGED_DEBOUNCE_MS`, `:84`), `selectedDate` read
  through a ref so the listener is never re-registered on a day change, `ether.off` on unmount.
- **Shared selected day**: `localStorage` `ether_programlog_date_<stationId>` (`:70-82`), read on mount
  and on a station switch (`:95-99`, `:176-181`), written on every pick (`:100`); absent/throwing/
  garbage → today. Both surfaces open on the last day picked for the station. (Live-syncing the day
  between them is deliberately NOT done — the two windows are two views; each keeps its own day
  once open.)
- Receipts: smoke (a) `schedule:changed` fired once for a Fill with `{stationId, reason:"generate",
  from, to, rows}`; (d) once per Clear (`cleared` carried); (h) all 8 main.js writer sites call it,
  the daemon relays are wired, ProgramLog subscribes once/debounced/unsubscribes.

### 4. Both open, closing one, reopening
- Two React trees, two listeners (one each), each debounced — a Generate (one `generate` + one
  `missed` sweep event) is one re-read per surface; a go-live is one. No storm.
- Closing the dock = `setProgPanel(null)` (unmount → `ether.off`); closing the window = `window.close`
  (its renderer dies with it). Reopening either seeds from the shared day key and re-subscribes; the
  pop-out restores its bounds. The Program Log's own Fill/Clear still re-read explicitly after the
  call (2 reads of ≤ ~1,000 rows on a click; acceptable, and the other surface's read rides the
  broadcast).
- The progress bar (`<GenerateProgressBar/>`, App top-level) shows for the docked panel; the pop-out
  has none — its status line is its progress (unchanged from slice 2).

### 5. Calendar — untouched (`git diff --stat` shows no `BroadcastCalendar.tsx`).

### Help
`docs/help-program-log.md`: new "Docked or in its own window" section; `where:` names the tab, the
menu and the hamburger.

### Tests (verbatim)
`scripts/smoke-programlog-writes.js` (57): the slice-3 lines —
```
PASS  handlers registered: generateDay, clearDay, get
PASS  a · schedule:changed fired ONCE for the Fill (stationId 1, reason generate, window carried)
PASS  d · schedule:changed fired for BOTH clears (reason clear-day; the second says cleared 0)
PASS  h · every generated_schedule writer in main.js calls _scheduleChanged (8 sites)
PASS  h · the daemon's playstart and missed events are relayed as schedule:changed
PASS  h · _scheduleChanged sends to ALL windows on channel schedule:changed
PASS  h · ProgramLog.tsx subscribes to schedule:changed once per mount, debounced, and unsubscribes
PASS  h · the shared selected-day key is read on mount and written on every pick
=== 57 passed, 0 failed ===
```
`scripts/smoke-programlog-popout.js`:
```
PASS  main.js: POPOUT_SIZES found and carries programlog
PASS  main.js: the Schedule menu's Program Log entry goes through menuNav("nav:programlog", "programlog")
PASS  App.tsx: nav:programlog opens the pop-out (not the Schedule Manager pane)
PASS  App.tsx: the hamburger's Program Log entry opens pop-out panel programlog
PASS  App.tsx: PROGRAM LOG is a dock tab and the dock renders <ProgramLog embedded>
PASS  PopoutRenderer.tsx: case programlog mounts <ProgramLog onClose={window.close}>
PASS  1 · first open creates ONE BrowserWindow titled popout:programlog
PASS  1 · sized from POPOUT_SIZES.programlog (clamped to the single work area)
PASS  1 · one monitor: placed right of centre, below the header strip (the live screen stays visible)
PASS  1 · loads the dev URL with #popout/programlog (PopoutRenderer's route)
PASS  1 · no bounds file yet (nothing persisted until the user moves/resizes)
PASS  2 · a second open REUSES the window: show+focus, still ONE BrowserWindow
PASS  3 · moved/resized → popout-bounds.json carries programlog {300,200,1000,700}
PASS  3 · loadPopoutBounds reads it back
PASS  4 · after close, reopen creates a NEW window with the saved bounds
PASS  4 · the other panels' bounds are untouched by programlog's save
PASS  5 · boundsOnScreen rejects an off-screen rectangle
PASS  5 · reopen with off-screen saved bounds falls back to the default placement (on screen)
PASS  6 · with a second monitor a first open lands there (x = secondary + 60) at full POPOUT_SIZES
PASS  7 · dedupe is per panel: a Play Log window open does not stand in for the Program Log
=== 20 passed, 0 failed ===
```
`src/components/ProgramLog.layout.test.tsx`:
```
 ✓ src/components/ProgramLog.layout.test.tsx > ProgramLog docked (embedded) layout contract > renders in both modes without throwing
 ✓ src/components/ProgramLog.layout.test.tsx > ProgramLog docked (embedded) layout contract > root fills its box (height:100%, flex row) so the dock's height, not the content, sets the size
 ✓ src/components/ProgramLog.layout.test.tsx > ProgramLog docked (embedded) layout contract > sidebar is a fixed 220px column; embedded it scrolls as a whole, standalone it does not
 ✓ src/components/ProgramLog.layout.test.tsx > ProgramLog docked (embedded) layout contract > embedded, TODAY'S SHOWS stops claiming all the height (flex 0 0 auto, capped) so the buttons stay in reach
 ✓ src/components/ProgramLog.layout.test.tsx > ProgramLog docked (embedded) layout contract > the rundown column scrolls on its own (flex:1 + overflow-y:auto)
 ✓ src/components/ProgramLog.layout.test.tsx > ProgramLog docked (embedded) layout contract > nothing Jeff uses is hidden when docked: Fill Day, Clear Day, CSV, Print, PDF, the mini month, Shows & Dayparts
 ✓ src/components/ProgramLog.layout.test.tsx > ProgramLog docked (embedded) layout contract > no element forces a min-width wider than a narrow panel
 ✓ src/components/ProgramLog.layout.test.tsx > shared selected-day key + debounce constants (slice 3) > the key is per station
 ✓ src/components/ProgramLog.layout.test.tsx > shared selected-day key + debounce constants (slice 3) > readSharedDate tolerates a missing/throwing localStorage and rejects garbage
 ✓ src/components/ProgramLog.layout.test.tsx > shared selected-day key + debounce constants (slice 3) > a burst of schedule:changed events is coalesced into one re-read (400 ms)
      Tests  10 passed (10)
```

### Gates
`npx tsc --noEmit` exit 0. `npx vitest run` → **32 files, 425 passed**. `node --check electron/main.js`
ok. `test:ipc-contract` / `test:preload-bridge` / `test:undefined-calls` → PASS. `test:programlog-reads`
11 · `test:programlog-writes` 57 · `test:programlog-popout` 20. watchdog 32. audiod smokes (exit 0 each):
autofit 47 · autopost-arm 21 · cmd-routing 7 · deck-identity 22 · deck-position 16 · deck-snapshot 25 ·
enginestate-wire 15 · enginestate 19 · logreader-anchor 18 · manual-mode 30 · meter-contract 15 ·
orphan 4 · queue-classes 8 · seam-stop 60 · xfade-contract 33 · dead-air 50.

### Runtime receipt owed
PROGRAM LOG tab → the panel docks under the decks, dashboard still visible, left column scrolls to
Clear Day; Schedule → Program Log AND ≡ → Program Log open the SAME window (second click brings it to
front); drag it, close, reopen → same place; with both open, Fill Day in one → the other shows the
rows within ~1 s; a song going to air turns its row `playing` in both; both open on the same day.
Jeff confirms on screen after the relaunch.


---

## Slice 4 — built (2026-09-20, the hour modal's edits; local commit on `log-reader-flip`)

No push, no tag, no bump, no install, no live DB. Jeff confirmed slice 3 on screen first. The
Calendar is untouched (`git diff --stat`: no `BroadcastCalendar.tsx`). Line numbers are post-change.

### 1. Every write rides the log editor's own handlers
`ProgramLog.tsx` HourModal (`:1041-1330`) — the Calendar's rule, kept verbatim: **no optimistic paint**;
after every edit the day is re-read (`onEdited` → `loadDayData`, `:1032`) and the modal is handed the
LIVE block (`block={hourBlocks.find(b => b.hour === hourModal.hour)}`, `:1029`), so a refused edit never
shows as applied for even a frame. `afterEdit` (`:1092-1103`): a handler's `ok:false` puts its `error`
verbatim in a red line at the top of the modal; on success it re-reads, then asks
`schedule:checkRow(stationId, uuid, at)` and shows the warnings under the row (informs, never gates).
- **Swap a song** (`swapSong`, `:1105-1117`) → `schedule:editRowFields(uuid, { song_id })`.
  `main.js:9493-9521`: the handler gained a `song_id` branch — the row's title, artist, length,
  `file_key` (the file's basename, as Generate stamps it) and category are taken **from the Library
  row**, never from the renderer (the same principle as its title/artist refusal: what the log says
  must be what airs); `file_path` is left NULL for the reader's join (`loggen.js readLogAnchored`
  `COALESCE(gs.file_key, s.file_key)` / `COALESCE(gs.file_path, s.file_path)` on `song_id`). Refused
  by name on a non-song row (`:9504`), a song not in the Library (`:9509`), a song with no audio
  (`:9510`). Stamps `source='operator'`; `log-edit` health event `swap-song`; fires
  `_scheduleChanged(…, 'swap-song')` (`:9519`). The `_CELL_FIELDS` path (title/artist/category) is
  unchanged.
- **Drag** (`moveRow`, `:1119-1125`) → `schedule:moveRow(fromUuid, toUuid)` — the two rows **swap
  times** (never a ripple; `main.js:9413`). The old modal shuffled positions in the dead table; the
  header now says "drag a row onto another to swap their times".
- **Delete** (`deleteRow`, `:1128-1136`) → `schedule:deleteRow(uuid)` (soft, `main.js:9450`).
- **Aired rows are records**: `isAired` (`:1057`) → not draggable (`:1209`), no drop target, no swap,
  no ✕, dimmed, tooltip "Already aired — a record, not a plan"; and whatever is tried, main's
  `_guardEditable` (`_EDIT_LOCKED = {played, playing}`) answers `"<title>" has already aired — the log
  is a record of what happened, not a plan, so it cannot be edited/moved/deleted`, shown verbatim.
- **Grep receipt**: `scheduled_log` / `scheduledLog` — **0 mentions anywhere in `ProgramLog.tsx`**
  (comments included); no `execute(` / `UPDATE` / `INSERT INTO` / `DELETE FROM` in the file; the `execute`
  import is gone. Smoke (i) asserts all three.

### 2. Brought over from the Calendar (§4)
- **YOURS badge** (`:1249-1254`): `source === 'operator'` (log-edit-core's `OPERATOR_SOURCES`, the
  allow-list; NOT "any source" — `auto` is the extender's provenance, not ownership).
- **Time column with seconds + Length** (`:1233-1237`, header `:1176`): scheduled `HH:MM:SS`, actual
  air time under it once aired; Length `m:ss`.
- **Delete row** (the ✕, `:1277-1287`).
- **Separation warnings after an edit** (`checkRow`, `:1098`).
- **State on the row** (`playing` accent / `missed` red, `:1216`, `:1257`).
**Skipped** (not built, listed): pin/release (`schedule:setRowSource`) — an edit, swap or move already
stamps `operator`, so an explicit pin only matters for an untouched auto row; the spreadsheet cell
edits (double-click title/artist on a non-song row, category picker) — `editRowFields` supports them,
the modal does not offer them; the `ether:schedule-regenerated` DOM event and the Schedule Manager's
`onMutated` hook — the Program Log's own re-read + `schedule:changed` cover both surfaces.

### 3. Every edit fires `schedule:changed` — receipts
`main.js`: `editRowFields` `:9519` (`swap-song`) and `:9538` (`edit-cell`), `moveRow` `:9445`
(`move`), `deleteRow` `:9477` (`delete`). Smoke (i): `swap-song`, `move` and `delete` each observed on
the broadcast; **none** for a refused edit.

### 4. Calendar — untouched.

### Help
`docs/help-program-log.md`: "What is not wired yet" is gone; "Editing an hour (✎ Edit)" describes swap,
drag = swap times, ✕, YOURS, the ⚠ warning, and why aired rows cannot change.

### Tests (verbatim — `scripts/smoke-programlog-writes.js`, now 82)
```
PASS  g · the hour modal's swap and drag no longer write the dead table (slice 4)
PASS  i · a generated 15:00 hour to edit (12 rows)
PASS  i · swap: editRowFields({song_id}) ok
PASS  i · swap: schedule:get returns the NEW song at that slot (song_id, title, artist, length, file_key from the Library; same time)
PASS  i · swap: the row is now operator-owned (YOURS) — Generate will not replace it
PASS  i · swap: schedule:changed fired (reason swap-song)
PASS  i · swap: the log-reader would air the new file — its COALESCE(gs.file_key, s.file_key) / join on song_id resolves song1
PASS  i · swap to a song that is not in the Library is refused by name
PASS  i · swap on a non-song row is refused by name
PASS  i · checkRow answers with a warnings array (informs; the edit already applied)
PASS  i · drag: moveRow ok
PASS  i · drag: the two rows swapped times (A ↔ B), both operator-owned
PASS  i · drag: the daemon-facing order (pending rows ORDER BY scheduled_at — loggen's predicate) matches what the panel shows
PASS  i · drag: B now airs where A was (first of the hour), A where B was
PASS  i · drag: schedule:changed fired (reason move)
PASS  i · delete: deleteRow ok, the row is gone from schedule:get but still in the table (soft)
PASS  i · delete: schedule:changed fired (reason delete)
PASS  i · a played row: swap refused with 'has already aired — the log is a record of what happened, not a plan'
PASS  i · a played row: move refused (as the source)
PASS  i · a playing row: move refused (as the target)
PASS  i · a playing row: delete refused
PASS  i · the refused rows are untouched
PASS  i · no schedule:changed for a refused edit
PASS  i · the grep receipt: no scheduled_log / scheduledLog reference remains anywhere in ProgramLog.tsx
PASS  i · ProgramLog.tsx writes nothing directly: no execute( / UPDATE / INSERT / DELETE in the file
PASS  i · the hour modal invokes editRowFields({song_id}), moveRow, deleteRow, checkRow — and nothing else writes
=== 82 passed, 0 failed ===
```
Section (i) runs the shipped handlers (`editRowFields`, `moveRow`, `deleteRow`, `checkRow`, `_logRow`,
`_guardEditable`, read out of main.js) against a generated day: a swap on a pending 15:00 row →
`schedule:get` returns the new song at that slot with the Library's title/artist/length/file_key,
`source='operator'`, and the reader's COALESCE resolves the new file; a drag → the two rows' times
swap and the daemon-facing order (pending rows `ORDER BY scheduled_at`, loggen's predicate) matches the
panel; a delete → gone from `schedule:get`, soft in the table; swap/move/delete on played and playing
rows → refused with the handler's "already aired" reason and the rows untouched.

### Gates
`npx tsc --noEmit` exit 0. `npx vitest run` → **32 files, 425 passed**. `node --check electron/main.js`
ok. `test:ipc-contract` / `test:preload-bridge` / `test:undefined-calls` → PASS. `test:programlog-reads`
11 · `test:programlog-writes` 82 · `test:programlog-popout` 20. watchdog 32. audiod smokes (exit 0
each): autofit 47 · autopost-arm 21 · cmd-routing 7 · deck-identity 22 · deck-position 16 ·
deck-snapshot 25 · enginestate-wire 15 · enginestate 19 · logreader-anchor 18 · manual-mode 30 ·
meter-contract 15 · orphan 4 · queue-classes 8 · seam-stop 60 · xfade-contract 33 · dead-air 50.

### Runtime receipt owed
✎ Edit on a future hour: click a song → pick another → the row shows the new title with YOURS, the
Up Next / Calendar show the same song at that time, the daemon airs it when its slot comes; drag a row
onto another → the two trade times; ✕ → the row is gone; on an aired hour the rows are dimmed and a
try shows the red "already aired" line. Jeff confirms on screen after the relaunch.
