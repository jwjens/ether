# Scheduler gate on its own test stations: the 1018 installer (2026-10-18)

The gate no longer reads any installed station. It builds two test stations on a blank database
(scripts/lib/gate-fixture.js). An installed database lends only its schema, and the app's migration chain runs on top.

- **FX-EVENING:** a show from 15 to 21 and a late show from 21 to 22 on another clock, with no programming outside those hours. Rules: song 120, artist 60, title 120 min. A 5-song category is placed in every third slot, which forces UNSCHEDULED slots. Two songs carry no-repeat hours. Artist credits are joined, and titles include "(Live)" and "- From" variants.
- **FX-ALLDAY:** an all-day show with timed spot breaks at :20 and :40. Rules: song 90, artist 45, title off. One recording sits on two song rows under two paths.
- Both stations have two days of history. Automation starts at 12:25, before the log. Generate runs while on air. The X, re-cues and failed writes are covered in test-record-phase1.js.

## Installer

`C:\openair-wt\release-1018\dist-electron\Ether Setup 4.6.59.exe`
- 174,971,189 bytes
- sha256 `32479ebcba43e312a360e9551e50a15af1a39f734ad5b2818abdd7c126948797`
- commit 032c111 (release/1018 = sched/one-scheduler 21c5f83 + ui/screen-builder 8026921)
- schema v63 + v64: install on both machines together
- verify-packaged: RELEASE GATE PASS

## Finding: T3 fails (count spread), and the cause is the reader's catch-up, not the pick

On FX-ALLDAY (1-day run, 2 AM):
- Hour 1 ran 27 s short, so the fill put a 261 s song in at 1:59:33. The 2:00 head joined at 2:04:05, which is correct.
- The reader's existing catch-up (anchor to the latest arrived row, retire the earlier ones) then stamped the 2:04:24 song **missed**. At 2:22, with the station 80 s late, it stamped two **spots** missed.
- The missed song's next planned row was hours away. Other songs got their second airing first, so T3 fails.

The catch-up rule is existing reader design (hour-join.test.js, "the reader's ordinary catch-up is unchanged"). Changing it is Jeff's call. It is not changed here.

Also seen: T18. Timed breaks start up to 23 min off their minute; this is the same lateness.

## Not possible as specified

A show change at 9:30: `shows` has only `start_hour` / `end_hour`, so shows change on the hour. The test station changes shows at 21:00.

## Late-hour scenario: today's engine vs 6558e57 (the build on air)

Same fixture station and same log: the 1 AM hour ends 62 s short of 2:00, the 2 AM hour is back-to-back songs with two
spots at 2:22, and every element plays exactly its planned length. Driven through each checkout's real engine
(DaemonEngine) by a scratch copy of test-record-phase1.js. This is a harness result; on-air behaviour is UNVERIFIED.

| | 6558e57 (on air) | 032c111 (1018 build) |
|---|---|---|
| 2:00 hour joined | 2:15:39 (15 min 39 s late) | 2:01:58 (1 min 58 s late) |
| planned songs dropped ("missed") | 6 (1:55:30, 2:08, 2:12, 2:15, 2:19 ×... see run) | 0 |
| planned spots dropped (of 2 at 2:23) | 1 | 2 |
| fill rows not aired | none (no fill) | 3 (1 skipped, 2 missed) |
