# Spot artwork on PUBLIC surfaces — the R2 trigger has fired

**Written:** 2026-08-05 · **For:** Jeff / Claude Desktop / the next session
**Status:** diagnosed read-only. **NOT STARTED.** No code, no build, no deploy.
**Related:** `spot-artwork-override-design-2026-08-04.md` · `public-artwork-queue-gap-2026-08-05.md`

---

## 0 · Jeff's report, verbatim

> "that artwork is what should be showing on the listener page and dashboard — it worked on the
> dashboard yesterday"

Screenshot: SPOTS → Edit Spot → the **Artwork** panel showing the uploaded OV/QVC logo, with the caption
the feature itself renders: **"Stays on this computer."**

---

## 1 · Why the uploaded art cannot reach a public surface today

**By design, and the UI says so.** `spots.art_image` is a base64 **data URL in the local SQLite row**.
That was the explicit v1 decision (`spot-artwork-override-design-2026-08-04.md` §DECIDED):

> **LOCAL PATH for v1** … "OV is one install; the park is carried by A + a local override.
> **Revisit R2 only if/when spot art becomes a listener-facing surface.**"

**That trigger has now fired.** Jeff wants it on the listener page and the dashboard.

The public surfaces do not read the install's database. They read `now_playing.art_url` from the
backend. And for imaging the desktop sends **`art_url = null` deliberately** (`src/App.tsx:2117`):

```js
if (!["JIN", "SWP", "SPOT"].includes(payload.content_class || "")) {
  payload.art_url = await ether.station.nowPlayingArt(st.uuid, payload.filePath);
}
```

That guard is correct and pre-dates this work — it stops a *music-store* lookup for imaging. But its
side effect is that **a spot's own uploaded art also never leaves the machine.** There is no path from
`art_image` to any public surface. This is a MISSING HALF, not a regression.

---

## 2 · "It worked on the dashboard yesterday" — the one thing to check first

Jeff's report outranks inference and is recorded as fact. The mechanism is NOT yet established, and it
matters, because it may reveal an existing route that only needs pointing at the right image.

**The most likely explanation, to be confirmed or killed by trace — do not assume:**
`resolveContentClass` (`App.tsx:442-455`) looks the on-air file up in `songs`, then in `spots`, and
**defaults to `MUSIC` when it finds neither.** If the spot's `file_path` matched neither table, the
payload would have been stamped `MUSIC`, the guard above would NOT have fired, and
`nowPlayingArt:ensure` would have uploaded the file's **embedded** cover to R2 and returned a real
`art_url`. A public surface would then have shown *something* for that spot.

If that is what happened, "it worked" was an accident of a mis-resolved class, and it would stop working
the moment the class resolves correctly. **Confirm before building anything on top of it.**

The check: for that spot's `file_path`, does a row exist in `songs`? in `spots`? And what
`content_class` does the payload actually carry for it on air?

---

## 3 · What actually has to be built

**The R2 half of the spot-artwork feature**, i.e. option B from the original design, which was
deliberately deferred:

1. **Upload the operator's chosen image to R2** when it is set in the Edit Spot form, and store the
   returned public URL alongside (or instead of) the local data URL.
   - The pattern already exists twice: `electron/now-playing-art.js` (embedded cover → backend-signed
     PUT → R2 public URL, content-hash de-duplicated) and `electron/station-metadata.js:85-105`
     (`logo-upload-url` → signed PUT). Do not invent a third.
2. **Send it.** For `SPOT`/`JIN`/`SWP`, `payload.art_url` becomes the spot's R2 URL when one exists —
   still never a music-store lookup. The `App.tsx:2117` guard is refined, not removed: the rule is
   "no music-store lookup for imaging", not "no artwork for imaging".
3. **Schema.** `spots.art_image` (local data URL, v36) gains a companion for the R2 key/URL. Decide
   whether the data URL stays as the local fast path or is replaced — the local copy is what makes the
   desktop deck tile instant and offline-correct.
4. **Listener/dashboard need no change for this** — they already render `art_url` when present. The
   separate queue gap (`public-artwork-queue-gap-2026-08-05.md`) is a different fix and both are needed
   for a spot IN THE QUEUE to look right.

**Cost of not doing it, stated plainly:** the operator uploads artwork, sees it on the deck, and the
public sees nothing. That is worse than never offering the upload, because it looks like it worked.

---

## 4 · Sequencing against the other open artwork work

Three separate things, often confused. **They do not substitute for each other:**

| # | Job | State |
|---|---|---|
| A | Imaging never gets a music-store lookup | ✅ SHIPPED — listener + ether-cast deployed, endpoint gated |
| B | Per-item `content_class` in the queue payload | ⏳ desktop change WRITTEN, staged, **uncommitted**; listener half not started |
| C | **This doc** — uploaded spot art reaching public surfaces | ❌ not started |

A spot in the listener's queue looking correct needs **B**. A spot showing the operator's *own* artwork
anywhere public needs **C**.

---

## 5 · State at handoff

- `C:\openair` — `src/App.tsx` (queue `content_class`) + `package.json` (version string 4.4.143) are
  **staged but UNCOMMITTED**. **No installer was built.** Nothing to install.
- `C:\ether-listener` — commit `a051d0b` deployed; `PlayButton.tsx` still HELD and uncommitted.
- `C:\ether-cast` — gate deployed.
- Backend — confirmed it round-trips `queue` untouched (`index.js:4787` whole-array `JSON.stringify`),
  so job B needs **no** backend change.
