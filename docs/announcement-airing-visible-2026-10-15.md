# Seeing the announcement that's playing — BUILT, not shipped (2026-10-15)

Governing plan: `docs/announcements-show-like-songs-plan-2026-10-13.md` (Jeff's corrected answers: staff/management
only, never the listener page; Park page + Announcements panel first).

## Jeff (verbatim)

> Test 4 results: MUTE works and carts work from the Park page. Priority now: seeing the announcement that's playing.
>
> Build it now (venue/management only, never on the public listener page):
> 1. Park page: when an announcement airs, show it big and clear: its name, a pulse, and a seconds countdown to the end. After it ends, its line in Announcements Today shows "Played 8:29 PM". Failed or skipped show plainly too.
> 2. Ether's Announcements panel: the airing announcement pulses with its seconds countdown. Each of today's lines shows played/failed/skipped with the time.
> 3. The station has to report "announcement airing, name, length, started at" to the server. Tell me what part needs the station installer and what is server/page only.
> 4.

(Item 4 was cut off in the paste.)

Then, the same day:

> dont forget we need the announcements playing in the app UI just like in the desktop app
>
> just so the user can observe announcements firing off just like in the program

## What was built, by where it runs

| Part | Repo / files | Needs |
|---|---|---|
| Station records what's airing: name, channel, length, start time. Records failed scheduled fires with the reason (memory, today). Health ledger `announcement-fired` / `-failed` / `-skipped`. New IPC `announce:airing`. | `openair` `electron/main.js` | **Station installer** |
| Station reports it: `ops_config.announcement_playing` {title, duration_sec, started_at, position_sec, at, entry_uuid}. Schedule rows gain `skipped_at`, `failed_at`, `fail_reason`. Pushed at once when an announcement starts, ends or fails (1 s check, no DB). | `openair` `src/lib/ccData.ts` (`announcementStatus`, `pushOpsData`), `src/lib/parkMirror.ts` | **Station installer** |
| Announcements panel: TONIGHT list. The airing line pulses red with ON AIR and the seconds left. Other lines: Played / Failed: reason / Skipped / Did not play / Up next / Waiting / Due now, each with its time. | `openair` `src/components/Announcements.tsx` | **Station installer** |
| Server passes `announcementPlaying` through and adds `skippedAt` / `failedAt` / `failReason` to each queue line | `ether-backend` `src/index.js`, `src/ops-core.js` | **Server deploy** (Railway) |
| Web app (app.ether-cast.com), station page, under the decks: "Announcements · tonight". **Watch-only.** The airing line pulses red with ON AIR · Ns, then each line shows Played / Failed: reason / Skipped / Did not play / Up next, each with its time. It reads the mirror the station already sends (`ops_config`, `announcement_schedule` via the existing owner-scoped `/api/account/station/:uuid/data`). Refreshes every 4 s. Hidden for a station that has never sent announcement data. | `ether-dashboard` `src/components/AnnouncementsTonight.tsx` (new), `StationDetail.tsx`, `styles.css` | **Web app deploy** (wrangler). No server change. The ON AIR line and Failed need the station installer. |
| Park page: ANNOUNCEMENT ON AIR card (pulse, name, seconds left). Each line shows ON AIR NOW / Played 8:29 PM / Failed: reason / Skipped / Did not play. | `ether-park` `src/App.tsx`, `types.ts`, `styles.css` | **Page deploy** (wrangler) |

**Order doesn't matter.** Every new field is optional on both sides:
- The new page on today's server shows Played (from 83df5dd) and no ON AIR card.
- The new server with today's installer sends nulls.

**The ON AIR card and Failed only appear once the station installer is on the park machine.** "Played 8:29 PM" needs
only the server (83df5dd, plus this commit) and the page.

## How "airing" is known (honest state)

- **Set** only after the engine accepts the play (the same point the Played stamp is written). The length comes from
  the file, and the start time is when the engine took the play.
- **Ends** when the file's length runs out. It also ends early if the engine first reported the channel playing and
  then reports anything else, such as a stop on the board (`announcementStatus`). If the channel never reports, the
  countdown runs on the length alone.
- **Unknown length:** the page shows "playing" with no countdown, for up to 10 minutes (`ANNOUNCE_AIRING_UNKNOWN_LEN_MS`)
  or until the engine reports the channel stopped.
- **Repeats** (plays-in-a-row) show as airing on their line. They do not re-stamp the line.
- **Failed is kept in memory only, with no schema change.** After a relaunch, a failed line reads "Did not play", never
  "Played".
- **Never in the listener payload.** The airing record rides `ops_config` (Park only), not `station_now_playing`.

## Receipts

- `npx tsc --noEmit` (openair): **0 errors**.
- `node --check electron/main.js`: OK.
- `ether-park` `tsc --noEmit`: 0 errors. `npm run build`: OK.
- `ether-backend` `node scripts/smoke-ops-core.js`: **55 / 55 PASS** (10 new checks: skipped/failed lines, reason,
  other-date failure ignored, airing pass-through, null/garbage handling).
- **Park page seen in the browser**: the local dev station (`ether-park/scripts/dev-station.cjs`, extended with
  `GET /dev/announce?uuid=&dur=` and `DEV_ANN_DEMO=1`) running the real `ops-core`. Seen:
  - the ON AIR card counting down (81 → 74 → 67 → 9 s);
  - the line "ON AIR NOW" (pulsing);
  - after the end, the card gone and the line "Played 4:17 PM";
  - "Failed 4:11 PM: No source channel is patched…" and "Skipped 4:13 PM…";
  - both widths: 1400 px and 400 px (phone).
- Fixed after looking: the airing line was greyed like a finished one, because it is stamped Played at start.
- **Web app block seen in the browser.** A throwaway page (deleted after) rendered the real `AnnouncementsTonight`
  component with mocked station data. Seen:
  - "ON AIR · 17s" pulsing;
  - after the end, "Played 4:22 PM";
  - Failed with its reason, Skipped, and Up next.
  - Fixed after looking: times with seconds wrapped onto two lines; the column was widened.
- `ether-dashboard` `npm run build`: OK. `tsc --noEmit` has 1 error, in `ListenersPanel.tsx` (no types for
  `topojson-client`). That file was not touched here, so the error was already there.

## UNVERIFIED (runtime)

- **Ether's Announcements panel (TONIGHT) has not been seen running.** Check: open Ether → ☰ → Announcements and fire
  one with ON AIR (or wait for a scheduled one). The line should pulse with the seconds counting down, then read
  "Played h:mm".
- **The real station → server → Park page path.** Check after the installer and the server deploy: during a fire,
  `GET /public/ops/halloween` shows `announcementPlaying` with the title, and the page shows the red card.
- **Whether the engine reports the S-slot status in daemon mode.** If it doesn't, the length-based countdown still
  runs. Only a stop on the board mid-announcement would then go unseen.

## Not built (deliberately; from the 2026-10-13 plan, later items)

- Console strip title/countdown on the announcement channel.
- Program Log / Calendar rows.
- Up Next "Played".
- Live Activity line.
- Leaving announcements out of the BMI/ASCAP export.
- A manual fire stamping its entry.

## State

Nothing is committed, pushed or deployed. Changes are uncommitted in three trees:
- `C:\openair`, on branch `fix/monitor-local-output`;
- `C:\ether-backend`, on branch `fix/p0-billing-blockers`, the same branch as 83df5dd;
- `C:\ether-park`;
- `C:\ether-dashboard`, on `main`, which is already 4 commits ahead of origin.
