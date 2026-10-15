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
- (Leaving announcements out of the BMI/ASCAP export: built later the same day; see below.)
- A manual fire stamping its entry.

## State (2026-10-15, after Jeff's GO)

### Item 4 (Jeff): "leave announcements out of the BMI/ASCAP export"
- Built in `src/components/logs/royalty.ts`: `ROYALTY_SQL` adds `AND COALESCE(content_class, '') <> 'ANN'`.
  The printable (PDF) log keeps announcements.
- Test: royalty 7/7.
- Real SQLite check of the query text: an ANN row is dropped. A song with no class, a MUSIC row and a CART row are kept.
- Help: `docs/help-logs.md`.

### Branches and commits (local)
| Repo | Branch | Commit | Base |
|---|---|---|---|
| openair | `feat/announcements-visible` | `dd2274c` | `fix/monitor-local-output` @ `5e46b69`. This line holds ecf38bbf's work (b343fe0), which the installer needs. |
| ether-backend | `feat/announcements-visible` | `afa6896` | `83df5dd`, the Played fix, on top of live `eb61418` |
| ether-park | `feat/announcements-visible` | `ab9f1b6` | `master` @ `68b7fa3` (= live) |
| ether-dashboard | `feat/announcements-visible` | `727078c` | `main` @ `651becf`. Its 4 unpushed commits were already live (below). |

### What else rides along (Jeff's item 2: "Nothing unrelated ships")
- **ether-backend `fix/p0-billing-blockers`:** besides `83df5dd` it holds nothing that isn't already on `origin/main`.
  - `git log origin/main..fix/p0-billing-blockers` = `83df5dd` only.
  - The billing work (`21156d3`) was already inside `origin/main`.
- **ether-dashboard `main`, 4 unpushed commits, all already live:** they were deployed with wrangler but never pushed to git.
  - `4d6172c`: a machine that has the station open but doesn't hold the broadcast shows as "<machine>: standby".
  - `096eb99`: the status pill's lines wrap inside the card.
  - `14318b4`: Park page access per station, login safety, Park activity log.
  - `651becf`: reverts `14318b4`.
  - Net: only the two status changes.
  - Live check before the deploy: the live bundle (`index-kz4VgvY9.js`) has ": standby" and no "Login safety".
    A rebuild of `main` produced the same file name.
- **ether-park `master` = live:** the live bundle `index-oJ3w3-xR.js` is byte-identical (sha256) to a build of `master`.

### Deploys (Jeff: "GO: deploy the announcement pieces now")
Staff-visible state, read from `GET /public/ops/halloween` before and after each step:
- Level 0.166 (−15.6 dB), MUTED (staff's own), lock off, closing 9:00 PM, 4 carts, station online.
- Every write route refuses without a login (403). These routes check the login before doing anything, so the check
  changes nothing.
- **Identical before and after all three deploys,** apart from the song playing and the new fields.

1. **Server.**
   - Deploy: `git push origin feat/announcements-visible:main`, `eb61418..afa6896`. Railway deployment `15cf29b5` SUCCESS.
   - Live: `playedAt` and `announcementPlaying` are present.
   - Rollback ready (local, not pushed): branch `rollback/server-announcements` = `915522d`. It reverts both commits, and
     its diff to `eb61418` is empty. To use it: `git push origin rollback/server-announcements:main`.
2. **Park page, the first attempt was ROLLED BACK.**
   - The first deploy (`56fa3d6a`) showed a blank page on the live domain. It was rolled back at once with the saved
     copy of the live build.
   - Cause: not the build. Its own address served it fine. During Cloudflare's switch between deployments, the domain
     served the new `index.html` before the new script and stylesheet. The catch-all `/* /index.html 200` then answered
     those file requests with the HTML page, and files are sent with `max-age=14400` (4 h), so a browser keeps that
     wrong answer.
   - Second deploy (`124c0d4e`):
     - built with fresh paths (`vite build --assetsDir a2`; no source or config change), so no stale copy matches;
     - carries the old `assets/` files too.
     - Watched every 5–8 s for a minute: the same gap happened for ~16 s (4:44:03–4:44:11 PM, script answered as HTML),
       then steady.
     - Seen in the browser: correct. Fader −15.6 dB, MUTED with "Muted from Park page, 3:20 PM", closing 9:00 PM,
       carts 1–4, today's 4 announcements.
   - **Staff risk:** a phone that reloaded the Park page between about 4:41 and 4:44 PM can still show a blank or
     unstyled page for up to 4 hours. Clearing the site's data, or a private tab, fixes it. A phone that kept the page
     open is not affected.
   - **Proposed (not built):** add a `_headers` file so that `/a2/*` and `/assets/*` revalidate
     (`Cache-Control: public, max-age=0, must-revalidate`). A wrong answer during a switch would then be re-checked on
     the next load instead of kept for 4 hours. The same applies to the web app.
   - Rollback copy: `scratchpad/park-rollback-dist` (session scratch).
3. **Web app.**
   - Deploy: Cloudflare `b71b74c4` (same method, `a2` paths plus the old files).
   - The same gap happened on the stylesheet for ~16 s (4:47:05–4:47:13 PM).
   - Seen live: the HalloVeen station page loads normally (decks, Up Next, controls). "Announcements · tonight" sits
     under Up Next: 8:29 PM "Up next", the others "Waiting".
   - Rollback copy: `scratchpad/dash-rollback-dist` (= live `index-kz4VgvY9.js`).

**"Played" on the Park page for today: not yet confirmable.** The first announcement is due at 8:29 PM. A read-only
check is armed for 8:31 PM.

### Installer (Jeff's item 4)
- **Path:** `C:\openair\dist-electron\Ether Setup 4.6.59 announcements 76f29be1 dd2274c.exe`
- **sha256:** `76f29be157902808506a48e29122e360566b2bb7141a23bb6ecf4923457cf94d`
- **Size:** 216,076,850 bytes.
- **Built from** `feat/announcements-visible` @ `dd2274c`: ecf38bbf's work (b343fe0), the announcement station
  reporting, the TONIGHT list, and announcements left out of BMI/ASCAP.
- **Version and engine:** version unchanged (4.6.59). Engine unchanged: native `91b9f495`, daemon code `5aaa0e91`.
- **Before the build:**
  - `tsc --noEmit` 0 errors;
  - vitest 105 files / 901 tests;
  - `test:sync` 55/55;
  - `test:wedge` all passed;
  - schema chain v0–v62 clean (pre-commit).

### Release gate, repeated
| Run | Kind | Result | First ping answered at | "engine" answered in |
|---|---|---|---|---|
| 1 | Diagnostic gate, first launch right after packaging (true cold) | PASS | 7.0 s (try 3) | 2 ms |
| 2–4 | Real gate `audiod/verify-packaged.js` ×3 | PASS ×3 (identity matched by sha256) | — | — |
| 5–8 | Diagnostic gate on a brand-new copy of `win-unpacked` each time (cold files, Defender rescans) | PASS ×4 | 7.3–7.7 s (tries 7–8) | 1–4 ms |

**ecf38bbf's single failure was not reproduced in 8 runs.** What the evidence rules out and leaves:
- **Ruled out: the daemon had no identity.** It hashes the engine at load (`ether-audiod.js:145-146`), before it
  listens, so a daemon that answers ping already has it.
  - "(none)" on both lines would need both hashes to fail at once.
- **Ruled out, in these runs: an event line arriving before the answer.**
  - The gate reads only the first line on its socket (`verify-packaged.js:35`), and the daemon broadcasts events to
    every client (`ether-audiod.js:162`).
  - But with the gate's empty temporary database no station exists, so nothing was broadcast. Exactly one line, the
    answer, arrived in all 5 diagnostic runs.
- **Left: the "engine" request got no usable answer within the gate's 3 s.** That covers a timeout, a socket error or
  `ok:false`.
  - The gate turns all of these into the same "(none)" and kept no log of which, so the cause on that run cannot be
    named now.
  - The cold start is slow (7+ s to the first ping) and the request window is short (3 s), so a busy moment just
    after start is the likeliest fit. UNVERIFIED.
- **Proposed (not built):** the gate says which of the four happened, retries "engine" up to 3 times, and saves the
  daemon log beside the result.
  - A failure then names itself.
  - The retry would hide a one-off slow moment but never a wrong engine: the identity must still match by sha256.
