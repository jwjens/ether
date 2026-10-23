# Songs, categories, artists, carts and plays sync check (4.6.62) — 2026-10-21, restarted 2026-10-23

## Jeff's request (verbatim)

> Library, carts and playout sync on 4.6.62: I'll change a song's category and artist and a cart on OVEVENTS. Confirm
> read-only from both machines' databases and the server that they reached OV and applied to the right
> song/category/artist/cart by UUID, and that OV's plays since its install are recorded and syncing. Pass/fail per item.
> Tell me when you're ready for my test changes.

2026-10-23: "Restart the item-2 sync check with a new baseline time of now, and tell me when you're ready for my test
changes."

## Method (read-only everywhere)

- Each computer: `scripts/check-sync-items.js <baseline>` (node:sqlite, opened read-only, safe while Ether runs). Lists
  the songs/categories/artists/cart_slots journal since the baseline, the current state of each touched row by uuid
  (song → category uuid/code/station, artist uuid/name; cart → slot/title/station/file), and plays by the computer that
  aired them, plus this computer's play_log journal by sync status.
  On OV (no repo): `set ELECTRON_RUN_AS_NODE=1` then
  `"%LOCALAPPDATA%\Programs\Ether\Ether.exe" check-sync-items.js <baseline>`.
- Server: the mutations OVEVENTS pushed for those rows (`ref_uuids` it sent) and that OV pulled. Needs `railway login`.
- Pass = same uuid on both computers, OV's song points at the category uuid and artist uuid OVEVENTS chose, OV's cart
  matches by uuid.

## First baseline (2026-10-21T18:58Z) — OVEVENTS, plays only

OV's plays since its install were arriving on OVEVENTS: 135 on halloVeen (20:02:20Z → 00:17:06Z) and 37 on Open Format
(23:13:13Z → 00:17:35Z), aired on `ovowforestmusic`. OVEVENTS's own 41 plays (22:00:03Z → 22:49:34Z) all journaled and
synced. The test changes were not made on that baseline.

## Restarted baseline: 2026-10-23T20:29:00Z

OVEVENTS (client `8e8f6181`, schema 68), 20:29Z:

```
── changes in this computer's journal since then: 0
── songs as they stand here (by uuid)
── carts as they stand here (by uuid)
── plays recorded on this computer since then
  none
  journaled for sync: none
```

Ether was **not running** on OVEVENTS at the baseline (no Ether.exe process). It has to be open for the changes to be made
and to sync; plays from OV reach this database only while Ether here is running.

Server, 20:45Z (pushes since each computer's 4.6.62 install, read-only):

```
client 8e8f6181 (OVEVENTS)  first schema-68 push 2026-10-21T18:58:35Z  last push 2026-10-23T20:27:06Z
  play_log      177 since install ( 177 in last 48h)  2026-10-21T22:00:42Z -> 2026-10-23T20:27:06Z
  users           3 since install (   0 in last 48h)
client 041ceb96 (OV)        first schema-68 push 2026-10-21T19:49:36Z  last push 2026-10-23T20:44:09Z
  play_log     1933 since install (1906 in last 48h)  2026-10-21T20:02:28Z -> 2026-10-23T20:44:09Z
  users           1 since install (   0 in last 48h)
```

No categories, songs, artists or cart_slots pushes from either computer since the installs: nothing changed them, so
the test changes are the first exercise of those tables on 4.6.62.

## Results

Jeff, 2026-10-23: "run the item-2 check with just the cart I added ("idoberg creepy halloweenfx v3...")". The song edits
could not be made (docs/library-category-and-rename-2026-10-23.md).

Cart `4cb0e991-0d0d-43de-8c84-c61311eaf29b`, slot 11, halloVeen (`43889edc`):

| OVEVENTS (UTC) | change | server received |
|---|---|---|
| 20:47:22 | title "" → "idoberg creepy halloween bell trap melody 247720", file set | 20:48:01 seq 1071613 |
| 20:47:30 | cleared | 20:48:16 seq 1071614 |
| 20:47:42 | title → "idoberg creepy halloween fx v3 249319", file `…\catalogue\idoberg-creepy-halloween-fx-v3-249319.mp3` | 20:48:26 seq 1071615 |

All three `synced` here; on the server with `ref_uuids {"station_id":"43889edc-…"}` (the right station by uuid).
**`file_key` stayed `dragon-studio-scary-transition-401717.mp3`** (the slot's file before 10-12) — no update changed it.
`file_key` is what another computer uses to fetch the audio from R2 (migration v59), so OV may load the old audio for
this cart if the new file isn't in its catalogue.

**OV — Jeff, 2026-10-23 (verbatim):** "Checked on OV myself: HalloVeen cart slot 11 shows "idoberg creepy halloween fx v3"
and plays the new sound. Cart sync passes; no scripts needed on OV."

**Cart: PASS** (OVEVENTS → server → OV, same uuid, right station, right title, new audio plays). The stale `file_key` did
not stop OV playing the new file in this test; it remains a wrong value on the row (not investigated further).

| item | OVEVENTS | server | OV | result |
|---|---|---|---|---|
| song category | edit could not be made (Library bug) | — | — | not tested |
| song artist | edit could not be made (Library bug) | — | — | not tested |
| cart | synced 20:47:42Z | received 20:48:26Z, station uuid 43889edc | slot 11 shows the new title, plays the new sound (Jeff) | **PASS** |
| OV plays recorded and syncing | 172 OV plays arrived (10-21); 9 more 20:32–20:47Z (10-23) | OV pushed 1,933 since install, last 20:44:09Z | — | **PASS** |
