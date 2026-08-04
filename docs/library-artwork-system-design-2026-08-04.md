# Library artwork system — design of record

**Date:** 2026-08-04 · **Status:** DESIGN. Read-only tracing done. **NOTHING BUILT.**
**Model:** Jeff's "iTunes of old" — every track carries its own correct art, captured once, hand-fixable.
**Builds on:** `docs/spot-artwork-override-design-2026-08-04.md` (shipped v4.4.134/135) and the metadata
trace in this session.

---

## 0 · Read-only confirms, before any design

### ✅ 1 — the real extractor exists and already yields everything needed

`electron/main.js:3165-3182` uses genuine `music-metadata`:

```js
3170  const mm = await import("music-metadata");
3171  const meta = await mm.parseFile(filePath, { duration: false });
3172  const pic = meta.common && meta.common.picture && meta.common.picture[0];
```

`meta.common` carries `picture`, `album`, `artist`, `title`, `year`, `genre` — **one parse yields all of
it.** The import path does not use this. It uses `src/audio/id3.ts`, a hand-rolled parser whose
`ID3Tags` interface is `{title, artist, album, year, genre, durationSec}` — **no picture field exists in
it**, and `ImportDialog.tsx:84` discards the album it did parse ("skip album lookup for reliability").

### ✅ 2 — a persisted artwork folder is the right shape, and differs from spots ON PURPOSE

`app.getPath("userData")` is the established app-data root (`main.js:300`, `:488`, `:2343`).

**Why library art goes to a FOLDER while spot art went in the ROW:** 5 spots × one small image is
nothing. 464+ songs × ~50-200 KB of cover art is 20-90 MB of base64 in a **synced** table, riding
mutation payloads. Same problem, different scale, so a different answer. Not an inconsistency — record
it so nobody "harmonises" them later.

### ✅ 3 — the editor to hang the upload button on

`App.tsx:4634` is the **Edit Metadata** modal, opened from the library right-click menu
(`App.tsx:5286`). That is the existing door; the artwork control goes there.

### ⚠️ 4 — the resolution order already half-exists

As shipped in 4.4.135, `src/lib/albumArt.ts:101-103`:

```
spot/imaging → override → embedded → nothing        (no music store, ever)
music        → embedded → music store (UNVERIFIED)
```

The music-store call (`albumArt.ts:43-44`) searches **title + artist** — but with `limit=1` and **no
check that the returned track corresponds to the request.** That absence, not the missing album term,
is the defect. There is no album data to add: `album_id IS NULL` on **464 of 464** songs and the
`albums` table holds **1 row**.

### ❌ 5 — the Spotify premise is false, and there are no sidecars

- **`spotify_uri IS NOT NULL` → 0 rows.** There are no Spotify-sourced files in the library. The
  `library:writeTrack` path (`main.js:5524`) that creates URI-only rows has never been used here.
  **Capture has no Spotify case to target.**
- **No sidecar images.** The main library folder (`C:\Users\jensj\Music\ether music library`) holds
  1,376 files and **0** `.jpg/.png/.webp/.gif`. Art is **embedded-only**.

So capture targets exactly one source: the embedded picture in the audio file.

### ⚠️ 6 — "Artist - Title" auto-split is NOT safe, and the data proves it

20 unknown-artist rows. 10 contain `" - "`. But the order is not consistent:

```
"Bobby Boris Pickett - Monster Mash…"          → artist first  ✔
"KANYE WEST - MONSTER (NICKI)"                 → artist first  ✔
"Heads Will Roll - A-Trak Remix - Yeah Yeah Yeahs"  → TITLE first, artist LAST  ✘
```

A blind split turns "Heads Will Roll" into the artist. The other 10 have no separator at all
("Doctor Finklestein In The Forest", "Tales from the crypt_mixdown").

**Therefore: no automatic split.** §4 proposes a review-and-confirm tool instead. 20 rows is twenty
minutes of a human being right, versus a migration that is silently wrong on half of them.

---

## 1 · The system

**One capture, persisted; one override, authoritative; one verified fallback.**

```
MUSIC artwork resolution (in order):
  1. manual override        — operator set it in Edit Metadata          (art_source='manual')
  2. captured art           — extracted from the file at import, on disk (art_source='embedded')
  3. music-store lookup     — ONLY when verified to correspond          (art_source='store')
  4. neutral                — no art. Rendered honestly, never guessed.
```

Rule that governs 3: **wrong art is worse than no art.** Same principle that drove the spot fix.

---

## 2 · Capture at import

Replace the hand-rolled parse in `ImportDialog.tsx` with **one** call into a new main-side extractor
that reuses the already-proven `music-metadata` path:

```
audio:extractMetadata(filePath) →
  { title, artist, album, year, genre, durationSec, artWritten: string|null }
```

- Runs `mm.parseFile` **once** and returns tags *and* writes any embedded picture to the artwork folder,
  returning its path. One parse, not two.
- **Filename is still the fallback for title**, exactly as today (`ImportDialog.tsx:77`).
- **Album is now kept** — `albumsFindOrCreate` already exists (`main.js:5527`) and is used by the
  Spotify path; import simply starts calling it. This is the half of Jeff's item 1 that is free.
- If there is no embedded picture, `artWritten` is null and the song's `art_path` stays NULL. That is
  "no art captured", not an error.

### The artwork folder

```
{userData}/artwork/{sha1-of-image-bytes}.{jpg|png|webp}
```

- **Content-addressed**, so an album's twelve tracks sharing one cover store **one** file. Matches the
  existing `_hashToUrl` de-dupe in `now-playing-art.js:53-54`.
- Written once at import; never rewritten by capture.
- Orphans are harmless. A sweep can come later; it is not v1.

### Backfill

Existing 464 songs were imported before capture existed. A one-shot **"Capture artwork for library"**
action (Settings → Library) walks songs with `art_path IS NULL AND file_path IS NOT NULL`, extracts, and
writes. Progress-reported, cancellable, resumable — it is the same shape as the R2 library sync that
already exists. **Never touches a row whose `art_source='manual'`.**

---

## 3 · Schema — code-managed vs user-managed, decided before the migration

**Standing rule, applied.** Two new columns on `songs`:

| column | type | managed by | meaning |
|---|---|---|---|
| `art_path` | TEXT NULL | **code-captured, user-overridable** | absolute path into the artwork folder, or a user-chosen file |
| `art_source` | TEXT NULL | **code** | `'embedded'` \| `'store'` \| `'manual'` \| NULL |

**Why `art_source` is not optional.** Without it, the backfill and any future re-capture cannot tell a
captured image from one Jeff hand-set, and would silently overwrite his choice. `art_source='manual'` is
the lock. This is the single most important column in the design.

`album_id` is **code-captured** (from tags at import) and **user-editable** (Edit Metadata). It already
exists; no change beyond starting to populate it.

**Migration v37** — `songs.art_path TEXT`, `songs.art_source TEXT`. Both nullable, no default: NULL
means "nothing captured", which is every existing row. Additive, no rebuild, idempotent. Verified on a
DB copy before the live DB; the app applies it at startup (`main.js:1120-1130`).

Both columns must be registered in `electron/sync/synced-tables.js` **and** in the songs handler's
`PATCHABLE` list — omitting the latter is what silently drops a field on `updateById`, as found during
the spot build (`handlers/spots.js:17`).

**Sync note, stated not discovered later:** `art_path` is a local filesystem path and is meaningless on
another install — the same accepted limitation as the spot override and the library `file_path` gap. A
peer receiving it should treat a non-existent path as "no art" and fall back. It is not a bug to fix by
uploading art to R2 without Jeff's call.

---

## 4 · Upload / replace in the library editor

In the **Edit Metadata** modal (`App.tsx:4634`), the same control shipped for spots: thumbnail,
**Choose image…**, **Clear** — plus one addition that spots didn't need:

- **Re-capture from file** — re-extract the embedded picture, discarding a manual override. The way back
  after a mistake.

Choosing an image sets `art_path` to the chosen file and `art_source='manual'`. **Clear** sets both
NULL, which means the song falls back to the store lookup, then neutral.

The picker reuses the existing image dialog. (Note the known cosmetic wart carried over from the spot
build: the shared picker is titled "Choose Station Logo". Fixing it is one line, parameterising
`main.js:5589`, and would fix both surfaces — recommend doing it here since this is the second caller.)

### The 20 unknown-artist rows

**A review tool, not a migration.** A small panel lists each unknown-artist song with a *proposed* split
where a separator exists, both fields editable, each row confirmed individually. Nothing is written
without a click. §0.6 shows why: on this data a blind split is wrong roughly half the time.

---

## 5 · Verified music-store lookup

Replace `albumArt.ts:39-50`. The query keeps title + artist (album is empty library-wide, so there is
nothing to add), but:

- **Raise `limit=1` → `limit=5`** and consider all candidates.
- **Accept only on correspondence.** Normalise (lowercase, strip punctuation, strip `(feat…)`,
  `- remaster`, `[HQ]`, bracketed suffixes) and require **both**:
  - candidate `trackName` matches the requested title, and
  - candidate `artistName` matches the requested artist.
- **No artist → no lookup.** A title-only search is exactly how a commercial got a band's cover. If the
  song has no usable artist (20 rows today), return neutral rather than guess.
- **On any doubt, return null.** Neutral beats wrong.
- Cache the *decision*, including "no acceptable match", so a miss isn't retried every session.

Result is stored as `art_source='store'` **only if** it is persisted; otherwise it stays a session
value. Recommendation: **do not persist store results** — they are someone else's URL, they can rot, and
persisting them makes a wrong match permanent. Captured/embedded and manual persist; store stays live.

---

## 6 · Architecture compliance

| Rail | Compliance |
|---|---|
| Correct minimal solution | Reuses `music-metadata` already in main, `albumsFindOrCreate` already written, the spot artwork control already built, the existing Edit Metadata door. |
| Doors before rooms | Artwork lives in the editor operators already open; the backfill sits in Settings → Library with a help entry. |
| Honest state | Neutral when unknown. No guessed art. `art_source` records *how* each image was obtained, so the UI can say so. |
| Build the sense | Backfill reports captured / no-embedded-art / failed counts; the editor shows the source of the current image. |
| No schema without cause | Two columns, one migration, verified on a copy first. |
| Content-class isolation | Untouched: spots/imaging keep their own chain with no store lookup (v4.4.135). |

---

## 7 · Build order

1. **Slice A — capture + schema.** Migration v37, `audio:extractMetadata`, import uses it (art + album),
   registered in synced-tables + PATCHABLE. New imports carry correct art immediately.
2. **Slice B — backfill.** One-shot capture over the existing 464, skipping `art_source='manual'`.
3. **Slice C — the override.** Artwork control in Edit Metadata; resolution order honours it.
4. **Slice D — verified lookup.** Match-checking replaces the blind `limit=1`.
5. **Slice E — the 20.** Review-and-confirm artist/title tool.

A–C are the "iTunes of old" model working. D removes the last source of wrong art. E is cleanup.

---

## 8 · For Jeff before building

1. **Slice order** — A→B→C first, or is the verified lookup (D) more urgent than the backfill (B)?
2. **Persist store results?** Recommend no (§5). Confirm.
3. **The shared picker title** — fix "Choose Station Logo" to be caller-supplied while here? One line,
   fixes spots too.
4. **Spotify** — item 5 of the request assumed Spotify-sourced files exist; there are **zero**. Confirm
   nothing is expected there, or tell me what you were seeing.
