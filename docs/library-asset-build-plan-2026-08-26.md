# `library_asset` — the build plan (2026-08-26)

**Status: PLAN. NOT BUILT.**

## 0. SCOPE — ruled, and it absorbs a table that already exists

Jeff, 2026-08-26:

> *"The audio files are ONE shared library all stations draw from — an asset exists once. But how each
> station treats that asset is per-station: category, badges, rotation behavior, scheduling are all
> unique to each station. Change stations and the same song is categorized and badged differently."*

**That model already has a table: `station_programming`** — added by the same Phase-4 / Direction-C
work that made `songs` install-scoped. Its shape is exactly the ruling:

```sql
station_programming(uuid, song_id, station_id, category_id, energy, daypart_mask,
                    rotation_status, no_repeat_hours, last_played_at, play_count, notes,
                    UNIQUE(station_id, song_id, category_id))
```

So the design does **not** invent `asset_music_meta`. It **generalises `station_programming` from
songs to every asset type** — one install-scoped asset, N per-station treatment rows.

### But it is barely wired, and that is the real finding

Measured read-only on the live profile:

| | |
|---|---|
| `station_programming` rows | **12** (all station 2) |
| `songs` rows | **510** |
| songs with treatment on **2+ stations** | **0** |
| `categories.station_id` exists | ✅ yes — categories ARE station-scoped |
| what rotation actually filters on | **`s.category_id`, `s.rotation_status`, `s.daypart_mask`** — the INSTALL-scoped columns on `songs` (`audiod/loggen.js:70`) |

And each song's `category_id` points at exactly ONE station's category:

```
Open Format 163 · halloVeen 151 · Magical Forest 76 · Christmas in Jully 46
```

**So today the shared library is PARTITIONED across stations, not TREATED differently by them.** A
song is assigned to one station's category; it is not simultaneously Power Gold on Open Format and
Halloween on halloVeen. Switching stations shows a different set of songs — which looks like
per-station treatment and is worth stating carefully, because the mechanism is different and it caps
what the model can do.

**UNVERIFIED at runtime.** This is a schema-and-data reading, not a claim about the running app. The
one check that settles it: categorise a song on Open Format, switch to halloVeen, and see whether that
same song is available to categorise there too, or whether it has effectively left the pool.

**This makes the arc more valuable, not less.** Finishing the per-station treatment model is what
turns Jeff's stated intent into how the product actually behaves, and the library convergence is the
natural place to do it — the alternative is a second migration later over the same rows.

### Consequence: one open decision

Migrating `songs.category_id` into per-station treatment rows needs a rule for the 436 categorised
songs:

- **(a) Preserve today exactly** — each song gets ONE treatment row, on the station whose category it
  currently points at. Nothing changes on air; the model is correct but the library stays partitioned
  until someone widens it by hand.
- **(b) Preserve + make available** — same row, and every other station can now add its own treatment
  for that asset. Nothing changes on air either, but the shared library becomes genuinely shared.

**My recommendation: (b)** — it is what Jeff described, it changes nothing that is currently
scheduled, and (a) would need a second pass later anyway. **Jeff rules.**

---

## 1. The registry IS the design

**The mistake to avoid:** four types spelled into the schema (a `CHECK` constraint), into every query
(`content_class = 'MUSIC'`), and into every panel (a hardcoded tab list). Adding a fifth then means
editing rotation, separation, the log generator, analytics and the UI separately — which is exactly
the position we are in now with `content_class`.

**So: no type literal appears in the schema, and no behaviour branches on a type name.**

```
library_asset.type   TEXT NOT NULL     -- NO CHECK constraint. The schema does not know the set.
```

Behaviour lives in **one module**, `src/lib/assetTypes.ts` (mirrored for main/daemon as
`electron/asset-types.js` — one file, two loaders, never two definitions):

```ts
export interface AssetTypeDef {
  code: string;                 // 'SONG' | 'SPOT' | ...  — stored in library_asset.type
  label: string;                // "Songs"        — plural, operator's word
  labelOne: string;             // "Song"
  badge: string;                // "SPOT"         — log/queue badge
  color: string; bg: string; border: string;

  // ── CAPABILITIES: what the rest of the product asks, instead of asking "is it a spot?" ──
  eligibleForRotation: boolean; // may fill a music slot in the clock
  honorsSeparation: boolean;    // artist/title/file rest applies
  countsAsMusic: boolean;       // included in music metrics (plays, top artists, spins)
  scheduler: SchedulerKind;     // 'rotation' | 'traffic-break' | 'cadence' | 'date-list' | 'manual'
  bus: BusKind;                 // 'rotation-deck' | 'source-channel' | 'cart-overlay'
  metaTable: string | null;     // type-specific side table, or null
  showAsTab: boolean;           // gets its own filtered view in the Library
  sortOrder: number;
}
```

Everything downstream asks a **capability**, never a name:

| Subsystem | asks | never asks |
|---|---|---|
| rotation / `loggen` | `eligibleForRotation` | `type = 'SONG'` |
| separation | `honorsSeparation` | `content_class = 'MUSIC'` |
| analytics | `countsAsMusic` | `!= 'ANN'` |
| log generator | `scheduler` | a list of classes to exclude |
| playout | `bus` | `if spot … else if sweeper …` |
| Library UI | `showAsTab`, `label`, `color` | a hardcoded tab array |
| Play Log filter | the registry, enumerated | `CLASS_ORDER` literal |

**Two hard rules, and they are the whole of the extensibility guarantee:**

1. **No SQL literal type.** Queries take a list built from the registry:
   ```ts
   const rot = typesWhere(t => t.eligibleForRotation);        // ['SONG', …]
   `… WHERE a.type IN (${qs(rot)})`
   ```
   One helper builds the placeholders. A new type with `eligibleForRotation: true` is included by
   every rotation query the moment it is declared — nothing is edited.
2. **Unknown types degrade, never vanish.** `normalizeType()` returns a safe default for a code this
   build has never seen, the same way `normalizeClass()` already does. A future build's asset must
   still be visible and reportable in an older one, not silently dropped from a log.

---

## 2. The schema

**Identity unifies. Type-specific detail sits beside it.** This is the decision the whole design turns
on: a spot's ISCI code has no business on a sweeper row, and a rotation query has no business joining
past columns it will never read.

```sql
-- ONE row per playable asset. INSTALL-scoped, like songs today: an asset is a FILE.
CREATE TABLE library_asset (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid          TEXT NOT NULL,
  type          TEXT NOT NULL,            -- registry code. NO CHECK constraint, deliberately.
  title         TEXT NOT NULL,
  file_path     TEXT,
  file_key      TEXT,                     -- R2
  duration_ms   INTEGER,
  intro_end_ms  INTEGER,
  outro_start_ms INTEGER,
  cue_in_ms     INTEGER,
  cue_out_ms    INTEGER,
  bpm           REAL,
  lufs_measured REAL,
  peak_db       REAL,
  gain_db       REAL,
  is_processed  INTEGER DEFAULT 0,
  art_image     TEXT,
  is_active     INTEGER DEFAULT 1,
  last_played_at INTEGER,
  play_count    INTEGER DEFAULT 0,
  raw_metadata  TEXT,
  r2_uploaded_at TIMESTAMP,
  created_at    TEXT, updated_at TEXT, deleted_at TEXT
);

-- MUSIC detail: everything rotation and the clock need. One join on the hot path, indexed.
CREATE TABLE asset_music_meta (
  asset_uuid TEXT PRIMARY KEY, artist_id INTEGER, album_id INTEGER, category_id INTEGER,
  genre TEXT, energy REAL, mood TEXT, gender TEXT, rotation_status TEXT,
  daypart_mask INTEGER, no_repeat_hours INTEGER, is_explicit INTEGER,
  spotify_uri TEXT, has_intro INTEGER, intro_version_path TEXT, cart_id TEXT);

-- TRAFFIC detail. STATION-scoped: the same audio file can be sold to two stations differently.
CREATE TABLE asset_spot_meta (
  id INTEGER PRIMARY KEY AUTOINCREMENT, asset_uuid TEXT NOT NULL, station_id INTEGER NOT NULL,
  spot_type TEXT, advertiser TEXT, agency TEXT, isci_code TEXT, cart_number TEXT,
  spot_category_id INTEGER, start_date TEXT, end_date TEXT, max_plays_day INTEGER,
  play_count INTEGER DEFAULT 0, last_played_at INTEGER, length_sec INTEGER, notes TEXT,
  is_active INTEGER DEFAULT 1, uuid TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT);

-- SWEEPER detail.
CREATE TABLE asset_sweeper_meta (
  asset_uuid TEXT PRIMARY KEY, sweeper_category_id INTEGER, lead_in_sec REAL, underlap_sec REAL);
```

**Scope, and this is a real decision I am making explicitly:** `library_asset` is **install-scoped**
because an asset is a file. Anything genuinely per-station lives in a station-scoped meta row —
`asset_spot_meta` is station-scoped for exactly that reason. This resolves today's incoherence, where
`songs` is install-scoped and `spots` is station-scoped for what is the same concept. **Say if you
want it the other way; it is cheapest to change now.**

---

## 3. THE TEST — adding a fifth type

Jeff's test: *"Show me how a new type gets added."* Here is **Voice Tracks**, end to end.

### Step 1 — declare it. One object, one file.

```ts
// src/lib/assetTypes.ts
VOICETRACK: {
  code: 'VOICETRACK', label: 'Voice Tracks', labelOne: 'Voice Track', badge: 'VT',
  color: '#a78bfa', bg: 'rgba(167,139,250,0.14)', border: 'rgba(167,139,250,0.45)',
  eligibleForRotation: false,   // never fills a music slot
  honorsSeparation:    false,   // no artist/title rest
  countsAsMusic:       false,   // excluded from music metrics
  scheduler: 'log-element',     // placed as a row in the log
  bus:       'rotation-deck',   // plays on a normal deck
  metaTable: null,              // no type-specific fields
  showAsTab: true, sortOrder: 60,
},
```

### Step 2 — there is no step 2.

That is the entire change. Concretely, with nothing else edited:

| What happens | Why, mechanically |
|---|---|
| Rotation skips it | `loggen` filters `type IN (typesWhere(eligibleForRotation))` — VT is not in the list |
| Separation ignores it | rest maps filter on `honorsSeparation` |
| Analytics excludes it | music metrics filter on `countsAsMusic` |
| Play Log badges it purple, labelled "Voice Track" | badge reads the registry |
| The Play Log filter offers a **Voice Tracks** button with a count | the filter enumerates the registry |
| The Library grows a **Voice Tracks** tab | tabs are `typesWhere(showAsTab)` |
| It logs as `content_class='VOICETRACK'` | the log class IS the type code |
| The queue badges and colours it | the queue reads the registry |
| An older build still shows it | `normalizeType()` degrades unknown codes safely |

**No migration.** `library_asset.type` has no `CHECK`, so a new code needs no schema change. A
migration is needed **only** if the type wants its own meta table — and then it is one numbered
transformer that adds one table, touching nothing else.

**That is the test, and it is the acceptance criterion for the build:** when the work is done, adding
a type must be a diff of one object. If it is not, the build is not finished.

---

## 4. Build order

Sequenced by dependency, not by risk. Nothing is behind a flag; each step leaves the app working.

| # | Lands | Repoints off `songs` | Receipt |
|---|---|---|---|
| **1** | `assetTypes` registry + `normalizeType` + capability helpers. Pure, no schema. | — | unit tests, incl. the §3 walkthrough as a test |
| **2** | **v50**: the four tables + backfill (`songs`→`library_asset`+`asset_music_meta`, `spots`→`library_asset`+`asset_spot_meta`, `JIN`→`type='SWEEPER'`). `songs`/`spots` remain and stay authoritative. | nothing yet | smoke: row-for-row parity, the spots/songs overlap reconciled by `file_path` and **reported, never silently merged** |
| **3** | Sync: registry entries + handlers for the new tables. | — | `test:sync` |
| **4** | **Reads flip** — rotation, separation, generate, loggen, playlog classifier, health. The classifier's two-store lookup collapses to one and the bug class disappears. | `audiod/loggen.js` (8), `src/audio/loggen.ts` (7), `generate-core` (2), `separation-enforce` (1), `playlog` (1), `library-health` (12) | smokes per subsystem; rotation output compared before/after |
| **5** | **Writes flip** — library import, edit, delete, R2, the Library UI. | `main.js` (26), renderer (84 across ~40 files) | manual + existing handler smokes |
| **6** | **Panels become views** — Library tabs from the registry; SPOTS and SWEEPERS become filtered views; **JINGLES → SWEEPERS everywhere** (panel, button, engine identifiers, help doc). | `App.tsx` (56), `JinglesPanel`, `Spots` | tsc + build + eyes |
| **7** | **v51**: drop `songs`, `spots`, `jingle_categories`; delete their handlers and registry entries; delete the orphaned sync-journal rows. | — | smoke, same shape as v49 |

**Census behind those numbers (measured today):** 52 files carry a `songs` SQL touchpoint;
~140 statements total. This is a multi-session arc, and steps 4-6 are where the volume is.

---

## 5. What does NOT change

- **Four schedulers stay distinct** — rotation, traffic breaks, cadence, date-list. One library,
  several schedulers. Unifying storage is not unifying scheduling.
- **The announcement arc stays as built.** `announcements` + `announcement_schedule` already has the
  right asset/schedule shape; it folds in at step 6 or later as `type='ANNOUNCEMENT'`, and nothing
  about firing, the 250 ms tick, the source channel or the ducker moves.
- **Sweepers stay on the CART overlay for now.** Moving them to scheduled deck elements is the
  separate sweeper redesign and depends on the log-reader flip's Phase 3. This arc gives them the
  right name and the right store, not a new playout path.
- **The ducker, the fire path, `generated_schedule`, and the log-reader are untouched.**

---

## 6. The two open questions

1. **Install-scope for `library_asset`** (§2). I am proceeding on install-scoped unless you say
   otherwise — it is the cheapest thing to change before step 2 and expensive after.
2. **`songs_all`** — the delete-foundation VIEW work is local/uncommitted and reshapes the same table.
   It must land before step 2 or be abandoned; the two cannot interleave.

**Rule on §3 and these two, and I start at step 1.**
