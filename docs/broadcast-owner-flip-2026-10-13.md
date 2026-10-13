# HalloVeen flipping between OVEVENTS and ovowforestmusic — one broadcast owner (2026-10-13)

## Jeff's report (verbatim)

> HalloVeen is now LIVE from OVEVENTS (Jeff switched it; the stream is fine). The Remote page (app.ether-cast.com) and the Park page flip back and forth every few seconds between:
> - "LIVE · sourced from OVEVENTS", AUTO, decks cued/on air, and
> - "STOPPED · sourced from ovowforestmusic", MANUAL, decks empty, red "Forbidden (403) · 80d ago".
> Same cause as the Park page "Nothing playing" flicker.

## Diagnosis

**Who reports for HalloVeen.** Two machines: OVEVENTS and ovowforestmusic. HalloVeen's status row, sampled every 2 s from the production database (read-only), 08:39–08:40 UTC:

```
08:39:08 playing=true  eng=live decks=A:playing,B:idle,C:idle src=OVEVENTS
08:39:24 playing=false eng=off  decks=A:idle,B:idle,C:idle    src=ovowforestmusic
08:39:29 playing=true  eng=live decks=A:playing,B:idle,C:idle src=OVEVENTS
08:39:48 playing=false eng=off  decks=A:idle,B:idle,C:idle    src=ovowforestmusic
...
```

Each machine sends a report about every 20 s, a few seconds apart.

**Why the server accepted ovowforestmusic.** The server had no idea of an owner. `POST /api/now-playing` overwrote the station's row with every report: the last one to arrive won. Its only guard covered machines that did *not* claim to be the source. ovowforestmusic **does** claim to be the source, so it got through.

**Is ovowforestmusic still running Ether with HalloVeen loaded?** Yes, judging by its reports: it posts for HalloVeen every ~20 s, with HalloVeen's engine **off** and all three decks idle. The desktop (`src/App.tsx`, the now-playing heartbeat) only posts a station when that machine believes its own stream of it is **live** (`ss.live`). So Ether on ovowforestmusic believes it is still streaming HalloVeen while playing nothing: its stream status is stuck. **UNVERIFIED at runtime:** I did not touch ovowforestmusic. One check would settle it: look at HalloVeen's stream indicator on that machine.

**The "Forbidden (403) · 80d ago" banner.** One Icecast refusal on **2026-07-24 18:42 UTC** (80 days ago). Icecast refused a source connection, typically because the mount was already in use by another machine. The server stored the station's "last stream error" with COALESCE, so nothing ever replaced or cleared it. The Remote page shows it whenever the station isn't live. Every ovowforestmusic report flipped the station to "not live", and the July error reappeared each time. It is stale.

**The Park page "Nothing playing".** Same cause: the Park page reads the same row, so it showed whichever machine reported last.

## Fix (server, deployed)

`ether-backend` `5e4fb3b` (Railway, live 08:50:50 UTC):

- **`src/lib/broadcast-owner.js`: ONE owner per station.**
  - The owner is the machine holding the broadcast.
  - Only the owner's reports update live status, decks, now playing and the listener feed.
  - Any other machine's report is recorded in `station_report_machines` as **standby** and never applied.
- **The owner changes only when the broadcast really moves:**
  1. there is no owner;
  2. the owner has been silent for 90 s;
  3. a machine goes live after being silent, with something playing (or the owner isn't on air);
  4. a machine that is on air takes over from an owner that is stopped.

  A machine that has claimed all along with nothing playing (ovowforestmusic tonight) can never take it from an on-air owner, including when it restarts.
- **The stream error shown is this broadcast's only.** An error from before the current owner took the broadcast is history, and so is one older than 10 minutes once the station is live again. A new owner starts with a clean error.
- **The Remote page's station lists carry `standby`.** `app.ether-cast.com` shows it as "· ovowforestmusic: standby", never as the source (`ether-dashboard` `4d6172c` + pill wrapping, deployed with wrangler). The status line also wraps inside its card now; long lines used to run over the next card.
- **Also fixed:** the Park page's fader/MUTE commands (`ops:set-level`, `ops:set-mute`) weren't in the server's list of commands aimed only at the owner (`station-commands.js`). The page never sent them, because the fader stays locked until the station reports its sound. They're now aimed at the owner like every control.

**Tests:**
- `broadcast-owner.test.js`: 13, including the exact HalloVeen pattern and the restart case.
- All server unit tests: 107/107.
- The real `upsertStationNowPlaying` (sliced from `index.js`) replayed against an in-memory Postgres with tonight's two-machine pattern: after the first report the row is OVEVENTS on air on every tick, and the July 403 is cleared.

## After the deploy (5-minute watch, 08:52–08:57 UTC)

- **Status row**, sampled every 2 s: **every** change is OVEVENTS, `playing=true eng=live`; only the decks advance (B → C → A as songs change). ovowforestmusic never appears as the source.
- **Remote page:** "LIVE · sourced from OVEVENTS · ovowforestmusic: standby", AUTO, decks A/B/C filled, no 403 banner.
- **Park page:** "Now playing: Remember Me…", steady.
- **The July error** is still in the raw column (an owner that keeps the broadcast keeps COALESCE'ing). It isn't shown, because it predates this broadcast.

## Not changed

- **ovowforestmusic:** not touched. Its Ether still believes it's streaming HalloVeen. It shows as standby now and does no harm to the status. Closing HalloVeen's stream there (or Ether) when someone is at that machine would stop it reporting at all.
- **The legacy global now-playing slot** (`/api/now-playing` GET, the old single-station feed) is still last-write-wins. Nothing current reads it for HalloVeen.
- **No station-side change** was needed. The installer built tonight doesn't depend on this fix.
