# Scheduler Phase 1: what aired is the record (2026-10-18)

**Design:** `docs/scheduler-rotation-playout-design.md` §3.9 (the record), §5 Phase 1, §6.2 and §6.4 (the alert stream and
its Phase 1 kinds).
**Branch:** `sched/one-scheduler`, local commits only. Jeff GO 2026-10-18.
**Nothing was installed or launched; nothing touched the air machine.** Runtime behaviour in the app is UNVERIFIED; the
checks are at the end.

## In plain words
- **No log row airs twice.** Every deck now holds its own entry, and only that entry is used up when the deck goes on air.
  - The same simulated evening that aired 6 rows twice on the 6558e57 engine airs none twice now.
  - That evening has the 10/16 conditions: songs running long, and a regenerate under the cued decks.
- **Every play records its log row, its category, its kind and the computer that aired it.** The log row is stamped at
  the same moment, in the same database step.
  - If the write fails, Ether retries for 30 seconds, then raises an alert.
  - Sweepers that fire are stamped too.
- **The record is never rewritten:**
  - Generate, Clear Day, the editors and the library relink touch only rows still waiting to air.
  - On HalloVeen in the gate, the 6:10 PM regenerate deleted 67 aired rows before Phase 1, and none after.
  - A row a deck holds is never marked "missed" while it is about to air. That was why the log said "missed" for songs
    that played.
- **The X takes the row out of the log,** so it stays out and does not air. On the cued deck it also takes it off the deck.
- **One alert stream:**
  - every alert goes to the health log, the Health Monitor's new **Alerts** list, the Iris live stream and
    `/api/alerts?since=`;
  - a database trigger catches any change to an aired row, by any code path;
  - the monitor only detects and reports.

## Results

### The Phase 1 test (`npm run test:record`, scripts/test-record-phase1.js)
It runs the real engine and reader through a two-hour HalloVeen evening on a copy of this machine's database, with a
simulated sound card. The same evening, the same checks, through each engine:

| Check | 6558e57 (before) | Phase 1 (after) |
|---|---|---|
| T10r no row airs twice | **FAIL**: 6 rows aired twice (599913, 599916, 599918, 599922, 599923, 599946) | PASS: 38 go-lives, 38 rows, 0 twice, 0 alerts |
| T11 every go-live = one play with its row, category, machine; the row stamped; the sweeper stamped | **FAIL**: 32 of 32 plays carry no row and no machine, 31 no category; the sweeper row stays pending | PASS: 0 / 0 / 0 / 0; sweeper `played` |
| T12 the X: never airs, not back after 10 refills, out of the log | **FAIL**: 1 removed row aired anyway, 2 still in the log | PASS |
| T4t no aired row rewritten; a rewrite is caught | **FAIL**: 10 aired rows rewritten during the evening (the replays restamping) | PASS: 0 rewritten; a deliberate rewrite → 1 row → 1 alert |
| T4g Generate's own delete leaves aired rows | **FAIL**: 43 of 43 aired/retired rows in the window deleted | PASS: 0 of 40 |
| NS a failing write is retried; one that never lands is an alert | **FAIL**: no retry, no alert (the stamp's catch swallowed it) | PASS: landed on the 3rd try; never-lands → 1 `not-stamped` |

The first run of this test caught a real defect that is now fixed. In a drifting evening, the reader stamped
15 of 38 rows "missed" while they were cued on decks, and they then aired.

### The scheduler gate, 7 days per station (`npm run test:scheduler-gate`)
Phase 0 run `2026-10-18T17-45-18-198Z` against Phase 1 run `2026-10-18T18-29-04-938Z`:

| Test | Phase 0 | Phase 1 |
|---|---|---|
| T4 aired rows untouched | HalloVeen **FAIL 67 deleted**; others pass | **PASS on all 4** |
| T11 simulated: plays from log rows carry their row and category | **FAIL all** (2506 / 3683 / 3308 / 3978 unlinked) | **PASS on all 4** (0 unlinked, 0 without category) |
| T11 this machine's own record (the last 7 days, aired by 6558e57) | FAIL | FAIL, unchanged: those plays were made before Phase 1 and are history |
| T1, T2, T3, T5, T8, T10, T15, T16, T18, T19 | FAIL | FAIL, as expected: those are Phases 2 and 3 |

**About the "worse" lines the ratchet printed after Phase 1:**
- **T1, T3, T8 and T18 rise and fall by a few percent between runs.** Generate's pick is still `ORDER BY RANDOM()`
  (T16), which Phase 1 does not touch, so every run plans a different week.
- **T19 is wall-clock time.** It ran while the Screen Builder agent was building on the same machine, and the reader
  query it times did not change.
- **The ratchet was fixed to only ever tighten.** `--update-ratchet` used to write a worse number over a better one.
  - The file now holds, for each metric, the better of Phase 0 and Phase 1: T4 for HalloVeen 67 → 0, and T11 → 0 on
    every station.
  - Until Phase 2 makes the pick deterministic (ties excepted), the random-pick metrics need a tolerance, or the gate
    will fail on noise. That is Jeff's number (below).

### Other gates (all run on this tree)
- `npx tsc --noEmit`: 0 errors.
- `npx vitest run`: 108 files, 923 tests passed. The Phase 0 self-test was named `*.test.js` and failed vitest as "no
  suite"; it is renamed `scripts/lib/log-checker-selftest.js`.
- **Electron and Node smokes:** `test:sync` 55/55; `test:programlog-writes` 108/108; `test:programlog-reads` 11/11;
  `test:hour-rollover` 7/7. Each of these passed: `test:calendar-anchor`, `test:stale-rows`, `test:spot-edge`,
  `test:queue-rows`, `test:jukebox-gate`, `test:window-station`, `test:wedge`, `test:local-playback`, `verify:schema`,
  `test:log-checker` 7/7.
- **`test:programlog-popout` fails** with `_popoutWins is not defined`. It fails the same way on 6558e57, so it is not
  from this work.

## What was built (file by file)
- **`scripts/migrate-play-record-phase-sync-63.js` (v63):**
  - `play_log.row_uuid`: the generated_schedule row's uuid, or the announcement's uuid for an announcement;
  - `play_log.machine_id`;
  - `log_row_changes`, local-only, and two triggers on `generated_schedule`. The triggers record any UPDATE or DELETE of
    a row whose state is not `pending`; playing → played with nothing else changed is the one normal transition.
  - Additive and idempotent. The payload transformer passes payloads through unchanged (the v62 lesson).
- **`electron/sync/synced-tables.js`:** play_log gains the two columns (a foundation file; GO on Phase 1).
- **`audiod/playlog.js`:**
  - one row builder and one insert for every caller;
  - `logPlay` for a play with no row (jukebox, an operator's own load);
  - **`recordGoLive`** for a play that fulfils a row: the play plus the row's stamp in one transaction. It returns
    `repeat` (the row had aired), `retired` (it was marked missed) and `missingRow`; an overlay (a sweeper) is stamped
    `played`;
  - the machine id from client_identity.
- **`audiod/engine.js`:**
  - **Row identity:** `deckQid` per deck, set with the occupant. A go-live calls `_consumeDeckEntry` (that deck's own
    entry) in all four go-live paths. Loads use `_takePending` (the first entry no deck holds and that has not aired).
  - **Preload** takes the first pending entry, or the exact entry a re-cue names. It never takes one that aired.
  - **The calendar re-cue** matches standby decks to the log by row, in play order. Every wrong deck first lets go of its
    entry, then each is cued with the exact entry. Both guards against touching a playing or paused deck are kept.
  - **The aired set is in memory** at go-live, so no path can cue a row again while its stamp lands.
  - **`_recordGoLive`:** the record at go-live, retries every 500 ms for 30 s, and alerts.
  - **A row a deck holds is never stamped missed.**
  - **Passed sweepers are stamped missed** (`_retirePassedSweepers`); fired ones are stamped played (`_logJinglePlay`).
  - **The X (`intentRemove`):** the row comes out of the log (pending only); a cued entry comes off its deck and the deck
    is re-cued; on air is refused.
  - **`skip()`** plays the next cued deck's own entry when it has one.
- **`audiod/loggen.js`:** `selectRowForNow(…, { asPending })`, so the go-live shadow still asks "what would you air now?"
  with the row that just went live still pending.
- **`electron/log-edit-core.js`:** `NOT_AIRED_SQL` and `isPlan`, one definition of "a plan".
- **`electron/main.js`:**
  - `_commitDayRows` deletes plans only;
  - the auto source stamp touches plans only;
  - `_guardEditable` locks every state but pending;
  - announcements record `row_uuid`;
  - **the alert stream** (`_alerts`, with publish to the health log, windows and SSE): `health:alerts` IPC,
    `GET /api/alerts?since=`, and the `log_row_changes` scan every 15 s;
  - the daemon's `alert` and `log-row-removed` events are routed.
- **`electron/health-alerts.js`:** the v1 alert schema, the ring and catch-up, and the change scanner.
- **`electron/library-folders.js`:** the relink rewrites only plans' file paths (it checks the column exists, for old
  tables).
- **`src/components/health/AlertsHealth.tsx` + `HealthMonitor.tsx`:** the Alerts list, first under the cards. It is never
  collapsed.
- **Docs:**
  - `docs/iris-ether-contract.md` §3a "Alert stream (read-only)";
  - `docs/help-health-monitor.md` (Alerts);
  - `docs/help-log-editing.md` (missed rows are locked);
  - new `docs/help-up-next.md` (the X).
- **Tests:**
  - `scripts/test-record-phase1.js` (`npm run test:record`, with `--engine-dir` for the before receipt);
  - the gate harness now migrates its copies with main's own `runMigrationChain`, records through `recordGoLive`, and
    measures T11 by `row_uuid`;
  - the ratchet only tightens.

## Removed or changed — what worked before and what replaces it (the standing rule)
- **The deferred playhead stamp** (`engine._shadowStampPlayhead`, run from `setImmediate` inside a catch) is removed. It is
  replaced by `_recordGoLive`: synchronous on the go-live path, in one transaction with the play, with retry and alert.
  It adds one SELECT and two UPDATEs inside the transaction the play write already opened on that path, with no extra
  commit. The time per go-live on the air machine is UNVERIFIED; the test's evening shows no stall, but that is not the
  air machine.
- **`dequeue()` at go-live** ("whatever is first") is replaced by the deck's own entry. `dequeue()` itself remains for
  any other caller.
- **`_preloadNow`'s `queueIndex`** (a position in the whole queue) is no longer used; callers keep their signature.
- **The editors can no longer move, swap, edit or delete a `missed` row.** Before, only played/playing were locked.
  **This removes a capability an operator had:** deleting a missed row from the Program Log. The row is evidence ("SPOT
  DID NOT AIR").
- **Generate's window delete no longer deletes an aired row in the window** (the station ran ahead and aired tomorrow's
  row early). The row stays, and as a kept row it blocks its own slot from being refilled.
- **The X used to remove only the in-memory entry** (it came back on the next refill). It now removes the log row
  (pending only), which is what the operator asked for. A cued entry is now removable (it was refused).
- **The library relink no longer rewrites aired rows' file paths.**
- **Rows held by a deck are no longer stamped missed by the reader's catch-up.**
- **The checker self-test** was renamed `scripts/lib/log-checker.test.js` → `log-checker-selftest.js`.

## Not built in Phase 1, and why
- **Remote admin app push of alerts.** The alerts are on the Iris live stream and `/api/alerts`. Getting them to
  app.ether-cast.com needs the backend and dashboard repos and a deploy, which needs Jeff's GO.
- **A marker on the Program Log row for an alert.** Later, with the Program Log reconciliation view (Phase 6).
- **`songs.last_played_at` written on every play "as display".** The only writer (`songsMarkPlayed`) writes a full synced
  song-row mutation per play. That would add one sync mutation for every song that airs, on every machine. Nothing reads
  the value after Phase 2. **Decision for Jeff:** keep it unwritten (recommended), or write it as a local-only display
  value.
- **The station light does not change colour on an alert yet.** The light is audio-only today; tying alerts to it is a
  Phase 3 item with the light's numbers.

## Fleet note (important before any install)
v63 adds a synced column. A v62 machine quarantines every mutation stamped v63 until it upgrades (merge-engine), across
every table, as with v62. **Install the build that carries v63 on every machine on the account together** (this machine,
OVEVENTS, ovowforestmusic, ovowjensj). Never only some.

## Decisions for Jeff
1. **The ratchet's tolerance until Phase 2.** The random-pick metrics (T1, T2, T3, T8, T18) moved by up to +30% between
   two runs of the same code. Options:
   - (a) a tolerance setting, starting value proposed 10%, for those metrics only until the pick is deterministic;
   - (b) leave them out of the ratchet until Phase 2;
   - (c) take the median of 3 runs.

   And T19, a timing: the median over more calls, with the same tolerance?
2. **`songs.last_played_at`:** keep it unwritten (recommended), or write it as a local-only display value?
3. **Missed rows locked in the editors:** agreed? Before, the operator could delete a missed row.

## Runtime checks for Jeff (nothing was launched here)
1. **Build** this branch locally (tsc, `npm run build`, `npm run electron:build:win -- --publish never`). Install it on
   this machine only, after closing Ether fully.
2. **Start automation on HalloVeen and let it run an hour.** Then check:
   - the Program Log shows each song played once, stamped at its time;
   - Play History shows each play with its category;
   - Health Monitor → **Alerts** shows nothing red.
3. **Press the X on an Up Next song:** it disappears from Up Next and from the Program Log, and does not come back.
4. **Press the X on the song cued on the next deck:** that deck empties and the next song is cued.
5. **In the Program Log, try to delete a row marked missed:** it refuses, with the reason.
6. **From another machine on the LAN, open `http://<this machine>:3400/api/alerts`.** You get `{ ok: true, v: 1, alerts: [...] }`.

## Addendum, the same day: Jeff's decisions on this report (2026-10-18)
1. **"No ratchet tolerance. Give Generate a fixed random seed inside the harness so identical code gives identical numbers;
   the ratchet stays exact. Reader timing (T19): median of 3 runs against the limit setting."**
   - **The harness only, the product is unchanged:**
     - each DB copy's connection gets a seeded `random()` that takes precedence over SQLite's built-in, behind every
       `ORDER BY RANDOM()`;
     - `Math.random` is seeded;
     - the simulated week starts at the first local midnight after the newest play in the database, not at "the next top
       of the hour". The history trim keys off the same anchor.
   - **Receipt:** two full 7-day runs on this machine are identical on every test (T19 timing and the history window's
     text aside). A third full run against the fresh ratchet reports nothing worse.
   - **The ratchet was re-baselined** from the first of those runs, because the simulated week moved to the data anchor.
     T19 left the ratchet (a timing cannot be exact). It is judged as the median of 3 runs of 15 calls against the limit
     setting.
2. **"songs.last_played_at: leave it unwritten AND remove every read of it. Every 'last aired' shown anywhere is derived
   from the play record. Add to the gate: nothing reads last_played_at."**
   - **Generate** (`electron/generate-core.js`) reads this station's plays once per run, last aired by the file that aired
     (`ctx.lastAiredByFile`). The candidate query no longer selects the column. The legacy differential, `_lrpFallback`
     and break mode all use the same map.
   - **The scheduler core** (`audiod/scheduler-core.js lastSongTs`): this run's own placement first, else
     `state.lastAiredByFile`. Its unit tests now give last aired through the play record.
   - **The renderer picker** (`src/audio/loggen.ts`, the window-mode path): song rest and artist separation come from this
     station's `play_log`.
   - **The Library's "Last Played" column** (`src/App.tsx`): from library-health's per-station play-log eligibility, which
     the Library already loads.
   - **The Program Log's swap list** no longer selects a column it never showed.
   - **The last writer is gone:** `src/db/client.ts` no longer calls `songs.markPlayed` (it wrote a full synced song-row
     mutation per play). The handler `songsMarkPlayed` remains in the sync foundation with no caller.
   - **Gate (T15):** every mention of `last_played_at` in electron/, audiod/ and src/ must be on a named allowlist of the
     other tables that have such a column (spots, announcements, announcement_schedule, station_programming, the sync
     column registry). Any other is a finding with its file and line. No caller of `.markPlayed(` may exist. Today: 0 and
     0.
   - **Behaviour change (the rule):** where Generate's fallback read a song's last airing, it read the column, which was
     filled for few songs ("populated ~54/530", `separation-enforce.js:10`) and stale. It now reads the play record, so
     least-recently-played orders by what really aired.
3. **"Missed rows locked in the editors: agreed."** As built.

Gates after these changes: tsc 0 · vitest 923/923 · `test:record` 6/6 · calendar-anchor, stale-rows, window-station PASS ·
log-checker 7/7 · the gate's T15: 38 findings (was 43), `songs.last_played_at` read at 0 places.
