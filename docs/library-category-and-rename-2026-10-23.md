# Library: category dropdown won't open, rename bounces back (OVEVENTS, 4.6.62) — 2026-10-23

## Jeff's report (verbatim)

> Bug on OVEVENTS, 4.6.62: in the Library, a song's category dropdown doesn't open when clicked, and changing a song's
> name bounces back and doesn't save. Find the cause (renderer console errors, the save path, file:line, which commit) and
> whether OV has it too. Fix it in 4.6.63 with a test that edits a song's name, artist and category and confirms each
> saves.

## What is established (read-only)

- **Nothing was saved.** OVEVENTS's journal has no `songs` change since 20:29Z (`scripts/check-sync-items.js`); the
  server has none from either computer since the 4.6.62 installs. So the edits never reached `songs:update-by-id`, or it
  failed before journaling.
- **The log has no Library error.** This session (pid 30976, started 20:45:06Z) in `%APPDATA%\Ether\ether-startup.log`:
  only `[ENGINE] Poll error … daemon cmd timeout: getState` ×77 from 20:46:46Z and a board-watch line. The log carries
  renderer warnings/errors only; an unhandled promise rejection (see below) would not necessarily appear.
- **The Library code did not change in 4.6.62.** `git diff 88625a1 56c1566 -- src/App.tsx` (4.6.61 → 4.6.62): only the
  SyncOffBadge import/render and the DesignationBypassBanner removal. No Library, InlineNameEditor or songs-handler
  change in that range.
- **The save paths (code):**
  - Title: `src/App.tsx:5884-5887` `InlineNameEditor` → `onSave` → `ether.songs.updateById(s.id, {title})` → `load()`.
    `src/components/InlineNameEditor.tsx` `save()` is `try { await onSave } finally { setEditing(false) }` — **no catch**:
    a failed save closes the editor and shows the old name with no message ("bounces back").
  - Category: `src/App.tsx:5943-5948` native `<select>`, `onChange` → `updateById(s.id, {category_id})` → `load()`.
    Disabled only for library_asset rows (`isSongRow`, :4708).
  - IPC: `electron/preload-handlers.js:312` → `electron/sync/handlers/songs.js:458` `songs:update-by-id`.
- **Where the Library is shown:** main window (Library page), ☰ → Library window (`LibraryWindow.tsx`, PopoutRenderer),
  and the Screen Builder "Song Library" module (`src/modules/registry.ts:80`, dockview, 0ec31e5 2026-10-18). All three
  render the same `LibraryPanel`.

## Update 21:00–21:10Z — cause found (fix deferred to the build after 4.6.63, Jeff 2026-10-23)

Jeff, 2026-10-23 (verbatim): "i can click on the categories now but i cant save an artist name"

- **Runtime receipt:** the live journal shows `artists insert` "Will s" (21:04:15Z) and "Will SMith" (21:04:21Z) and **no
  songs update** — the artist was created, the song was never changed. `discogs:updateTrack` (`electron/main.js:10531`)
  returns `{ok:false,error}` and `commitInline` (`src/App.tsx:4931-4946`) ignores the result: silent.
- **Every live song saves** on a copy of the live database: all 551, artist and title, through the real handlers
  (`scratchpad diag-library-edits-all.js`, rolled back per song). The data is not the problem.
- **The Library shows 31 deleted songs as editable-looking rows.** `library_asset` rows of type SONG whose song row is
  deleted (deleted 2026-07-06 … 2026-08-06), all **created 2026-10-21T18:57:58Z** — the minute OVEVENTS first started
  on 4.6.62 (first schema-68 push 18:58:35Z). LibraryPanel shows a library_asset row when no LIVE song has its uuid, with a
  negative id. On such a row: category `<select disabled>` (`App.tsx:5943`) — "doesn't open"; rename `onSave` returns
  early when `!isSongRow` (`:5886`) — "bounces back and doesn't save"; artist → `updateTrack({id:-N})` creates the artist,
  then `songsUpdateById` throws "row not found by id" — "can't save an artist name". Also 5 ANNOUNCEMENT and 4 SPOT
  asset rows (legitimate non-song elements).
- **What recreated them at 18:57:58Z:** not yet identified. Writers of library_asset: `electron/sync/handlers/asset-mirror.js:138`,
  migrations v50/v51, `scripts/backfill-library-assets.js`. Next step.
- **Also found (data loss, older — 486b861, 2026-05-10):** `discogs:updateTrack` builds `patch.artist_id = null` /
  `patch.album_id = null` whenever artist/album aren't in the call (`artistId !== undefined` is always true). An inline
  edit of album/year/genre/bpm clears the artist; an artist edit clears the album. Proven on a copy (song 544: artist
  edit → album_id 3 → null; title via updateTrack → artist_id → null).
- **OV:** UNVERIFIED — same check (library_asset SONG rows with a deleted song, created at OV's first 4.6.62 start).

## Not yet known — needs a runtime receipt (superseded above)

The cause. A select that won't open AND an edit field that reverts both fit the row being re-mounted or its events being
swallowed by the surrounding surface — UNVERIFIED. Needed from Jeff on OVEVENTS: which Library (main window / ☰ window
/ screen module), and the DevTools Console (F12 in that window) while clicking the dropdown and saving a name.

A copy-of-data launch was not used: the copy has no account session (account sign-in is the gate), and signing a copy
in would register a new computer on the license and could sync.

Seen in passing: `%APPDATA%\Ether\ether-startup.log` is 1.87 GB.
