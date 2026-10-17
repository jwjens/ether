# HalloVeen playout findings (10/16) + the queue X: plan, nothing built (2026-10-17)

## Jeff (verbatim)

> Live findings from ovowforestmusic (HalloVeen, 10/16), read from the installed app and its database. Fix the causes in
> code, test them, and put them in the next installer. Plan in plain words first.
> 1. Top-of-hour replays (7, 8 and 9 PM: GC Sponsorship, Freaks Come Out at Night, Somebody's Watching Me, Superstition,
>    Bésame mucho). Near the end of an hour the queue pulls the next hour's opening rows in early (8:55), and they air, but
>    their schedule rows are never marked played. They stay "pending", and at the hour selectRowForNow (audiod/loggen.js)
>    plays them again.
>    a. Root cause: a schedule row must be marked played the moment a deck goes live with it, every time, including early
>       pull-ins. Trace and fix it in audiod/engine.js.
>    b. Safety net: selectRowForNow and readLogAnchored must never play a row whose song/title already aired within the
>       station's separation rules (halloVeen: 120 min song, 120 min title, 60 min artist). Mark it missed and move on. The
>       separation rules apply at playout, not only when the schedule is built.
> 2. Songs dropped at the end of the hour (Tie the Knot Tango, Sweet but Psycho, We Don't Talk About Bruno at 8:55). Why
>    does the queue jump to the next hour early and drop the end of the current one? Find the setting or logic. Research
>    how Zetta/NexGen handle hour fill and soft vs hard hour starts; don't guess. Propose the fix, with any timing as a
>    visible setting.
> 3. Sound effects (sweepers paired with songs) play on air but are never marked played in the log (111 pending, 91 missed
>    on 10/16). That makes the log drift from the queue. Mark them played when they air.
> 4. Every play-history row since about 4:47 PM on 10/16 has a blank category. Stamp the real category on every play.
> 5. The Program Log and Calendar open on the last date viewed (e.g. Oct 9). They should open on today.
> 6. The status bar shows "22 MISSING". List them, and include Disturbia_-_Rihanna.mp3 (missing from the catalogue folder)
>    and the 4 tracks with no cloud file key (Disturbia, Five Nights at Freddy's, Grave Wanderer, Toxic).
> Test 1 and 3 with a simulated hour change that pulls rows in early: no row may air twice, and the log must match what
> actually played.

Then: "after your done" (after the Remote-app announcements task). Then:

> for some reason now when i click x in the queue on a song it doesnt cut the song from the queue

## New evidence: the replays happen all evening, not only at the top of the hour

HalloVeen's play history for 10/16, 6:44–9:15 PM (cloud `station_play_history` and this machine's synced `play_log`,
both read-only, 102 rows). **One engine session** (`94669526…`) aired all of it, so this is one machine, not two.

Songs aired twice, about 4–10 minutes apart:
- Superstition 6:55, 6:59.
- Sidney's Lament 7:18, 7:25.
- Jack's Lament 7:19, 7:29.
- I Put a Spell On You 7:22, 7:32.
- Doctor Finklestein 7:26, 7:35.
- Somebody's Watching Me 8:00, 8:10.
- Bésame mucho 8:04, 8:13.
- Haunted Heart 9:04, 9:11.
- Anthem 9:07, 9:14.
- Freaks Come Out at Night 7:03, 8:55, 9:04. At 9:04:21 it started, and 8 s later Haunted Heart started.

This fits rows that air but stay `pending`: the anchored reader keeps reading them back as not yet played. So the fault
is in ordinary playout, not only in the early pull-in at :55.

## Plan, in plain words (nothing built; waiting for GO)

### 1. Replays

**Found in code:**
- The only thing that marks a row played is `_shadowStampPlayhead` (`audiod/engine.js:1872`).
  - It runs a moment *after* the deck goes live (`setImmediate`).
  - It is wrapped in `try { } catch { }`, so any error is swallowed silently.
- A row that aired early can also be **replaced**.
  - `_commitDayRows` (`electron/main.js:11201`) deletes every machine row from the next top of the hour on, **whatever
    its state**, then writes fresh pending rows.
  - So an auto-extend or Generate between 8:55 and 9:00 would replace a 9:00 row that already aired at 8:55 with a new
    pending copy.
- Which of the two happened on 10/16 is **not proven yet**. Either of these settles it:
  - ovowforestmusic's engine log for 6:40–9:15 PM (the `[PLAYHEAD]`, `logreader`, `calendar re-cue` and
    `[auto-extend]` lines);
  - the simulation below.

**Fix:**
- **(a)** Mark the row `playing` in the same step that puts the deck on air, on every go-live path, early pull-ins
  included. A failed mark becomes a red health event that names the row; it is never silent again.
- **(b)** Generate never deletes or replaces a row that is `played` or `playing`.
- **(c)** Safety net, as you specified:
  - `selectRowForNow` and `readLogAnchored` check the station's separation rules against what actually aired (HalloVeen:
    song 120 min, title 120 min, artist 60 min).
  - A row that would break them is stamped `missed`, with the reason, and named in the Health Monitor.

**Test:** a simulated evening run through the real engine and the real reader, with:
- an hour change, with rows pulled in at :55;
- a Generate in the middle of it;
- sweepers.

Pass = no row airs twice, and every row's state matches the play log.

### 2. Songs dropped at the end of the hour

**Research** (sources at the end):
- Zetta uses Exact Time Markers (ETM):
  - **Soft:** the element on air finishes, then anything left up to the marker time is skipped.
  - **Hard:** the audio stops and the next element fires at the marker.
- Both act **at the marker time (:00)**, never minutes before it.
- NexGen's own documentation could not be found online. It was discontinued and replaced by Zetta, so nothing is
  claimed here about how NexGen did it.

**Ether today:**
- The anchored reader drops ("misses") every pending row whose time has passed as soon as a later row's time arrives,
  with 60 s of slack.
- The new hour starts through the hour join.
- The 10/16 history shows the 9 PM opening rows (GC Sponsorship, Freaks) airing at 8:55, so the old hour's last songs
  were stepped over **early**.
- Why it happened at 8:55 is not proven. The same engine log as item 1 settles it.

**Proposal (Zetta's soft start):**
- Inside an hour, no song is dropped only because its time has passed.
- At :00 the song on air finishes. Then the old hour's unplayed rows are marked missed and the new hour starts.
- The next hour is never pulled in before :00 while rows of the old hour are left.

**Visible settings** (Preferences, per station). You pick the starting values:
- **Hour start:** Soft or Hard.
- **Latest start for an old-hour song after :00**, in seconds.
- **Catch-up slack:** today a fixed 60 s in code; it becomes a visible setting.

### 3. Sweepers never marked played
- **Found in code:**
  - A sweeper that fires writes its play-log line (`_logJinglePlay`, `engine.js:2457`).
  - Its schedule row (`JIN`/`SWP`) is never stamped. Only deck rows are.
- **Fix:**
  - Stamp the sweeper's row `played` when it fires (the fire already carries its row id).
  - Stamp it `missed` when its seam passes without it firing.
- Tested in the same simulation as item 1.

### 4. Blank category on every play
- **Found in code:**
  - In daemon mode the engine writes the play log.
  - Its play logger always leaves `category_code` empty (`audiod/playlog.js`, the `row` object).
  - Every row in the 10/16 window is blank.
- Why it starts at about 4:47 PM: most likely the moment play logging moved to the engine on that machine. UNVERIFIED.
- **Fix:**
  - Each queue item carries its row's category (the schedule row's `category_id`, mapped to that category's code).
  - A play that isn't from the log uses the song's own category.
  - Tested on the play-log rows.

### 5. Program Log and Calendar open on an old date
- **Found in code:** this was built on purpose. `ProgramLog.tsx:74-85` saves the last date picked, per station, so the
  docked log and the pop-out agree.
- **Fix:** both open on today every time. While both are open, they still follow each other.

### 6. "22 MISSING"
- The list lives on ovowforestmusic. It can't be read from here.
- **From the cloud copy of HalloVeen's library** (read-only), 10 tracks have no cloud file key:
  - Ariana Grande, "hate that i made you love me"
  - "Hate That I Made You Love Me – LIVE… (edit)"
  - Exploration
  - Other Father Song
  - Sidney's Lament
  - Spooky, Scary Skeletons
  - E.T.
  - **Five Nights at Freddy's**
  - **Grave Wanderer**
  - **Toxic**
- Disturbia is not in the cloud copy at all.
- **Fix, in the installer:** clicking MISSING opens the list. It names each file and why it's missing: not in the
  catalogue folder, no cloud key, or both.
- The full list of 22 needs that list, or a read on ovowforestmusic.

### The queue X does nothing (new)

**Found in code:**
- The X sends `queue:remove` (`UpNext.tsx:476` → `engine.js:1948`), which takes the song out of the queue.
- With the log reader on (`log_reader_flip = 1`), the engine rebuilds Up Next from the schedule every 2 s
  (`_refillFromLog`, `engine.js:1529`).
- The schedule row is still `pending`, so the song comes straight back.
- The X on either of the two songs already cued on a deck is refused silently (`boundQids`).

Runtime UNVERIFIED. One check settles it: on ovowforestmusic, click X on a song lower down the list. Does it vanish for a
second and come back, or never move at all?

**Proposal:**
- The X marks that schedule row as removed (an operator edit, like deleting the row in the Program Log), so the reader
  leaves it out.
- On a song that's already cued, Ether either says plainly why it can't be removed there, or re-cues the deck.
- Drag-to-reorder in Up Next has the same rebuild problem and gets the same kind of fix.

## Sources (item 2)
- RCS, "Building GSelector Clocks" (ETM Soft/Hard/Hit/Reset): https://www.rcsworks.com/blog/rcs-live-building-gselector-clocks/
- Media Realm, "Integrating RCS Zetta with Powergold" (HARD/SOFT ETM field values): https://www.mediarealm.com.au/articles/integrating-rcs-zetta-with-powergold-music-scheduling/
- Media Realm (NexGen discontinued in favour of Zetta): https://www.mediarealm.com.au/articles/metaradio-rcs-nexgen-nowplaying/
