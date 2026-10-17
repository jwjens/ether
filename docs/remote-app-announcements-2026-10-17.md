# Remote app: announcements in Up Next and ON AIR (2026-10-17)

## Jeff (verbatim)

> Regression: announcements no longer show in the Remote app (app.ether-cast.com) Up Next queue or as now playing. They
> used to. The app is the management/PD view; announcements must show there in the queue, as ON AIR when playing, and in
> the "Announcements · tonight" list, exactly like Ether. The ONLY place announcements stay hidden is the public listener
> page (listen.ether-technologies.com) and its public now-playing/queue.
> Find what removed them (which change, which commit), restore it, and confirm on the live app with today's
> announcements. Before any future change, check you're not removing something that already works, and list anything
> removed in your report.

## What was found (receipts)

- **No commit removed them, and no deployed build of the web app ever drew an announcement in Up Next or as now
  playing.**
  - Every production deployment back to 3 months ago (Cloudflare `b71b74c4`, `b004eafc`, `f4797c83`, `a7b25e73`,
    `bc6cdcf4`, `a6e71339`, `451e541b`, `6907a399`) was fetched and searched.
  - Only the current one (`b71b74c4`, 10/15) has any announcement code: the "Announcements · tonight" list.
  - `git log -S announc` in `ether-dashboard` (all branches) finds only `727078c` (that list).
- **Up Next in the web app is the station's playout queue, as the station sends it.**
  - `StationDetail.tsx` shows `now_playing.queue`.
  - The station builds that queue from `engine.getQueue()` (`openair src/App.tsx` `buildNowPlayingPayload`), which never
    holds an announcement. Announcements fire on their own channel from main's 250 ms tick, not from the queue.
  - The server stores the queue as sent (`ether-backend src/index.js` now-playing ingest). Nothing filters it.
  - Live queue read at 23:13 UTC: 12 songs/spots, no ANN.
- **Ether's Up Next adds announcements on screen only** (`openair src/components/UpNext.tsx:159-210`, a display merge
  from `announcement_schedule`, 2026-08-26). The web app never had that merge.
- **The "Announcements · tonight" list was working live** before this change: seen in the browser at 4:10 PM with
  4:04 Skipped, 4:20 Up next, 4:32 and 4:34 Waiting.
- **The station sends everything needed** (prod DB, read-only): `ops_config.announcement_playing`, `local_date`, and
  today's 4 `announcement_schedule` lines with `due_time`; the queue items carry their lengths.

## What was built (ether-dashboard `feat/announcements-visible` @ `2f42473`, web app only)

- **Up Next:** today's coming announcements (not yet played, skipped, failed or airing) are shown where they will air.
  - Placement: the start time of each queue item is added up from the on-air song's time left, the two songs cued on
    decks, and each item's length. An announcement goes before the first item that starts at or after its time; any
    later than the visible queue go at the end.
  - Row: amber ANN tile, title, "Announcement · 4:20 PM". Never draggable. It moves no song: an announcement plays on
    its own channel over the music, so it is shown, not queued.
- **ON AIR:** while one airs, a pulsing red card above the decks: ON AIR · title · "Announcement" · seconds left.
- **Tonight list:** unchanged in behaviour. The three now share one reading of the station's mirror (every 4 s), not
  separate fetches.
- **Listener page:** untouched. No server or station change; the listener's now-playing/queue
  (`station_now_playing`) carries no announcement.

## Removed in this change

- Nothing user-visible. The Tonight list's own fetch loop moved into a shared hook (`useStationAnnouncements`), so the
  page reads the mirror once instead of once per piece.
- **Not shipped (left out on purpose):** `public/_headers` (commit `57787cd`, never deployed to the web app) was removed
  from the upload so only this change went live.

## Checks

- `tsc --noEmit`: 1 error, the existing `ListenersPanel.tsx` `topojson-client` types error (file untouched; it was there
  on 10/15). `vite build`: OK.
- **Deploy:** Cloudflare `1aebd1df`, 4:16 PM.
  - Built with `--assetsDir a3`; the live `a2/` and old `assets/` files are kept inside it.
  - Watched for 40 s: the new script was answered as JavaScript every time, with no HTML gap.
- **Rollback:** `scratchpad/dash-live-before-ann` (the live 10/15 `index.html` + `a2/` + old `assets/`).
  `npx wrangler pages deploy <that folder> --project-name ether-dashboard --branch main`.
- **Seen live (4:17 PM):** Up Next shows "HALLOVEEN 15 MIN · Announcement · 4:20 PM" after Recuérdame/Zombie (the deck
  songs) and before Call me Cruella; "HALLOVEEN 30 MIN · 4:32 PM" after Bad Romance.

## Noticed, not investigated

- Ether's own Up Next merge keeps only lines with a fixed `trigger_time` (`UpNext.tsx:190`). Tonight's four lines are
  before-closing lines (`trigger_type: close_offset`, `trigger_time: null`), so Ether's Up Next may not list them unless
  the schedule read fills `trigger_time`. UNVERIFIED. Check: Ether → Up Next before 4:32 PM today.

## Confirmed live (4:20 PM, today's real announcement)

- The relay of what the station reported (`/public/ops/halloween`, 4:20:00 PM): `HALLOVEEN 15 MIN`, 7.34 s, started
  23:20:00.051Z.
- **The web app at the same moment** (screenshot): above the decks, a red card "ON AIR · HALLOVEEN 15 MIN ·
  ANNOUNCEMENT · 1s". Up Next: "HALLOVEEN 30 MIN · Announcement · 4:32 PM" after Bad Romance, "HALLOVEEN CLOSED ·
  4:34 PM" after Popular.
- **Tonight list afterwards:** 4:04 Played 4:04 PM; 4:20 **Played 4:20 PM**; 4:32 Up next; 4:34 Waiting.
- **Public listener feed** (`/public/station/halloween`, HTTP 200): no announcement title, no "announc", no ANN.
