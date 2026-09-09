# One arc: rows sync, files follow, any machine signs in and is current

**Status: CURRENT · 2026-09-09 · SWEEP + FIX BUILT (§1) · §2–§5 ARE PROPOSALS, NOTHING BUILT.**

Jeff, 2026-09-09:
> "Carts work like everything else. A file can come from anywhere — desktop, downloads, a USB stick —
> Ether ingests it, copies it into the catalogue, registers the row, and it fires from the catalogue."
>
> "R2 backs up songs only. That's wrong and it was always wrong — an mp3 is an mp3, the table name is
> just a name."
>
> "Design it as ONE thing to the operator. I don't want a Sync toggle and a Backup button and a cloud
> restore that each do half the job."

---

## 0 · Measured state, both machines

| | this machine (jensj) | OV (projector) |
|---|---|---|
| catalogue | `%LOCALAPPDATA%\Ether\catalogue` | `C:\Users\projector\AppData\Local\Ether\catalogue` |
| files in it | **483** (425 mp3 + 58 wav), **2.9 GB** | 481 (Jeff, runtime) |
| rows with audio | **602** | 600 |
| rows pointing outside the catalogue | **0** | 0 (Jeff: foreign 0, dead 0) |
| rows whose file is missing | **0** | 2 cleared |

Both machines are flat catalogues under their own user. **The premise T-new-4 was written against is
gone, and the migration that would have moved stragglers has nothing left to move.**

> Correction on the record: an earlier read in this session described OV as being on 4.5.0 with carts
> in `jensj\Downloads`. That came from the `P:\openair.db.ov-20260908.db` snapshot and was a day
> stale. OV is on 4.6.19 and clean. Nothing in this document rests on the stale read.

---

## 1 · The drop-hole sweep — BUILT

### 1.1 · Every door that puts an operator-chosen file into a row

**Copy-on-import present (correct before this change):**

| door | `file:line` | writes to |
|---|---|---|
| Cart assign — picker (`cart_slots` wall) | `DeckConfigurator.tsx:1111` | `cart_slots` |
| Cart assign — picker (localStorage wall) | `App.tsx:3567` | `ether_carts_v1` |
| Announcements | `Announcements.tsx:817` | `announcements` |
| Spots — file | `Spots.tsx:207` | `spots` |
| Spots — folder | `Spots.tsx:230` | `spots` |
| Library import | `ImportDialog.tsx:72` | `songs` |
| Track editor | `TrackEditor.tsx:68` | `songs` |
| G-Selector import | `GSelectorImport.tsx:215` | `songs` |
| Publish episode | `PublishEpisode.tsx:291` | `published_episodes` |

**Copy-on-import MISSING — the holes:**

| # | door | `file:line` | writes to | status |
|---|---|---|---|---|
| **A** | Cart **drag-and-drop** (`cart_slots` wall) | `DeckConfigurator.tsx:1035` | **`cart_slots` — SYNCED** | **FIXED** |
| **B** | Cart **drag-and-drop** (localStorage wall) | `App.tsx:3616` | `ether_carts_v1` | **FIXED** |
| **C** | Voice-track take | `VoiceTracker.tsx:719` `writeTakeFile()` | `voice_tracks` | **open — §1.3** |
| **D** | Imaging region commit | `imagingCommit.ts:28` `renderRegionToDisk()` | `songs` | **open — §1.3** |

A is the serious one and is exactly what Jeff found. `cart_slots` is a **synced** table, so a path
written by the drop handler travelled to every peer; a peer without that directory got a cart it
could not open. Copy-on-import was added to the picker paths on 2026-09-04 and the drag paths were
missed — one gesture guarded, the other not, on the same tile.

**The model to copy:** `BroadcastEditor.tsx:1311` already writes its exported clip into
`audioLibraryDir()` and names the reason in a comment. It is the only generated-audio path that gets
this right.

### 1.2 · The guard — `scripts/smoke-copy-on-import.js`

Static, CI-able. Three sections: every drop handler that stores a path must call
`importIntoAudioLibrary` between reading `dataTransfer` and storing; both cart walls' both gestures
checked by name; generated-audio destinations reported.

**Proven to bite:** run against the pre-fix tree it fails on both A and B by name. A guard that cannot
fail is not a guard.

### 1.3 · C and D — generated audio lands outside the catalogue

Neither imports a browsed file; both **generate** audio and write it into the profile directory:

- `writeTakeFile()` → `<profileDir>/voice-tracks/vt_<ts>.wav`, then `voiceTracks.create({file_path})`
- `renderRegionToDisk()` → `<profileDir>/imaging/<reel-slug>/<name>.wav`, then `songs.create({file_path})`

Under "every audio file lives in one folder" these are the same violation as A and B — the row points
outside the catalogue by construction. **Neither has ever run on this machine** (no such folders
exist), so they have produced no bad rows here.

**Not fixed, because one of them carries a design question:** `renderRegionToDisk` organises by
**reel subfolder**, which a flat catalogue collapses. Is that organisation load-bearing for the Reel
Splitter, or incidental? Voice tracks have no such question and could move today.

**Needs your call.** The guard reports both as `NOTE` and flips to `PASS` on its own when they move.

### 1.4 · Migration re-run — nothing to do

You asked me to re-run the migration here to bring stragglers in. Measured: **602 rows, 0 outside the
catalogue, 0 missing files.** There are no stragglers. Running it would be a no-op, so I did not.

---

## 2 · The cart carve-out — what removing it costs

### 2.1 · What T-new-4 was protecting against

> **T-new-4.** *a `cart_slots` row pointing outside the music dir is **not** rebased into it*

Read against `docs/audio-library-one-folder-rule-2026-09-04.md` §4, it was protecting **two different
things that got bundled into one rule**:

1. **"Carts may legitimately live outside the library"** — the premise. It came from a measurement
   (10 of 10 carts in `Downloads`) that was read as a design intent rather than as the defect it was.
   **This premise is dead.** Both machines are flat catalogues; the measurement that motivated it now
   reads 0.
2. **"The sync layer must never rebase a path on its own"** — the protection. Rebasing on mutation
   apply would have the receiver *invent* a path the operator never chose, which is the same class of
   defect as broadcasting the sender's path. **This is still right and must survive.**

The one-folder doc already proposed the split, and it holds:

> **T-new-4 (revised).** A `cart_slots` row pointing outside the audio library is reported `foreign`
> like any other table. Rebasing happens at import and by explicit migration — never silently on
> mutation apply.

### 2.2 · What breaks when `neverForeign` goes

Blast radius is **five lines in three files**:

| site | change |
|---|---|
| `audio-library-index.js:113` | drop `neverForeign: true` from the `cart_slots` entry |
| `library-health.js:124` | the `opts.neverForeign` branch becomes dead — remove the option, don't leave an unused escape hatch |
| `library-health.js:109,138` | the two comments explaining the carve-out |
| `test-library-health-foreign.js:84` | **inverts** — a cart outside the catalogue is now `foreign`, not `dead`-but-local |
| `test-library-health-foreign.js:87` | a cart resolving outside is still `resolves` but is **also** `foreign` |

**Nothing else reads the flag.** No resolver path, no sync path, no UI.

**What it changes at runtime, today:** nothing. Both machines report `foreign: 0` for carts because
every cart is in the catalogue. The carve-out is currently suppressing a signal that has nothing to
suppress. That is the best possible moment to remove it — the alarm goes live already green.

### 2.3 · A cart still pointing outside

Three tiers, in order, and none of them is new:

1. **It plays.** The resolver's basename tier finds it in the local catalogue (`resolvesElsewhere` in
   the classifier). Airing is not affected by this change.
2. **It is now visible.** Health reports it `foreign` instead of hiding it. That is the point.
3. **It is repaired by an explicit act** — the migration, or CHANGE FILE LOCATION — never silently on
   mutation apply.

**No row is rewritten by removing the flag.** It is a reporting change only.

### 2.3a · THE LIMIT OF IT — found while building, and it needs a ruling

`classifyRow` **short-circuits on reachability**, on its very first line:

```js
if (exists(fp)) return { cls: 'resolves', foreign: false };
```

So **a file that opens is never reported `foreign`, on any table.** That is the classifier's own
semantics and it was never what the cart carve-out controlled.

The consequence, stated plainly: **a cart sitting on the desktop that plays on this machine still
reads clean.** It travels nowhere, no basename resolves it on another machine, and health says
nothing. Removing `neverForeign` does not fix that case — it only makes an *unreachable* cart
countable.

`docs/audio-library-one-folder-rule-2026-09-04.md` §4 proposed exactly this case as `foreign`
("the file being reachable does not make its location legitimate"). It is right, and it is **a change
to the shipped meaning of `foreign` for every table**, not a cart carve-out removal — so it is not
smuggled in. `H-5c` in `test-library-health-foreign.js` pins the current behaviour so nobody assumes
otherwise.

**Needs a ruling.** Make `foreign` mean "the stored path is not in the catalogue", independent of
whether the file opens? Both machines read 0 either way today, so it would ship green here too. My
recommendation is yes, for the same reason as the carve-out: it is a signal that currently cannot see
the thing it exists to see.

### 2.4 · Is this the held one-library arc, or something smaller?

**Smaller, and separable.** The held arc is the ~12 import paths, the 60-string rename, and the
folder move. Those are done or moot: copy-on-import is on every door (§1), and both machines already
moved. What remains of the carve-out is a **five-line reporting change plus a doc amendment**.

### 2.5 · Does `[N-23a]` then cover carts with no special case?

**Yes, and this is the part that makes it worth doing now.** `[N-23a]` says the receiver takes the
**basename** and discards the directory. That rule is type-blind — it never asks which table a row
came from. The only reason carts needed a carve-out was that their audio might legitimately be
somewhere the basename would not resolve. With every file in one catalogue, a basename plus the local
catalogue always resolves, so carts need no special case anywhere in the sync path.

`resolvesElsewhere` stops being a fallback and becomes the normal resolution.

---

## 3 · R2: back up the catalogue, not one table

### 3.1 · What it does today

- **Upload** (`main.js:10751`) — `SELECT id, file_path FROM songs WHERE … r2_uploaded_at IS NULL`.
  Row-driven, songs-only. Resume marker is `songs.r2_uploaded_at`.
- **Download** (`main.js:10887`) — `SELECT id, file_key, file_path FROM songs WHERE file_key …`.
  Also songs-only.
- **The leak** (`main.js:10923`) — download writes `file_path` through the **mutation-logged** writer,
  so every machine restoring from R2 broadcasts its own local paths to every peer. A fresh install
  pulling 510 songs emits 510 path mutations. **This is the highest-volume path-leak vector in the
  tree**, and it is on the restore path, which is exactly when a machine is least able to cope.

### 3.2 · Folder-driven, and what it costs

Walk the catalogue, upload each audio file under `<license>/audio/<basename>`, with a manifest
(`{basename, size, mtime}`) as the resume marker and the "what is already up there" answer.

**Storage, measured:** 483 files, **2.9 GB**. R2 is **$0.015/GB-month** → **≈ $0.044/month** for one
machine's catalogue. Both machines share the same basenames, so the second machine adds **≈ nothing**
— same keyspace, same objects. Egress is free on R2; Class A (write) ops are $4.50/million, so a full
483-file upload is ~$0.002.

**The cost is not the issue. Two hundredths of a dollar a month is not a decision.**

**No migration needed.** Folder-driven needs no `file_key` and no `r2_uploaded_at` on any table,
because neither the key nor the resume marker is a row property any more. That is what unblocks it —
the wider-query alternative is blocked on a five-table migration.

**Backwards compatible:** existing objects are already keyed by basename
(`fileKey = path.basename(song.file_path)`, `main.js:10767`), so a folder-driven upload lands in the
same keyspace and nothing needs re-uploading.

### 3.3 · Restore, on a machine that doesn't have the file

Download pulls what the manifest has and the local catalogue lacks, **straight into the catalogue**,
and **writes no rows at all**. That removes §3.1's leak *by construction* rather than by discipline —
there is no row write left to route wrongly.

Rows then resolve by basename through the resolver that already exists. A machine that signs in gets
its rows immediately and its audio as it lands.

### 3.4 · What still needs a row-side fix, and what comes free

| concern | unit | mechanism | status |
|---|---|---|---|
| **Backup / restore** — get my audio onto another machine | the **folder** | folder-driven + manifest | **free** — no migration |
| **Materialization** — fetch the audio for *this one row* | the **row** | `file_key` | still needs the five-table migration; rides with the protocol amendment |
| The restore path-broadcast leak | — | write `file_path` local-only | **free** — folder-driven writes no rows |
| Carts/spots/announcements in the backup | — | — | **free** — the walk does not ask what a file is |
| The unreferenced files in the catalogue | — | — | **free**, and correct for a *backup* |

### 3.5 · Does anything still assume songs-only?

Yes — three places, and they are the whole list:

1. `main.js:10751` upload query — `FROM songs`
2. `main.js:10887` download query — `FROM songs`
3. `songs.r2_uploaded_at` / `songs.file_key` as the only resume/identity columns

Everything downstream is already type-blind: `audio-library-index.js` walks by extension and knows
nothing about tables, and the resolver matches basenames.

---

## 4 · ONE thing to the operator

> "The user says *keep my stuff synced* and Ether does the hard part — rows and files, in the right
> order, both directions." — Jeff

### 4.1 · The surface

**One switch: `Keep my station synced`.** On or off. No Backup button, no Restore button, no separate
cloud-library toggle.

Under it, **one honest status line** that names what is actually happening, in the operator's words:

```
Keep my station synced                                    ●  ON

    Up to date · 483 files · last checked 12 seconds ago

    ─ or, while working ─

    Catching up · 47 of 483 files · about 4 minutes left
```

That is the entire surface. Everything else is a consequence.

### 4.2 · The rule that makes one button honest

**A row whose audio has not arrived does not look playable.**

This is the whole design. Rows sync in seconds; 2.9 GB of audio does not. The gap is unavoidable —
what is *not* unavoidable is a library that lists a track, lets you load it to a deck, and produces
silence. So:

- a row whose audio is still coming shows as **Coming down** — visible, greyed, not loadable to a
  deck, not selectable by rotation, not counted as available;
- it becomes ordinary the moment its file lands. No refresh, no restart;
- **the scheduler never picks one.** This is the part that must not be got wrong: a generator that
  places a not-yet-present track produces dead air at a specific future minute.

An operator never sees a half-finished state because **the half-finished state is a visible, named
condition rather than a normal-looking row that fails on air.**

### 4.3 · What the two mechanisms need underneath it

| # | need | why | free? |
|---|---|---|---|
| 1 | **One state machine, not two** — a single `syncState` that owns rows *and* files, with the file phase a declared stage of it | Today they are separate features with separate triggers and separate failure reporting. One button over two independent mechanisms is a button that lies half the time. | **no** — this is the real work |
| 2 | **Order: rows first, then files** | Rows are small, and the manifest tells the file phase what to fetch. Files-first has nothing to aim at. | free |
| 3 | **A per-row presence answer** the UI can read cheaply — "is this row's audio here?" | This is what `Coming down` renders from. `checkFilePresence` exists; it needs to be a bulk, cached read, not a per-row fs stat in a list render. | **no** — small but real |
| 4 | **Rotation and the generator must exclude absent audio** | The one failure that reaches air. The library R2-materialization gate already proved this class: half a station's library never aired because rotation skipped rows whose files were absent — silently. | **no** — and it is the highest-risk item |
| 5 | **The manifest as the shared truth** | Both phases read it: "what should be here" for files, "what is complete" for the status line. | free with §3 |
| 6 | **Failures are named and countable** | "Catching up" must never be a permanent state with no explanation. A file that cannot be fetched after N attempts is named, in the Health Monitor, with its reason. | **no** — but small |
| 7 | **Local-only `file_path` writes everywhere on the restore path** | Otherwise turning the one switch on makes every machine broadcast its own paths — the leak in §3.1, now automatic instead of manual. | free with §3.3 |

**Items 1, 3, 4 and 6 are the build.** 2, 5 and 7 come free with the folder-driven change.

### 4.4 · What one switch means for `sync_enabled`

`sync_enabled` stays as the internal flag; the switch is its face. **It is not currently on for OV**,
and nothing in this document proposes turning it on. That is a separate decision with its own
verification.

---

## 5 · Order, if this ships as one arc

1. **§1 drop-hole fix + guard** — done, and it stands alone. It stops the supply of foreign paths.
2. **§2 carve-out removal** — five lines, two test inversions, doc amendment. Ships green because
   both machines read `foreign: 0` today.
3. **`[N-23a]`** — receiver takes the basename. Now sufficient rather than transitional, and type-blind,
   so carts need no special case.
4. **§3 folder-driven R2** — upload + manifest + download-writes-no-rows. Removes the restore leak by
   construction.
5. **§4 one switch** — the surface, once 1–4 make it honest. **Not before**: a single switch over
   mechanisms that can still produce a playable-looking row with no audio is a button that lies.

Steps 1–4 are each independently shippable and each leave the tree better. Step 5 is the one that
needs the others under it.

---

## 6 · OPEN — needs Jeff

1. **§1.3** — voice tracks and imaging cuts write generated audio outside the catalogue. Voice tracks
   can move today. The imaging path organises by reel subfolder — is that load-bearing, or can it go
   flat into the catalogue?
2. **§3** — upload the catalogue files that no row references? Folder-driven says yes by default and
   I think that is right for a *backup*. On this machine that is the difference between 602 referenced
   rows and 483 actual files — they are nearly the same set, so the question is currently academic
   here, but it will not be on a station with a big unreferenced folder.
3. **§4.2** — does `Coming down` also block **manual** deck load, or only rotation? My recommendation:
   block both, because a jock hitting a greyed track and getting silence is the same defect as the
   generator doing it.
