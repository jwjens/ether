# The cloud backup should carry the audio library, not one table · PLAN

**Status: CURRENT · last verified 2026-09-04 · PLAN (§1-5) + BUILT (§6). Local, uncommitted.**
Follows `docs/audio-library-one-folder-rule-2026-09-04.md`.

Jeff, 2026-09-04:
> "Cloud backup of my library" means "my songs" — which is a narrower promise than the name makes,
> and it's the same songs-only assumption behind everything this week. Under the one-library rule
> that assumption is now wrong by definition. Every audio file lives in one folder; the backup should
> carry that folder's audio, not one table's rows.

---

## 1 · What it does today

### 1.1 · Upload — `library:sync-r2:upload`

**Phase 1, consolidate.** Builds a basename index of the library's PARENT folder, resolves each
**song** to a real file, and copies it into the library. Row-driven: a file in the library that no
`songs` row names is never considered.

**Phase 2, upload** (`main.js:10751`):

```sql
SELECT id, file_path FROM songs
 WHERE deleted_at IS NULL AND file_path IS NOT NULL AND file_path != ''
   AND r2_uploaded_at IS NULL          -- the resume marker
```

**Resume marker: `songs.r2_uploaded_at`** — a column on `songs`.

### 1.2 · Download — `library:sync-r2:download` (`main.js:10887`)

```sql
SELECT id, file_key, file_path FROM songs WHERE file_key IS NOT NULL AND file_key != ''
```

**Fetch key: `songs.file_key`** — also a column on `songs`.

### 1.3 · Measured consequence on this machine

1,878 audio files in the library; **1,113 of them have no row in `songs`**. Under today's design the
cloud backup would carry, at most, the 765 that do — and none of the carts, spots or announcements,
which are the things that went silent on OV.

---

## 2 · ⚠ A leak found while reading this — the download broadcasts paths

`main.js:10923`, and its comment presents this as deliberate:

```js
// Write file_path (mutation-logged) so the automation picker treats this cloud
// song as a rotation-eligible local track.
try { songsUpdateById(db, song.id, { file_path: res.filePath }); }
```

**Every machine that restores its library from R2 broadcasts its own local paths to every peer.** A
fresh install pulling a 510-song library emits 510 path mutations — the highest-volume vector found
so far, and precisely the shape that put `C:\Users\projector\...` on this machine and
`C:\Users\jensj\...` on OV.

The fix is the one already applied to `applyRelink`, the migration and CHANGE FILE LOCATION: write
`file_path` **local-only**. Small, self-contained, and it belongs with this work.

---

## 3 · THE QUESTION: wider query, or folder-driven?

### 3.1 · The wider query

Extend both statements across the seven audio-bearing tables.

- ✔ Smallest conceptual change; keeps the existing per-row resume and fetch mechanics.
- ✘ **Blocked on a schema gap.** `announcements`, `spots`, `cart_slots`, `voice_tracks` and
  `published_episodes` have **neither `file_key` nor `r2_uploaded_at`**. Both are needed: one to name
  the object in R2, one to resume. That is a numbered migration across five tables — the same
  migration `docs/design-machine-local-paths-2026-09-04.md` Option B is blocked on.
- ✘ **It still misses the 1,113.** A file in the library with no row remains invisible, so the
  promise "backup of my library" is still not kept — only kept *wider*.
- ✘ It re-states the assumption in a new costume: the backup is still an index of rows, not the
  library.

### 3.2 · Folder-driven

Upload the audio files **in the library folder**. The unit is the file; the key is its basename.

- ✔ **It is what the rule says.** Every audio file lives in one folder — so that folder IS the
  library, and backing it up is backing up the library. No table is privileged.
- ✔ **No migration.** It needs no `file_key` and no `r2_uploaded_at` on any table, because neither
  the key nor the resume marker is a row property any more.
- ✔ Carries carts, spots, announcements, sweepers, voice tracks, episodes **and** the 1,113
  unreferenced files, without knowing or caring what any of them are — which is the same principle as
  "type is metadata on the row, never a reason to store the file somewhere else."
- ✔ Restore becomes trivially correct: pull the folder, and every row that names a basename inside it
  resolves — which is exactly the property the resolver tier and `[N-23a]` are built around.
- ✘ Needs a **manifest** instead of a row column for resume and for "what is already up there".
- ✘ Uploads files nothing references. For a *backup* that is correct — they are audio the operator
  put in their library — but it is bandwidth and storage, and it should be the operator's call.

### 3.3 · RECOMMENDATION — folder-driven, and it is not a close call

**A backup keyed on rows cannot keep the promise its name makes.** The 1,113 files are the proof:
they are in the library, the operator put them there, and no widening of a row query will ever
include them.

**But one thing the wider query buys must not be lost.** Per-row **materialization** — "this row's
audio is not here, fetch just it" (the prefetch path, and `r2Only` in the health classifier) — needs
a per-row key, and that is still `file_key`. Folder-driven backup does not replace it.

So the two concerns separate cleanly, and should:

| concern | unit | mechanism |
|---|---|---|
| **Backup / restore** — "get my audio onto another machine" | the **folder** | folder-driven, manifest-based. No migration. **Build this now.** |
| **Materialization** — "fetch the audio for this one row" | the **row** | `file_key`, needing the five-table migration. **Rides with the protocol amendment.** |

---

## 4 · The plan (folder-driven backup)

1. **Upload** walks the audio library (reusing `audio-library-index.js` — one definition of what
   counts as an audio file and one walk), and uploads each file under `<license>/audio/<basename>`.
2. **A manifest** in R2 alongside it: `{basename, size, mtime, sha?}` per file. It is the resume
   marker and the "what is already up there" answer, replacing `r2_uploaded_at` for this purpose.
   Compare by size first; a hash only where sizes collide.
3. **Download** pulls what the manifest has and the local folder lacks, straight into the library
   folder. **It writes no rows at all** — which removes §2's leak by construction rather than by
   discipline, because there is no row write left to route wrongly.
4. **Rows resolve afterwards by basename**, through the resolver tier that already exists. A restored
   machine gets its audio, and every row pointing at a foreign path resolves against the local
   library — which is `resolvesElsewhere` in the health classifier, and the whole point of the rule.
5. **Keep `songs.r2_uploaded_at` and `file_key`** untouched. Materialization still uses them; this
   plan does not disturb that path.
6. **Progress and refusals stay loud**, same as the migration: named files, named reasons.

**Backwards compatibility:** existing R2 objects are already keyed by basename
(`fileKey = path.basename(song.file_path)`, `main.js:10767`), so a folder-driven upload lands in the
same keyspace and an existing library does not need re-uploading wholesale.

---

## 5 · OPEN — needs Jeff

1. **The 1,113 unreferenced files — upload them?** Folder-driven means yes by default, and I think
   that is right for a *backup*. But it is ~GB of audio nothing currently plays. Options: upload
   everything (truest to the rule), or upload everything with a visible count and a way to exclude.
2. **Does §2's leak fix ride with the tag, or with this work?** It is three lines and independent —
   my instinct is fix it before tagging, since every restore is currently a broadcast.
3. **Scope check:** this replaces the *audio* backup only. The gzipped `openair.db` cloud backup
   (`electron/cloud-backup.js`) is separate and unchanged.

---

## 6 · BUILT 2026-09-04 (local, uncommitted)

All three items, per Jeff's go.

### 6.1 · The resolver tier — BOTH sides
Jeff: *"Fixing one without the other gets me announcements on decks while nothing airs, or the
reverse."*

- **`electron/main.js`** — `resolveLocalAudioPath` gains tier **(1b)**: the audio-library index,
  tried **before** R2. Index cached 30s (a log refill resolves dozens of rows in a burst).
- **`audiod/engine.js`** — `_resolveLocal(fp)` **returns a path, not a boolean**, and that is the
  actual fix: `_fileOk` only ever answered "playable?", so a row could pass the gate and then be
  loaded from the path that does not exist. `_playable()` and the refill admission now carry the
  **resolved** path. `_fileOk` is retained as a thin wrapper so the two can never disagree.
- The daemon learns its library from `ETHER_PROFILE_DIR` (published by `ether-audiod.js` beside the
  DB open), falling back to the same default as the app.
- **`electron-builder.json`** — `electron/audio-library-index.js` added to `asarUnpack`. The daemon
  runs unpacked and requires it; without this the tier would silently never work in a packaged
  build. Precedent: two `electron/sync/*.js` files are unpacked for exactly this reason.

### 6.2 · The download path leak — closed
`main.js` R2 download wrote `file_path` through `songsUpdateById` — the **sync-logged** writer — and
the old comment presented it as the point: *"(mutation-logged)"*. A fresh install pulling a 510-song
library emitted 510 mutations each carrying its own absolute paths. Now local-only; and the bulk
download writes no rows at all (§6.3), so the vector is gone by construction. The now-dead
`songsUpdateById` imports were removed from that loop and from the `library-folders` registration.

### 6.3 · Folder-driven R2 — `electron/audio-library-r2.js`
- **Upload** walks the audio library and pushes every audio file. Resume is by **manifest + size**,
  not a row column, because most of these files have no row. Keyspace unchanged (basename), so an
  existing library needs no re-upload.
- **Download** is manifest-driven and **writes no rows** — files land in the library and rows resolve
  by basename through §6.1. The backend has no LIST endpoint, so the object set is described by a
  manifest stored under the reserved key `_audio-library-manifest.json`.
- **Phase 1 consolidation still runs** and still sets `songs.file_key`: per-row *materialization* is a
  different concern from backup and still needs a per-row key.
- Downloads verify size and discard short files (`.part` → rename only on success).

### 6.4 · Gates
`npm run test:resolver` (15) · `test:audio-library-r2` (25) · `test:audio-library` (41) ·
`test:relink` (21) · `test:library-foreign` (26). The ones that matter: a file with **no database
row** is backed up and restored; a second run of either direction moves nothing; a short download is
discarded rather than left in the library; `downloadLibrary` takes **no db handle**, so it cannot
write a row even by mistake.

### 6.5 · Still open
- The **1,113 unreferenced files** upload by default. **RULED 2026-09-04 — keep it that way:**
  *"A backup that leaves out files because nothing currently references them isn't a backup — those
  are the same files that turned out to be the carts and announcements when it mattered. GB of audio
  is cheaper than discovering a gap on the machine you're restoring to."* No code change: this is
  already what folder-driven does. Recorded so nobody "optimises" it back to referenced-only later.
- **RUNTIME UNVERIFIED.** Main-process and daemon changes need a restart, and no real R2 round trip
  has been performed. The unit tests use a fake backend.
