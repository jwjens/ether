# Public artwork — the queue gap (the part that is NOT fixed)

**Written:** 2026-08-05 · **For:** Jeff / Claude Desktop / the next session
**Companion to:** `docs/public-artwork-handoff-2026-08-05.md`, `docs/listener-deploy-review-2026-08-05.md`
**Status:** diagnosed with a LIVE receipt. **Two-repo change NOT started.**

---

## 0 · What shipped, and what it did not fix

**SHIPPED and verified on production** (`listen.ether-technologies.com`, commit `a051d0b`, deployed):

| Surface | State |
|---|---|
| Listener hero / player (`App.tsx:275`) | ✅ gated — `isImaging` |
| Listener station tiles (`StationView.tsx:72`) | ✅ gated — `tileImaging` |
| `/api/artwork` endpoint (`functions/api/artwork.ts`) | ✅ refuses `JIN`/`SWP`/`SPOT` |
| ether-cast (`index.html`) | ✅ gated, confirmed in the served bytes |

Endpoint proof against production:
`?title=Zombie&artist=The Cranberries&class=SPOT` → `{"art_url":null}`
`?title=Zombie&artist=The Cranberries` → a Deezer URL (music untouched)

**NOT FIXED — Jeff's screenshot, 2026-08-05:** the listener's **queue list** ("Next from: HalloVeen")
shows *Commercial Spot* wearing third-party cover art (Skinny Pimp). The desktop's own queue shows the
same spot correctly blank.

---

## 1 · ROOT CAUSE — the queue payload carries no content class

Live from the production API, fetched 2026-08-05:

```json
"content_class": "MUSIC",        ← the NOW-PLAYING item HAS it
"queue": [
  { "title": "Commercial Spot", "artist": "", "duration": 11000 },   ← queue items DO NOT
  { "title": "Defying Gravity",  "artist": "Cynthia Erivo, Ariana Grande", "duration": 459833 },
  ...
]
```

`QueueItem` in `C:\ether-listener\src\types.ts` is exactly `{ title?, artist?, duration? }` — because
that is all the backend sends, because that is all the desktop puts in `payload.queue`.

So `NpRow` (`Fullscreen.tsx:139`) calls `fetchAlbumArt("Commercial Spot", "")`, the endpoint receives no
`class`, and Deezer answers with whatever matches the words.

**The listener cannot tell it is a spot. The information is not in the payload.**

This is the same shape as the 4.4.132 relay bug and the VU-levels bug: a field the receiver needs,
hand-picked out in transit by a payload builder. The engine knows each queue item's content class —
`payload.queue` drops it.

---

## 2 · Three ungated callers, also missed

Claimed "everywhere" and did not enumerate these. All three call `fetchAlbumArt` with no class:

| Call site | What it renders |
|---|---|
| `src/components/Fullscreen.tsx:139` (`NpRow`) | **the queue rows in the screenshot** |
| `src/components/NowPlaying.tsx:23` | now-playing component |
| `src/components/EmbedWidget.tsx:31` | the embeddable widget |

Gated already: `App.tsx:275`, `StationView.tsx:72`.

---

## 3 · THE FIX — two repos, and NEITHER ALONE FIXES IT

### 3.1 · Desktop (`C:\openair`) — the missing data. DO THIS FIRST.

Add the per-item content class to each entry of `payload.queue` in `buildNowPlayingPayload`
(`src/App.tsx`). The engine already carries `contentClass` on every queue item
(`engine-rodio.ts` queue items; loggen sets it from `generated_schedule.content_class`) — the payload
builder simply does not copy it.

Requires: a desktop change, a build, and an install. Verify the field appears in
`/public/station/<slug>` before touching the listener.

**Check the backend passes it through.** `station_now_playing.queue` is stored as JSON, so it most
likely round-trips untouched — but confirm rather than assume; the top-level `content_class` needed an
explicit column and an explicit whitelist (`ether-backend/src/index.js:474, :4758`).

### 3.2 · Listener (`C:\ether-listener`) — thread it through

1. `types.ts` — `QueueItem` gains `content_class?: string | null`.
2. `api.ts` — `fetchAlbumArt(title, artist, contentClass?)` appends `&class=<cls>`; return `null`
   immediately for `JIN`/`SWP`/`SPOT` without a network call.
3. `Fullscreen.tsx` — `NpRow` takes the class and passes it.
4. `NowPlaying.tsx`, `EmbedWidget.tsx` — same gate.
5. Deploy, then verify on the live player.

**Ordering:** the listener half is invisible until the desktop ships the field; the desktop half is
useless until the listener passes it. **Recommended: desktop first**, since that is the actual missing
data.

---

## 4 · Acceptance

On the LIVE public player, with a spot in the queue:

1. The queue row for *Commercial Spot* shows the **station/OV logo or a neutral placeholder** — never
   third-party cover art.
2. Music rows in the same queue still show real cover art (proves the gate did not over-apply).
3. The now-playing hero and the station tiles are unchanged (already fixed — do not regress them).

Verify by eye on the player, not by grep. This bug survived two rounds of "fixed everywhere" precisely
because each round enumerated only the paths that had already been looked at.

---

## 5 · State at handoff

- `ether-listener` — commit `a051d0b` **deployed to production**; working tree still holds
  `PlayButton.tsx` uncommitted and HELD (unrelated to artwork; see
  `docs/listener-deploy-review-2026-08-05.md` for the https question that gates it).
- `ether-cast` — gate deployed and confirmed in the served file. **Note:** its queue/now-playing art has
  the same class dependency and will need the same treatment once the desktop ships the field.
- `ether-dashboard` — untouched, operator-facing, last in the order.
- `C:\openair` — untouched by this job. D1 is a separate job; see `docs/D1-launch-receipt-2026-08-05.md`.
