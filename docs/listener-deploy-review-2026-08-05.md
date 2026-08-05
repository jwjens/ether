# ether-listener — review of the 7 uncommitted files before any deploy

**Written:** 2026-08-05 · **For:** Jeff / Claude Desktop
**Companion to:** `docs/public-artwork-handoff-2026-08-05.md` (the job), which this supersedes on the
question of *what to commit*.
**Status:** read-only review COMPLETE. **Nothing committed. Nothing deployed. Nothing edited.**

---

## 0 · Why this review exists

`wrangler pages deploy` builds from the **working tree**, so deploying `ether-listener` ships every
modified file, not just the artwork fix. Jeff will not ship in-flight work he has not reviewed in order
to land the artwork guard. This is that review.

`C:\ether-listener` — branch `main`, **ahead 8**, 7 modified files:

```
 M src/App.tsx                      ← guard
 M src/components/StationView.tsx   ← guard
 M src/types.ts                     ← guard
 M src/api.ts                       ← GUARD (see §2 — not optional)
 M src/components/SocialLinks.tsx   ← cosmetic
 M src/components/AccountHub.tsx    ← cosmetic
 M src/components/PlayButton.tsx    ← RISK — hold
```

Total across the four non-guard files: **6 insertions, 16 deletions.**

---

## 1 · The guard files (already reviewed, correct)

`App.tsx`, `StationView.tsx`, `types.ts` — the imaging guard. Verified **absent from `HEAD`**, i.e.
working-tree only, which is why the live site still guesses.

- `App.tsx:268` `isImaging` = `content_class ∈ {JIN,SWP,SPOT}`
- `App.tsx:275` lookup runs only when `!isImaging && title && !art_url`
- `App.tsx:278-280` imaging → `art_url → hubLogo → station logo`; music → `art_url → iTunes → station logo`
- `StationView.tsx:67,72` same rule for the station tiles
- `types.ts:16` types `content_class` and states the rule in a comment

---

## 2 · `api.ts` — +1 / −1 — **PART OF THE GUARD. Cannot be split off.**

```diff
-  account: { name: string | null; slug: string | null } | null;
+  account: { name: string | null; slug: string | null; logo_url?: string | null } | null;
```

Type-only, additive, optional field. It looks like unrelated in-flight work and **is not**:

`App.tsx:259` declares `hubLogo` as *"account (OV) logo — the imaging-art fallback"*, and the guard's
chain at `:279` is `art_url → hubLogo → station logo`. **Without `logo_url` on this type the imaging
fallback has no hub logo to fall back to.**

**If Jeff chooses "separate the guard", the guard set is FOUR files: App.tsx, StationView.tsx, types.ts,
api.ts.** Shipping the first three alone would land a half-fix.

---

## 3 · `SocialLinks.tsx` — −1 — cosmetic, safe

Removes `<span className="powered">Powered by Ether</span>` from the footer.

## 4 · `AccountHub.tsx` — −3 / +1 — cosmetic, safe

Removes the EtherCast wordmark footer; replaced by a comment: *"No platform wordmark — listener surfaces
carry the client's brand only."*

Both are white-labelling, consistent with listener surfaces carrying the client's brand. **Zero
functional surface — neither can affect playback or artwork.**

---

## 5 · `PlayButton.tsx` — −11 net — ⚠ **THE ONE WITH REAL RISK — recommend HOLD**

It **removes the mixed-content proxy fallback**:

```diff
-  // Browsers block http:// audio on an https page (mixed content). When the station broadcasts to an
-  // http Icecast mount (e.g. http://44.244.52.207:8000/ov), relay it through our OWN same-origin https
-  // proxy (/api/stream) so the browser sees an https source and plays it.
-  const src = (streamUrl && /^http:\/\//i.test(streamUrl) && location.protocol === "https:")
-    ? `/api/stream?url=${encodeURIComponent(streamUrl)}`
-    : streamUrl;
```

…and plays `streamUrl` directly. The new comment asserts the premise: *"The published stream_url is an
https Icecast mount (e.g. https://stream.ether-technologies.com:8443/ov), so it plays directly."*

**The risk, stated plainly:** if ANY station still publishes an `http://` mount, its public player stops
working the moment this deploys — the browser blocks http audio on an https page and the proxy that
rescued it is gone. The removed comment names a real example (`http://44.244.52.207:8000/ov`).

**Where the audio actually lives:** the streams are on **AWS Lightsail, `44.244.52.207`**, fronted by the
https mount `stream.ether-technologies.com:8443`. So the question is precisely: **do all published
`stream_url` values point at the https mount (`https://stream.ether-technologies.com:8443/…`), or does
any station still publish the old `http://44.244.52.207:8000/…` AWS address?** Query the published
values when fresh — **`PlayButton.tsx` stays HELD until that list shows all https.**

Query (Railway Postgres — CLI was `Access is denied` in the 2026-08-05 session, so run it with working
credentials):

```sql
SELECT s.slug, m.stream_url, m.public_enabled
FROM station_metadata m LEFT JOIN stations s ON s.uuid = m.station_uuid
WHERE m.stream_url IS NOT NULL ORDER BY 1;
```

**The one question that settles it: do ALL published `stream_url` values use `https://`?**
If yes → clean simplification, ship it separately and confirm playback.
If unsure → **do not let it ride along with an artwork fix.** A silent playback failure on one station is
far worse than a spot showing the wrong cover.

---

## 6 · RECOMMENDATION

**Commit and deploy (the complete artwork fix):**
`src/App.tsx` · `src/components/StationView.tsx` · `src/types.ts` · `src/api.ts`

**Optional, Jeff's call, no functional risk:**
`src/components/SocialLinks.tsx` · `src/components/AccountHub.tsx`

**HOLD until the https question is answered:**
`src/components/PlayButton.tsx`

**Then, on top:** the class gate in `functions/api/artwork.ts` (§3 of the companion handoff) — the
endpoint currently runs `fromDeezer() || fromItunes()` unconditionally at `:43`, so any caller can make
it guess. Not among the 7 modified files, so it does not tangle.

**Then ONE deploy**, and verify on the live surface.

---

## 7 · Verification (on the PUBLIC player, not the source)

1. Play a **jingle or spot** on a live station → the public player must show the **station / OV logo**,
   never third-party art.
2. Play a **music track** → art must still resolve normally (this proves the gate did not over-apply).
3. Confirm **playback still works** on every station if `PlayButton.tsx` was included.

A grep proves the tree, never the product. This bug survived precisely because the code was right and
the deployed site was old — verify on the live player.

---

## 8 · State at handoff

- Nothing committed, deployed or edited in `ether-listener`, `ether-cast`, `ether-dashboard`, or
  `ether-backend`.
- `ether-listener` still `main`, ahead 8, 7 modified files, exactly as found.
- Backend passthrough confirmed working — **no backend change needed** (receipts in the companion doc).
- Unrelated and separate: `docs/D1-handoff-2026-08-05.md` (desktop app). Do not tangle the two.
