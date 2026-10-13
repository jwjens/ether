# Park page fader drops out (2026-10-13)

Jeff, verbatim: "The fader and MUTE randomly disappear and show 'The station hasn't reported its sound level yet', then come back."

## Why

- **Which report carries the level:** the station's mirrored `ops_config` row (`uuid "ops"`). Ether sends it with `pushOpsData` (`src/lib/ccData.ts`) to `POST /api/account/data/sync`:
  - every 60 s;
  - at once on a level, closing-time or cart change.
  
  The Park page reads `park` from that row.
- **Does it expire?** No. The row has no expiry; the page shows whatever was written last.
- **What clears it:** HalloVeen is open on two machines, and both send the WHOLE row.
  - OVEVENTS (current build) sends the level.
  - The other sender, an older build, sends only closing time and date. This is almost certainly ovowforestmusic: the row doesn't name the machine, but it's the only other machine with HalloVeen open.
  - Last write wins, so the older push wiped the level once a minute.
- **Didn't the owner fix cover it?** No. Tonight's owner fix covers now-playing reports only, not this mirror.
- **Seen live**, 11:05–11:08Z, read-only: a row with no level (keys `closing, local_date, uuid`) landed every minute at :20, then the next OVEVENTS push restored it.

## Fix (deployed; GO given)

**Server `58e5c0d`** (`src/lib/park-sound.js`, 5 tests; all 124 server tests pass):
- An ops row from a build older than the sound controls (no `pushed_at`) is ignored while the current build has reported in the last 3 minutes.
- If the current build stops reporting, the older row is applied, but the last known level is kept.
- The page is told `stationOnline`: whether the machine Park commands go to (the station's owner) has its command connection open. It's the same test that decides whether a fader move can be delivered.

**Park page `fa6b80c`:**
- The fader and MUTE never vanish.
- If the owning machine isn't connected, they stay on screen, greyed, with "Station offline".
- The station is on air, so live it shows online, as expected.

## Watched live, 5 minutes after deploy

145 polls of the live page data, 2 s apart, 11:13–11:18Z: level missing 0, offline 0, errors 0. That spans five of the older machine's once-a-minute pushes.

## Not changed

- The older machine still pushes the announcements and cart lists too. Jeff reports carts and closing time work.
- Once both machines run the current build, both will send a level. To take the Park data only from the owning machine, the station would need to send its machine id with each push. That's a desktop change, not built.
- Closing time: Oct 13 is 04:34 in the station's settings. Jeff set it as a test; left alone.
