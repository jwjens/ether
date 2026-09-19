# Program Log vs playout, and a wiring audit of every window (2026-09-17)

**Read-only.** Nothing edited, built or committed. All DB facts are from a COPY of this box's DB taken
10:32 local today (`scratchpad\dbcopy2\openair.db` + WAL) — the live DB was not opened. Tree: `C:\openair`
HEAD `4a7261b` (4.6.45). Airing station on this box: **2 · halloVeen** (`stations.is_active = 1`).

**Operator report, verbatim:** Schedule → Program Log for Thu Sep 17 shows every hour "Open Format ·
Click Generate", "0 hours", shows 0/24h, while the engine is airing from a generated log (daemon log:
"logreader refill: N pending from log (mode=ahead)"). Program Log is not reading the log playout reads.

---

## PART 1 — Program Log vs playout

### 1. What the log-reader reads to air

`audiod/loggen.js:322-355 readLogAnchored(db, stationId, count, slackSec)`, called from the engine's
refill (`audiod/engine.js:1290-1300 _refillFromLog` → `loggen.readLogAnchored(this.db, this.stationId, 20)`).

- **Table:** `generated_schedule gs LEFT JOIN songs s` (`loggen.js:330`).
- **Station:** `gs.station_id = ?` bound to the daemon engine's `stationId` (`:330`, `:344`, `:353`) —
  the integer id of the station whose engine is running (2 here).
- **Window:** anchor = the row for NOW from `selectRowForNow(db, stationId, nowTs)` (`:282-320`, `:324`),
  then `gs.state = 'pending' AND gs.deleted_at IS NULL AND gs.scheduled_at >= <anchorTs> ORDER BY
  scheduled_at LIMIT 20` (`:331-332`, `:349-353`). "Missed" sweep is day-bounded to rows `>= local
  midnight AND < anchor` (`:337-343`).
- **Timezone:** `scheduled_at` is a Unix epoch integer (`generated_schedule.scheduled_at INTEGER NOT
  NULL`); `nowTs = Math.floor(Date.now()/1000)` (`:323`); the only local-time use is the day bound
  `new Date(); d0.setHours(0,0,0,0)` (`:337`). No date strings, no hour columns.
- Also filtered: on-format categories (`getFormatCategoryIds`, `:327-329`) and `content_class NOT IN
  ('JIN','SWP')` (`:332`) — sweepers ride a separate seam, not the refill.

### 2. What the Program Log window reads

Component `src/components/ProgramLog.tsx` (1,708 lines), opened by Schedule → Program Log
(`electron/main.js:2874 menuNav("nav:programlog","programlog")`), the hamburger "Program Log"
(`src/App.tsx:2916`), or as a pop-out (`PopoutRenderer.tsx:84`). Rendered at `App.tsx:3090`.

- **IPC:** raw SQL through `query()` (`src/db/client.ts:10-22`) → `window.ether.db.query` →
  `ipcMain.handle("db:query")` (`electron/main.js:5410-5417`), which runs the SQL **verbatim — no station
  scoping, no rewriting**. Writes go through `window.ether.scheduledLog.*`
  (`electron/sync/handlers/scheduled_log.js`).
- **Day rows:** `SELECT * FROM scheduled_log WHERE log_date=? ORDER BY hour, position` (`ProgramLog.tsx:110-112`).
  **Table: `scheduled_log`.** Date = `selectedDate` string `YYYY-MM-DD` (`:62 todayStr()` → `fmtDate(new
  Date())`, local calendar date); hour = an integer column. **No `station_id` in the query.**
- **Scheduled dates (the day picker):** `SELECT DISTINCT log_date FROM scheduled_log` (`:91-92`) — no station.
- **Shows (the "Open Format" label):** `SELECT s.*, c.name AS clock_name FROM shows s LEFT JOIN clocks c
  … WHERE s.deleted_at IS NULL ORDER BY s.start_hour` (`:100-102`, again `:114-116`) — **no
  `station_id`**, so all four stations' shows are loaded; each hour takes the first show whose hour
  range matches (`:118-…`).
- **Hour count / "0 hours":** derived from the `scheduled_log` rows for the day (`:120-125 scheduledHours`).
- `useActiveStation()` is called (`:85`) and `stationId` is passed to the **writes** (`:208`, `:355`,
  `:391`, `:397`) but to **none of the reads**.

### 3. Both queries against the DB copy — Thu 2026-09-17, station 2

| | Program Log reads | Playout reads |
|---|---|---|
| Table | `scheduled_log` | `generated_schedule` |
| Query | `WHERE log_date='2026-09-17'` (no station) | `WHERE station_id=2 AND deleted_at IS NULL` (+ state/window) |
| Rows for the day | **0** | **978** (played 208, playing 1, pending 744, missed 25) |
| Hours covered | 0 | **24** (`00:00:00` → `23:57:43` local) |
| Whole table | **0 rows, ever** (`SELECT count(*) FROM scheduled_log` = 0, min/max log_date NULL) | 206,870 rows |
| Log-reader's live predicate right now (`pending`, on/after now, station 2, non-imaging) | — | 1,892 rows |

**The precise difference: a different table.** Program Log reads `scheduled_log`, which has never held a
row on this install; playout reads `generated_schedule`. Not a date-format, timezone or station-id
mismatch — those never get a chance to matter, because the source is empty. (Two further mismatches
would bite if it weren't: the day query has no `station_id`, and the shows query has no `station_id`.)

**"Open Format" on every hour, explained:** `shows` holds one show per station, all `start_hour 0 →
end_hour 0` (= all day): `1 Open Format (station 1)`, `3 HalloVeen (station 2)`, `2 Christmas (3)`,
`4 Summer Christmas (4)`. The unscoped shows query returns all four ordered by `start_hour`; `find()`
takes the first match — station 1's "Open Format" — for every hour of every station (`:114-125`, and the
generator's own lookup at `:169-178`).

This is already recorded in the tree: `ProgramLog.tsx:156-164` — *"Every INSERT silently fails inside
the try/catch, so scheduled_log has 0 rows and schedule generation has never worked … tracked in
docs/phase-3.5-programlog-deferred.md"* (that doc: Status **Deferred**, commit `a4e85c2` 2026-05-04,
`rows: 0` confirmed 2026-05-04). `Logs.tsx:169-172` says the same when it was moved OFF `scheduled_log`
on 2026-08-09 ("which NOTHING WRITES"). The Program Log itself was never moved.

### 4. Related to the filed `BroadcastCalendar.tsx:205` "Too few parameter values" error?

**No.** That error is in a different window (`BroadcastCalendar.tsx:204-207`: `station_id = ?` with
`[]` params, `skipScoping:true` — the calendar's "auto days" marker query) against `generated_schedule`.
Program Log's queries have no unbound placeholders (`:110-112` binds `[date]`; the others bind nothing
and use none), and Program Log does not import or call the calendar. Both are "schedule" windows, which
is the only connection. The calendar bug only blanks its day-markers; the calendar's rows come from
`schedule:get` (`electron/main.js:10531-10556`, `FROM generated_schedule g … station_id`), which is the
airing table.

### 5. What "Generate" and "Fill Day" write — and whether that is the airing table

- **Generate (per hour)** `generateHour` (`:361`) → `scheduleOneHour(date, hour)` (`:166-358`):
  1. `scheduledLog.clearByHour(stationId, date, hour)` (`:208`) — deletes `scheduled_log` rows for that hour.
  2. picks songs from `songs` by the clock's slots (`:180-192`, `:231-239`) with its OWN separation
     arithmetic on `songs.last_played_at` (`:251`, `:270`), and **stamps `songs.last_played_at` with a
     FUTURE time** per pick: `songs.updateById(picked.id, { last_played_at: hourStartTs + slot.position })`
     (`:294`; overflow `:350`, `+3600`). `songs` is a synced table, so those stamps would replicate.
  3. `scheduledLog.batchInsert(stationId, pendingRows)` (`:355`) → `scheduled_log` (handler
     `scheduled_log.js:151-200`, `INSERT INTO scheduled_log (log_date, hour, position, …)`).
- **Fill Day** `fillDay` (`:372-389`) = `scheduleOneHour` for each hour of the day.
- **Clear hour / Clear day** (`:391`, `:397`) → `scheduledLog.clearByHour/clearByDate` — `scheduled_log` only.

**Neither Generate nor Fill Day writes `generated_schedule`.** They cannot overwrite or duplicate what is
airing — the log-reader never reads `scheduled_log`. What they CAN do is worse in a different way: step 2
writes `songs.last_played_at` in the future, and the real generator uses that column as its fallback
when a song has no `play_log` timestamp (`electron/generate-core.js:173 maps.songLastTs.get(song.id) ??
(song.last_played_at || 0)`), so a Program Log "Generate" that runs to completion would make the real
generator believe those songs were just played and rest them. **Receipt that it has not happened here:**
`SELECT count(*) FROM songs WHERE last_played_at > now` = **0** in the copy. (Whether the generator's
queries even run today is UNVERIFIED — the columns it needs, `daypart_mask`, `rotation_status`,
`is_explicit`, `last_played_at`, `category_id`, all exist on `songs`, so nothing in the schema stops it.)
The airing log is written only by the desktop's `schedule:generateDay/Days` (`electron/main.js:9548`,
`:9498`, via `generate-core.js`) and `schedule:insertVoiceTrack` (`:8909`), and stamped by the daemon
(`audiod/engine.js:1342`, `:1774-1781`).

---

## PART 2 — wiring audit of every window

**Doors** (receipts): native menu `electron/main.js:2825-2931`; hamburger `src/App.tsx:2913-2929`;
bottom tabs `App.tsx:2665-2681` (DECKS · CARTS · SHOWS · CLOCKS · CATEGORIES · SWEEPERS · SPOTS ·
LIBRARY · CALENDAR · PHONE); the dock switch `App.tsx:4353-4378`; workspace panels `App.tsx:3088-3180`;
pop-outs `src/components/PopoutRenderer.tsx:67-97`. "Truth" = what the daemon reads/writes:
the daemon **writes** `generated_schedule` (state/played_at), `play_log`, `songs` (a few fields),
`station_config_kv`, `spots.play_count`; it **reads** `generated_schedule, station_config_kv, songs,
play_log, spots, separation_rules, clock_slots, stations, shows, deck_configs, categories, cart_slots`
(grep over `audiod/engine.js, loggen.js, playlog.js, ether-audiod.js`). Row counts are from the copy.

**Status key:** WIRED = reads the same source playout/engine uses · STALE-SOURCE = reads a different or
dead source · DEAD = no handler / placeholder / hardcoded · PARTIAL = mixed.

| # | Window · door | Displays · reads (file:line) | Should reflect | Status | Actions → reach the engine? |
|---|---|---|---|---|---|
| 1 | **Program Log** · Schedule menu `main.js:2874`, hamburger `App.tsx:2916`, pop-out | `scheduled_log` by `log_date` (`ProgramLog.tsx:110`), unscoped `shows` (`:100, :114`), `clock_slots` (`:180`), `scheduling_rules` (0 rows, `:194`) | the station's `generated_schedule` for the day | **STALE-SOURCE** (empty table; unscoped shows) | Generate / Fill Day / Clear → `scheduled_log` + `songs.last_played_at` (`:208, :294, :350, :355, :391, :397`) — **never the airing log**; Shows modal edits `shows` (`:1477-1503`) — those DO reach the generator |
| 2 | **Calendar** · bottom tab CALENDAR (`App.tsx:2681` → `:4356`), hamburger, pop-out | `schedule:get` → `generated_schedule` per station (`main.js:10531-10556`); `categories`, `shows` (`BroadcastCalendar.tsx`) | the airing log | **WIRED** (one defect: day-marker query binds `[]` for `station_id = ?`, `:204-207`, filed) | Generate → `schedule:generateDay/Days` (`main.js:9548/:9498` → `generate-core.js`) = the airing table; edit/move/delete/check/setSource → `schedule:*` handlers on `generated_schedule`. **Yes.** |
| 3 | **Play Log** · Schedule menu `:2875`, hamburger `:2918` | `play_log` + `generated_schedule` as-run reconciliation (`Logs.tsx:169-172`, fixed off `scheduled_log` 2026-08-09) | the daemon's `play_log` writes (`playlog.js:71`) | **WIRED** | `playLog.clearByStation` → `play_log` (data, not engine) |
| 4 | **Up Next** · main screen (`App.tsx:4288`), View → Play Queue, Monitors pop-out | `schedule:playhead-view` (`main.js:10569` → `generated_schedule`+`songs`), engine queue via `useAudioEngine`, `announcements.listSchedule`, `schedule.sweeperPlacements` | the daemon queue + log | **WIRED** | reorder/remove → engine queue intents (`qid`) — yes |
| 5 | **Clocks** · bottom tab, Schedule menu `:2868`, hamburger "Schedule" | `Scheduler` → `ClocksTab.tsx`: `clocks, clock_slots, categories, spots, clock_breaks` via typed handlers | what the generator reads (`generate-core.js`; daemon reads `clock_slots`) | **WIRED** | create/update/delete clocks, slots, breaks → synced tables the generator reads — yes (next Generate) |
| 6 | **Shows & Dayparts** · bottom tab SHOWS, Schedule menu `:2869` | `ShowsTab.tsx`: `shows, clocks` | generator's show → clock mapping | **WIRED** | shows create/update/delete — yes |
| 7 | **Categories** · bottom tab, Schedule menu `:2870` | `CategoriesTab.tsx`: `categories, songs` | format categories the log-reader filters on (`loggen.js:327`) | **WIRED** | category CRUD + song recategorise — yes |
| 8 | **Spots & Promos** · bottom tab SPOTS, Library menu `:2861` | `Spots.tsx`: `spots, spot_categories, clock_breaks, library_asset` | `spots` the daemon reads/updates (`engine.js` `UPDATE spots`) | **WIRED** | spot/category CRUD, import from folder — yes |
| 9 | **Sweepers** · bottom tab SWEEPERS (`App.tsx:4360-4372`) | `SweepersPanel.tsx`: `library_asset, categories` (pools via `sweeper_pool_member` handlers) | the daemon's sweeper seam pool | **WIRED** | pool/assignment edits — yes |
| 10 | **Imaging** · hamburger `:2915`, Monitors pop-out | `ImagingPanel.tsx`: `generated_schedule, library_asset, sweeper_pool_member, categories, station_config_kv` | what fires ahead (log + pools) | **WIRED** | read-only + "OPEN IMAGING" editor door |
| 11 | **Library** · bottom tab, Library menu `:2860`, hamburger | `LibraryPanel` (in `App.tsx`): `songs, categories, clock_slots, library_asset`; metadata handlers | `songs` (daemon resolves files from it) | **WIRED** | load A/B/C, queue → engine; edit/delete → `songs` — yes |
| 12 | **Import Music / Import from Folder** · File & Library menus `:2829, :2864` | `LibraryImport.tsx`: `songs, artists, categories` | library | **WIRED** | `songs.create` etc. — yes |
| 13 | **Import Library (Tools)** · `:2896` | same component as 12 | library | **WIRED** | as 12 |
| 14 | **Cue Editor** · Library & Tools menus `:2865, :2893` | `TrackEditor.tsx`: `songs` (cue points via `songs.updateById`) | `songs.intro_end/outro_start` the log-reader carries (`loggen.js:349`) | **WIRED** | save cue → `songs` — yes (next load) |
| 15 | **Clip Editor** · Tools `:2894` | `ClipEditor.tsx`: files + `station_config_kv` | disk clips | **WIRED** (files) | `media:writeAudio` — yes |
| 16 | **Voice Tracker** · Library/Tools menus `:2862, :2886`, Monitors pop-out | `VoiceTracker.tsx`: `voice_tracks` (0 rows), `clocks, clock_slots, shows`, **and `scheduled_log` for the prev/next context** (`:483-486`, station-scoped, empty) | the airing log's neighbours | **PARTIAL** — context list is always empty (dead table); insert is right | `schedule:insertVoiceTrack` → `generated_schedule` (`main.js:8909`) — **yes**; `voiceTracks.create` → `voice_tracks` |
| 17 | **Voice Track Inbox** · panel `vtinbox` | files under `<userData>/voice-tracks/` (`VoiceTrackInbox.tsx:11`) | disk | **WIRED** (files) | queue → engine — yes |
| 18 | **Rotation Analytics** · Schedule menu `:2880`, hamburger `:2921` | `rotation:analytics` (`main.js:9156` → `electron/rotation-analytics.js`: `generated_schedule, songs, categories, separation_rules`) | the airing log | **WIRED** | read-only |
| 19 | **Schedule Manager** · Schedule menu `:2881`, hamburger `:2920` | `schedule/ScheduleWorkspace.tsx`: `play_log` + child panels (calendar/clocks) | log + play history | **WIRED** | via children |
| 20 | **Announcements** · Schedule menu `:2882` | `Announcements.tsx`: `announcements`, `announcement_schedule` (handlers), `library_asset` | the fire path in main (`main.js:4679` writes `announcement_schedule.last_played_at`) | **WIRED** | create/update/fire — yes |
| 21 | **EAS Logbook** · Schedule menu `:2883` | `EASLogbook.tsx`: `eas_tests` (0 rows; raw INSERT) | its own logbook | **WIRED** (own table; nothing else reads it — by design) | log a test — data only |
| 22 | **Smart Scheduler** · Tools `:2899` | `SmartScheduler.tsx`: `smart_schedule_rules` (0 rows), `songs` | rules the generator applies | **STALE-SOURCE** — the generator never reads `smart_schedule_rules` (only listed for sync/backup, `main.js:2140, :8025`) | rule CRUD writes a table nothing consumes |
| 23 | **Schedule Preview** · panel `schedpreview` | `SchedulePreview.tsx`: `scheduled_log` (`:9, :97, :171, :180`), `pinned_songs` (0 rows), `clock_slots, shows` | the airing log ahead | **STALE-SOURCE** (dead table) | read-only |
| 24 | **PD Picks** · panel `pdpicks` | `PDPicks.tsx`: `pinned_songs` (0 rows), `songs` | picks the generator honours | **STALE-SOURCE** — `pinned_songs` is not read by `generate-core.js` (only FK/sync mentions, `main.js:1943, :2125`) | pin/unpin writes a table the generator ignores |
| 25 | **Scheduler Reasons** · panel `reasons` | `SchedulerReasons.tsx`: `scheduler_reasons` (0 rows) | why the generator chose/skipped | **DEAD** — no writer exists (only a DELETE on song delete, `handlers/songs.js:254`) | none |
| 26 | **Stream Manager** · Tools `:2898` | `StreamManager.tsx`: `stream_settings` (0 rows; legacy, migrated away at `metadata-dispatcher.js:287-293`) | `stations.icecast_*` that `stream:go-live` reads (`main.js:10839-10842`) | **STALE-SOURCE** | `stream_stop` / `stream_update_metadata` handlers exist; the settings it edits are not the ones go-live uses |
| 27 | **Listener Analytics** · Tools `:2900` | `ListenerAnalytics.tsx`: `play_log`, `songs`, and `scheduled_log` for "scheduled vs played" (`:8, :238-242`) | play history | **PARTIAL** — the scheduled side is always 0 | read-only |
| 28 | **Cloud Log Backup** · Tools `:2901`, hamburger | `CloudBackup.tsx`: `cloudBackup.*`, `catalogueBackup.*`; restore writes `play_log` **and `scheduled_log`** (`:264-334`) | backups | **PARTIAL** — restores into the dead table (harmless, pointless) | run-now/restore — data |
| 29 | **Audio Routing** · Tools `:2902` | `AudioRoutingPanel.tsx`: `audio.listOutputDevices/setOutputDevice`, `station_config_kv` | the daemon's output device | **WIRED** | set device → engine — yes |
| 30 | **Station Manager** · Tools `:2903` | `StationManager.tsx`: `stations.*`, `stationConfigKv`, `identity.get` | stations | **WIRED** | create/switch/delete — yes |
| 31 | **Manage Devices** · panel `managedevices` | `ManageDevices.tsx`: `identity.get`, `stationConfigKv.list` + backend seats | seats | **WIRED** | deauthorize → backend |
| 32 | **System Health / Health Monitor** · Tools `:2905`, Monitors pop-out | `HealthMonitor.tsx`: `ha:dashboard`, `audio:health` feed, ledger, `generated_schedule`, `play_log`, `stationConfigKv` | engine/daemon/HA truth | **WIRED** | CLEAR & RE-SUPERVISE, PUSH/PULL, migrate — yes |
| 33 | **Live Activity** (inside 32) | `activity:tail` → the daemon-reported log file (7fb8eba) | the running daemon's log | **WIRED** (as of 4.6.45) | — |
| 34 | **Decks** · View menu, Monitors pop-out, DECKS tab (config) | `DeckConfigurator.tsx` / `OnAirDeck.tsx`: engine deck stream (`useAudioEngine`), `deck_configs`, `cart_slots`, levels | the daemon's deck state | **WIRED** | play/stop/load/EQ → engine — yes |
| 35 | **Carts** · bottom tab CARTS (`App.tsx:2670`, dock `:4377`), hamburger | `BoutiqueCartWall` (in `DeckConfigurator.tsx`): `cart_slots` (daemon reads `cart_slots`) | cart wall | **WIRED** | fire → engine `cart:fire` path — yes |
| 36 | **Mic Deck** · View menu, pop-out | `MicDeck.tsx`: engine + `station_config_kv` EQ | mic channel | **WIRED** | EQ → `audio.setEq` — yes |
| 37 | **Master Output** · pop-out | `MasterOutput.tsx`: `audio.onLevels`, `setMasterMonitorVolume`, `setEq`, console feed | the bus | **WIRED** | yes |
| 38 | **Processor** · pop-out | `ProcessorRack.tsx` (params via `useProcessorParams` → `station_config_kv`; meters via `audio:proc-meters`) | Audio Processing v1 | **WIRED** | toggles/target → KV the daemon polls — yes |
| 39 | **Phone Desk** · bottom tab PHONE, pop-out | `PhoneDesk.tsx`: engine + `ffmpeg.writeAudio` | phone/hybrid | **WIRED** (recorder ~90%, per memory) | yes |
| 40 | **Show+** · Tools `:2892`, hamburger `:2928`, pop-out | `ShowPlus.tsx`: `studio:record:*`, `studio:rtmp:*`, `station_config_kv`, `install_config_kv` | video engine | **WIRED** | record/RTMP — yes |
| 41 | **Show+ DAW (StudioPro)** · Tools `:2891`, hamburger `:2929`, pop-out | `StudioPro.tsx`: `studio_sessions/_versions/_notes`, `songs`, `audio:resolve-local-path`, `watermark:verify` | sessions + library | **PARTIAL** — `studio:force-close` invoked (`StudioPro.tsx`) has no `ipcMain` handler (only mentioned in preload); rest wired | send-to-deck/library — yes |
| 42 | **Jukebox** · hamburger `:2927`, pop-out | `Jukebox.tsx`: `jukebox.*` handlers, `deck_configs`, `songs` | jukebox deck via daemon | **WIRED** | play/close — yes |
| 43 | **Macros** · panel `macros` | `MacroEngine.tsx`: `macros` (0 rows), consumed by `gpio-engine.js` | GPIO/macro engine | **WIRED** (0 rows = unused, not dead) | CRUD → `macros` |
| 44 | **MIDI Settings** · panel `midi` | `MidiEngine.tsx`: `midi_mappings` (0 rows; raw SQL) | MIDI engine | **WIRED** (unused) | CRUD |
| 45 | **Settings / Preferences** · File menu `:2830`, panel | `SettingsPanel.tsx` (4,415 lines): `station_config_kv`, `stations`, `users`, `separation_rules`, `songs`, many `invoke`s | preferences per station | **PARTIAL** — the **Controllers** section (`:878-960`) invokes `controller_list_devices / controller_connect / controller_get_status`, **no handler anywhere** (`main.js`/`preload.js`: 0 mentions) → every scan/connect rejects; dead Tauri-era channel | everything else (autostart, backup, AI keys, sync) has handlers |
| 46 | **Broadcast Editor** · panel `broadcasteditor` | `BroadcastEditor.tsx`: files, `voice_tracks`, `songs.updateById` | editor | **PARTIAL** — "Load into Deck A" (`:1366`, `:2054`) invokes **`audio_load`, no handler** (dead Tauri channel); status still says "✓ Loaded into Deck A" (`:2055`) — a false success | save → files/`voice_tracks` ok |
| 47 | **Show Prep** · panel `showprep` | `ShowPrep.tsx`: `liner_cards`, `prep_notes` (0 rows each) | prep notes | **WIRED** (unused) | CRUD |
| 48 | **AutoCue** · panel `autocue` | `AutoCue.tsx`: `songs` + file analysis | cue points | **WIRED** | `songs.updateById` — yes |
| 49 | **G-Selector Import** · panel `gselector` | `GSelectorImport.tsx`: writes `format_clocks` (0 rows) + `categories, songs, clock_slots` | import | **PARTIAL** — `format_clocks` is not read by the generator (`main.js:2141` sync list only); the rest lands | as stated |
| 50 | **Help** · Help menu `:2926-2930`, panel | `HelpPanel.tsx` static; `AboutPanel.tsx` `system.getVersion`; Keyboard Shortcuts overlay | docs | **WIRED** | Check for Updates → `help:check-updates` |
| 51 | **Subscription** · panel `subscription` | `SubscriptionPanel.tsx`: `identity.get`, KV, backend | plan | **WIRED** | open portal |

### Flags, collected
- **Reads a table nothing writes (`scheduled_log`, 0 rows since inception):** Program Log (#1, its whole
  display), Schedule Preview (#23), Voice Tracker's context list (#16), Listener Analytics' scheduled side
  (#27), Cloud Backup restore (#28). `Logs.tsx` was moved off it on 2026-08-09 (`:169-172`); the others were not.
- **Reads/writes a table the generator/engine never consumes:** Smart Scheduler → `smart_schedule_rules`
  (#22), PD Picks → `pinned_songs` (#24), G-Selector → `format_clocks` (#49), Stream Manager →
  `stream_settings` (#26; go-live reads `stations.icecast_*`, `main.js:10839-10842`).
- **No writer at all:** `scheduler_reasons` (#25).
- **Dead Tauri-era channels (no `ipcMain` handler):** `audio_load` (Broadcast Editor "Load into Deck A",
  `BroadcastEditor.tsx:1366, :2054` — reports success anyway), `controller_list_devices /
  controller_connect / controller_get_status` (Settings → Controllers, `SettingsPanel.tsx:878-960`),
  `studio:force-close` (StudioPro). Snake_case names on the same bridge that still work:
  `stream_stop`, `stream_update_metadata`, `open_url`, `clean_filenames` (handlers present).
- **Install-global state shown as per-station:** Program Log's shows list (#1) — all stations' shows on
  one station's day (the "Open Format" on halloVeen). `db:query` itself is unscoped by design
  (`main.js:5410`), so any raw `query()` without `station_id` is install-global; the ones found: Program
  Log `:91, :100, :110, :114, :169`.
- **Hardcoded / placeholder:** none found in the windows above beyond the Program Log's "Click Generate"
  text (`:1148-1149`), which is a truthful message about an empty table it will never fill correctly.

Report only. No fixes proposed here.
