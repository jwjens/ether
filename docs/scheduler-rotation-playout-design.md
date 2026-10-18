# Scheduler, rotation and playout: the design

**Date:** 2026-10-17 · **Status:** DESIGN. Nothing is built, and nothing gets built until Jeff approves it. No code was
changed for this document and nothing touched the air machine.

**Asked (Jeff, verbatim):** "NO PATCHES. NO TEMPORARY FIXES. … This must be designed correctly, to the standard an RCS Zetta /
GSelector engineer would sign off on. Write ONE design document … 1. HOW THE PROS DO IT … 2. HOW ETHER DOES IT TODAY … 3. THE
CORRECT DESIGN. One scheduler, one rotation behavior for every station, no hidden settings, no second code path, no baked numbers
… 4. PROOF … 5. Build order in phases, each with its test. Plain words at the top: a one-page summary."

The patch on P:/H: (`ether-patch-regenerate-from-next-song-2026-10-17.diff`) and the earlier fix lists are reference only.
Nothing from them was applied; the copy I had put in `docs/` was removed. Built but not installed anywhere: commit 10348f4
(installer 615c4632). This design decides what becomes of it (§5, Phase 0).

---

## Summary, in plain words (one page)

**What is wrong today, in one line:**
- Ether has three song pickers. They pick at random first, and none of them knows what actually aired.
- STRICT is never read.
- The log reader plays tomorrow's rows today when nothing is due.
- The record of what aired is incomplete.

**Result on HalloVeen, 10/16–10/17:** some songs played 10 times, 7 never played, and 22 of 118 songs re-aired within 30
minutes.

**What the professionals do:**
- **GSelector** scores every candidate song against one ranked list of rules and goals:
  - an **unbreakable** rule can never be broken;
  - a **breakable** rule is broken only when the score says it costs least;
  - when nothing can pass, the position is **left unscheduled** and reported. It is never filled with a rule-breaker.
- **Zetta** plays the log **in order**. The top of the hour is a marker in the log:
  - **soft:** the song on air finishes, then the rest of the old hour is skipped and marked skipped;
  - **hard:** the song on air is cut.
- **A short hour** is filled to the marker with **fill songs**, not by starting the next hour early.
- **Every play is sent back to the scheduler at once**, so song rest is always measured from what really aired.

**What Ether will do:**
1. **One picker for every station and every path.** Generate, Fill Day, the hour's Regenerate, auto-extend, the log reader's fill
   and the stall recovery all use it. The other two pickers and the hidden `enforce_separation` switch are deleted.
2. **The rules are obeyed.** Song, artist and title separation, in minutes from Programming preferences, per station, are
   measured against what actually aired plus what is already in the log on either side of the slot.
3. **The pick:** among the songs in the slot's category that pass every rule, take the one that has **waited longest since it
   last aired**. Random only for exact ties. Nothing else decides.
4. **If no song passes,** the slot is **UNSCHEDULED** in the Program Log and reported, with the rule that blocked it.
   - The only thing that may fill it is the station's **fallback**, a category you name, picked under the same rules and the same
     pick as every other slot.
   - If no fallback is set, or nothing in it passes, the slot stays UNSCHEDULED and alerts.
   - The scheduler never chooses another category on its own, and never reasons about what a category contains.
   - A rule is never quietly broken.
5. **Play counts are the proof, not the rotation.** A Rotation screen shows each category, its songs and their play counts. The
   release gate checks that inside every category, highest − lowest never exceeds 1.
6. **The clock is law on air.**
   - The reader never plays a row whose hour has not started.
   - A short hour is filled to the top of the hour from the hour's own clock, never with the next hour's rows.
   - Every hour of every day has a clock: a station **default clock** covers hours with no show.
   - **Spot breaks land on their time** the same way the hour does: through the station's Hour start (Soft/Hard) and the fill,
     never by choosing a song for its length. A break that still lands late or early beyond the tolerance is an alert.
7. **Starting automation early or late** plays the log row for **now**, not the first row of the log.
8. **Regenerate works on the hour on air.** It starts at the next song, as the engine reports it, never at a guessed time.
   Anything that aired is never touched.
9. **What aired is the record.**
   - Every element (song, sweeper, spot, announcement) is written to play history with its log row, category and machine, at the
     moment it goes on air.
   - The log row is stamped in the same step.
   - One log row can air only once.
10. **Every number is a setting** with a sensible starting value you can see and change. There is no hidden setting.
11. **Proof:** a release-gate test suite runs on copies of every station's database. It generates and simulates 7 days per
    station and checks them with a second, independent checker:
    - zero song, artist or title separation violations;
    - every pick was the longest-waiting song that passed (re-derived pick by pick);
    - inside every category, highest play count − lowest ≤ 1 (songs added during the run excepted; see §3.2.5 for the one case
      where the rules themselves cause 2);
    - aired rows byte-identical;
    - never ahead of the clock;
    - started-early, started-late and regenerated-on-air scenarios.

    A failure blocks the release, so this cannot silently break or be rolled back again.
12. **The health monitor is Iris's eyes** (§6).
    - One air check watches every element as it airs, with the same rules, and reports every problem as one alert: in Ether, on
      the Remote admin app and in the health log.
    - It only detects. It never decides or fixes.
    - Iris can subscribe to the same stream later.
    - A replay of 10/16 and 10/17 in the release gate proves it raises every alert.

**Where Ether differs from Zetta/GSelector on purpose** (each is your decision, see §3.12):
- **no breakable rules and no scoring:** GSelector has both; Ether obeys the rules and leaves the slot unscheduled;
- one combined scheduler + playout (not two products);
- rules are per station, not per category;
- an unscheduled position is filled only from the fallback you name; with none set it stays a hole, as in GSelector, and
  alerts.

**Decisions:** Jeff answered §3.12 on 2026-10-17 (recorded there). One is still open: per-song "no repeat hours", keep or
remove.

---

## 1. How the professionals do it

**Sources:** RCS's own pages (rcsworks.com blog, Director help) and MusicMaster's public pages.
- rcsworks.com blocks direct reads. Its text here comes from search-engine extracts of those pages, so it is paraphrased.
- The ZettaCloud **Playout Settings – Sequencer Settings** help page was read in full. It describes ZettaCloud; on-prem Zetta may
  differ.
- No public GSelector manual exists; RCS points to its in-app help.
- **UNSOURCED** marks what no public source states. It is inference and is treated as a question, not a fact.

The source URLs are listed at the end of this section.

### 1.1 Rotation and song rest
- **GSelector:**
  - **Three phases:**
    - plotting, by daypart;
    - scheduling: every candidate gets a score;
    - optimization: GSelector looks a few elements ahead, and for a week, across the whole week, for a better total score.
  - **Rest is "Min Sep"** on a field (song, artist and so on): the time before the same thing may schedule again.
  - **"Max Sep"** forces a song that has waited too long.
  - **Other rotation controls:**
    - Hour Rotation (a song must move through the other hours of a daypart before returning to the same hour);
    - Past Days / Yesterday (avoid the same slot day to day);
    - No Repeat, Drive Protection;
    - Airplay Starvation (pushes songs that have not played, around 150–200% of a category cycle).
  - **UNSOURCED:** the base candidate order, whether there is randomness, and the tie-break.
- **MusicMaster** (cross-reference): a category is a **card file**, a stack.
  - With no rules, songs play in strict stack order: the song that played longest ago comes next.
  - The scheduler looks down the stack ("search depth") for the first song that passes the rules.
  - "Optimum goals" can choose the best of that depth. Minimum rest is called "the most important rule".
- **Zetta:** does not pick songs. It plays the log GSelector wrote.

### 1.2 Artist, title and song separation
- **GSelector:**
  - **Artist fields are split into participants** on delimiters you set ("/", "&", "f/"). "A f/ B & C" is three artists, each
    separated on its own.
  - **A participant can be switched off for one song.**
  - **Artist Groups** separate artists who are not the same name (Lennon / McCartney).
  - **Title + artist identity** decides which songs are the same song.
  - **Separation is time based** (Min Sep). Sound-code segues (Pop into Pop into Pop) are also rules.
- **MusicMaster:** the same rule types exist, set in its Rule Tree.

### 1.3 Hard vs soft rules
- **GSelector:**
  - **Two kinds of rule:** **Breakable** (a passing score of 65 or more) and **Unbreakable** (score 0: the song cannot schedule
    there).
  - **Goals cannot be made unbreakable.**
  - **Rules and goals sit in one ranked Priority List.** A category can have its own list.
  - **RCS's advice:** make a rule breakable at one depth and unbreakable at a deeper one, rather than one blanket ban.
  - **UNSOURCED:** the exact formula for which breakable rule gives way first. Inferred: rank weights the score, and the
    highest-scoring candidate wins.
- **MusicMaster:** Breakable and Unbreakable folders. Typically a wider rule is breakable and a tighter copy of it unbreakable.

### 1.4 When no song passes
- **GSelector:**
  - **The position is left unscheduled.** It is never filled with a song that breaks an unbreakable rule.
  - **It is shown and explained:** the scheduler lists unscheduled positions, and a hand insert shows "Failure Details" with the
    song's score. An Unscheduled report names the unbreakable rules that blocked it (documented for Selector 12/15).
  - **Re-running the scheduler fills only the unscheduled positions.**
- **MusicMaster:**
  - **Unscheduled positions** are marked; "jump to next failure" moves between them.
  - **A Recap report** says which unbreakable rule failed and how often.

### 1.5 Hour start (Zetta)
- **Zetta's top of the hour is an Exact Time Marker (ETM)** in the log:
  - **Soft ETM:** the element on air plays to its end, then the events up to the ETM are **skipped**. Zetta records them as
    *skipped*; it does not delete them. This is the usual music-station top of hour.
  - **Hard ETM:** the element on air is cut and the next event fires at once (news joins, network).
  - **Hit ETM:** a guide only, showing how far off time the log is; it changes nothing.
  - **Reset ETM:** resets the log's air time.
- **Settings** (ZettaCloud, read in full):
  - a **Soft ETM window** (seconds early or late);
  - an event due inside the window with more audio after the ETM than before is skipped;
  - **maximum stretch / squeeze %**;
  - **"Play through Soft ETM when underfilled"**;
  - ETMs enabled in Live Assist.
- **UNSOURCED:** what Zetta does at the top of the hour when the log has no ETM. Inferred: it plays on in sequence.

### 1.6 Automation started before or after the log
- **Zetta:** Auto (every event segues), Live Assist (chains can stop), Manual. Pressing play resumes the log.
- **UNSOURCED:** whether entering Auto mid-hour resumes at the next event in sequence or jumps to the event for the clock time.
  Inferred from the ETM design: Zetta plays in sequence and comes back to time only at an ETM.
- **Zetta's "Emergency Playlist" fills hours that have no log.**
- **NexGen** (cross-reference): a station guide says Auto mode "keeps the clocks in order".

### 1.7 Running ahead or behind
- **Zetta:**
  - **On-Air** shows the ETM and the **actual gap** (over or under).
  - **Underfill:** filled from songs tagged as **ETM fill**, which start in Auto when the station is about to run out of audio.
    "Play through Soft ETM when underfilled" is an option.
  - **Overfill:** the soft-ETM skip, the hard-ETM cut, and stretch/squeeze limits.
  - **Spot blocks** have their own fill, stretch and "always fixed" settings.
- **UNSOURCED:** whether Zetta ever starts the next hour early. Not documented. At most, the play-through option might allow it.
- **WideOrbit** (cross-reference): timing targets per segment ("end at 59:50"), filled with stretch/squeeze or spread silence.

### 1.8 Regenerating or editing a log while on air
- **GSelector + Zetta "live integration"** (vendor claim): a change in one shows in the other, and a re-saved current hour is
  "automatically available in Zetta". In 5.24.1 it runs over site replication.
- **The Zetta Log module** loads one hour at a time and can regenerate, delete or copy a log.
- **Flat-file schedulers** reimport through a manual button.
- **UNSOURCED:** what a reimport does to the playing hour and to events that already aired.

### 1.9 How aired items are recorded
- **Zetta → GSelector** (vendor claim):
  - **Every play or skip is recorded in GSelector at once**, so the next scheduling uses real history. The same data feeds the
    ASCAP / BMI / SoundExchange reports.
  - **A dropped song is reconciled at once**, and its score is reset.
  - **Songs fired from hot keys count as aired.**
- **MusicMaster:**
  - **Reconciles from the automation's as-run file:** dropped songs are removed from history, added songs are added, moved songs
    get their true time, and a report lists the changes.
  - **Its advice is to reconcile after the broadcast day.**

### What no public source states (questions, not facts)
- GSelector's candidate order and tie-break.
- The break-order formula for breakable rules.
- Where Zetta resumes when put into Auto mid-hour.
- Zetta at :00 with no ETM.
- Whether Zetta ever starts the next hour early.
- What a reimport does to the hour on air.

Settling these needs RCS's in-app help or a test on a real Zetta / GSelector system. **If Jeff has access to either, those six
answers would firm up §3.**

**Sources:**
- RCS:
  - help.director.rcsworks.com …/Playout_Settings-Sequencer_Settings.htm (read in full)
  - rcsworks.com blog:
    - building-better-rotations-with-gselectors-priority-lists
    - advanced-gselector-scheduling-techniques
    - gselector-priority-list-scheduling-tips
    - gselectors-rotation-rules-window
    - gselectors-no-repeat-drive-protection
    - gselector-5-1-1-new-features
    - artist-control-then-and-now
    - tips-tricks-by-rcs-support
    - building-gselector-clocks
    - how-zetta-compliments-news-talk-formats
    - zettas-on-air-module
    - zettas-log-module-did-you-know
    - working-ahead-with-zettas-mini-logs-shows
    - zetta-gselector-live-integration
    - zetta-5-24-1-new-features
    - zettas-flat-file-assignments
- MusicMaster: musicmaster.com ?p=861, ?p=8205, ?p=2183, ?p=965, ?p=161; newsletters/1221; Nexus API reconcileElements.
- WideOrbit: segment-rulesets.
- Goshen WGCS Zetta handbook.
- KRFC NexGen guide.

---

## 2. How Ether does it today (receipts)

**The build on air** at ovowforestmusic and on this machine is **1278bdeb = commit 6558e57**. Line numbers below are from 6558e57
unless marked HEAD (10348f4, built and not installed). The 10/17 airplay figures are from `docs/playout-change-audit-2026-10-17.md`.

### 2.1 Rotation / song rest
- **Generate's first choice is random:**
  - The candidates are read `ORDER BY RANDOM()` (`electron/generate-core.js:153`).
  - scheduler-core's tier 1 takes the **first** candidate that passes (`audiod/scheduler-core.js:117-125`).
  - Break mode does the same (`generate-core.js:283-297`), or takes the closest length among the passers near a break.
- **Least recently played is only the fallback** when nothing passes (`scheduler-core.js:62-68`, `generate-core.js:189-195`).
- **"Last played" comes from `songs.last_played_at`** (`generate-core.js:174`, `:285`, and scheduler-core's `lastSongTs`), plus
  the picks made in the same run.
  - **That field is never written in daemon mode.** Its only writer is the window's `logPlay` (`src/db/client.ts:147`), skipped
    when the daemon plays (`src/App.tsx:2275`).
  - The daemon's play logger writes play_log only (`audiod/playlog.js:71`).
  - **Receipt:** of HalloVeen's 155 songs on this machine, 75 were never stamped, 80 are older than their real last airplay (up to
    81 days), and **0 are right**.
- **The run's own maps start empty** (`generate-core.js:134`), so rest across the boundary of a Generate run is not known.
  Neither are the rows already in the log after the window.
- **The floor fill** (`audiod/loggen.js fillQueue`): clock slots, then tier 1 `ORDER BY RANDOM()` (`loggen.js:192`, `:213`).
  Tiers 2 and 3 drop the rules and use least recently played from play_log.
- **The renderer twin** (`src/audio/loggen.ts:318,357,495`): `ORDER BY RANDOM()`. This is a second code path for the same job.
- **Goal mode** (`stations.scheduler_mode='goal'`, `generate-core.js:104-108`, `:502-529`): a third planner that runs in shadow
  only, plus a wider category universe in loggen (`loggen.js getFormatCategoryIds`).
- **Result, ovowforestmusic 10/16–10/17:**

  | Measure | Result |
  |---|---|
  | Plays per song | min 0, median 4, max 10 |
  | Songs never played | 7 |
  | Same title re-aired within 30 min (since noon 10/17) | 22 of 118 |

### 2.2 Artist / title / song separation
- **The rules are three numbers per station:** artist, song and title (`generate-core.js:78-83`), read with `station_id` since
  7/27.
- **Artist separation matches `artist_id` only** (`scheduler-core.js violationOf`). "Selena Gomez" and "Selena Gomez,
  Marshmello" are two different artists. There is no participant split, no artist groups and no featuring handling.
- **The title key is lower-cased and trimmed only.** "Grim, Grinning Ghosts" and "Grim Grinning Ghosts – From …" are different
  titles.
- **Song identity is the song row.** Duplicate rows for one file are two songs.
  - **Receipt:** Goo Goo Muck #807 and #808 share one file. Thriller, Wolves, Jack's Lament, The Monster, Kidnap, On Our Own,
    Remember Me and I'm In Love With a Monster also have duplicates (audit doc).
- **Per-song rest** (`songs.no_repeat_hours`) is honoured only by the hidden enforced picker and the floor fill.
- **"Max songs in a row from same category"** is seeded (`electron/seed-station-config.js:16`) and shown (`SettingsPanel.tsx:2734`
  at 6558e57), and enforced **nowhere**.

### 2.3 Hard vs soft rules
- **STRICT/SOFT is `separation_rules.is_hard`.** It is stored, synced (`electron/sync/synced-tables.js:808`) and shown, with the
  words "STRICT — rule is enforced absolutely, no exceptions" (`SettingsPanel.tsx:3288` at 6558e57).
- **It is read by no picker:** not by generate-core, scheduler-core, separation-enforce or loggen. **STRICT has never been
  wired.**
- **HalloVeen's three rules are all STRICT**, and are broken on air every evening (§2.1 receipt).

### 2.4 When no song passes
- **Generate places the least recently played candidate anyway.** All rules are bent. The bend is recorded in `pick_reason`
  (`generate-core.js:309-310`, `:462`) and `ctx.relaxed`, and is not shown as a failure.
- **The floor fill drops the rules in tiers 2/3,** with a `console.warn` only (`loggen.js` fillQueue tiers).
- **Nothing is ever left unscheduled. Nothing tells the operator that a STRICT rule was broken.**

### 2.5 Hour start
- **Since 10/04 (bb32265, Jeff's ruling)** there is no top-of-hour cut. The song crossing :00 plays out and the new hour "joins"
  after it (`audiod/hour-join.js`).
- **Catch-up is by time:** the reader takes the latest pending row whose time has come (`loggen.js:266-331`), so rows that fall
  behind are skipped and stamped missed.
- **HEAD (10348f4) adds a Soft/Hard setting** with latest-start and slack values. Not installed.

### 2.6 Automation started before or after the log
- **When nothing in the log is due,** the reader airs **the earliest future pending row**, by design: "AHEAD … the play-early
  candidate" (`loggen.js:318`; Rider A, "never wait, never dead air").
- **Receipt, 10/17:**
  - HalloVeen's shows run 3–10 PM.
  - On this machine, automation at 8:31 AM aired 3–5 PM rows between 9:14 and 11:40 AM (Latch: scheduled 3:11 PM, aired 9:14 AM).
  - ovowforestmusic started at 12:24 PM. The patch header written there gives "~47–63 min ahead all evening"; that figure was not
    read by me.
- **There is no default clock for hours without a show.** Such hours have no log, so the reader pulls the evening forward.

### 2.7 Running ahead / behind
- **Ahead:** see §2.6. **Short hour:** the next hour starts early, by the same rule.
- **Behind:** catch-up stamps the passed rows missed (`loggen.js:333+`).
- **No fill-to-time from the hour's own clock exists.**

### 2.8 Regenerating while on air
- **Generate starts at the next top of the hour:** `effStart = max(dayStart, ceil(now/3600)*3600)` (`electron/main.js:11452`,
  `:11500`, `:11574`, and Clear Day `:11255`), since 6/10 (709b67c, "never regenerate the past").
- **Every hour before it is skipped** (`generate-core.js:224`). **The hour on air cannot be rebuilt.**
- **"Regenerate from the playhead" was designed on 7/27** (`docs/instant-regen-and-rebuild-forward-design-2026-07-27.md`,
  Feature A) **and never built.**
- **Aired rows in the window are deleted.**
  - The delete removes every non-operator row in the window **whatever its state** (`main.js:11201`). A row of the next hour that
    already aired early is deleted and replaced with a fresh pending row, which can air again.
  - **HEAD (10348f4) keeps played/playing rows** (`main.js` HEAD:11210). Not installed.
- **The cued decks keep their old rows** until the re-cue notices the change (§2.10).

### 2.9 How aired items are recorded
- **play_log is written at go-live** (`audiod/engine.js:1823`), with:
  - `scheduled_log_id: null` and `category_code: null` hard-coded (`audiod/playlog.js:56`): **no link to the log row, blank
    category** since about 4:47 PM 10/16 at the latest. (HEAD writes the category.)
  - **no machine id.** Two machines airing one station are mixed together. On 10/17 this machine aired HalloVeen 8:31–12:12 and
    3:58–6:15 while ovowforestmusic was on air.
- **The log row is stamped by a "shadow" step after go-live** (`engine.js:1835`, `:1872-1884`), not in the same step as the play.
  - The 10/16 evening's replays were all stamped played and still aired twice (proved in the simulation; audit doc).
- **Sweepers:** written to play_log (`engine.js:2457`) and **never stamped on their log row**; every sweeper row stays pending.
  (HEAD stamps them.)
- **Songs:** `songs.last_played_at` is not written (§2.1).

### 2.10 Decks, replays and stall recovery
- **The calendar re-cue** (`_resyncCuedDecks`, `engine.js:2282`) came in on 9/14 (fb4ab4f, "the decks are a slave to the
  calendar", Jeff's request). 995fa97 (9/16) stopped it wedging, so from then on it completed.
- **The replays:**
  - A go-live removes the **first** queue entry (`this.dequeue()` at `engine.js:1221`, `:2047`, `:856`), not the deck's own.
  - A re-cue left the replaced entry bound in the queue.
  - Preload took position 0 of the whole queue.
  - Proved from the 10/16 engine log: 8 rows aired twice, each after a re-cue (`docs/halloveen-playout-findings-2026-10-17.md`).
  - ovowforestmusic's same-title re-airs within 30 min rose from 1–4% to 10–13% of music every day from 9/17.
- **The stall recovery** (`_resumePlayout`, `engine.js:822`) plays, in order:
  1. a hand-cued deck;
  2. a ready deck;
  3. **any idle deck that still has a file loaded**;
  4. otherwise the queue's first entry.

  It never asks whether that deck's content is the log's row for now, and it checks no rule. That is how a leftover deck track
  airs.
  - **Receipt, 10/16 engine log:** 4 stalls in 2½ hours. Each came when a song ended without the next one starting, and the
    watchdog then aired deck A's content 1 second later (01:59:40Z, 02:04:00Z, 03:50:22Z, 04:04:06Z).
  - The rotate that should have fired before the end did not; why is not established. UNVERIFIED.
- **The X:** with the log reader on, Up Next is rebuilt from the log every 2 s and the removed row comes back. (HEAD removes it
  from the log.)

### 2.11 Past fixes that were rolled back or left half-wired
| Fix | When | What happened |
|---|---|---|
| Least recently played from play_log + separation enforcement (`separation-enforce.js`) | 7/27, 2e3d2b3 (the doc calls the releases 4.4.88/4.4.89; Jeff remembers it as September) | Built **behind a per-station switch, default OFF** (`generate-core.js:90-94`). The UI toggle in its design (`RulesEditor.tsx`) was never built, and no station has it on. Hidden ever since. |
| The renderer twin of that picker (`src/audio/separationEnforce.ts`) | 7/27 | Same switch, same state. |
| Regenerate from the playhead | 7/27 design | Never built. |
| Generate's least-recently-played ladder (13df91d) | 7/06 | Made least recently played the **fallback** only. The first choice stayed random. |
| Title separation in Generate (1fde024) | 6/15 | Built. Never seeded from real airplay. |
| `songs.last_played_at` writer (`markPlayed`) | — | Only in the window path. Daemon mode, the default, never calls it. |
| Top-of-hour hard cut | removed 10/04 (bb32265, Jeff's ruling) | Replaced by the hour join. No soft/hard choice until 10348f4, not installed. |
| The calendar re-cue | 9/14–9/16 | Works, and causes the replays. Fixed in 10348f4, not installed. |
| Goal-driven scheduler (`docs/goal-driven-scheduler-redesign-2026-08-10.md`) | 8/10 | Bounded reversal of "clock is law" granted for category choice. **Shadow only**: a second planner that never airs. |

---

## 3. The correct design

**Binding rules this design follows:**
- **The user is in charge** (memory: user-controls-on-off).
- **No hidden defaults:** every on-air number is Jeff's (memory: no-hidden-defaults).
- **The clock is law** (`docs/generate-clock-law-deleted-slots-2026-07-21.md:3`; for structure, goal doc §6.1).
- **No rule outranks another unless Jeff sets it** (Jeff, this request).
- **Rotate the pool and the spacing follows** (Jeff, this request).
- **The log reader is the single playout source** (`docs/log-reader-single-source-playout-design-2026-07-20.md`).
- **Offline-first.**

### 3.1 One scheduler, one code path
- **`audiod/scheduler-core.js` is the only thing that chooses a song,** for every station and every caller:
  - Generate: day, days, Fill Day, the hour's Regenerate;
  - auto-extend / Iris (`_generateRange`);
  - the reader's fill for a short or empty hour (§3.7);
  - the playout re-check's replacement (§3.8);
  - the window's in-process fallback: it asks main over IPC, so there is no picker in the renderer.
- **Deleted when this is built:**
  - `separation-enforce.pickEnforced` (its play_log reading moves into the core's rule check);
  - the `enforce_separation` switch;
  - `generate-core.js` `selectMusic`'s own loop (break mode calls the core);
  - `_legacyPickMusic` and the differential;
  - `loggen.js` pickTier/fillQueue picking;
  - `src/audio/loggen.ts` and `src/audio/separationEnforce.ts` picking;
  - the goal-mode shadow planner, unless Jeff rules to promote goals (§3.12, decision 9).

### 3.2 Rotation: the rules, then the song that has waited longest (Jeff, 2026-10-17)

Jeff's rule replaces least-recently-played as a backbone, and the play-count rounds draft. Play counts are **only the proof**.

**The rules** come from Programming preferences, per station, with nothing baked in:
1. **Song separation:** no song plays again within the minutes set.
2. **Artist separation:** no artist plays again within the minutes set. **Title separation** works the same way.
3. **These are obeyed.** They are measured against what actually aired plus what is already in the log on either side of the slot.

**The pick:** among the songs in the slot's category that pass every rule, take the one that has **waited longest since it last
aired**. Random only for exact ties. Nothing else decides.

**If no song passes,** the slot is **UNSCHEDULED** and reported. It never quietly breaks a rule.

#### 3.2.1 What each word means in the code
- **The slot's category:** the clock slot's category. Songs in rotation, MUSIC. Daypart: see decision D3.
- **Passes every rule:** at the slot's time, for every rule:
  - **The song:** its last airing on this station (play_log, by recording, §3.5) and its nearest placement already in the log on
    either side are both at least the song separation away.
  - **The artist:** every credited artist, the same check with the artist separation. A participant split is a setting (§3.11).
  - **The title:** the normalised title, the same check with the title separation.
- **Waited longest since it last aired:** the oldest "last time".
  - While Generate plans ahead, a song it has already placed earlier in this plan counts as having aired at that placement.
    Without that, a 7-day plan would put the same longest-waiting song in every slot.
  - The record itself stays what aired.
  - A song that has never aired has waited longest. Several such songs are an exact tie, so random.
- **Random only for exact ties:** the one place randomness is used.
- **UNSCHEDULED:** a log row with no song. It names the category and, for the songs that came closest, the rule and the minutes
  short ("Kids: Kidz Bop Kids, artist 22 min, rule 60"). It is a red row in the Program Log and a health event.

#### 3.2.2 The same pick everywhere
- **Generate, Fill Day, the hour's Regenerate and auto-extend** pick with it.
- **The reader's fill for a short hour** (§3.7) picks with it.
- **The playout check** (§3.8) uses the same rules against what aired up to that second.
  - A row that no longer passes (because the air drifted, or something played in between) is marked **skipped** with the rule.
  - The pick is then run again for that slot, or the slot is unscheduled.
- **There is no other rule, weight, score or order.**

#### 3.2.3 When a slot is unscheduled, what airs
- **The log says UNSCHEDULED.** Then (Jeff, 2026-10-17):
  - **The station's fallback,** a category the user names per station, is picked with the same rules and the same pick as any
    other slot. The fill is written on the row ("fallback: Halloween Gold").
  - **No fallback set, or nothing in it passes:** the slot stays UNSCHEDULED and alerts (`unscheduled`, §6).
  - **The scheduler never fills from another category on its own.** All categories are treated identically. The scheduler never
    reasons about what a category contains.
- **Never a song that breaks a rule.**
- **"Fill unscheduled"** re-runs the pick on unscheduled slots only, for example after you add songs or change a rule.

#### 3.2.4 Play counts: the proof, not the rotation
- **No play count is read by the pick.**
- **Counts are computed from play_log:** plays per song (by recording) per category, by the station's broadcast owner.
- **They are shown and tested:**
  - **The Rotation screen** (Programming → Rotation, read-only): for each category, its songs with their aired count, last aired,
    their next row in the log, and, when blocked, why ("artist: Danny Elfman 22 min ago, rule 60"). At the top, the check:
    "highest − lowest ≤ 1 in every category" (songs added in the window are listed separately), or the category and songs that
    are off.
  - **The release gate's proof (§4, T3)** reads the same numbers.
- **Help:** `docs/help-rotation.md`.

#### 3.2.5 Said plainly: when the count check can fail with the rules and the pick both right
The longest-waiting songs are the ones with the lowest count, so the pick goes through a category in turn and the counts stay
level. **But not always.** When every song with the lowest count is blocked by a rule at that moment, the pick takes the
longest-waiting song that passes, which has already played one more time. A small category with several songs by one artist does
this:
- HalloVeen Kids has 11 songs, several of them Kidz Bop Kids, with artist separation 60 min.
- When the songs left at the lowest count are all Kidz Bop, and one just aired, the next Kids slot takes a song one count higher.
- The spread becomes 2. The rules and the pick did exactly what they say.

So the gate must tell the two cases apart (decision D1):
- **Recommended:** the gate's checker re-runs every pick on its own and fails if any pick was not "the longest-waiting song that
  passed".
  - A spread above 1 then fails the gate unless, at that moment, every lower-count song in the category was blocked by a named
    rule. That exception is listed in the report with the rule and the songs, never hidden.
- **Or:** a spread above 1 always fails, and the station changes its rules or its category until it passes.

#### 3.2.6 How this compares with the professionals
- **MusicMaster's card-file stack is the same idea.** The song that played longest ago is next; if it fails a rule, the next one
  down; an unscheduled position when none passes.
- **GSelector** adds scored goals (Max Sep, Spread, Airplay Starvation, Hour Rotation) and breakable rules on top. Ether
  deliberately has none of these. There is one pick and the rules are obeyed (decision D5).

### 3.3 Who counts as the same artist, the same title
- **Artist means every credited artist,** split on delimiters that are a station setting. Starting value: `/ & , feat. ft. f/ x
  with`. A song can switch off a participant (as in GSelector). Artist groups are a later phase.
- **Title means a normalised title:** lower case, no punctuation, with the bracketed or "– From …" tail removed. The tail rule is
  a setting.

### 3.4 (folded into §3.2.3)

### 3.5 One recording, one song
- **Separation, "last aired" and the proof's play counts are by recording, not by song row:** the file's content hash, the one the audio resolver already keys on
  (`electron/audio-resolver.js`, `local_files.content_hash`). Where a song has no hash yet, its stored file name is used. Two
  song rows on one file are one song from day one.
  - UNVERIFIED: how many HalloVeen songs carry a hash today. That is the first count in Phase 2.
- **A Duplicates view in the Library** finds:
  - the same recording;
  - the same normalised title + artist with length within a setting (starting value 2 s).

  It offers to merge: the operator picks the one to keep, future log rows move to it, the others are deleted through the songs
  writer (synced), and history is kept. **Never by script on a live database.**

### 3.6 The clock covers every hour
- **Each station gets a default clock** (setting), used for any hour with no show. **Generate fills those hours too**, so the
  log is 24 hours a day and the reader is never short of a row for now.
- **Until a default clock is set,** hours without a show are a red line in the runway, and in those hours the reader fills live
  from the last clock that aired, under the rules. It **never** plays a later hour's rows.
- **Matches Zetta's Emergency Playlist idea,** but made from the station's own clock and rules.

### 3.7 On air: the clock is law
- **The reader plays the log in order within the hour.** It never airs a row whose hour has not started, except within the
  **early-start window** (setting, starting value 0 s): a row may start that many seconds before its hour.
- **Top of the hour: the Hour start setting** (Soft / Hard, as built in 10348f4: latest start for an old-hour song 0 s,
  catch-up slack 60 s):
  - **Soft:** the song on air finishes; the old hour's unstarted rows are marked **skipped** (named "skipped", not "missed", as
    in Zetta); the new hour starts at its first row.
  - **Hard:** the song on air is cut at :00.
  - A per-clock top-of-hour type (Soft/Hard per clock, like a Zetta ETM per log) is a later option (decision 7).
- **A short hour** (the hour's rows end before :00): the core fills from **this hour's clock** (its categories, in clock order),
  under the rules, until the remaining time is less than the **fill tolerance** (setting, starting value 30 s). Then the next
  hour starts at :00. The filled songs are written to the log as fill rows, so the record is complete.
  - **Ether differs from Zetta here:** Zetta fills from songs tagged as fill. Ether fills from the hour's own clock under the same
    rules, so there is no fill library to maintain. Jeff decides (decision 6).
- **A long hour:** Soft or Hard, above.
- **Spot breaks land on their time the same way** (Jeff, 2026-10-17: the clock is law; the pick is never bent).
  - Each timed break in the clock (`clock_breaks`) is a time marker in the log, treated exactly like the top of the hour, with
    the station's Hour start setting:
    - **Soft:** when the break's time comes, the song on air finishes; the unstarted music rows before the break are marked
      **skipped**; the break starts.
    - **Hard:** the song on air is cut at the break's time.
  - **Music running short before a break** is filled the same way as a short hour (§3.7 above), under the rules, to within the
    fill tolerance.
  - **The pick never chooses a song for its length.** It stays the longest-waiting song that passes. Today's length fitting
    (`fitTargetTs`, "among the N oldest") is removed.
  - **A break that still starts more than the break tolerance** (setting, starting value 30 s) before or after its time is an
    alert, `break-late` or `break-early` (§6), with the planned and actual time.

### 3.8 Every path that puts a song on a deck checks it
- **Covered:** the reader, the preload, the re-cue, the stall recovery, PLAY NOW from the queue, and the skip.
- **Before a row is loaded:**
  1. **Its log row is the row for now:** the next unplayed row of the current hour in order, or a fill per §3.7.
  2. **It passes every rule** against what has aired on this station, as recorded in §3.9.

     A row that fails is marked **skipped** with the rule, and the pick is run again for that slot (§3.2.2), or the slot is
     unscheduled.
- **The stall recovery stops playing "any idle deck with a file".** It plays the deck that holds **the log's row for now**.
  Otherwise it loads that row. A deck whose content is not that row is emptied, and that is logged.
- **An operator's own load of a specific song is never refused.** The user is in charge. It is logged as an operator play, and
  its rule breaks are shown, not blocked.

### 3.9 What aired is the record
- **At go-live, in one transaction:**
  - the play is written (song, sweeper, spot, announcement, cart) with its log row id, category, content class, recording,
    machine id and session;
  - the log row is stamped **playing** (the previous one **played**).

  If the write fails, it retries and shows a red health line (10348f4's `_stampOnAir` model).
- **A log row airs once.** Each deck holds its own row, and only that row is consumed at go-live (10348f4's model).
- **Generate, Clear Day and every editor touch pending rows only.** played / playing / skipped / missed / unscheduled are the
  record and are never deleted or rewritten.
- **Rotation counts plays of the broadcast owner only** (setting, starting value on).
  - Today two machines aired one station and both counted.
  - A test or standby machine must not block songs on air.
  - Its plays stay in history, marked by machine.
- **A reconciliation view** in the Program Log shows log against as-aired for any hour: added, skipped, moved, replayed. Nothing
  needs a separate reconcile step, because the record is written as things air (as Zetta → GSelector does).
- **`songs.last_played_at` / `play_count`** are written by the daemon on every play, as display values. **No picker reads them.**

### 3.10 Regenerating while on air
- **Generate may start at the next song.** The start is **asked of the engine:** the deck on air, its row, its position and its
  length, from a new daemon command.
  - **If the engine says nothing is playing,** the start is now.
  - **If the engine cannot be asked** (no daemon), the start is the next row boundary of the log, and the report says so.
- **There is no time limit and no guess.**
- **The rest of the current hour is planned from that point** in the clock's order:
  - its earlier positions are taken as **filled by what actually aired**;
  - the rules and "last aired" use that airplay;
  - nothing is planned before the start, so no phantom row can block a song.
- **Aired rows are never touched (§3.9).** The cued decks re-cue to the new rows at the next seam by row identity (10348f4's
  re-cue model).
- **Auto-extend** (unattended) still starts at the next top of the hour, so it never reshuffles the hour on air under the
  operator. That is the distinction the patch header drew, and it is kept.

### 3.11 Settings (all visible, each with a starting value Jeff sets)
| Setting | Where | Starting value (proposed) |
|---|---|---|
| Song / artist / title separation (minutes), each on/off | Music Scheduling Rules (Programming preferences) | as each station has them today |
| Artist delimiters | same | `/ & , feat. ft. f/ x with` |
| Title tail rule | same | on |
| Fallback category (fills an UNSCHEDULED slot, same rules and pick) | same | none (the slot stays UNSCHEDULED and alerts) |
| Duplicate length tolerance | Library → Duplicates | 2 s |
| Default clock (hours with no show) | Programming | none (runway shows red) |
| Hour start Soft / Hard, latest start, catch-up slack | Hour start | Soft, 0 s, 60 s (Jeff, 10/17) |
| Early-start window | Hour start | 0 s |
| Fill tolerance for a short hour, and before a break | Hour start | 30 s |
| Break tolerance (late or early beyond this is an alert) | Hour start | 30 s |
| Count only the broadcast owner's plays | Music Scheduling Rules | on |

**Nothing else.** Removing `enforce_separation` leaves no hidden key. A test enforces this (§4, T15).

### 3.12 Where Ether differs from Zetta/GSelector: Jeff's decisions (2026-10-17)
All recommended, except 3b, 3c and 3d.

1. **Scheduler and playout are one product.** Ether writes the log and plays it, so "live integration" is built in: there is no
   reimport.
2. **D1, the count proof:** a spread above 1 fails the gate unless every lower-count song was blocked by a named rule at that
   moment, which is reported (§3.2.5). **Decided.**
3. **D2, STRICT / SOFT:** the button is removed. The rules are obeyed. **Decided.**
3a. **D3, daypart:** a song outside its daypart is not in the slot's category for that hour, so it neither passes nor blocks.
   **Decided.**
3b. **D4:** "max songs in a row from one category" is **removed** (Jeff). Per-song **"no repeat hours"**: **OPEN**, keep or
   remove. If kept, it is enforced by the same rules module and checked by the gate.
3c. **Spot-break timing is kept** (Jeff): "The clock is law. Spot breaks land on their time through the station's hour start
   (Soft/Hard) and fill, never by bending the pick. The pick stays: longest-waiting song that passes. Any break that still lands
   late or early is an alert." Design: §3.7; test: T18.
3d. **Unscheduled slot** (Jeff): a fallback the user names, per station, under the same rules as every other pick. All categories
   are treated identically; the scheduler never reasons about what a category contains. If no fallback is set, the slot stays
   UNSCHEDULED and alerts. Never filled from another category on its own. Design: §3.2.3.
4. **Rules are per station,** not per category. Per category is a later phase. **Decided.**
5. **D5, no scoring:** the rules obeyed plus the longest-waiting song, instead of GSelector's weighted score, breakable rules,
   Max Sep, Spread and Airplay Starvation. **Decided.**
6. **A short hour is filled from the hour's own clock,** not from a fill-tagged library as in Zetta. **Decided.**
7. **Hour start** is per station (Soft/Hard). Per-clock types come later. **Decided.**
8. **Only the broadcast owner's plays count** for the rules, "last aired" and the proof. **Decided.**
9. **Goal mode:** the shadow planner is deleted now (no second path). **Decided.**
10. **10348f4 (installer 615c4632) is not shipped.** Its parts are reviewed and rebuilt inside Phases 1 and 3, each with its gate
    test. The work is on branch `sched/one-scheduler`, from 6558e57. **Decided.**
11. **The early-start window is 0 s;** "never dead air" is kept by the short-hour fill. **Decided.**

---

## 4. Proof: tests an RCS engineer would accept

**How they run:**
- **One harness,** `scripts/test-scheduler-gate.js`, run with no audio, on **copies** of every station's database found on the
  build machine. Copies only, deleted after; never the live file. The audio engine is needed only for T9–T12, and those use a
  private daemon on a private pipe, muted, as `scripts/test-cart-exhaustion.js` does.
- **A second, independent checker** (`scripts/lib/log-checker.js`) re-derives every rule from play_log + the log. It shares no
  code with scheduler-core, so a bug in the picker cannot hide itself.
- **Added to the release gate** (the packaged-build gate, `audiod/verify-packaged.js` → `gate-logs/`). **Any failure fails the
  gate.**
- **A ratchet file** records each station's results. A worse result than the last gate fails, even if within the rules.

| # | Test | Pass condition |
|---|---|---|
| T1 | **Zero separation violations:** 7 days generated and simulated per station, on copies, from each station's real as-aired history, with real song-length error, :00 skips, X removals and a regenerate on air | the independent checker finds **0 song, 0 artist and 0 title separation violations**, in the log and on air, measured against what aired plus the log on both sides |
| T2 | **The pick**, re-derived slot by slot | every placed song was, among the category's songs passing every rule at that time, the one that had waited longest (exact ties excepted); every slot where no song passed is UNSCHEDULED with its reason; nothing else ever decided |
| T3 | **Even play counts (the proof)** | at every go-live, inside every category, highest aired count − lowest ≤ 1, songs added during the run excepted. Per decision D1, a spread of 2 passes only if every lower-count song was blocked by a named rule at that moment, and that is listed. Each station's spread is reported and ratcheted |
| T4 | **Aired rows untouched** | snapshot every non-pending row; run Generate, Days, Fill Day, hour Regenerate, Clear Day, auto-extend, editor moves; every snapshot row byte-identical |
| T5 | **Started early** (automation at 12:25, shows from 3 PM; with and without a default clock) | no row airs before its hour (beyond the early-start window); the hours before 3 PM air the default clock, or live fill under the rules; 0 evening rows consumed |
| T6 | **Started late / mid-hour** (automation at :20, at :59, after a 2 h gap) | the first row aired is the log's row for now per Hour start; the passed rows are marked skipped, not aired |
| T7 | **Regenerated on air** (at :20 with a song playing; at :58; with the station ahead; with the station behind) | the first new row starts at the engine-reported end of the song on air; nothing aired changed; the rest of the hour obeys the rules against the aired part; small categories keep their full pool |
| T8 | **Never ahead of the clock**, 24 h simulated with real song-length error (true vs planned length, ±10%) and spots | at every go-live, the row's hour has started (± the early-start window); short hours filled from the hour's clock; drift reported |
| T9 | **Hour start Soft and Hard** at :00, long and short hours | Soft: the song finishes, the old hour's unstarted rows are skipped, the new hour starts at its first row; Hard: cut at :00 |
| T10 | **Playout re-check**: a song that breaks separation inserted into the log; a replay attempt; a stall with a leftover track on an idle deck | the violator never airs (skipped, reason); no row airs twice; the stall recovery airs the row for now, never the leftover |
| T11 | **As-aired = record**: every go-live over 24 h | one play per aired row, with row id, category, content class, machine; every sweeper/spot/announcement stamped; the reconciliation view shows zero unexplained differences |
| T12 | **The X and editor moves on air** | a removed row never airs and stays removed through 10 refills |
| T13 | **Duplicates**: one recording on two song rows | one "last aired" and one separation for both; the merge keeps history and moves future rows |
| T13a | **The screen's counts** | the Rotation screen's counts equal the checker's recount from play_log |
| T14 | **Two machines**: a standby airs the same station | its plays don't block the owner's songs (if decision 8 = yes); both are recorded by machine |
| T15 | **No hidden settings, no baked numbers** (static) | every key the core, reader and Generate read is in the settings registry with a UI control and a starting value; no numeric literal in rule or timing code outside that registry; `enforce_separation`, `is_hard`, `max_same_category`, `fitTargetTs` and `songs.last_played_at` are read nowhere by the pick; `no_repeat_hours` is read only by the rules module, or nowhere (3b open) |
| T18 | **Spot breaks on time** (Jeff, 3c): 24 h simulated with real song-length error and every station's timed breaks, Soft and Hard | every break starts within the break tolerance of its time, or raises `break-late` / `break-early` with planned and actual time; no song was chosen for its length (T2 holds through every break); the music rows passed over by a Soft break are marked skipped |
| T16 | **One code path** (static) | exactly one module chooses songs: no `ORDER BY RANDOM()` outside the core's tie-break; no picking in `src/audio/`; `pickEnforced` and `_legacyPickMusic` gone |

**Today's code is expected to fail** T1, T2, T3, T4, T5, T8, T10, T11, T15 and T16 (T18 is added with 3c). Phase 0 proves the harness catches them
before anything is fixed.

---

## 5. Build order, in phases, each with its test

Each phase:
- is a branch with local commits only;
- has its gate tests passing on DB copies;
- is reported with receipts.

Jeff tests it off-air and then on OVEVENTS before it goes near ovowforestmusic. No phase ships without Jeff's GO.

| Phase | Builds | Proved by |
|---|---|---|
| **0. Decisions + the harness** | Jeff's answers to §3.12. The gate harness, the independent checker and the ratchet, run against **today's** code. 10348f4 not shipped (decision 10). | the harness reports today's failures (T1–T16) with receipts: the tests catch what is wrong |
| **1. The record** | Go-live writes play + row stamp in one transaction, with row id, category, content class, machine; each deck holds its own row; one row airs once; sweepers/spots/announcements stamped; Generate, Clear Day and the editors touch pending rows only; `songs.last_played_at` as display only. Reviewed from 10348f4, not copied. | T4, T11, T12, T10 (replay part) |
| **2. One pick** | scheduler-core: the rules (song, artist, title) against what aired + the log on both sides, by recording; the longest-waiting passing song; random for exact ties; UNSCHEDULED slots + the station's fallback; artist participants; title normalising. Delete the second and third paths, and the rule switches D2/D4 remove. | T1, T2, T3, T15, T16 |
| **3. The clock on air** | Default clock; the reader never ahead; Soft/Hard at :00 and at every timed spot break, with skipped rows; short-hour fill from the hour's clock; automation start at the row for now; every deck-loading path re-checks the rules (§3.2.2); stall recovery plays the row for now. | T1 and T3 on air, T5, T6, T8, T9, T10, T18 |
| **4. Regenerate on air** | Daemon command for what is on air; Generate from the next song; the current hour planned with its aired part as fact; aired rows untouched; re-cue by row. | T7, T4 again |
| **5. Duplicates** | Recording identity (from Phase 2), plus the Library Duplicates view and merge. | T13 |
| **6. Screens and help** | The **Rotation screen** (§3.2.4); Music Scheduling Rules rewritten to what the code does; every §3.11 setting on screen; Program Log UNSCHEDULED / skipped / fill rows; reconciliation view; help docs (`help-rotation.md`, `help-music-scheduling-rules.md`, `help-hour-start.md`, `help-duplicates.md`, `help-default-clock.md`). | T13a, T15 + launching the app and looking at each screen (CLAUDE.md: the only valid UI test) |

After Phase 6, the ovowforestmusic spread is re-measured on the next real night and compared with §2.1's numbers.

---

## 6. Health monitor: Iris's eyes

### In plain words
**Why it missed tonight:**
- Of the ten failures Jeff listed, the monitor **checks only two, and alerts on neither.**
  - It saw the station running ahead (67 "logreader-ahead" lines this morning, up to **371 min ahead**). It filed them grey, in a
    log nobody is shown.
  - It saw upcoming songs breaking song separation (54 "queue-lint" lines tonight, for example **Goo Goo Muck "139 min early"**
    eleven minutes before it aired). It files those as "routine" and hides them by default.
- **It never checks** what actually aired against the rules, a row airing twice, a stall, the watchdog's leftover track,
  Generate rewriting aired rows, sweepers left unmarked, or blank categories.
- **The station light only knows audio:** frames, silence, queue depth, engine restarts. So it stayed green all evening.
- **The Remote app gets only that light,** never an alert.

**The design:**
- **One air check watches every element as it goes on air**, with the same rule code the picker uses, reading the same Programming
  preferences. Every threshold is a setting.
- **It only detects and reports.** It never decides and never fixes.
- **Each problem becomes one alert event** (what, when, station, row, song, rule, measured against setting) on **one stream**:
  - shown in Ether's Health Monitor (never hidden);
  - shown on the Remote admin app;
  - written to the health log;
  - available for Iris to subscribe to later, without changing the monitor.

**The proof:** a release-gate test replays 10/16 and 10/17 and fails unless every one of those alerts is raised at the right
moment.

### 6.1 Why it missed tonight (receipts)

**What existed on these nights:**
- **10/16:** ovowforestmusic's engine log (`docs/halloveen-engine-log-2026-10-16.txt`). Its health log is on ovowforestmusic and
  is not here.
- **10/17:** this machine's health log
  (`%LOCALAPPDATA%\Ether\profiles\ETH-STN-BAA8-E056-6FC8\health-events.jsonl`) for its own HalloVeen run, 8:31 AM–12:12 PM and
  3:58–6:15 PM, plus play_log and generated_schedule (read-only handle). ovowforestmusic's 10/17 health log is not here
  (UNVERIFIED).

**Tally of this machine's health log, 10/17, HalloVeen:**

| Events | Kind |
|---|---|
| 855 | audio-rt |
| 359 | processing |
| 281 | jingle |
| 185 | library-health |
| 70 | level changes |
| **67** | **logreader-ahead** |
| **54** | **queue-lint** |
| 47 | sweeper-placement |
| 11 | generate-timing |
| 7 | board-state-mismatch |
| 6 | announcement-fired |
| 5 | logreader-missed |
| 5 | spot-missed |

**No event exists** for a separation break on air, a replay, a stall, a leftover track, an aired-row rewrite, a sweeper not
stamped, or a blank category.

| Failure | Checked at all? | Why no alert |
|---|---|---|
| **A song aired inside its song separation** | **Only before air, and not against what aired.** `lintUpcoming` (`electron/library-health.js:606`) checks the next rows in the log against play_log. | It flagged them: 54 `queue-lint` lines 10/17, for example 17:11:31 "Goo Goo Muck, song, 139 min early", which aired at 17:22; 18:15:32 "Thriller, 30 min early". But `queue-lint` is in `ROUTINE_KINDS` and **hidden by default** (`src/components/health/healthUtils.ts:179-188`). It is otherwise only a chip in Up Next. It never reaches the station light, the Remote app or an alert. It also uses its **own copy of the rules** (`sepConfig`, `library-health.js:339`): per-song `no_repeat_hours`, not the song separation minutes, and rounded to whole hours at `:366`. And nothing checks the song **when it airs**. |
| **An artist aired inside its artist separation** (title the same) | Artist: the same lint, the same hiding. **Title: not checked anywhere** (`lintUpcoming` has no title rule). | as above |
| **Running ahead / behind the clock** | **Ahead:** the reader emits `logreader-ahead` (`audiod/engine.js:1616`), written to the ledger (`electron/main.js:1305`). **Behind:** only as `logreader-missed` when rows are dropped. | 67 events 10/17, 08:37:44 "22 min" up to 08:49:03 **"371 min"** and 12:12:05 "168 min". `eventLevel()` colours by name; "ahead" matches neither the red nor the yellow pattern (`healthUtils.ts:168-170`), so it is **grey**. It is not part of the station light (`electron/audio-health.js:279-322`), nor of the Remote frame. **Behind:** `logreader-missed` (5 on 10/17, for example 15:58:45, 1124 s) is yellow in the list but not in the station light. |
| **A log row airing twice** | **No.** | Nothing compares a go-live with the rows that already aired. On 10/16, 8 rows aired twice (`docs/halloveen-playout-findings-2026-10-17.md`); no line in any log names it. |
| **The watchdog playing a leftover deck track** | **No.** | `_resumePlayout` (`engine.js:822` at 6558e57) logs "resume-playout: deck A LIVE — <title>" to the daemon log only. Nothing checks that the deck's content is the log's row for now. |
| **A stall (song ended, next didn't start)** | **Engine only.** The watchdog emits `error` with `where:"watchdog"` (`engine.js:828`). | `main.js` routes only `where:"play-skip"` and `where:"resume-playout"` (`main.js:1402-1409`). The watchdog's own error **falls through unrouted**; the comment there names it as a known gap. The station light's silence rules need 10 s for yellow and 30 s for red (`audio-health.js:19-20`, baked numbers). A 1 s gap never shows. Receipt: 4 stalls on 10/16, at 01:59:40Z, 02:04:00Z, 03:50:22Z and 04:04:06Z, in the engine log only. |
| **Generate deleting or rewriting aired rows** | **No.** | `_commitDayRows` deletes every non-operator row in the window whatever its state (`main.js:11201` at 6558e57) and logs nothing about aired rows. No sense watches writes to non-pending rows. Whether it happened on 10/17 (Jeff's 6:10 PM regenerate on ovowforestmusic, with the station ahead) is UNVERIFIED; one read on ovowforestmusic settles it. |
| **Aired items not marked played (sweepers); blank category** | **No.** | Sweeper plays are written to play_log (`engine.js:2457`), and their log rows stay pending. Every sweeper row on this machine's 10/17 log is still pending. `category_code` is hard-coded null (`audiod/playlog.js:56`): 316 of 316 cloud plays since noon 10/17 are blank. Nothing compares a play with its row. |
| **A slot UNSCHEDULED because nothing passed** | **Cannot exist today.** Generate never leaves a slot empty; it bends the rules instead. | The bend is counted in `pick_reason` / `ctx.relaxed` and on the `auto-extend` line. Receipt: "Christmas in Jully" 10/17 08:26, `relaxedPicks: 5826` of 6624 rows. It is in the ledger and nowhere visible as a problem. |

**Also missing:**
- **The Remote admin app receives only the station's light and reason** (the health frame, `electron/health-frame.js`;
  station_cc_data `health`, read 10/17). No alert reaches it.
- **The station light's thresholds are baked in** (`audio-health.js:16-26`): `FROZEN_MS` 3000, `SILENT_RED_MS` 30000,
  `SILENT_YELLOW_MS` 10000, `QUEUE_LOW` 5, `NEXT_DECK_TRACK_LEFT_MS` 30000, `PING_LAG_MS` 500 and the rest.
- **So is the watchdog's:** `STALL_MS` 1000 (`engine.js:52`).

### 6.2 The design
**One air check, in the daemon, next to go-live.** That is where the truth happens. It reads only what happened:
- go-live and end of every element;
- deck loads and re-cues;
- the watchdog's recoveries;
- every write to generated_schedule;
- the log as written.

**It uses the one rule module.**
- The rules live in one module (`audiod/rules.js`: song, artist and title separation, reading Programming preferences). The
  picker uses it to choose and the air check uses it to judge.
- There is no second copy: `library-health.js` `sepConfig` and its own song-rest arithmetic are removed, and the queue preview
  calls the same module.
- A bug in that module is caught by the release gate's **independent** checker (§4), which is a test tool and never part of
  the product.

**What it detects** (each is one alert kind; thresholds are settings):

| Alert | When it is checked | What is measured against what | Setting (proposed starting value) |
|---|---|---|---|
| `separation-aired` (song / artist / title) | at every go-live | minutes since the last airing of that song / artist / title (owner's plays, by recording), against the Programming-preferences minutes | none: the rule is the setting |
| `separation-in-log` | when Generate commits, and every few minutes over the next hours of the log | the same, for rows already in the log, against what aired plus the log on both sides | look-ahead hours (2) |
| `clock-ahead` | at every go-live | the row's scheduled time against now | alert beyond the early-start window (§3.7, 0 s) |
| `clock-behind` | at every go-live and at :00 | now against the row's scheduled time | alert when behind by more than (120 s) |
| `row-aired-twice` | at every go-live | the row id against the rows already aired | none |
| `off-log-play` | at every go-live | the element against the log's row for now. Names the path: stall recovery, re-cue, preload, operator. An operator's own load is reported as `operator-play`, not as a fault. | none |
| `stall` | when a rotation deck ends and nothing goes live | seconds of gap, the song that ended, what recovered and with what | alert when the gap exceeds (1 s). The watchdog's `STALL_MS` becomes this same setting. |
| `aired-row-changed` | on any write | any UPDATE or DELETE of a generated_schedule row whose state is not pending, caught by a database trigger into an append-only table, so every code path is caught including ones not yet written | none |
| `not-stamped` | at every go-live | the element's log row is not playing/played within the time set; the play has no row id or no category | stamp deadline (30 s) |
| `break-late` / `break-early` | at the break's go-live | the break, its planned time against its actual start | break tolerance (30 s) |
| `unscheduled` | when Generate writes it, and again when its time comes on air | the slot, its category, the closest songs and rules | none |

**Every alert is one event, one shape** (versioned):
```
{ v: 1, id, kind, severity, stationUuid, at, observedAt, machineId,
  row:  { id, scheduledAt, title } | null,
  song: { recording, title, artist, categoryId } | null,
  rule: { key, setting, measured, unit } | null,      // e.g. { key: "artist_separation_min", setting: 60, measured: 22, unit: "min" }
  path: "go-live" | "stall-recovery" | "re-cue" | "generate" | "editor" | ...,
  message: "Goo Goo Muck aired 9 min after it last aired; song separation is 120 min." }
```
- **Severity** per kind is a setting. Starting values:
  - **red:** separation-aired, row-aired-twice, off-log-play, stall, aired-row-changed;
  - **yellow:** clock-ahead, clock-behind, not-stamped, unscheduled (red when its time comes on air).
- **The message is plain words:** what, when, which song or row, the rule and the numbers.

**One stream, three places, nothing hidden:**
1. **Health log:** through the one ledger writer (`electron/main.js:212`), kind `alert`.
2. **Ether:**
   - an **Alerts** list at the top of the Health Monitor, never in "routine";
   - the station light takes the worst open alert;
   - the Program Log row it concerns carries a marker that opens the alert.
3. **Remote admin app** (app.ether-cast.com, Health): pushed with the health frame as a list of the last alerts. Each one is
   pushed once; nothing is pushed to the public listener page.

**Nothing is fixed silently.** The monitor never acts. Where playout itself does something (§3.8 skipping a row that no longer
passes, §3.2.3 an unscheduled slot filled from the station's fallback), playout writes its own event to the same stream, so the user
sees every action.

**Iris:**
- **One stream:** the alert stream is the one Iris will read. The monitor writes each alert once to the ledger, and the same
  object goes out on the SSE live-wire as event `health:alert`. That is the live-wire Iris already connects to (`:3400`,
  `main.js:9904`; `docs/iris-ether-contract.md` §3).
- **Replay after a reconnect:** a reconnecting subscriber asks for alerts since a given `id` (`GET /alerts?since=`), so nothing
  is lost.
- **The contract:** a new section in `docs/iris-ether-contract.md`, "Alert stream (read-only)", holds:
  - the schema above and its version rule (fields are only ever added);
  - that the stream is detection only;
  - that the monitor reads nothing from Iris and waits on no subscriber.
- **No Iris logic is built.** What Iris may do about an alert is already governed by her two tiers (§2 of the contract), and is
  out of scope here.

**The station light** keeps its audio checks, and their numbers become settings (`audio-health.js:16-26`), with today's values
as starting values. The light's level is the worst of the audio checks and the open alerts.

### 6.3 Proof: the replay test (release gate, T17)
**`scripts/test-air-check-replay.js`, on copies, no audio:**
- **Inputs:**
  - 10/16: ovowforestmusic's engine log, parsed into go-live / end / re-cue / stall events, plus that night's log rows. The rows
    need a **read-only copy of ovowforestmusic's database**, taken with Ether fully closed. Until Jeff provides it, the rows the
    findings doc already proved stand in.
  - 10/17: this machine's play_log and generated_schedule for its two HalloVeen runs (copy), plus ovowforestmusic's 10/17
    copy, needed in the same way.
- **The expected alerts are written out in advance**, from the receipts, in
  `scripts/fixtures/air-check-2026-10-16-17.expected.json`. Each entry has its kind, time window, row or song, and rule:

  | Night | Expected alert |
  |---|---|
  | 10/16 | `row-aired-twice` for rows 721491, 721501, 721520, 721521, 721539, 721540, 721543 and 721544, each at its second go-live |
  | 10/16 | `stall` at 01:59:40Z, 02:04:00Z, 03:50:22Z and 04:04:06Z, each with the `off-log-play` / recovery it led to |
  | 10/17, this machine | `clock-ahead` from 08:37:44 PDT (22 min) through 371 min |
  | 10/17, this machine | `separation-aired` for Love Ain't It 16:23 and 16:38, Havana 16:43, Wolves 17:18, Goo Goo Muck 17:22 |
  | 10/17, ovowforestmusic | Thriller 15:23, Ghostbusters 15:49 and 18:04, Goo Goo Muck 17:57 |
  | 10/17, both | `not-stamped` for every sweeper; `not-stamped` (blank category) for every play |

- **Scenarios with no receipt on these nights are injected on the copy:**
  - a Generate run over aired rows, which must raise `aired-row-changed` (or, once Phase 1 is built, change nothing);
  - a slot with no passing song, which must raise `unscheduled` at commit and at air.
- **Pass:** every expected alert is raised once, inside its window, with the right row, song and rule numbers. Every red alert
  raised that is not on the list is printed, and fails the test unless it is added to the list with a receipt.
- **Today's monitor fails this test**, which is the point. Phase 0 runs it to prove that.

### 6.4 Where it goes in the build order
- **Phase 0:**
  - the replay fixture and expected list;
  - T17 run against today's monitor, which fails;
  - the alert schema;
  - the Iris contract section.
- **Phase 1:** the alert stream (ledger, SSE `health:alert`, Remote push, Alerts list) plus `row-aired-twice`,
  `aired-row-changed` (the trigger), `not-stamped`.
- **Phase 2:** the one rule module, plus `separation-aired`, `separation-in-log` and `unscheduled`. The lint's second copy is
  removed.
- **Phase 3:** `clock-ahead`, `clock-behind`, `stall` (the watchdog's number becomes the setting) and `off-log-play`. The
  station light's numbers become settings.
- **Every phase:** T17 grows to cover what the phase adds, and stays in the release gate.

---

**Removed by this design, if built:**
- `ORDER BY RANDOM()` as the first choice (Generate, `loggen.js`, `loggen.ts`);
- `separation-enforce.pickEnforced` and the `enforce_separation` switch;
- `_legacyPickMusic` and the differential;
- the renderer pickers (`src/audio/loggen.ts`, `separationEnforce.ts`);
- the goal-mode shadow planner (if decision 9 = delete);
- the reader's "AHEAD, play the earliest future row" rule (Rider A, kept instead by the short-hour fill);
- the stall recovery's "any idle deck with a file" choice;
- Generate's delete of non-pending rows;
- pickers reading `songs.last_played_at`;
- the screen's current STRICT/SOFT wording, and the button itself if D2 = remove;
- every way a rule is broken to fill a slot (Generate's least-recently-played fallback, loggen's tiers 2/3, `pickEnforced`'s relax
  ladder);
- spot-break length fitting (`fitTargetTs`); breaks land on time through Hour start and fill (3c);
- "max songs in a row from one category" (3b); per-song "no repeat hours" only if Jeff says remove (open).

**Kept:**
- the clock-is-law format guard (`getFormatCategoryIds`);
- the hour join, as Soft;
- operator rows surviving Generate;
- auto-extend starting at the next top of the hour.
