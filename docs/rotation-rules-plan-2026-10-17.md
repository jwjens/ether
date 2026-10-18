# Rotation rules, wired properly: plan (nothing built)

Asked (Jeff, verbatim): "The rotation rules were never fully wired. Fix it properly (plan first, build after the show, nothing on
the air machine tonight):
1. Least recently played, from what actually aired (play history), is the primary pick for every slot in every picker, including
   break mode. Random only breaks exact ties.
2. STRICT means strict: a song that breaks a STRICT rule is never scheduled. If nothing qualifies, report it plainly and fill per a
   visible fallback setting; never silently relax. SOFT may relax and says so.
3. The rules are checked at playout too: the queue reader and the stall recovery never air a song that breaks them.
4. Replace the stale last_played_at with real play history (or keep it updated on every play).
5. Find and merge duplicate songs (Thriller, The Monster, Wolves, Jack's Lament).
6. The rotation screen must describe exactly what the code does.
Test against 10/16–10/17 HalloVeen airplay: show me the spread of plays per song before and after."

Status: **plan only.** Nothing has been built, nothing changes on the air machine, and no live database is written.

## What the code does today (receipts)

| Picker | Where | First choice | When nothing passes |
|---|---|---|---|
| Generate, clock mode | `scheduler-core.pickForCategory` (via `generate-core.js` :451) | candidates in `ORDER BY RANDOM()` order, **first that passes** song/title/artist | least recently played, rules broken, recorded only in `pick_reason` |
| Generate, break mode (clocks with timed breaks) | `generate-core.js` `selectMusic` :263 | same random-first; near a break, the closest-length song among those that pass | same fallback |
| Generate, `enforce_separation` on | `separation-enforce.pickEnforced` | **least recently played from play_log**, first that passes | relaxes in steps, flagged `relaxed` |
| Log reader floor / no log | `loggen.fillQueue` | clock slots then tier 1 `ORDER BY RANDOM()` with song and artist rules from play_log (no title rule) | tier 2/3: least recently played, rules dropped (`console.warn` only) |
| Renderer fallback (no daemon) | `src/audio/loggen.ts` | `ORDER BY RANDOM()` | random |
| At playout | log reader / stall recovery (`_resumePlayout`) | **no rule check** in the build on air (615c4632 checks the log reader only) | — |

- **"Last played":** without `enforce_separation`, Generate reads `songs.last_played_at` for anything before the run.
  - That field's only writer is the window's `logPlay` (`src/db/client.ts:147`), which is skipped in daemon mode
    (`App.tsx:2275`). Daemon mode is the default on Windows.
  - On this machine, of HalloVeen's 155 songs: **75 never stamped, 80 older than their real last airplay (up to 81 days), 0
    accurate**. The newest stamp is 9/30.
- **`enforce_separation`** is not set on HalloVeen, and no screen can turn it on.
- **STRICT/SOFT** (`separation_rules.is_hard`) is read by no picker.
- **"Max songs in a row from same category"** is shown and saved, but nothing enforces it.

## The plan

### 1. One picker, least recently played first, everywhere
- **One function** (extending `separation-enforce.pickEnforced`, which already does least recently played from play_log) makes
  every music pick:
  - Generate (clock mode and break mode);
  - the log reader's floor fill (`fillQueue`, `fillQueueEnforced`);
  - Generate's replacement of a row;
  - the renderer fallback (`loggen.ts`).
- **Order:** last aired from **play_log**, merged with the picks already made in this run. Never aired comes first. Random only
  among songs with exactly the same last-aired time, which in practice means only songs that have never aired.
- **scheduler-core keeps its shape:** its tier 1 becomes this ordering. The differential comparator (`_legacyPickMusic`) is
  retired once both sides use it.
- **Break mode, a decision for Jeff:** anchor-fit (picking the song whose length lands the break on its minute) cannot also be
  "least recently played, random only for ties".
  - **(a) Recommended:** fit only among the **3 most overdue** songs that pass, said in the row's reason ("fit for :20 break, 2nd
    most overdue"). Rotation stays least recently played within 3 places, and breaks still land.
  - **(b)** Pure least recently played. Breaks drift, shown as break-drift health events as today.
- **`enforce_separation` stops being an option:** this becomes the only behaviour. The key is left in place and no longer read.

### 2. STRICT means strict, SOFT says so
- **Each rule's STRICT/SOFT is read by the picker** (song, title, artist, and per-song `no_repeat_hours`).
- **STRICT:** a song that breaks it is never placed.
- **SOFT:** may be broken only when nothing else passes. The row says which rule and by how much ("same artist 42 min after,
  rule 60"), in the Program Log and in `pick_reason`.
- **When nothing passes the STRICT rules,** a visible per-station setting, **"When no song passes the STRICT rules"**, decides
  what happens:
  - **Leave the slot empty:** the log is shorter, and the hour fills from the next rows.
  - **Play from a fallback category:** chosen in the setting, still under the STRICT rules.
  - **Play the least-broken song, and say so:** STRICT is broken only by this explicit choice.
- **The starting value is Jeff's** (no hidden defaults). Every time it fires, it is a health event and a line in the Program Log
  naming the slot, the rule and what was done.
- **"Max songs in a row from same category":** enforce it, or take it off the screen. Jeff's choice. Recommended: enforce it,
  since it is already seeded and shown.

### 3. Checked again at playout
- **615c4632** already re-checks the song/title/artist rules in the log reader (`separationAtPlayout`).
- **To add:** the same check on every path that puts a song on a deck:
  - the floor fill;
  - stall recovery (`_resumePlayout`, both its cued-deck and queue branches);
  - `handleLoadNext`;
  - PLAY NOW from the queue.
- **On a STRICT break at playout:** the row is marked **missed** with the reason, and the next row that passes plays.
- **On a SOFT break at playout:** it airs, and the play is noted as relaxed.
- **An operator's manual load of a specific song is never refused.** It is the operator's choice, logged as such.
- **Two machines, a decision for Jeff:** play_log syncs, so the rules would count both machines' plays (today this machine aired
  HalloVeen too).
  - **Recommended:** count only plays from the broadcast owner, so a standby or test machine cannot block songs on air.

### 4. Real play history replaces last_played_at
- **Every picker reads last-aired from play_log** (one indexed query per run: `MAX(played_at)` grouped by file, artist and title,
  as `buildRestMaps` does), never `songs.last_played_at`.
- **The daemon's play logger also stamps `songs.last_played_at` / `play_count`** on every play, so the library screen's "last
  played" column is true. It is display only.
- **The index needed:** `play_log(station_id, file_path, played_at)`. Checked with the runway-style timing receipt so Generate
  does not slow down.

### 5. Duplicates found and merged, in the app, by the operator
- **Found:** a **Duplicates** view in the Library groups songs by the same file, or the same normalised title plus artist with
  length within 2 s.
- **This machine's HalloVeen library** (same file or same title, artist and length):

| Song | Copies |
|---|---|
| Goo Goo Muck | #807 / #808 (same file) |
| Thriller | #919 / #920 |
| Wolves | #936 / #937 |
| Jack's Lament | #830 / #831 / #832 (same file name; #830 is tagged All-American Rejects) |
| The Monster | #905 / #906 (#904, Chris Bacon, is a different song) |
| I'm In Love With a Monster | #828 / #829 |
| Kidnap The Sandy Claws | #840 / #841 |
| On Our Own | #866 / #867 |
| Remember Me (Mayday Parade) | #882 / #883 |

- **Not duplicates** (shown, not merged): Monster Mash (Goofy / Pickett), Poor Unfortunate Souls (McCarthy / Carroll), Grim
  Grinning Ghosts (two versions), A Nightmare On My Street (Kids / Will Smith), Disturbia (Kids / Rihanna), Munsters Theme (48 s /
  174 s), Men In Black.
- **Merged:**
  - The operator picks the one to keep.
  - Future log rows are re-pointed to it.
  - The others are deleted through the songs mutation path, so sync carries it.
  - History stays: play_log keys on the file.
  - Never by an external script on a live database.
- **Rotation treats one file as one song** even before a merge: last-aired is by file, so the two Goo Goo Muck rows share it.

### 6. The screen says what the code does
- **Preferences → Music Scheduling Rules is rewritten** to the shipped behaviour:
  - "Songs are picked least recently played first, from what actually aired."
  - "STRICT: never broken; if no song passes, [the fallback setting] decides and it is reported."
  - "SOFT: broken only when nothing else passes, and the log says so."
  - "Checked when the log is made and again just before each song plays."
- **New help doc:** `docs/help-music-scheduling-rules.md`, reachable from the screen.

### Not in this plan, but tonight's first problem
**Running ahead** is the log reader's "air early when nothing is due" rule, and 615c4632 keeps it. It needs Jeff's decision, as
it overrides his earlier "never wait, never dead air" (Rider A):
- **Recommended:** in an hour with no show, the reader **never takes a later hour's rows**. It fills from rotation under these
  rules, and the log stays for its own hour.
- In an hour **with** a show that runs short, the next hour may start early, as now.

## Test (after the build, on copies only)
1. **Inputs:**
   - ovowforestmusic's real airplay 10/16–10/17 from the cloud, by session, as the play history;
   - a **copy** of HalloVeen's database (categories, clocks, rules, library).
2. **Generate 10/16–10/17** in that copy with today's code and with the new code, and play both through the hour-change
   simulation (`audiod/sim-hour-change.js`, real engine).
3. **Report, before and after:**
   - plays per song (minimum, median, 90th percentile, maximum, never played), per category;
   - every rule break, as STRICT / SOFT / fallback;
   - re-airs within 30 minutes;
   - break drift.

**Before, from real airplay** (ovowforestmusic 10/16–10/17, matched to this machine's copy of the library):

| Measure | Result |
|---|---|
| Music files matched | 123, 473 plays |
| Plays per song | min 0, 10th percentile 1, median 4, 90th percentile 6, max 10 |
| Never played | 7 |
| Songs by play count | 0: 7 · 1: 13 · 2: 10 · 3: 26 · 4: 21 · 5: 18 · 6: 17 · 7: 6 · 8: 3 · 10: 2 |
| Most played | Superstition 10, The Monster 10, I Put a Spell On You 8, Thriller 8, E.T. 8 |
| Same title re-aired within 30 min (ovowforestmusic, since noon 10/17) | 22 of 118 |
| Aired but not in HalloVeen's categories now (music) | 26 files, 47 plays |

## Decisions needed from Jeff
1. Break mode: (a) fit among the 3 most overdue (recommended), or (b) pure least recently played.
2. "When no song passes the STRICT rules": the starting value (leave empty / fallback category / least-broken, said).
3. Max songs in a row from same category: enforce (recommended) or remove.
4. Count only the broadcast owner's plays for the rules (recommended) or every machine's.
5. Running ahead: in an hour with no show, fill from rotation and never take a later hour's rows (recommended)?

## Architecture compliance
- **ONE-scheduler model:** scheduler-core stays the authority. This makes its tier 1 least recently played rather than adding a
  picker.
- **Log-reader flip:** generated_schedule stays the playout source. The playout check marks rows missed and never rewrites the
  log.
- **No hidden defaults** (memory rule): every new choice is a visible setting with Jeff's starting value.
- **Christmas-leak guard:** `getFormatCategoryIds` is unchanged; every pick stays inside the active clocks' categories.

**Removed by this plan, if built:**
- random-first picking (`ORDER BY RANDOM()` as the first choice in Generate, the fill and `loggen.ts`);
- the `enforce_separation` option (it becomes the only behaviour);
- the picker's reads of `songs.last_played_at`;
- the differential comparator `_legacyPickMusic`;
- the current STRICT/SOFT wording on the screen.
