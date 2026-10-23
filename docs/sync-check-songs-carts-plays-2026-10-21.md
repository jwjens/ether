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

Pending Jeff's test changes.

| item | OVEVENTS | server | OV | result |
|---|---|---|---|---|
| song category | | | | |
| song artist | | | | |
| cart | | | | |
| OV plays recorded and syncing | | | | |
