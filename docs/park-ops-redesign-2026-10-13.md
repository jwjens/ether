# Park Ops page — redesign, made functional (2026-10-13)

The HalloVeen park page at `park.ether-cast.com/<station>`. Jeff: "this isnt a bug its just a placeholder it doesnt work it was never finished just do the redesing and make it functional."

Three repos change:
- **The page:** `C:\ether-park`, Cloudflare Pages project `ether-park`.
- **The backend:** `C:\ether-backend`, Railway.
- **The station:** this repo.

All three are local commits only. Nothing is deployed and nothing pushed; going live needs Jeff's GO for each deploy.

## The five questions, answered

1. **"Park Closes shows 04:30 PM with 'Tonight: 9:00 PM' underneath. Which is real and why do they differ?"**
   9:00 PM is real for tonight. The closing time is one setting with three layers: an every-day time (`default`, 4:30 PM on halloVeen), times per weekday (none) and times per date (halloVeen has one for nearly every date in October, 9:00 PM tonight). The station uses date → weekday → every-day, so tonight it closes at 9:00 PM. The old page put the every-day time in the big box, which nobody uses, and tonight's time in small print. **Now:** the page shows tonight's time, as the station's own announcement scheduler resolves it.

2. **Why announcement times showed "—".** HalloVeen's announcements are all "N minutes before closing" (−31, −15, −3, −1). The backend looked for that kind of row under the name `before_close`, but the station calls it `close_offset`. Nothing matched, so it fell back to a fixed time, which such rows don't have, and showed "—". **Now:** the station sends, for each of today's announcements, the exact time its scheduler will fire it at (`announce:due-times` runs the scheduler's own `dueTimeFor`). The page shows that. The backend's own arithmetic is fixed too (right name, plus seconds), but it's only a fallback for an older station.

3. **Carts labelled 1, 2, 3, 4, A, S, D, F.** The page mirrors the station's cart wall, the CARTS panel in Ether. Assignments live in that station's cart table, and whoever drops audio on a tile there changes them. The desktop wall labels its tiles by keyboard key: the first row 1–8, a later row A, S, D, F. HalloVeen's wall has the same four carts in slots 1–4 and again in A–D. The old page listed every loaded tile and named it by key. **Now:** the page always shows eight tiles, the wall's first row (desktop keys 1–8), labelled 1–8. An empty slot shows "Empty", and the tile number is the same cart as that key in the studio.

4. **The view-only link (no `?k=`).**
   - Anyone with the address can read the page.
   - Every change needs the `?k=` token: the closing time, the fader, MUTE and the carts. The backend refuses a change without it (403, "This copy is view-only…"), and the page greys those controls out and says so.
   - The token is per station, made by the station's install. Today the full link is only written to the station's console at start-up ("[ops] Park Ops (editable): …"). There's still no button in Ether to show it; one line, not built here.

5. **What the fader and MUTE control.**
   - **The fader:** this station's MONITOR level, i.e. the level of halloVeen's sound out of the studio computer's speakers, which is what the park hears. It's the same level as halloVeen's station MONITOR strip in Ether, set through the same two calls that strip makes (the engine, then Preferences `monitor_volume`).
   - **Not:** the internet stream, other stations, or the machine-wide MONITOR.
   - **MUTE:** that level at 0. The level before muting is kept (`park_unmute_level`) and comes back on unmute.
   - **"Muted" on the page:** read from the real level, not a stored flag, so a level moved in the studio shows on the phone too.
   - **Note on "+10 dB at the top":** the fader is drawn with the studio's console law, topped at the station's *Fader maximum → MONITOR* in Preferences. That's 0 dB unless raised (Jeff's 2026-10-11 ruling: MASTER and MONITOR top out at 0 dB). Set it to +10 dB in Preferences and the park fader has 0 dB at its normal position and +10 at the top (screenshot 6). The page never offers more than the engine accepts.

## The page (`C:\ether-park\src\App.tsx`, `styles.css`)

No banner. Three columns, full height, no page scroll on a normal screen or tablet (a phone held upright gets one scrolling column).

- **Left (half of the remaining width):**
  1. The big clock.
  2. Now playing, with a countdown.
  3. **Park closes tonight.** Tap the time to change it; a big **SAVE** appears beside it, with Cancel. Nothing changes until SAVE; Cancel, Escape or leaving keeps the time the station has. After SAVE it says "Saved — waiting for the station to confirm…", then "Saved. The announcements below have moved with it."
  4. **Announcements today:** each with its real time, in playing order, updating seconds after a Save.
- **Middle (thin, full height):**
  - one big vertical fader: the console law, scale marked, the current dB shown, starting at the station's real level;
  - one big **MUTE** (red "MUTED", "Tap to bring the sound back").
- **Right (same width as left):** carts 1–8, two columns of four, filling the column. The playing cart lights up with "Playing · m:ss left", read off the station's real cart channel, whether fired from the phone or the studio.
- **Real state:** the page refreshes every 4 s and catches up within a second after a change. The station pushes its mirror at once when anything it shows changes: in Preferences, on the desktop strip, from the phone, or a cart starting or stopping.

## The backend (`C:\ether-backend`)

- `GET /public/ops/:slug` returns:
  - tonight's closing time as the station resolves it;
  - each announcement's real fire time (the station's `due_time`);
  - eight cart tiles (slots 0–7, with empty slots);
  - `park` (level, fader maximum, muted) and `cartPlaying`.
- **New:** `PUT /public/ops/:slug/level` and `PUT /public/ops/:slug/mute`. They're token-gated, stamped and aimed exactly like closing-time and fire, and an offline station is told, never queued.
- `src/ops-core.js buildQueue`: uses the station's `due_time`; fallback arithmetic fixed ('close_offset', seconds); a row timed from closing with no closing time has no time (the station refuses to fire it).
- **Tests:**
  - `scripts/smoke-ops-core.js` 39/39 (two checks updated for the corrected rules, five added);
  - `src/lib/park-ops-target.test.js` 5/5 (one added: the sound routes are gated and aimed like the rest).

## The station (this repo)

- **`src/lib/closingTime.ts`:** THE ONE closing-time writer. Preferences → Announcements and the phone's `ops:set-closing` both call it, not a copy. It sets `byDate[date]` only and re-pushes the Park mirror. Announcements timed from closing are resolved when they fire (`dueTimeFor`), so they move with the write. Test: `src/lib/closingTime.test.ts` 3/3.
- **`App.tsx` execCmd:** `ops:set-level` / `ops:set-mute` (station-scoped in `cmd-routing.ts`).
- **`electron/main.js`:**
  - `announce:due-times`: the scheduler's own answer for a date.
  - `ops:changed`: raised when `closing_time`, `monitor_volume`, `fader_top_db_monitor` or `park_unmute_level` is written. It names the station by UUID (leak guard at baseline 13).
- **`src/lib/ccData.ts pushOpsData`:** adds `closing_today`, `park`, `cart_playing` (read off the cart channel; `hasEngine` only, never creates one) and each row's `due_time` and `close_offset_sec`.
- **`src/lib/parkMirror.ts`:** the mirror for EVERY station. It used to cover only the station on screen, so a park whose station wasn't active went stale. It runs every 60 s, at once on `ops:changed` / `ether:ops-push`, and at once when a cart starts or stops (checked every second from the engine, no database reads).

## Tested in dev

`C:\ether-park\scripts\dev-station.cjs` is a dev-only stand-in for the backend and the station. It answers the page with the **real** backend logic (`ops-core.js`) and applies a Save with the **real** station function the scheduler fires from (`announce-time.js offsetDueTime`), seeded with halloVeen's real values (read-only). The page ran in Vite against it.

Screenshots in `C:\openair\dist-electron\park-ops-screenshots-2026-10-13\`:
1. the page;
2. the closing time open with 9:30 PM typed — announcements still at the 9:00 times;
3. after SAVE: 9:30 PM, and the four announcements moved 30 minutes (8:29 → 8:59, 8:45 → 9:15, 8:57 → 9:27, 8:59 → 9:29);
4. MUTED, with cart 3 playing and its time left;
5. the view-only link with everything locked;
6. the fader with a +10 dB top.

Also verified in dev: unmute returns to 0.0 dB, and dragging the fader set −12.2 dB, which the stand-in applied.

**Not tested end to end:** the real chain of phone → Railway → station needs the backend deployed and the station installed. The dev servers are stopped.

## To go live (Jeff's GO for each)

1. Deploy the backend (`C:\ether-backend`, Railway).
2. Deploy the page: `cd C:\ether-park && npm run deploy` (wrangler, project `ether-park`). An older station keeps working with the new page: missing fields show as "not reported yet".
3. Install the station build with these changes.

## Deployed (Jeff's GO, 2026-10-13 ~08:20 UTC)

- **Safety check first.** The server change touches only the Park page's read (`GET /public/ops/:slug`) and adds two park-only routes (`…/level`, `…/mute`). Nothing the station calls changed. The air machine's current build (OVEVENTS, HalloVeen) already handles the page's closing-time Save the same way (it writes tonight's date entry; announcements resolve at fire time). The page only sends level/MUTE once a station reports its sound, which the current build doesn't, so those can't reach it.
- **Server:** `a6d6493` fast-forwarded onto `ether-backend` main (live was `21156d3`; this commit was the only difference). Railway deploy SUCCESS at 08:20:54Z; `/health` ok.
- **Still on air:** HalloVeen's own play log on OVEVENTS shows "We Don't Talk About Bruno" at 08:20:37Z, then "Dark Horse" at 08:24:09Z, back to back across the deploy. The station kept reporting to the server every few seconds throughout.
- **Page:** `wrangler pages deploy` (project `ether-park`, branch main), deployment `51c61ad1`; live at `park.ether-cast.com/halloween`. Screenshots 7 and 8.

### What works now, with OVEVENTS on its current build
- Clock; tonight's closing time (9:00 PM); the four announcements with real times (8:29, 8:45, 8:57, 8:59 PM, worked out by the server from the closing time); carts 1–8 with the four HalloVeen carts and four empty; view-only lock.
- Closing-time Save: the current build applies it. The announcements move with it.
- Firing a cart: the current build plays it. The tile does **not** light up or count down (that needs the new build).

### What needs the new station build on OVEVENTS
- The fader and MUTE. They show "The station hasn't reported its sound level yet" and stay locked.
- The cart that's playing, with time left.
- Announcement times taken from the station's own scheduler (today they're the server's arithmetic, which gives the same times).
- Instant updates after a change made elsewhere. The current build updates the page only for the station on screen, and only every 60 s.

### Found while checking (not caused by this deploy, not changed)
- **"Now playing" shows "Nothing playing" while HalloVeen is on air.** The station's own now-playing report says all three decks are idle, even as its play log shows songs airing. The deploy didn't touch that report, and the page shows exactly what the station sends. Not investigated further. Runtime check to settle it: is HalloVeen the station on screen on OVEVENTS right now?
