# getSpotArt is station-blind — handoff

**Written:** 2026-08-05 · **For:** Jeff / Claude Desktop / a fresh session
**Status:** diagnosed with a DB receipt. **NOT STARTED.** Nothing built, nothing committed but this doc.
**Related:** `spot-artwork-override-design-2026-08-04.md` · `public-artwork-queue-gap-2026-08-05.md`

---

## 1 · The symptom

The **Commercial Spot** row in halloVeen's desktop queue renders a **blank tile**, even though the
operator's uploaded artwork is set on that spot and shows correctly on the deck tile.

## 2 · The defect

`src/lib/albumArt.ts`, in `getSpotArt`:

```sql
SELECT art_image FROM spots WHERE file_path = ? AND deleted_at IS NULL LIMIT 1
```

**There is no `station_id` filter.** The query is station-blind. When two stations have a spot built on
the same audio file, this returns whichever row SQLite hands back — which can be **the other station's**.

This is both today's blank tile **and a station-isolation violation**. Station scoping is not a nicety
here; it is the rule the rest of the codebase is built on.

## 3 · The DB receipt (read-only, on a copy, 2026-08-05)

Four `spots` rows share
`C:\Users\jensj\Downloads\idoberg-creepy-halloween-bell-trap-melody-247720.mp3`:

| id | title | station | `deleted_at` | `art_image` |
|---|---|---|---|---|
| 1 | "11 sec spot hv" | 2 | **soft-deleted** | NULL |
| 2 | "11 sec spot hv" | 2 | **soft-deleted** | NULL |
| **3** | "11 sec test spot " | **3** (Magical Forest) | live | NULL |
| **4** | "Commercial Spot" | **2** (halloVeen) | live | **SET — 37,766 chars** |

**The two live rows are legitimate.** Different stations, same source audio file — a supported situation,
not a duplicate and not an operator mistake. Mutation history shows ordinary user inserts from the SPOTS
page; nothing system-generated. `n=2 ids=3,4` is the only file_path collision in the entire table.

Also confirmed and worth not re-investigating: `spots.file_path` and `generated_schedule.file_path` are
**byte-identical** (77 chars). The join is fine. **Paths were never the problem.**

## 4 · ⚠ The fix that was tried and BACKED OUT — do not retry it

`ORDER BY (art_image IS NULL)` alone. It fixes the blank tile by preferring *whichever row has art* —
**including another station's**. If Magical Forest later gets artwork on that shared file, halloVeen
would display it. That trades a visible bug for a quieter, worse one.

**Backed out of the working tree 2026-08-05.** It must not ship on its own.

## 5 · The correct fix

```sql
SELECT art_image FROM spots
 WHERE file_path = ? AND station_id = ? AND deleted_at IS NULL
 ORDER BY (art_image IS NULL)          -- tiebreaker WITHIN the station: a row with art wins
 LIMIT 1
```

`station_id` first — scoping. `ORDER BY` second — a tiebreaker only among that station's own rows, for
the case where one station legitimately has several spot rows on one file.

### The threading, which is why this is not a one-liner

`stationId` must reach `getSpotArt`. It has no station parameter today, and neither does its caller.

| Site | File | Note |
|---|---|---|
| `getSpotArt(filePath)` | `src/lib/albumArt.ts` | gains `stationId` |
| `resolveArtwork(filePath, contentClass, title, artist)` | `src/lib/albumArt.ts` | gains `stationId`, passes it down |
| `isSpotFile(filePath)` | `src/lib/albumArt.ts` | same query shape — scope it too |
| **Call site 1** | `src/components/OnAirDeck.tsx` | has `useActiveStation()` |
| **Call site 2** | `src/components/UpNext.tsx` (deck rows) | has station context |
| **Call site 3** | `src/components/UpNext.tsx` (queue rows) | **the blank tile in the screenshot** |
| **Call site 4** | `src/components/NowPlaying.tsx` | pop-out — confirm it can resolve a station |
| **Call site 5** | `src/components/Spots.tsx` | `clearSpotArtCache` — cache key may need station too |

**Also check the cache.** `_spotArtCache` in `albumArt.ts` is keyed by `filePath` alone. With two
stations sharing a file, one station's resolved art would be served to the other from cache even after
the query is scoped. **Key it by `station:filePath`.** This is easy to miss and would reproduce the exact
bug the SQL fix just closed.

## 6 · Rides in the same build — the staged queue-payload change

`C:\openair` has **staged but UNCOMMITTED** work that should ship together with this:

- `src/App.tsx` — `buildNowPlayingPayload` now carries `content_class` per **queue item** (previously
  only the now-playing item had it, so the public listener could not tell a queue row was a commercial).
  Backend needs no change — confirmed, `index.js:4787` stores the queue with a whole-array
  `JSON.stringify` and serves it back verbatim.
- `package.json` — version string already bumped to **4.4.143**. Treat that as provisional; the job is
  not done until §7 passes.

**No installer was built. Nothing was pushed at Jeff.**

## 7 · Acceptance

1. **halloVeen's queue shows the uploaded artwork on Commercial Spot — every time, not intermittently.**
   Intermittent is the tell that scoping or the cache key is still wrong.
2. **Another station's artwork can NEVER appear.** Give Magical Forest's row (id 3) its own distinct
   image and confirm each station shows only its own — on the deck tile, the queue rows, and after a
   station switch.
3. Music artwork is unaffected.

Verify in the running app, not by query. Both surfaces — deck tile and queue row — read the same path,
and only one of them was ever observed working.

## 8 · State at handoff

- `C:\openair` — `src/App.tsx` + `package.json` staged, uncommitted. `albumArt.ts` **restored** (ORDER BY
  backed out). No installer.
- `C:\ether-listener` — `a051d0b` deployed; `PlayButton.tsx` still HELD and uncommitted.
- `C:\ether-cast` — gate deployed.
- Separate open jobs, do not tangle: `D1-launch-receipt-2026-08-05.md`,
  `public-artwork-queue-gap-2026-08-05.md`, `spot-art-public-surfaces-2026-08-05.md` (R2, deferred).
