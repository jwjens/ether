# Announcement fired? Can't be seen in the app or on Park ops (2026-10-13, HalloVeen on air from ovowforestmusic)

## Jeff (verbatim)

> i cant see in the app or park ops if the announcement fired

## What the server showed (read-only, `GET /public/ops/halloween`, 8:30:03 PM PDT)

| Announcement | dueTime | alreadyPlayed |
|---|---|---|
| HALLOVEEN 30 MIN | 20:29:00 | false |
| HALLOVEEN 15 MIN | 20:45:00 | false |
| HALLOVEEN FULL CLOSING OUTRO | 20:57:00 | false |
| HALLOVEEN CLOSED | 20:59:00 | false |

`cartPlaying: null`. Closing time tonight: 21:00.

Whether the 8:29 announcement aired is **UNVERIFIED** from here. ovowforestmusic's database and logs aren't reachable
from OVEVENTS.

## Why Park ops can never show it (code)

- **The install sends the time as a number.** It sends `last_played_at` as unix **seconds** (`src/lib/ccData.ts:406`;
  the fire stamps `Math.floor(Date.now() / 1000)`, `electron/main.js` `fireAnnouncement`).
- **The server compares it to a date.** It reads the first 10 characters as a date
  (`ether-backend src/ops-core.js:119`: `String(r.last_played_at).slice(0, 10) === dateStr`).
- **So the check never matches.** "1791945000".slice(0, 10) is never "2026-10-13", so `alreadyPlayed` is always false,
  whether or not the announcement played.
- **Fix:** one line on the server. Accept a number of seconds and compare its local date (America/Los_Angeles for the
  park, or the date the install sends) to `dateStr`. It is a server deploy, so it is **held until after 9:30 PM** (Jeff:
  "dont submit anything yet for the park page until after 9:30pm tonight").

## Why the app doesn't show it (code)

- **The Announcements panel never shows when an entry last played.** It reads `last_played_at` but only displays
  `skipped_at` (`src/components/Announcements.tsx:1109`).
- **The fire is recorded in two places that aren't on that panel:**
  - the as-run play log, a `play_log` row with content class `ANN` and the announcement's title
    (`electron/main.js` `fireAnnouncement` step 6);
  - the startup log line `[announce] scheduled fire station N "<title>" at HH:MM:SS (close_offset)` and
    `[announce] fired "<title>" on <slot>`. A failed fire logs `[announce] scheduled fire FAILED … <reason>`.

## How to tell tonight, on ovowforestmusic
- Open `ether-startup.log` in Ether's data folder and search for `[announce]`. "scheduled fire … HALLOVEEN 30 MIN at
  20:29:00" = it fired; "FAILED" = it did not, and the reason follows.
- Listen at 8:45:00 for HALLOVEEN 15 MIN.

## Proposed (not built)
1. **Server:** fix `alreadyPlayed` so Park ops shows "played" with the time.
2. **App:** show "Played 8:29 PM" (or "Skipped" / "Failed: reason") on each of today's lines in the Announcements panel.
