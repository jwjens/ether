# The library reports 510 — measured, and why

**Status: CURRENT · last verified 2026-09-04 · READ-ONLY, NOTHING CHANGED**
Machine: dev (jensj). Profile DB: `%LOCALAPPDATA%\Ether\profiles\ETH-STN-BAA8-E056-6FC8\openair.db`
(748 MB, modified 2026-09-04 09:17 — the only live DB on this machine; the other three `openair.db`
files are 0-byte, May, or July and are not in use).

Operator report, verbatim: *"The backup/sync keeps reporting 510 songs but I've added many more
since."*

**The report is correct. The songs are missing. But the count is not stale and nothing is filtering
them out — the rows were never created.**

---

## 1 · What produces the number

`electron/main.js:10567` — `library:cloud-status`:

```js
const LIVE = "FROM songs WHERE deleted_at IS NULL AND file_path IS NOT NULL AND file_path != ''";
const total    = n(`SELECT COUNT(*) AS n ${LIVE}`);
const uploaded = n(`SELECT COUNT(*) AS n ${LIVE} AND r2_uploaded_at IS NOT NULL`);
```

Two filters only: **not deleted**, and **names a file**. It does **not** touch the disk, and applies
no station scoping (`songs` has no `station_id` column — the library is account-wide).

The silent `.filter()` at `:10689` is a **different** query, in the uploader's Phase 2, and it is the
only place `fs.existsSync` is consulted:

```js
.all().filter(s => { try { return fs.existsSync(s.file_path); } catch { return false; } });
```

---

## 2 · The four numbers, measured

```
songs (table; NOT a view on this DB — songs_all absent)  : 543
deleted_at IS NULL                                       : 510
+ file_path non-empty          <-- THE REPORTED NUMBER   : 510
+ file exists on disk          <-- WHAT THE UPLOADER SEES: 510
of which already uploaded                                : 510

SILENTLY DROPPED by the uploader's .filter() RIGHT NOW    : 0
```

**The silent filter is dropping nothing.** The 543→510 gap is 33 rows with `deleted_at` set — deletes,
correctly excluded. Every live row has a file that exists, and every one is already uploaded.

So `510` is an honest count of what is in the database.

---

## 3 · The actual defect — the songs are not in the table at all

The newest row in `songs` was created **2026-07-24**. Nothing has been inserted since.

Matching the library folder against the table **by basename** (so a rewritten path cannot hide a
match):

```
library folder : C:\Users\jensj\Music\ether music library
audio files    : 1878
songs rows     : 543  (live 510)

files matching a LIVE song row    :  729
files matching a DELETED song row :   36
files with NO row at all          : 1113
```

**1,113 audio files sit in the designated library folder with no row in `songs`.** The most recent
orphans are exactly the additions in question:

```
2026-09-03 13:12  A_Thousand_Miles_spotdown.org.mp3
2026-09-02 16:41  Havana__feat._Young_Thug_.mp3
2026-09-02 16:39  The_Fate_of_Ophelia_spotdown.org.mp3
2026-09-02 15:46  Suga_Suga_spotdown.org.mp3
2026-09-02 15:46  All_You_Wanted.mp3
2026-09-02 15:46  I_Like_You__A_Happier_Song___with_Doja_Cat__spotdown.org.mp3
```

(729 files match 510 live rows because duplicates — the `- Copy` files — share a basename with a row.)

### The consequence, which is the operator's point

**They are not backed up.** The uploader enumerates `FROM songs`. A file with no row is invisible to
it — not skipped with a warning, simply never considered. The same is true of every other
library-driven path: rotation, Generate, and the A/B/C load path all read `songs`.

---

## 4 · What this is NOT

- **Not a stale count.** Re-measured live; 510 is what the table holds this second.
- **Not the silent `.filter()`.** It drops 0 rows right now. It remains a real hazard — a missing file
  is skipped with no counter and no log line — but it is not causing this.
- **Not station scoping.** `songs` has no `station_id`; nothing is scoped out.
- **Not deletes.** The 33 deleted rows are separate from the 1,113 orphans.

---

## 5 · OPEN — needs Jeff

**How were these files added?** The answer decides whether this is a bug or a missing door:

- **Copied into the folder directly** (the `spotdown.org` naming suggests downloads landing there) —
  then the question is whether dropping files into a folder named *"ether music library"* is expected
  to import them. If it is not, that is a doors-before-rooms defect: the folder's name is a promise
  the app does not keep, and there is no signal that 1,113 files are being ignored.
- **Through an Import in the UI** — then the import silently failed to write rows, and that is a
  straightforward bug to chase from the import path.

**Regardless of which, one thing is worth building:** the library has no sense of "files present in
my own library folder that I know nothing about." 1,113 is not a number that should be discoverable
only by a hand-written script. That belongs in the Health Monitor as a permanent sense.

**Nothing was changed. No fix proposed until the question above is answered.**
