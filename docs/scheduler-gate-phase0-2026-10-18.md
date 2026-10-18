# Scheduler gate, Phase 0: today's code against the tests (2026-10-18)

Design: `docs/scheduler-rotation-playout-design.md` §4 (tests) and §5 Phase 0. Branch `sched/one-scheduler`, from 6558e57 (the
build on air). **Nothing in the product was changed.** This is the harness, the checker and the ratchet, run against today's
code.

## In plain words
- **The gate works:** it catches every problem from 10/16–10/17 on today's code.
- **Ran:** 7 simulated days on each of the 4 stations with shows on this machine (Fall VIbes has none), plus the scenarios and
  the static checks.
- **Every test the design expected to fail, fails.** T1, T2, T3, T5, T8, T10, T11, T15, T16, T18 and T19 fail on every station
  they apply to.
- **T4 fails on HalloVeen only.** It is the one station that runs ahead, and the 6:10 PM regenerate deleted 67 rows that had
  already aired.
- **T18 does not apply** to Open Format and Magical Forest: their clocks have no timed breaks.
- **T8 was checked by hand and is real** (below).
- **The ratchet** (`scripts/fixtures/scheduler-gate-ratchet.json`) now holds these numbers. A later build that is worse on any
  of them fails.

## Results (run `scheduler-gate-2026-10-18T17-45-18-198Z`, 7 days, seed 1, 200 s)
```
FAIL  T1   station 1: 1945 separation violations on air, 2384 in the log ({"artist":56,"song":1879,"title":10} / {"song":2326,"artist":54,"title":4})
FAIL  T1   station 2: 4391 separation violations on air, 437 in the log ({"artist":868,"song":1743,"title":1780} / {"song":171,"title":187,"artist":79})
FAIL  T1   station 3: 5 separation violations on air, 0 in the log ({"song":5} / {})
FAIL  T1   station 4: 4843 separation violations on air, 5556 in the log ({"artist":1239,"song":3560,"title":44} / {"song":4122,"artist":1400,"title":34})
FAIL  T2   station 1: of 2919 picks, 2346 broke a rule and 515 were not the longest-waiting song that passed; 0 UNSCHEDULED slots exist (2319 slots had no passing song and got one anyway)
FAIL  T2   station 2: of 1168 picks, 247 broke a rule and 835 were not the longest-waiting song that passed; 0 UNSCHEDULED slots exist (158 slots had no passing song and got one anyway)
FAIL  T2   station 3: of 3795 picks, 0 broke a rule and 3734 were not the longest-waiting song that passed; 0 UNSCHEDULED slots exist (0 slots had no passing song and got one anyway)
FAIL  T2   station 4: of 4156 picks, 4112 broke a rule and 36 were not the longest-waiting song that passed; 0 UNSCHEDULED slots exist (4091 slots had no passing song and got one anyway)
FAIL  T3   station 1: 1028 go-lives pushed a category past spread 1 while a lower-count song was free (D1 exceptions: 1150); worst spread 24
FAIL  T3   station 2: 2748 go-lives pushed a category past spread 1 while a lower-count song was free (D1 exceptions: 34); worst spread 125
FAIL  T3   station 3: 3200 go-lives pushed a category past spread 1 while a lower-count song was free (D1 exceptions: 1); worst spread 49
FAIL  T3   station 4: 864 go-lives pushed a category past spread 1 while a lower-count song was free (D1 exceptions: 2574); worst spread 13
PASS  T4   station 1: of 2156 non-pending rows, Generate deleted 0 and changed 0
FAIL  T4   station 2: of 505 non-pending rows, Generate deleted 67 and changed 0
PASS  T4   station 3: of 3579 non-pending rows, Generate deleted 0 and changed 0
PASS  T4   station 4: of 3526 non-pending rows, Generate deleted 0 and changed 0
FAIL  T5   station 1: automation at 12:25 with the log starting at 3 PM — 40 evening rows aired before 3 PM (of 143)
FAIL  T5   station 2: automation at 12:25 with the log starting at 3 PM — 61 evening rows aired before 3 PM (of 162)
FAIL  T5   station 3: automation at 12:25 with the log starting at 3 PM — 52 evening rows aired before 3 PM (of 187)
FAIL  T5   station 4: automation at 12:25 with the log starting at 3 PM — 14 evening rows aired before 3 PM (of 228)
FAIL  T8   station 1: 43 of 2506 go-lives aired a row before its hour began (up to 2 min early); 0 off-log floor plays
FAIL  T8   station 2: 3634 of 3683 go-lives aired a row before its hour began (up to 7112 min early); 2339 off-log floor plays
FAIL  T8   station 3: 68 of 3308 go-lives aired a row before its hour began (up to 2 min early); 0 off-log floor plays
FAIL  T8   station 4: 124 of 3978 go-lives aired a row before its hour began (up to 3 min early); 0 off-log floor plays
FAIL  T10  station 1: "Don't Stop Me Now - Remastered 2011" placed again right after it aired (song rule 120 min) — the reader AIRS it next, 3 min after it aired
FAIL  T10  station 2: "Thunder" placed again right after it aired (song rule 120 min) — the reader AIRS it next, 3 min after it aired
FAIL  T10  station 3: "Frosty the Snowman" placed again right after it aired (song rule 60 min) — the reader AIRS it next, 2 min after it aired
FAIL  T10  station 4: "Winter Wonderland" placed again right after it aired (song rule 180 min) — the reader AIRS it next, 2 min after it aired
FAIL  T11  station 1 (simulated): 2506 of 2506 plays carry no log row id, 2506 music plays no category
FAIL  T11  station 2 (simulated): 3683 of 3683 plays carry no log row id, 3188 music plays no category
FAIL  T11  station 2 (this machine's record, 10/11, 10:46 AM → now, 142 hours with plays): 5418/5418 plays without a log row id, 2871 music plays without category, 0 rows stamped aired with no play, 2128 sweeper plays vs 0 sweeper rows stamped
FAIL  T11  station 3 (simulated): 3308 of 3308 plays carry no log row id, 3308 music plays no category
FAIL  T11  station 4 (simulated): 3978 of 3978 plays carry no log row id, 3680 music plays no category
FAIL  T15  43 findings: registry ABSENT; enforce_separation read at 2 places; last_played_at by the pick at 5; no_repeat_hours at 4; max_same_category at 0; break length fit at 12; baked rule defaults at 4; baked timing numbers at 14; is_hard (STRICT) is read by NO picker — the STRICT button decides nothing
FAIL  T16  6 modules choose songs; ORDER BY RANDOM() at 6 places
N/A   T18  station 1: not applicable — this station's clocks have no timed breaks
FAIL  T18  station 2: 168 of 168 timed breaks started outside ±30 s; of the 0 aired inside their own hour, 0 were off (up to 0 s late, 0 s early)
N/A   T18  station 3: not applicable — this station's clocks have no timed breaks
FAIL  T18  station 4: 206 of 298 timed breaks started outside ±30 s; of the 227 aired inside their own hour, 169 were off (up to 1252 s late, 244 s early)
FAIL  T19  station 1: the reader takes 19.1 ms a call (max 22.4 ms, 15 calls, 25901 log rows) against a limit of 10 ms, inside the 250 ms air loop
FAIL  T19  station 2: the reader takes 66.2 ms a call (max 79.8 ms, 15 calls, 82795 log rows) against a limit of 10 ms, inside the 250 ms air loop
FAIL  T19  station 3: the reader takes 32.8 ms a call (max 39.5 ms, 15 calls, 58571 log rows) against a limit of 10 ms, inside the 250 ms air loop
FAIL  T19  station 4: the reader takes 141.8 ms a call (max 191.8 ms, 15 calls, 111019 log rows) against a limit of 10 ms, inside the 250 ms air loop

not run in Phase 0 (need the engine or a scenario not yet built): T6, T7, T9, T12, T13, T13a, T14, T10's replay and stall parts

ratchet: nothing worse (entries written as each station finished)
```

What the station numbers are:
- **Station 1** = Open Format, **station 2** = halloVeen, **station 3** = Magical Forest, **station 4** = Christmas in Jully.
- **The "this machine's record" line** is the real play history on this computer, for the last 7 days: 142 hours with plays.
  It is a test machine, not the air machine. The other stations had no plays here in that window.
- **T19 is measured on the copy as it is**, before anything on it changes. The copy is compacted by `VACUUM INTO`, so the live
  file is slower: read-only on the live file, Christmas in Jully's `selectRowForNow` took 286 ms (2026-10-17). Jeff's figure is
  240 ms per call inside the 250 ms air loop.
- **Generate's own `ORDER BY RANDOM()` cannot be seeded.** A rerun moves the picker numbers a little, so the ratchet may need a
  margin once Phase 2 makes the pick deterministic (ties excepted). Today it is exact.

## T8 checked by hand (Jeff, 2026-10-18): real, not a harness artifact
- **The run:** a 1-day run on halloVeen, copies kept, then `scratchpad/verify-t8.js` against the copy.
- **Three "ahead" plays, the largest included.** Each is the log row, when it was scheduled, and when the reader aired it:

| Log row | Scheduled for | Aired at | Reader's mode | Log rows in the hour it aired |
|---|---|---|---|---|
| 599900 GC Sponsorship | Sun 10/18 3:00 PM | Sun 10/18 11:00 AM | ahead | 0 |
| 600104 Bad Blood | Mon 10/19 4:47 PM | Sun 10/18 11:03 PM | ahead | 0 |
| 598804 GC Sponsorship | Wed 10/21 3:00 PM | Mon 10/19 10:45 AM | ahead | 0 |

- **Each play** has its `play_log` row at that second, and the log row is stamped played at that second.
- **Why it happens:**
  - halloVeen's shows run 3 PM–10 PM, so 17 hours a day have no log rows.
  - In those hours today's reader returns mode `ahead` and the earliest future row (`audiod/loggen.js:318-320`).
  - The engine airs it ("never wait", `engine.js:1483-1488`).
- **The 52-hour one** (row 598804) was written by Jeff's real Generate on 10/17 at 4:22 PM. The reader reached it after
  burning through the run's own days.
- **In the 7-day run** this ran the log out: 2,339 off-log floor plays. The largest gap, 7,112 min, is the same mechanism
  continued.
- **This matches the 10/17 receipts:** on this machine, the 3–5 PM rows aired in the morning.
- **Small ahead counts on stations 1, 3 and 4** (43, 68, 124, up to 2–3 min) are the same rule at the top of the hour. A song
  ends before :00, nothing is due, and the next hour's first row airs early.

## How the gate works

**Files (branch `sched/one-scheduler`, from 6558e57, the build on air):**
- `scripts/lib/log-checker.js`: the independent checker. It requires nothing from `electron/` or `audiod/`. Every rule in it is
  written from the design's words: song (by recording), every credited artist, the normalised title; the pick (longest waiting
  among the songs that pass); the count proof with decision D1.
- `scripts/lib/log-checker-selftest.js`: the checker's own test (7 cases, including per-song no-repeat-hours). The judge is proven before it judges.
- `scripts/test-scheduler-gate.js`: the harness.
- `scripts/fixtures/scheduler-gate-ratchet.json`: the ratchet. Today's numbers are the worst a later build may have.
- `npm run test:scheduler-gate` runs the checker's test, then the gate.

**What runs is the product's own code, not a copy of it:**
- **Generate:** `electron/generate-core.js` (`buildScheduleCtx` + `generateDayRows`, hour by hour, as `_generateDayChunked`
  does). Then main.js's own `_commitDayRows` and `retireStaleScheduleRows`, lifted out of `electron/main.js` by name at run time
  and run as they are.
- **The reader:** `audiod/loggen.js` `readLogAnchored`, the playout source on every flipped station. Every station on this
  machine has `log_reader_flip=1`. `fillQueue` is used only if the log runs out.
- **The record:** `audiod/playlog.js` `logPlay`. The engine's two stamps, playing/played (`engine.js:1876-1884`) and missed
  (`engine.js:1445`), are two SQL statements, copied word for word.

**What is modelled, not run:**
- **The decks and queue.** One row goes live per seam: the row the reader names first. The engine plays the log in order
  (`engine.js:1503`).
- **Song length on air** is the planned length ±10%, seeded.
- **Audio files are not opened.**
- **Sweepers are not placed** (`_placeJingles` lives in main.js beside the write and was not lifted).
- **Generate's own `ORDER BY RANDOM()`** cannot be seeded, so two runs give slightly different numbers. That is itself a
  finding (T16).

**The simulation, per station:**
1. Run each station in its own process, with its own two copies. Its table, JSON and ratchet entry are written the moment
   it finishes, and its copies are deleted then (Jeff, 2026-10-18).
2. Start at the next top of the hour.
3. Generate the week, the way the Calendar's Week button does: one context, each day from its effective start, committed per day.
4. Air it for 7 days, one go-live per seam.
5. Regenerate the day on air at 6:10 PM, as Jeff did on 10/17.
6. The checker then judges what aired and what was planned.

**Two scenarios on a second copy:**
- **T5:** automation started at 12:25 PM on a day whose log starts at 3 PM.
- **T10:** the next row of the log becomes the song that just aired, as a swap, a sync or a bug can do, inside the song rule.

**Safety:**
- **Never the live file.** Each database is copied with `VACUUM INTO` from a read-only handle into the OS temp folder, and the
  copies are deleted at the end.
- **Changes made on the copies only:**
  - `ANALYZE`;
  - no fsync;
  - log rows that are already history and more than 2 days old are removed.

  Nothing the reader, Generate or the commit decides reads those rows, so results do not change. This machine's own record
  (T11) is read before anything is touched.
- Ether was closed on this machine for the whole run.

## Not run in Phase 0
- **T6, T7, T9, T12, T13, T13a, T14,** and T10's replay and stall parts. They need the engine's deck and queue machinery (a
  private daemon, as `scripts/test-cart-exhaustion.js` does) or a scenario not yet built. They come with the phase that builds
  each fix.
- **The release gate (`audiod/verify-packaged.js`) does not call this harness yet.** Today's code fails it by design, so wiring
  it in now would block every release, including an urgent one. It is wired in at the end of Phase 2, when its tests can pass.
  `npm run test:scheduler-gate` runs it by hand.
- **T17** (the 10/16–10/17 health replay) still needs ovowforestmusic's database copy and health log.

## Decisions recorded with this run (Jeff, 2026-10-18)
- **Per-song "no repeat hours": KEEP.** It is enforced by the same rules module and counted by the checker (design §3.2, 2a;
  §3.12 3b). No song on these four stations carries a value today, so it changed no number above.
- **Phase 3: nothing on the air loop waits on the database,** with a new test T19 whose limit is a setting (design §5
  Phase 3, §3.11, §4).
