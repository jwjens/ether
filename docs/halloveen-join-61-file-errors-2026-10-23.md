# HalloVeen join on the jensj work PC: "no music could be downloaded (61 file errors)", 2026-10-23

Build 4.6.63. Station halloVeen = uuid 43889edc-203d-4743-9e4f-6ea311d6e035, license 24 (jensj).
Diagnosed from the dev box using source, prod Postgres (read-only), R2 and the ether-backend logs. Nothing was written to the database.

## Findings

1. **The message is wrong. The renderer always reports zero files.** `src/components/OnboardingFlow.tsx:694` reads
   `result?.done`, but `downloadCatalogue()` (`electron/audio-library-r2.js:315-328`) returns `downloaded`, so
   `done` is always undefined. That makes `got` 0 and the "no music could be downloaded" branch at :706 runs on every restore,
   even a fully successful one. CloudBackup.tsx:228 and CloudInstallPrompt.tsx:31 read `downloaded` correctly. This is
   also why Retry "fails": Retry hits the same line.
2. **The 61 errors are real but harmless.** Backend log for the restore: the DB backup `24/backups/2026-10-23T20-26-01Z.db.gz`
   was signed at 21:32:12Z, followed by 312 audio signings (277 distinct keys) from 21:32 to 21:36. Of those keys, exactly
   **61 are not in R2**. All 61 are named `<Title>_.org.mp3`. In the restored DB every one of them belongs **only to a deleted
   song row** (deleted 2026-10-19, `file_path` NULL, `r2_uploaded_at` NULL). The manifest listed files that were never uploaded.
3. **The restore pruned them, as designed.** At 21:35Z there was one `[Audio/UploadURL] license:24 key:_ether-catalogue-manifest.json`,
   the `pruneMissing` rewrite (audio-library-r2.js:375). The manifest now has 612 entries, all present in R2, all sizes matching.
4. **Every live song is in the cloud.** Restored DB: 551 live songs, all 551 present in R2 under the exact `file_key` and all in the manifest.
5. **Not a network block.** The errors were per-file "not found in the cloud" (only those get pruned, and the prune count is
   exactly 61). A blocked R2 host would have failed all 277 with `fetch failed` and pruned nothing.

## Logs on a packaged install

The restore writes **no per-file errors to any file**. `console.log('[catalogue:restore] …')` (main.js:14206) goes to
stdout only. `ether-startup.log` (`%APPDATA%\Ether\ether-startup.log`) only gets `logStartup()` lines. The `failures[]` list
(name + reason) reaches the renderer in `catalogue:backup:download:done` and is thrown away there.

## Hosts

- `ether-backend-production.up.railway.app` (signs each URL: POST /audio/download-url)
- `ether-backups.9392ba937a6fdc8f18cec7705cbccf19.r2.cloudflarestorage.com` (the audio bytes, signed GET)

## Side finding

Every ~5 minutes some license-24 machine's pull re-fetches six keys that differ only by letter case
(`Deck The Halls_spotdown.org.mp3` / `Deck the Halls_…`, `Santa Claus Is Coming To/to Town_…`, `Dancing In The/In the Dark_…`).
On Windows the two names are one file, so one of each pair always looks missing or a different size, and the pull never settles.

### Measured, later the same day

All three pairs are **byte-identical in R2** (same ETag and size): Deck The/the Halls `55fe0341…` 2,425,020 B; Santa Claus Is
Coming To/to Town `abb58ca1…` 2,652,396 B; Dancing In The/the Dark `f4733bc7…` 7,085,181 B. Each "To/to" and "The/the" pair is
two live song rows in different categories (699 cat 6 / 1050 cat 14; 738 cat 6 / 1073 cat 14). Dancing In the Dark has one
row (788) and two manifest entries. Mechanism: `downloadCatalogue` matches local files by exact name (`localByName`). NTFS keeps
only one of the two names, so the other always counts as missing. It gets downloaded and renamed over the first, and the next
tick goes the other way. NTFS can't hold both names in one folder, so making them distinct files needs a design decision (item 3).

## Fix status

Items 1 and 2 are committed on release/1019: 82aedea (restore screen reads the real result) and 9a1d380 (per-file log lines +
cleanup accounting). Item 3: Jeff chose option A (store the second spelling under its own name on disk). Built in the commit
after 9a1d380:

- Naming (electron/audio-library-index.js): a name keeps its spelling unless a different-case spelling already holds it.
  Then it lives at `<stem>~c<sha1(name)[0..8]><ext>`, and `caseKeyOf` maps that back to the cloud name.
- Writers: downloadCatalogue (planned up front in code-point order, so concurrent downloads can't both take the plain name),
  fetchR2Track (cache hit and target), and the library-health prefetch.
- Readers: both resolvers (main `resolveLocalAudioPath`, daemon `engine._resolveLocal`) skip the case-blind `existsSync`
  fast path when a different-case spelling holds the name. `findInIndex` tries the exact name, then the alt name, then the old
  case-blind and loose matches.
- Upload: `walkCatalogue` reports cloud names, so an alt file is never uploaded as a new key.
- Test: `npm run test:case-distinct`, 40 checks (the two spellings carry different bytes in the test). Control run on the old
  code: each pull flips the one file between spellings (downloaded 2, then 1, then 1), and both spellings resolve to the same bytes.

What stays as before:
- Up to 30 s after a download, the daemon's index may not yet know a new alt file, so that song resolves to the other
  spelling (identical bytes for the three real pairs). Main's index is cleared on download.
- A single cloud name whose local copy differs only in case now gets its own alt copy beside that file instead of
  overwriting it.

## Fix (original proposal)

- OnboardingFlow.tsx:694: `result?.downloaded ?? 0`.
- Log `res.failures` (name + reason) to ether-startup.log from main.js catalogue:restore, and show the count of names
  pruned from the manifest instead of calling them errors.
