# Library Columns / Metadata Fields — Audit (2026-07-24)

**Repo:** `jwjens/ether` (EtherCast desktop app) · **Scope:** the Library's "Choose which columns appear"
panel (built-in fields) · **Method:** read-only. DB coverage from a read-only SQLite diag over the live
install DB (530 songs, active station "Christmas In July", station_id 4); code receipts from a read-only
source trace. **No code was changed by this audit.**

> Purpose: a standalone inventory of which Library columns are actually backed by data, populated by a
> running path, and read by anything functional — vs. decorative toggles. Hand this to another Claude
> session as ground truth; every claim carries a `file:line` or DB-coverage receipt.

---

## 1. The one structural fact that explains everything

There are **two disjoint column systems**, and the panel lists both without distinguishing them:

1. **Standard columns** — `ALL_LIB_COLS` (`src/types/metadata.ts:3`): exactly 10 columns backed by real
   `songs.*` fields — `title, artist, album, year, genre, bpm, format, duration, category, plays`. These
   render from native song columns / joins.
2. **Built-in metadata columns** — 47 `metadata_definitions` rows seeded by
   `electron/seed-station-config.js`. Their per-song values live in a **separate** table
   `song_metadata_values` (`song_id, definition_id, value_text, value_vocabulary_id`;
   `electron/sync/handlers/song_metadata_values.js:17`). **Everything in the panel from "Release Date"
   onward is metadata-def-only.**

**`song_metadata_values` is 100% empty — 0/530 for every one of the 47 definitions** (verified with the
correct `value_text`/`value_vocabulary_id` columns; an earlier count using a wrong column name produced a
false zero and was corrected). The **only writers** to that table are the manual Library dropdowns
(`src/App.tsx:4614` commitMetaEdit, `:4666` multi-choice, `:4689` clear; plus `BulkAssignModal.tsx`).
**No importer and no analysis path writes it**, and **nothing outside the Library table reads it** (zero
references in `audiod/`, not referenced by the Generate button).

Consequence: **almost every toggleable built-in column is decorative**, and several of them *duplicate* a
real native field that does have data but is not the field the toggle displays.

### Native `songs` columns that actually exist (authoritative)
From `electron/sync/handlers/songs.js` (PATCHABLE list `:16`, INSERT `:65`):

```
title, file_path, file_key, artist_id, album_id, category_id, genre, duration_ms, bpm, energy, mood,
gender, rotation_status, daypart_mask, no_repeat_hours, lufs_measured, peak_db, gain_db, is_processed,
cue_in/out(_ms), intro_end, outro_start, intro_end_ms, outro_start_ms, intro_version_path, has_intro,
last_played_at, play_count, is_explicit, raw_metadata, spotify_uri, cart_id, content_class, jingle_category_id,
created_at, updated_at, uuid, deleted_at, r2_uploaded_at
```

There is **no** `year`, `rating`, `era`, `isrc`, `composer`, `sort_*`, `bit_rate`, `sample_rate`, `size`,
`last_skipped`, or `skip_count` column anywhere.

---

## 2. DB coverage ground truth (read-only diag, 530 songs)

**All 47 metadata definitions:** `populated = 0/530` (empty `song_metadata_values`).

**Native `songs` / `albums` column coverage:**

| Column | Populated | Notes |
|---|---|---|
| `bpm` | 461/530 | Rust analysis on import |
| `intro_end` | 462/530 | Rust cue detection |
| `outro_start` | 462/530 | Rust cue detection |
| `gain_db` | 461/530 | loudness analysis |
| `last_played_at` | 54/530 | bumped on air |
| `genre` | 4/530 | ID3 `TCON`; almost never present |
| `created_at` | 530/530 | row insert |
| `updated_at` | 530/530 | row upsert |
| `album.year` (join) | 0/530 | no album years present |
| `raw_metadata` | 0/530 | raw tag stash never populated |
| `play_log` rows | 10,377 | airplay history exists |

**Seeded vocabularies (choice-type value lists exist even though 0 songs are tagged):**
Genre 10 · Mood 5 · Era 7 · Tempo Feel 4 · Vocal Type 4 · Kind 5.

---

## 3. Verdict table

**Verdict key:** WIRED = real data **and** a live reader (live daemon `audiod/loggen.js` or the Generate
button `electron/main.js`). DISPLAY-ONLY = real data, shown/sortable, but no live reader (or only the dead
legacy `src/audio/loggen.ts` path). DEAD = 0/530, decorative toggle.

### ✅ WIRED — real data + a live reader (native `songs` fields)

| Field (native column) | Data | Reader (receipt) |
|---|---|---|
| Intro / Outro (`intro_end` / `outro_start`) | 462 / 462 | live daemon crossfade — `audiod/loggen.js:96,161,181,271` (queue-item `introEnd/outroStart` at `:100`) |
| Last Played (`last_played_at`) | 54 | Generate separation + LRP — `electron/main.js:5749,5834`; daemon uses `play_log` (`loggen.js:12-14`) |
| Plays / airplay (`play_count` + `play_log`) | 10,377 log rows | writer `songs.js:169` songsMarkPlayed (on air); feeds rotation-eligibility sense |

> ⚠️ The **panel toggles for "Intro Time", "Outro Time", "Last Played" are metadata-def duplicates
> (0/530, dead)** — the real data lives in the native fields above, which are *not* exposed as those toggles.

### 🟡 DISPLAY-ONLY — real data, shown/sortable, no live reader

| Field | Data | Note |
|---|---|---|
| BPM (`songs.bpm`) | 461 | written by Rust analysis on import; read **only** by legacy `src/audio/loggen.ts:218-222,618-631`, **not** the live daemon or Generate |
| Genre (`songs.genre`) | 4 | ID3 `TCON` (`src/audio/id3.ts:83`); almost empty; only legacy `loggen.ts:229` reads it |
| Date Modified (`songs.updated_at`) | 530 | shipped build shows "—" (DEAD); a pending fix displays + sorts from `updated_at`. No functional reader |
| Date Added (`songs.created_at`) | 530 | same pending fix, from `created_at` |

### 🔴 DEAD — 0/530, no writer but the manual UI, no reader but the table (decorative)

`Year` (album.year 0/530; native "year" LibCol reads the join, empty), `Release Date`, `Purchase Date`,
`Rating`, `Album Rating`, `Favorite`, `ISRC`, `Composer`, `Sort Title`, `Sort Artist`, `Sort Album`,
`Sort Composer`, `Last Skipped` (**no `last_skipped` column exists**), `Skips` (**no `skip_count` column
exists**), `Bit Rate`, `Sample Rate` (Rust *computes* it but `src/audio/songAnalysis.ts:101` never persists
it), `Size`, `Length` and `Kind` (dead metadata dupes of native `duration`/`format`), and the metadata-def
copies of `BPM` / `Genre` / `Plays` / `Year`.

Seed line receipts (all in `electron/seed-station-config.js`): Composer :24, Release Date :38, Purchase
Date :39, Rating :40, Album Rating :41, Favorite :42, Era :43, Tempo Feel :44, Vocal Type :45, ISRC :46,
Intro Time :47, Outro Time :48, Sort Title/Artist/Album :49-51, Date Added :55, Date Modified :56, Last
Played :57, Last Skipped :58, Skips :60, Bit Rate :61, Sample Rate :62, Size :63. The `(auto)` wording in
several seed descriptions is aspirational — no code auto-populates the metadata-def versions.

---

## 4. Select-type fields (Era / Tempo Feel / Vocal Type) — grouped

**Value-lists ARE seeded** (`seed-station-config.js:69-76`, inserted `:102-104`), so songs *can* be
hand-tagged via the Library dropdowns:

- **Era**: 60s, 70s, 80s, 90s, 2000s, 2010s, 2020s (7)
- **Tempo Feel**: Slow, Medium, Fast, Variable (4)
- **Vocal Type**: Male, Female, Group, Instrumental (4)
- (also Genre: Rock, Pop, Country, Jazz, R&B, Hip-Hop, Electronic, Classical, Folk, World; Mood: Upbeat,
  Mellow, Aggressive, Sad, Neutral; Kind: MP3, WAV, AAC, FLAC, AIFF)

**Verdict: taggable scaffolding, functionally inert.** The pick-lists exist and the dropdowns work, but
**0/530 songs are tagged**, nothing auto-assigns them, and no generator / rotation / separation reads them
even if tagged.

---

## 5. Bottom line

- The live scheduler (`audiod/loggen.js`) and the Generate button (`electron/main.js`) read only:
  `id, title, artist_id, artist_name, file_path, file_key, duration_ms, category_id, rotation_status,
  content_class, daypart_mask, no_repeat_hours, intro_end, outro_start, last_played_at` + `separation_rules`
  + `play_log`. **They read zero metadata-def fields, and not even `bpm` / `genre` / `year` / `energy` /
  `gender`.**
- **Everything from Release Date through Size is decorative** — a definition with no writer but the manual
  Library UI and no reader but the Library table.
- **Bonus dead rules:** `max_same_gender` (+ `songs.gender`) and `max_same_category` are **seeded**
  (`seed-station-config.js:15`, `main.js:1430`) but **never enforced** in Generate — no reader.

---

## 6. Follow-up options (not decided — for the next session)

1. **Populate on import.** Wire the importer / ID3 (`src/audio/id3.ts`) + Rust analysis
   (`src/audio/songAnalysis.ts`) to persist the fields that have an obvious source: Bit Rate, Sample Rate,
   Size, ISRC, Composer, Track/Disc Number, Year (from tags). Today none of these are written on import.
2. **Resolve the native-vs-metadata duplicates.** Intro/Outro Time, Last Played, BPM, Genre, Plays, Year,
   Length, Kind each exist twice — a live native column and a dead metadata twin. Point the panel columns at
   the native field (as the pending Date Modified/Added fix does) or remove the dead twins.
3. **Hide or label the purely decorative toggles** so operators don't tag into a void.
4. **Enforce or remove** the seeded-but-unread separation rules (`max_same_gender`, `max_same_category`).

## Provenance
- DB diag: `scripts/diag-metadata-audit.js` (read-only, `readonly:true`), run via Electron-as-Node.
- Files of record: `electron/seed-station-config.js`, `electron/sync/handlers/{songs,song_metadata_values}.js`,
  `src/types/metadata.ts`, `src/audio/{id3,songAnalysis,loggen}.ts`,
  `src/components/{ImportDialog,LibraryImport,GSelectorImport}.tsx`, `src/App.tsx`, `audiod/loggen.js`,
  `electron/main.js`.
- Note: the pending Date Modified / Date Added display+sort fix (from `songs.updated_at` / `created_at`) is
  implemented and typecheck-clean but not yet built at the time of this audit; it moves those two rows from
  🔴 DEAD to 🟡 DISPLAY-ONLY.
