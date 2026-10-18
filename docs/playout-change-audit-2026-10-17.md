# Playout change audit, HalloVeen 10/17 (read-only)

Asked (Jeff, verbatim): "Audit, no changes: list EVERY change made since 4.6.58 (or the last build Jeff ran without these
problems) that touches playout, the queue/log reader, the scheduler/generator, decks, the watchdog/stall recovery, sync, or
the engine, with commit, date, what it changed, and whether Jeff approved it. Then say plainly, for each of tonight's problems
(running an hour ahead, Adult songs in Hour Two, Goo Goo Muck/Ghostbusters repeats, songs never scheduled, STRICT ignored, X not
removing songs, program log not matching), whether any of those changes caused or worsened it, or whether it's older code.
Evidence for each."

Nothing was changed. All reads were read-only: the cloud through `railway run`, inside `BEGIN READ ONLY`, and this machine's
openair.db through a readonly handle. The scripts are in the session scratchpad (`diag-hv-*.js`, `diag-local-*.js`).

## 0. What ran tonight (receipts first)

| Machine | Build | Receipt |
|---|---|---|
| **ovowforestmusic** (machine 041ceb96, profile "projector") | **1278bdeb (commit 6558e57)**, not the new 615c4632 | Its talk settings carry `bufferMs` (6558e57 or later). Every play since noon has a **blank category** (316 of 316 rows in the cloud), and 10348f4 writes the category on every play. Broadcast owner since 12:15 PM; streaming. |
| **this machine, jensj** (machine 8e8f6181) | installed Ether.exe dated **10/16 4:28 PM** (= 1278bdeb), 4.6.59 | `%LOCALAPPDATA%\Programs\Ether\Ether.exe` dated 2026-10-16 16:28. Its plays also have blank categories. |

**The new build (615c4632 / 10348f4) has not run on either machine.** So it cannot have caused anything tonight.

**Two machines aired HalloVeen with automation on today.** Grouped by engine session in this machine's copy of play_log
(the cloud's file paths are not reliable for this, because sync rewrites a path onto the receiving machine):

| Session | Machine | Aired |
|---|---|---|
| 7c0bf626 | this machine | 8:31 AM – 12:12 PM, 109 rows |
| 1aa17a0b | ovowforestmusic | 12:25 PM onward (its engine started 12:24 PM), 207 rows by 6:13 PM |
| 5cd4fe47 | this machine | **3:58 PM – 6:15 PM**, 72 rows (its engine started 3:57 PM; last health report 6:18 PM, live, not streaming) |

Ether is not running here now (checked 6:52 PM). I did not start it: my commands this session were simulations on temp
databases and the release gate. Who started it is for Jeff to say. Both machines' plays land in the same cloud play history
and the Remote app's analytics. The Remote app's Now Playing and Up Next came from ovowforestmusic, the owner since 12:15 PM.

## 1. Every change since 4.6.58 in the named areas

4.6.58 is d17f911 (10/05). Everything below is in the 1278bdeb build that is on air, except 10348f4. Approval is taken from
Jeff's quote in the commit or its doc; "no record found" means I found none, not that there was none.

| Commit | Date | Area | What it changed | Approval record |
|---|---|---|---|---|
| d17f911 | 10/05 | installer | 4.6.58: auto-logon helper ships in every installer | 4.6.58 release |
| 515698c | 10/07 | engine (audio out) | MONITOR is master of every local output, AUX included | Jeff 10/07, quoted |
| b52ca9e | 10/11 | engine staging | the engine is staged by content hash, not version label | Jeff 10/10, quoted |
| 692dffc | 10/11 | engine / watchdog | red health event when the running engine is not the installed one; reload armed only when no station is live | no record found |
| 12b3f1d | 10/11 | engine / board | the engine restores the saved board itself and reads it back | Jeff 10/11, quoted |
| 00891e4 | 10/11 | board | faders are generic | Jeff 10/11 |
| **014eda6** | 10/11 | **engine, deck load** | `_load` sends every load through the one loudness normalizer (gain only; what loads is unchanged) | Jeff's rulings 1–4, 10/11 |
| 277e750 | 10/11 | board / stream | MONITOR silent until known; one duck default; stream bitrate | Jeff's rulings, 10/11 |
| 7e218ca | 10/12 | engine (limiter) | true peaks land on the ceiling | Jeff's ruling 5 |
| 90a6a47 | 10/12 | board | the window never writes a board value it didn't get from the operator | Jeff 10/12, quoted |
| **0acf1f8** | 10/12 | **Up Next display** | feeds never move the screen; decks out of App state | Jeff (OVEVENTS), quoted |
| 721cd86 | 10/12 | stall-sense (main thread) | measures what held main; not playout | no record found |
| **fc89cc5** | 10/12 | **Up Next display, sync push** | the queue list re-renders only when the queue changes; sync push index | no record found |
| **404ad66** | 10/12 | **sync** | excluded tables (generated_schedule) never enter the send queue; one-time purge of 217,002 queued rows | no record found (doc: sync-queue-excluded-leak) |
| 6233ccc | 10/12 | sync | that purge runs only in silence | no record found |
| 02e7f80 | 10/13 | engine (duck) | duck amount only from Preferences | no record found |
| ee2d98b, 5e633d7, b111628 | 10/13–16 | engine (park listen) | park listen copy of the local mix | Park work, Jeff's requests |
| **b343fe0** | 10/13 | **sync, startup, output watchdog** | Run sync cleanup now; heavy startup work in silence; **output watchdog skips a round when main is late (no reopen)** | Jeff's GO 10/13, verbatim in doc |
| dd2274c | 10/15 | announcements | the station reports the airing announcement | Jeff's GO |
| 331e0ea, ee0ea16, 139544c, 21c7a76, 4c33ad6, d9fcba6, 6558e57 | 10/16 | engine (Park mic) | Park mic inputs, talk receiver, To stream switch, buffer | Jeff's requests, quoted |
| **10348f4** | 10/17 | **playout, log reader, Generate, Up Next X** | no row airs twice; re-cue by row; Soft hour start; separation at playout; sweepers and category in the log; the X stays out | Jeff's GO, verbatim. **Not installed anywhere** |

**Nothing in this list touches what is chosen to play** in the build on air, except 10348f4 (not installed):

| File | Changes since 4.6.57 that are on air |
|---|---|
| `audiod/loggen.js` (the log reader) | none |
| `electron/generate-core.js` (Generate) | none; last change bb32265, 10/04, inside 4.6.57 |
| `audiod/scheduler-core.js` | none |
| `electron/separation-enforce.js` | none |
| `audiod/engine.js` | only 014eda6 (load gain) and 6558e57 (Park mic buffer); the queue, re-cue and stall-recovery code is untouched |

## 2. Each of tonight's problems

### Running an hour ahead: older code (log reader, August). 615c4632 does NOT fix it
- **Code:** `selectRowForNow` in the build on air: "AHEAD: nothing has arrived — the earliest future pending row is the play-early
  candidate". Its doc names this "Rider A (AHEAD = never wait, never dead air)". HalloVeen's shows cover only 3 PM–10 PM, so
  automation running at any other hour airs the evening log early, and every early row is gone by evening.
- **Receipt (this machine's log):**
  - Rows scheduled 3:11–4:59 PM were stamped played between 9:14 and 11:40 AM. For example, Latch was scheduled 3:11:50 PM and
    aired 9:14:32 AM.
  - Tonight, rows scheduled 5:04–6:24 PM aired 15–30 minutes early, and out of order. Thriller, scheduled 6:13:45, aired 5:43:42,
    before the 6:05 row.
- **ovowforestmusic:** started at 12:24 PM, 2½ hours before the first show, so the same rule applies. UNVERIFIED there. The one
  read that settles it, on ovowforestmusic:
  `SELECT scheduled_at, played_at, title FROM generated_schedule WHERE state='played' AND played_at >= strftime('%s','2026-10-17 19:00') ORDER BY played_at;`
- **No change since 4.6.58 caused it.**
- **615c4632 keeps the same rule.** Soft mode still "plays the next row early" when nothing in the hour is left, and an hour with
  no show has nothing. So it does not fix this. What should air when no show is scheduled is Jeff's decision (see the plan doc).

### Adult songs in Hour Two: older code plus data, mostly a result of running ahead
- **Clocks (synced):**
  - Hour Two, 6–7 PM, is HalloVeen-only (26 HV slots).
  - The Adult category is only in Hour Three (7–8 PM, 4 slots) and Hour Four (8–10 PM, 7 slots).
  - An Adult-category song in Hour Two can only come from running ahead into Hour Three or Four.
- **Songs that are not in HalloVeen's categories now aired anyway:**
  - On **this machine**: Problem, Havana, I Like It and The Greatest. Havana, Latch, I Like It and Survivor were generated as
    **Kids** (category 19) rows: the Havana rows at 4:22 PM today, the others at 8:49 AM. They are uncategorised now, so they
    were taken out of Kids after the logs were made. Generate does not rewrite a log after a song is re-categorised.
  - On **ovowforestmusic**: Heads Will Roll was cued on deck A at 6:55 PM. Its log rows carry category 7 (HV, made 10/14); the
    song now points at category 21, which does not exist.
- **What ovowforestmusic aired 6:18–6:51 PM:** none of the 7 Adult-category songs. E.T. (HV category) aired twice in 10 minutes
  (the replay below). Which songs Jeff heard as Adult I can't tell from here: **which songs, and on which screen?**
- **No change since 4.6.58 caused it.**

### Goo Goo Muck / Ghostbusters repeats: older code (9/14–9/16), plus duplicate songs
- **ovowforestmusic, by session:**
  - Thriller at 3:14 and 3:23.
  - Boo! / Ghostbusters at 3:40 and 3:41, then again at 3:48 and 3:49.
  - Ghostbusters at 5:54 and 6:04.
  - Goo Goo Muck at 5:48 and 5:57.
  - Since noon: **22 of 118** songs re-aired within 30 minutes.
- **This machine:** Wolves 5:06 / 5:18, Goo Goo Muck 5:10 / 5:22.
- **The cause is the replay I proved from the 10/16 engine log.** A song's go-live removed the first queue entry, not its own,
  and a re-cue left the replaced entry in the queue.
- **When it began:**
  - The re-cue came in **fb4ab4f (9/14)**, "the decks are a slave to the calendar", from Jeff's 9/14 request ("the calendar is
    always supposed to be running no matter what").
  - **995fa97 (9/16)** stopped re-cues from wedging, so from then on they completed.
  - ovowforestmusic's daily rate of same-title re-airs within 30 minutes:

    | Days | Rate |
    |---|---|
    | 8/12–8/31 | 1–4%, mostly 0–1 min doubles |
    | 9/17 | 34 of 335 |
    | 9/20 | 52 of 448 |
    | 9/25 | 84 of 595 |
    | 10/04 (before 4.6.57) | 48 of 392 |
    | 10/14 | 59 of 459 |
    | 10/16 | 55 of 403 |

- **Duplicates make it worse, in this machine's library:**
  - Goo Goo Muck is two song rows on **the same file** (#807, #808).
  - Thriller #919 / #920, Wolves #936 / #937, Jack's Lament #830 / #831 / #832, The Monster #905 / #906, and more.
  - Generate sees them as different songs; only the title rule can separate them, and it starts empty every Generate run.
- **No change since 4.6.58 caused or worsened it.** 615c4632 fixes the replay. It does not merge duplicates.

### Songs never scheduled: older code (Generate picks at random)
- **This machine's log, last 7 days:** only 4 of 155 HalloVeen songs never appeared, all sound effects.
- **ovowforestmusic's airplay 10/16–10/17:**
  - 7 music songs never aired: A Nightmare On My Street (Kids), Disturbia (Kids), Hungry Like the Wolf, Lady Gaga – Monster,
    Somebody's Watching Me (CDQ), Jacks Lament #04, hate that i made you love me.
  - Per song: median 4 plays, maximum 10 (Superstition, The Monster).
- **This machine's log has rows that never air:**
  - Dreams, ABC, A Thousand Miles and hate that i made you love me stayed pending while later rows aired.
  - Missing file or a skip: UNVERIFIED. The MISSING list on ovowforestmusic settles it (one click on the badge in 615c4632, or
    `scripts/diag-which-missing.js`).
- **Code:** Generate takes songs in `ORDER BY RANDOM()` order and keeps the first that passes. Least recently played is only the
  fallback.
- **No change since 4.6.58 touched it.**

### STRICT ignored: older code. STRICT has never been wired
- The rules are all STRICT (`is_hard = 1`): artist 60 min, song 120 min, title 120 min.
- `is_hard` is read by **no picker**: not by generate-core, scheduler-core, separation-enforce or loggen. Only Preferences shows
  it, with the words "rule is enforced absolutely, no exceptions".
- When nothing passes, Generate's fallback airs the least recently played song **whatever the rule says**.
- The log reader in the build on air checks no rule at playout, so replays break the rules too.
- **"Max songs in a row from same category"** is shown and saved, but enforced nowhere.
- **The stricter picker** (`enforce_separation`: least recently played from real airplay) exists, but no screen can turn it on.
  It is not set on HalloVeen.
- **No change since 4.6.58 caused it.**

### X not removing songs: older code. Fixed in 615c4632, not installed
- The X removes the entry from the engine's queue. With the log reader on, Up Next is rebuilt from the log every 2 s and the row
  comes back.
- The log reader flag on this machine was set 2026-08-17. ovowforestmusic's date is UNVERIFIED (the flag is machine-local):
  `SELECT created_at, updated_at FROM station_config_kv WHERE key='log_reader_flip';`
- The Up Next changes of 10/12 (0acf1f8, fc89cc5) only stopped re-renders when nothing changed. A removal changes the queue, so
  it still re-renders. Neither caused this.

### Program log not matching: older code. Mostly fixed in 615c4632, except running ahead
- **Rows stamped played at the wrong time:** on this machine, 4 PM rows were stamped played in the morning. That is running
  ahead, not fixed.
- **Replays:** a row is shown once and aired twice. Fixed in 615c4632.
- **Sweepers never stamped:** every sweeper row in this machine's log is still pending although the sweepers aired (S1 deck).
  Fixed in 615c4632.
- **Blank category on every play:** fixed in 615c4632.
- **Two machines' plays mixed** in one play history (today 8:31–12:12 and 3:58–6:15, this machine). Not a code change; see §0.
- **No change since 4.6.58 caused any of these.**

## 3. Summary

**No change since 4.6.58 caused or worsened any of tonight's seven problems.** All seven are older code:
- **August:** the log reader's "air early" rule.
- **9/14–9/16:** the re-cue that produced the replays.
- **Never built:** the rotation rules (random first; STRICT never read).

615c4632 fixes the replays, the X, the sweeper stamps and the category. It does **not** fix running ahead, the rotation rules,
STRICT or the duplicates. The rotation plan is `docs/rotation-rules-plan-2026-10-17.md`.

**Removed by this audit:** nothing; no change was made.
