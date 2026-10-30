# Platform report "By station": what each number is, and the ATH bug (2026-10-29)

**Jeff (verbatim):** "presencia24/7 has 1,543 performances with 0 ATH, 0 unique and 0 sessions; Magical Forest has 37
unique and 10.2 ATH but only 4 performances; several stations with 1–5 listeners all show about 9.9 ATH hours."
Then: "i just want to know what performances mean".

Page: `ether-admin/src/components/NetworkReport.tsx` → `GET /api/platform/rollup` (`ether-backend/src/index.js:2117`).
Time period: the From/To dates on the page (default: 1st of this month through today), whole days, To inclusive.
Read-only checks: `railway run --service Postgres`, `BEGIN READ ONLY`, range 2026-10-01..2026-10-29. Nothing written.

## The four columns

| Column | Source table | Written by | Means |
|---|---|---|---|
| **Performances** | `station_play_history`, rows with `played_at` in range | the desktop app pushing its play log (`POST /api/account/play-history`, license key) | songs the station actually aired, one row per play — what royalty exports count. Nothing to do with listeners. |
| **Sessions** | `listener_sessions`, `started_at` in range | the backend, when an Ether listener web page disconnects from the now-playing feed (`/public/station/:slug/stream`) | visits to the station's Ether listener page. The feed opens when the page loads (`ether-listener/src/hooks/useNowPlaying.ts`), not when Play is pressed. |
| **Unique** | same rows, `COUNT(DISTINCT lid)` | browser-generated anonymous id | distinct browsers that opened the listener page |
| **ATH hrs** | `station_stream_samples`, `ts` in range, `SUM(listeners)/60` | backend polls the Icecast `status-json.xsl` every 60 s for every station with a public page and a stream URL | listener-minutes on the station's Icecast mount, in hours (all players, not just the web page) |

## The three cases

- **presencia24/7 (lic 30 berrios0402@gmail.com):** 1,543 aired songs pushed 10-18..10-23. It has no
  `station_metadata` row: no public listener page and no stream URL known to Ether. So nothing is sampled (ATH 0) and
  no listener page exists to visit (sessions/unique 0). Correct for the data Ether has; not a bug.
- **Magical Forest (lic 24 jensj@opportunityvillage.org):** its play log stops at 2026-10-02 23:58, so only 4
  performances fall in October. The 44 sessions / 37 unique are page visits with a median length of 9 seconds (people
  opening the page, not listening). Its 10.2 ATH hours are the bug below.
- **~9.9 ATH hours on several stations:** the bug. 594 listener-minutes = 9.9 h on Cero DJ, Open Format, Christmas In
  July (and 609/725 on Magical Forest/HalloVeen): the five per-minute series are identical in 27,000+ of ~27,000
  shared minutes, although each has its own mount.

## Root cause (ATH)

`icecastListeners()` (`ether-backend/src/index.js:2095`), since 49796fd:

```js
const match = sources.find(/* mount path matches */) || (sources.length === 1 ? sources[0] : null);
```

When the Icecast server has exactly one live mount, every station whose own mount is not live gets **that** mount's
listener count. Live check just now: one source, `/halloween`. So every sampled station records HalloVeen's
listeners. ATH for every station except whichever mount was live is wrong, back to 10-04.

Fix (proposed, not built): drop the single-source fallback; a station whose mount is not on the server has no
listeners (record 0 or skip). Existing samples cannot be told apart afterwards and are left untouched (no data change).

Noted only: ~25 minutes per station this month have two samples (two backend instances during a deploy) — a small
double count.
