# Spot artwork override — design of record

**Date:** 2026-08-04 · **Status:** DESIGN. Read-only tracing done; NOTHING BUILT.
**Jeff:** spots pull unacceptable artwork from iTunes; there should be a manual override.
**UI home (Jeff's call):** the SPOTS page — bottom hamburger → **SPOTS** → Edit Spot form.

---

## What exists today (traced, with receipts)

**1 · No spot-artwork field exists.** No `art_url`/`artwork`/`cover` column on any table, no upload path,
no side table. This is NOT a built-but-unwired case like `cart_slots` or `noteOperatorMonitor` — it has
to be built. The only `art_url` (`App.tsx:485`) is a transient now-playing payload field, not storage.

**2 · Where the bad art comes from.** `OnAirDeck.tsx:109-113`:

```js
const local = await getLocalArt(deck?.filePath);          // embedded cover art — primary
setAlbumArtUrl(local || await fetchArt(title, artist));    // iTunes search — fallback
```

Local-first, **iTunes fallback with NO content-class guard**. A spot with no embedded cover falls through
to an iTunes search on its title — which is how a commercial gets album art. When iTunes returns nothing
the tile renders plain, so "no art" is already graceful; the defect is confidently WRONG art.

**THE RULE ALREADY EXISTS AND WAS NEVER APPLIED HERE.** `App.tsx:439` and `:2114-2118` state that
imaging/commercials (JIN/SWP/SPOT) must NOT get a music-store lookup, and set `art_url = null` for them
on the listener path — the comment cites the original failure ("pulled a jingle whose filename matched a
band"). The deck tile never got the same guard. **That asymmetry is the reported bug.**

**3 · CORRECTION to an earlier answer.** I said spots were `songs` rows with `content_class='SPOT'`.
**Wrong.** Spots have their OWN `spots` table — `Spots.tsx:277`
(`SELECT id FROM spots WHERE title = ? AND advertiser = ?`), saved via
`ether.spots.updateById(id, {...})` at `Spots.tsx:306` with a plain field bag (title, spot_type,
advertiser, start_date, end_date, max_plays_day, is_active, notes, spot_category_id).

That makes this simpler: the override has an obvious column home and an existing save path.

## The build — two separable halves. Do A first.

### A · Stop the wrong art (small, no schema change)

Apply the existing JIN/SWP/SPOT rule to the deck tile: skip the iTunes fallback for non-MUSIC content
classes and render the neutral spot treatment instead. **This alone removes the unacceptable artwork**
and is independent of B. The deck already knows the content class (it drives the SPOT gold outline).

### B · The manual override (schema + UI) — NOT STARTED, gated on A's verification

- **Migration v36:** `spots.art_path`. Current `schema_version` is **35** (confirmed by the pre-commit
  schema gate, 2026-08-04), so v36 is the correct next number. Run on a DB COPY first, verified, before
  the live DB (standing rule).
- **UI:** in the Edit Spot form (beside Advertiser / Notes) — artwork thumbnail + **Choose image…** +
  **Clear**. Empty state explains itself. Saves through the existing `updateById` with `art_path` added
  to the bag: **no new IPC**.
- **Resolution order for spots:** manual override → embedded cover → neutral. iTunes is REMOVED from the
  spot chain, not merely outranked.

**DECIDED (Jeff, 2026-08-04) — LOCAL PATH for v1.** `spots.art_path` holds a filesystem path. NOT R2.

> "LOCAL PATH for v1 (spots.art_path holds a filesystem path), stated as a limitation — not R2. OV is
> one install; the park is carried by A + a local override. Revisit R2 only if/when spot art becomes a
> listener-facing surface."

### ⏸ TRIGGER FIRED AND DEFERRED — Jeff, 2026-08-05

The revisit trigger named below ("if/when spot art becomes a listener-facing surface") **fired**: Jeff
asked for the uploaded spot artwork to appear on the listener page and the dashboard.

**Jeff's decision: NOT NOW.**

> "station logo on public spots stands for now (Option A — the deployed behavior). Uploaded spot art
> going public is the R2 revisit — file it as a roadmap feature (upload to R2/backend, art_url carries
> it, listener renders it), NOT started now."

**So the trigger is ACKNOWLEDGED and DEFERRED — not hanging open.** Public surfaces show the
station/account logo for imaging, which is the deployed and correct behaviour. Do not treat a public
spot showing the logo as a bug.

**Roadmap feature, when it comes:** upload the operator's chosen image to R2 at save time (the pattern
exists twice already — `electron/now-playing-art.js` and `electron/station-metadata.js:85-105`, both
backend-signed PUT), carry the resulting URL in `payload.art_url` for `SPOT`/`JIN`/`SWP`, and the
listener renders it with no listener change needed. The rule stays "no music-store lookup for imaging",
never "no artwork for imaging". Full write-up: `docs/spot-art-public-surfaces-2026-08-05.md`.

---

**Stated limitation, chosen not accidental:** the override is visible ONLY on the install that set it.
Other installs and the listener do not see it. This is the same shape as the library `file_path`-vs-R2
gap — that one hurt because it was an accident. This one is a decision, recorded here, with its
revisit trigger named: spot art becoming a listener-facing surface.

## Sequence (Jeff, 2026-08-04) — A SHIPS AND IS VERIFIED BEFORE B IS BUILT

1. **A ships first** — shipped v4.4.133 (`OnAirDeck.tsx:100-127`, commit `d6e2b8a`). Verify on a live
   spot: the deck tile shows neutral or the spot's own embedded art, NOT a band cover.
   **A may be all the park needs.**
2. **THEN B, only if the manual override is still wanted on top.**

**DO NOT BUILD B UNTIL A IS VERIFIED.** A may make B optional for the season.

If A fails the test — a band cover still appears — the guard is firing but `contentClass` is not
reaching the tile. That is a WIRE trace (`audiod/engine.js:611/635` → `engine-rodio.ts:64` `makeState`
→ `deck.contentClass`), **not a re-patch of the guard.**

## Notes for whoever builds it

- `Spots.tsx:306` is the save site; the form fields are just above it.
- Verify `spots` mutations are in the synced-table set. NOTE under the LOCAL PATH decision: even if the
  COLUMN syncs, the VALUE is a path on one machine and is meaningless on any other install. That is the
  accepted limitation, not a bug to fix — do not "repair" it by adding R2 upload without Jeff's call.
- Help entry required before ship (`docs/help-<feature>.md`, flat, no subfolders).
- Migration on a DB COPY first, verified, before the live DB (standing rule).
