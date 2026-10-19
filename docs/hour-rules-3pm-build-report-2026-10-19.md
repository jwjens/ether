# Hour rules after today's 3 PM on OV — build report (2026-10-19)

Branch `release/1019` in `C:\openair`. Built against the installed OVEVENTS build's behaviour (b02a58b lineage).

## Jeff's report and rules (verbatim)

> Found on OV today with the installed build; fix in the one build:
> 1. At the top of the hour: the song crossing :00 plays out, then the NEW hour's first row. The old hour's remaining rows are marked didn't-play and never air in the new hour. (Today 2 PM leftovers played 3:00–3:15 instead.)
> 2. Inside a show the player never waits for a row's time. No top-of-hour gate, no on-time wait. When a row ends, the next row plays. (Today: ~6 min of dead air waiting for 3:15:33.)
> 3. Generate sees every row before a slot, including the previous hour's rows, so it never repeats a song the previous hour already has.
> 4. Regenerate starts from the next song: keep the song on air and everything played, playing, missed or placed by hand; rebuild all pending rows from the end of the song on air onward, including the rest of the current hour. Remove the started-hour skips in generate-core.js (lines 214, 220, 224 on the installed build).
> 5. No filler-song fallback or anything else the code decides.
> Test each on the test stations with the 3 PM scenario from today.

Follow-up rulings (verbatim): hand-added rows — "Plays after crossing song". "2. Auto-regenerate stays ONLY inside a scheduled show when it runs out of music. If no show is scheduled, nothing generates and nothing plays. 3. Remove the break re-placement. Every clock is generated as a full hour, so the break goes where the clock puts it. 4. Watchdog: after a stall, resume the stalled song at the exact spot it stalled. Never play a different deck." "1. The rule is: there must always be music inside a show. When no song passes the rules, take the least-recently-played song from that slot's category. Never an empty slot, never silence. … 2. (a) Log reader for everything: on for every station on every computer, retire the old path. One way to play the log, no per-machine switch."

## What changed (by rule)

| Rule | Where | Change |
|---|---|---|
| 1 | `audiod/loggen.js` readLogAnchored | An automatic row whose piece (show-hour) has ended by the time the next row would start is never offered and is marked didn't-play. A hand-added row of the crossing song's hour plays after it, even across a show change (today's 3:00 was Morning → HalloVeen Hour One). |
| 1 | `audiod/engine.js` `_releaseEndedHourRows` | A standby deck holding an automatic row of an ended hour (cued before :00) lets go of it at the hour's end; the row is stamped missed. The on-air deck and hand-added rows are never touched. |
| 1 | `audiod/engine.js` `_projectedSeamTs` | The seam is the latest-ending playing deck (the song really on air), not the outgoing one in a segue overlap. |
| 2 | `audiod/loggen.js` selectRowForNow | Nothing on air inside a show → the next pending row plays now. Only a row of another show / another day waits for its start. |
| 3 | `audiod/scheduler-core.js` loadTimeline | Generate's timeline holds every row from a day before: pending, didn't-play, refused, previous-hour rows timed past :00, hand rows. Only the pending automatic rows this run rebuilds are left out. |
| 4 | `electron/main.js` `_regenPoint` + `electron/generate-core.js` ctx.regen | Every Generate starts at the end of the song on air, inside the piece it belongs to; the clock continues after the positions already used; breaks whose time passed are not placed again. The started-hour skips are removed. `_commitDayRows` replaces every pending automatic row in the window. |
| 5 | `electron/generate-core.js` | The trailing break re-placement is removed: a break the clock never reaches is reported (`breakDrift` direction `unreached`), never moved. |
| 5 | `electron/main.js` | The 30-min sparse-heal and runway top-up are removed. The only automatic generate is `_outOfMusicRegenerate`: a scheduled show is on, its log ran out (`waiting:log-ended-inside-show`), the station's switch is ON, and this machine may generate it (designation). No show → nothing generates. |
| 5 | `audiod/engine.js` watchdog | `_recoverStall` → `_resumeStalled`: the stalled deck restarts its own song (or, if that song had ended, the log's next row on its cued deck / the same deck). If the source is lost: a loud `stalled-unresumable` error, nothing else plays. Never a different deck. |
| 5 | always music | Unchanged and kept: no song passes → least-recently-played of the slot's category (`feedback_rules_or_least_recently_played`). |
| (a) | `audiod/engine.js` `_logReaderOn()` | Always true: one way to play the log. The legacy refill is kept only as the unused `_retiredQueueRefill`. Health Monitor's canary switch → a static LOG READER badge. |

UI: Program Log switch renamed **Generate when a show runs out**; Health Monitor panel "Playout & Generate"; designation bypass banner wording.

## NOT done — needs Jeff

- **"Resume the stalled song at the exact spot it stalled"**: the native engine (`ether-audio.node`) has no seek/start-offset call. The watchdog now restarts the **same song on the same deck** (never another deck), but from the top. Exact-spot needs a native change, which can't be compiled on this machine (no MSVC) and CI builds native only on a tag. Jeff's call: tag a CI build for it, or a machine with MSVC.
- Consequence of no timer top-up: a show whose log is empty when it starts generates the moment it runs out, so there can be a few seconds of silence while that generate runs.

## Tests (all on fixtures, nothing on the air machine)

- **New: `npm run test:three-pm`** (`audiod/smoke-three-pm.js`) — today's 3 PM on a test station built on the real schema: shows Morning 9–15 and HalloVeen Hour One 15–18 on one 33-row clock, breaks :00/:20/:40, segue 3 s. **27 passed, 0 failed**: rule 1 reader (hand row → 3 PM :00 break, no leftover offered, 23 leftovers didn't-play) and engine (standby deck released at 3:00:01, hand deck and on-air deck untouched, seam); rule 2 (3:09:32 plays the 3:15:33 row at once; show change no gate); rule 3 (previous-hour past-:00, pending, didn't-play and hand rows block their songs); rule 4 (rest of hour rebuilt from 3:16:00 less segue, 28 = 33 − 5 songs, only :20/:40 breaks); rule 5 (unreached breaks reported not moved; always music, 0 UNSCHEDULED; one reader; watchdog never another deck; no timer generate).
- Scheduler gate (`npm run test:scheduler-gate`), updated to the rules: T2 checker mirrors rule 3; T5 inside-a-show → next row plays at once (rule 2); runGenerate uses main.js `_regenPoint` (rule 4). Results: T1/T2/T4/T5/T8/T10/T11/T19/T20 PASS on all stations. vs the recorded ratchet: station 2 T3 1268 → 0; station 1 T3 154 = 154. Still failing as before: T15 (static findings), T18 station 2 — **335 also on untouched HEAD**, so not from this work. Station 3 (FX-PLAYTHROUGH, not in the ratchet) T3 went 131 → 236 — a count-spread measure, cause not investigated.
- tsc 0 · vitest 118 files / 1028 tests · programlog-writes 110/110 (rule-4 cases rewritten) · hour-rollover 7/7 · hour-join (vitest) updated to rule 2.

Runtime on a real station: **UNVERIFIED** — the check is OV's next top of hour on this build (Program Log: the old hour's leftovers show didn't play; the new hour's first row follows the crossing song; no gap).

## Architecture Compliance

- ONE scheduler (`project_scheduler`, `project_log_reader_flip`): generated_schedule stays the single playout source; the reader is now the only path (flag retired per Jeff's (a)).
- Time-anchored playhead §2.7 / show-boundaries: pieces (`audiod/show-window.js`) remain the boundary — another show / another day still waits; inside a show nothing waits.
- `feedback_pd_decides_hour_behavior` / `feedback_no_hidden_defaults`: removed code-decided behaviour (break re-placement, timer top-ups, watchdog deck substitution); the only automatic generate is behind the station's own switch.
- `feedback_rules_or_least_recently_played`: kept.
- Operator rows (`source='operator'`) are never released, skipped or rebuilt.

## Help

Updated: `docs/help-program-log.md` (Fill Day, the switch), `docs/help-show-schedule.md` (How the hour plays, AUTO), `docs/help-spots.md` (top-of-hour break, unreached breaks), `docs/help-designated-generator.md`.
