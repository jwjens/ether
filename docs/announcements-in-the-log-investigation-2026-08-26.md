# Announcements as rows in the queue/log — READ-ONLY investigation (2026-08-26)

**Status: RULED — OPTION C, BUILT (2026-08-26). Option B is explicitly NOT done.**

Jeff's ruling: Option C, both parts. Option B (ANN rows in `generated_schedule`) is refused for now —
it is the log-reader/rotation risk and it waits for the flip's Phase 3 as a deliberate separate change.

**Settled questions:**
- **Surfaces:** `UpNext` (the live queue) only. `Logs` and `BroadcastCalendar` can follow later.
- **Row duration:** BOTH, split by what is actually known. The `play_log` row gets a REAL duration
  read from the file (`audio.getFileDuration`, which main already has). The queue row shows the
  announcement's exact CLOCK TIME and no duration — a queue row's position is a projection from
  accumulated durations, but an announcement's time is a fact, so it is shown as one.
- **Consumer audit:** see §6 below.

Jeff's ask: announcements should appear as **rows in the queue/log inline with songs, jingles and
spots**, the way RCS/Zetta do it — everything is a logged element in the row sequence, shown where it
will fire and logged when it plays. Not a separate panel.

Hard rule restated: **announcements must not affect spots, jingles or rotation.**

---

## 1. What the queue/log actually is today

There is no single "the log". There are **four** distinct surfaces, and telling them apart is the
whole basis for the options in §3.

| # | Thing | Where it lives | Who writes it | Who shows it |
|---|---|---|---|---|
| 1 | **The live QUEUE** | in-memory in the daemon, mirrored to the renderer | the queue filler / loggen | `UpNext.tsx` via `engine.getQueue()` |
| 2 | **`generated_schedule`** | SQLite | `electron/main.js` (Generate), `audiod/engine.js` | `BroadcastCalendar`, `Logs`, `ScheduleWorkspace`, `HealthMonitor`, `UpNext` |
| 3 | **`play_log`** | SQLite | `audiod/playlog.js` `logPlay()` ONLY | `Logs`, `ListenerAnalytics`, affidavit, Health |
| 4 | **`scheduled_log`** | SQLite | (no INSERT found in-tree) | `ProgramLog.tsx` |

### 1a. The live queue — what UpNext shows

`UpNext.tsx` does **not** read the database. It reads `engine.getQueue()` and re-renders on
`ether:queue-changed`. A queue item is built by `audiod/loggen.js` `toItem()`:

```js
{ filePath, title, artist, durationMs, introEnd, outroStart, scheduledAt, fileKey, contentClass }
```

`contentClass` is already carried, and the comment on it says why:
> `contentClass: r.content_class ?? undefined,   // MUSIC/SPOT — carried so the queue UI can gold-tint spots`

**So the queue is already a mixed-element list with a per-row class, and the UI already styles rows by
class.** That is the precedent this whole request rests on.

### 1b. How non-song elements are already represented

- **Jingles (JIN)** — no parallel table. Migration v29 put them **inside `songs`** as
  `content_class='JIN'`, explicitly: *"Jingles live in the UNIFIED songs table as content_class='JIN'
  — no parallel jingle table (decision)"*. They are ordinary rows that queries exclude by class.
- **Spots** — a separate `spots` table, but they are **materialized into `generated_schedule` as
  rows carrying their own `file_path`/`title`** (`loggen.js:220`), and reach the queue with
  `contentClass='SPOT'`. `loggen.js:399-425` then treats runs of SPOT rows as **atomic breaks** for
  anchor fitting.
- **`generated_schedule` already has a `content_class` column** — the log-reader queries filter on it
  (`loggen.js:241, 288, 332`).

**The pattern is established: a non-song element becomes a row with a content class, and the readers
exclude it by class.** Announcements are the only audible element that has never been fitted to it.

---

## 2. Can an announcement be a row without changing how it fires?

**Yes — and two of the three pieces already exist.**

### Already in place

1. **`fireAnnouncement` already declares the class.** It passes `contentClass: 'ANN'` on the daemon
   load command (`electron/main.js`). The concept is already on the wire.
2. **`logPlay` already accepts a content class.** `audiod/playlog.js logPlay(db, {..., contentClass})`
   writes `play_log.content_class`, defaulting to `'MUSIC'`. Logging an announcement as `ANN` needs
   **no schema change**.

### What is missing — and this is the real finding

**Announcements never reach `play_log` at all.** They are the only audible element in the product
that airs without being logged.

`logPlay` has exactly three callers:

| Caller | What it covers |
|---|---|
| `audiod/engine.js:1421` (`_fireStart`) | rotation decks A/B/C |
| `audiod/engine.js:1854` | CART / jingle |
| `audiod/ether-audiod.js:413` | jukebox |

`fireAnnouncement` issues `audiodClient.cmd('load')` then `cmd('play')`. The daemon's `play` handler
(`ether-audiod.js:273`) is:

```js
play: (m) => { const ok = A.audioPlay(m.deck, m.stationId); ... return ok; },
```

It calls the addon **directly**. It never routes through `_fireStart`, which is the only thing that
writes `play_log` for a deck. And the `load` handler calls `e.noteManualCue(...)`, which early-returns:

```js
noteManualCue(deckId, track) {
  if (!["A", "B", "C"].includes(deckId)) return;
```

An announcement plays on a **source channel** (its slot comes from `deck_configs` where
`type='source' AND kind='announcement'`), so it is not A/B/C and never enters the engine's deck
bookkeeping either.

**Conclusion for Q2: yes.** Logging an announcement when it fires is an addition *inside*
`fireAnnouncement`, after the engine call already succeeded — the same place it already stamps
`last_played_at`. It does not touch the load/play path, the source channel, or the ducker.

---

## 3. Showing announcement rows inline — the three options

### Option A — DISPLAY-ONLY MERGE
The queue/log views read `announcement_schedule` alongside what they already read and interleave by
time. Nothing is written anywhere new.

- **Playout blast radius: ZERO.** Renderer-only. No table the daemon reads is touched.
- Rows appear where they will fire, styled by class like spots already are.
- **Cost:** the merge has to be implemented in each surface that should show it (`UpNext`, `Logs`,
  `BroadcastCalendar`), and a merged row is not a real log row — it will not appear in an export or
  affidavit that reads `generated_schedule`/`play_log` unless those are handled too.

### Option B — WRITE ANN ROWS INTO `generated_schedule`
Announcements become real plan rows, exactly as spots are.

- **This is the one that can affect rotation, and it is not a small risk.** `generated_schedule` is
  read by the log generator, the auto-fitter, the top-of-hour hard cut and the log-reader flip. The
  readers exclude classes by an explicit list:
  ```
  AND (gs.content_class IS NULL OR gs.content_class NOT IN ('JIN','SWP'))
  ```
  **An `ANN` row would pass that filter** and be treated as playable rotation content by the
  log-reader. Every one of those filters, plus the SPOT break-atomicity logic at `loggen.js:399-425`
  and the anchor fitting, would have to be taught about `ANN`.
- **It also would not make announcements play from the log today** — the log-reader flip is a
  per-station canary (`station_config_kv.log_reader_flip`) and is **off**. So `generated_schedule` is
  currently the PLAN and the live queue is what actually plays. Option B would put ANN rows in front
  of the flip the day it is switched on, which is a rotation-affecting change arriving later, at a
  distance from this work.
- Benefit: one true source, exports and the calendar get it for free.

### Option C — LOG AS-RUN FOR REAL, MERGE FOR UPCOMING  ← the middle
1. `fireAnnouncement` calls `logPlay(..., contentClass: 'ANN')` when it successfully fires. That is a
   **real** as-run row in `play_log`, in the same table as everything else.
2. The upcoming view is a display merge (Option A) over `announcement_schedule`.

- **Playout blast radius: zero.** Nothing the log generator or the flip reads is written.
- Announcements become genuinely logged — "logged when they play" is satisfied for real, not
  cosmetically.
- **One risk to check, and it is small:** `play_log` feeds least-recently-played rotation ordering
  (`loggen.js lrpOrder`), which joins `play_log.file_path` to `songs.file_path`. An announcement's file
  is not in `songs`, so an ANN row matches no song and cannot move rotation. Analytics and the
  affidavit read `play_log` more broadly and would start seeing ANN rows — they already have the
  `content_class` column to filter on, but **each consumer needs checking rather than assuming**.

---

## 4. Blast radius, stated plainly

| Approach | Rotation | Spots | Jingles | Log reader / `generated_schedule` | `play_log` consumers |
|---|---|---|---|---|---|
| **A — display merge** | none | none | none | none | none |
| **B — ANN in `generated_schedule`** | **AT RISK** | **AT RISK** | at risk | **directly modified** | none |
| **C — log on fire + merge** | none¹ | none | none | none | **needs an audit** |

¹ LRP joins `play_log.file_path` to `songs.file_path`; announcement files are not in `songs`.

**Option B is the only one that touches Jeff's forbidden ground**, and it does so in the exact place
that matters — the class-exclusion lists the log reader uses to decide what is playable.

---

## 5. What I would recommend, and what I would check first

**Option C**, and the reason is that it splits the request cleanly along the risk line:

- *"logged when they play"* → real `play_log` rows, one call inside `fireAnnouncement`, zero playout
  risk, and it closes a gap that exists today regardless of this feature: **an announcement can air
  and leave no trace anywhere.** That is worth fixing on its own merits.
- *"shown in the queue where they'll fire"* → a display merge, which is renderer-only and reversible.

Then, if Jeff wants one true source later, Option B becomes a deliberate, separately-verified change
to the log reader — taken with the flip's Phase 3 work rather than smuggled in beside it.

**Before building any of it, three things to settle:**

1. **Which surface(s) must show the rows?** `UpNext` (the live queue) is what "the queue" most likely
   means; `Logs` and `BroadcastCalendar` are separate views with separate readers. Each one costs
   separately.
2. **Does an announcement row need a duration?** The queue lays rows out by duration; an announcement
   currently has no stored duration (`announcements` has no duration column — it is read from the file
   at load). A merged row can show a time without one, but an inline row *between* songs implies one.
3. **`play_log` consumers** — a short audit of what starts seeing ANN rows: `Logs`,
   `ListenerAnalytics`, the affidavit export, `HealthMonitor`, `showClock.ts`. All have
   `content_class` available; the question is which currently assume everything is music.

**No build. Jeff rules on A, B or C.**


---

## 6. `play_log` consumer audit — the result

Every reader of `play_log` in the tree, classified.

### Safe by construction — they JOIN `songs`/`spots` on `file_path`
An announcement's file is not in `songs`, so these drop ANN rows with no change:
`audiod/loggen.js:73` (songSep), `:80` (artistSep, also class-filtered), `:178` (lrpOrder);
`electron/main.js:7849` (lrpOrder); `electron/separation-enforce.js:24` (restByArtist);
`src/audio/loggen.ts:154` (restByArtist twin); `electron/library-health.js:159,283,291,333,334`;
`electron/deletion-sweep.js:160`; `src/components/ListenerAnalytics.tsx:187`.

### Already filtered on `content_class`
`ListenerAnalytics.tsx:171,172,173` (plays / distinct songs / distinct artists), `:209` (top
artists), `:222` (top titles). Whoever wrote v29 did this properly.

### FIXED — the only genuine ROTATION risk in the whole audit
**`electron/separation-enforce.js:29` `restByTitle`** and its renderer twin
**`src/audio/loggen.ts:155`** build a map of `LOWER(TRIM(title)) → last played` **straight from
`play_log`, joining nothing and filtering nothing.** An announcement titled the same as a song would
have imposed that song's title-separation rest — an announcement silently resting a song, which is
precisely the effect announcements must never have. Both now filter to MUSIC.

`restByFile` (`separation-enforce.js:19`) is keyed by `file_path` and only ever looked up for a
candidate song's path, so an ANN key can never match. Left alone.

### FIXED — would have miscounted an announcement as music
- `ListenerAnalytics.tsx:248` — the daily plays trend counted every row. Now MUSIC-only, matching the
  overview stats directly above it.
- `PodcastMode.tsx:425` — builds an episode tracklist. An announcement would have been published as a
  track. Now MUSIC-only.

### LEFT AS-IS, deliberately — ANN belongs there
- `Logs.tsx:82,84,188` — the as-run log VIEWER. Showing announcements is the entire point of logging
  them.
- `Logs.tsx:325` — the affidavit export. It already SELECTs `pl.content_class` and LEFT JOINs
  spots/songs, so ANN rows arrive labelled rather than counted as music. An affidavit proving what
  aired should include what aired.
- `HealthMonitor.tsx:946,1025` — liveness ("has anything played, and when"). An announcement airing
  IS the station airing.
- `src/db/client.ts:73` — a raw row count for the DB health check.

### FLAGGED, not changed — a display choice for Jeff
- `LiveFeatures.tsx:24,121` — "recently played". Would now list announcements among songs.
- `ListenerAnalytics.tsx:265` — the recent-20 list.
- `src/lib/ccData.ts:249` — pushes rows to the web dashboard's history.
- `electron/main.js:7094` — a recent-50 IPC.

These are all "what has been playing" displays. Whether an announcement should appear in them is
taste, not correctness, and none of them feeds a scheduling decision. **Say the word and I will
filter any or all of them.**
