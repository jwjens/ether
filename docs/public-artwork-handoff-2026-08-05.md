# Handoff — spot/jingle artwork on the PUBLIC surfaces

**Written:** 2026-08-05 · **For:** a fresh session (and Claude Desktop)
**Job:** imaging and commercials (`JIN` / `SWP` / `SPOT`) must NEVER do an external artwork lookup on any
public surface. Music is unaffected.
**Status:** read-only investigation COMPLETE. **Nothing edited. Nothing committed. Nothing deployed.**

---

## 0 · Why this exists

The desktop app was fixed in 4.4.135. The public surfaces were not — they live in **separate
repositories with separate deploys**, so no desktop build could ever have reached them. A spot on the
public player still pulls Deezer/iTunes art, which has produced wrong and even explicit third-party
artwork for imaging.

---

## 1 · BLOCKING CHECK — PASSED. No backend work needed.

The question was whether the backend stores and re-serves `content_class`, since the whole fix depends
on the public surfaces knowing the class. **It does.**

`C:\ether-backend\src\index.js`:

| Line | Receipt |
|---|---|
| `471` | comment already states imaging/commercials must not get a music-store lookup |
| `474` | `ALTER TABLE station_now_playing ADD COLUMN IF NOT EXISTS content_class TEXT` |
| `4758` | ingest whitelists it: `["MUSIC","JIN","SWP","SPOT"].includes(body.content_class) ? … : null` |
| `4772 / 4782 / 4806` | stored in the upsert |
| `4896, 4936, 4985, 5023` | **re-served** as `now_playing.content_class` on four endpoints |

**The class is available to every public surface today.** Do not "fix" the backend.

---

## 2 · THE KEY FINDING — the listener fix is written, uncommitted, and undeployed

`C:\ether-listener` is on `main`, **ahead 8**, with **7 modified, uncommitted files**:

```
 M src/App.tsx                      ← the isImaging guard lives HERE
 M src/components/StationView.tsx   ← the tileImaging guard
 M src/types.ts                     ← content_class typed, rule in a comment
 M src/api.ts  M src/components/AccountHub.tsx  M PlayButton.tsx  M SocialLinks.tsx
```

Verified against `HEAD` — the guard is **working-tree only**:

- `git show HEAD:src/App.tsx | grep isImaging` → **NOT PRESENT**
- `git show HEAD:src/components/StationView.tsx | grep tileImaging` → **NOT PRESENT**
- `git show HEAD:src/types.ts | grep content_class` → **NOT PRESENT**

**The live site runs code that predates all of it.** That is why spots still guess. Same shape as the
desktop cart wall earlier this session: the fix existed and never reached the thing being looked at.

**The working-tree code is correct** — `App.tsx:266-280` resolves imaging as
`art_url → hub/OV logo → station logo`, keeps the lookup for music only, and cites the explicit-art
incident in its comment. `StationView.tsx:67,72` does the same for the station tiles.

**So the first action is NOT to write code. It is to get the existing correct code committed and
deployed, then verify.**

---

## 3 · What still has NO gate anywhere

`C:\ether-listener\functions\api\artwork.ts` — the edge function takes only `title` and `artist` and runs

```ts
:43   const art = (await fromDeezer()) || (await fromItunes());
```

unconditionally. **Any caller can make it guess.** The client guards prevent the call; the endpoint
should also refuse, so a future caller cannot reintroduce the bug. This file is **not** among the 7
modified files, so editing it does not tangle with the in-flight work.

Suggested shape (not written): accept a `class` query param, and return `{ art_url: null }` immediately
when it is `JIN` / `SWP` / `SPOT`. Callers pass `np.content_class`. Absent/unknown class keeps today's
behaviour so music is untouched.

---

## 4 · ⚠ DEPLOY HAZARD — read before running wrangler

`wrangler pages deploy` builds from the **working tree**. Deploying `ether-listener` right now would
ship **all 7 uncommitted files**, including `PlayButton.tsx`, `SocialLinks.tsx`, `AccountHub.tsx` and
`api.ts` — in-flight work that has not been reviewed for release.

**Do not deploy without Jeff explicitly confirming those files are deploy-ready.**

Jeff's preferred route (recommended): **he commits his own working tree**, then the endpoint gate goes on
top, then one deliberate deploy.

---

## 5 · The three repos, in order. ONE AT A TIME.

### 5.1 · `C:\ether-listener` — listen.ether-technologies.com — **PRIORITY**
1. Get the existing guard committed (Jeff's call — §4).
2. Add the class gate to `functions/api/artwork.ts` (§3).
3. Deploy: `wrangler pages deploy` (Pages project **ether-listener**).
4. **Verify:** play a jingle/spot on a live station, load the public player, confirm the station/OV logo
   shows — **not** third-party art. Confirm a music track still resolves art normally.

### 5.2 · `C:\ether-cast` — Ethercast PWA
- `index.html:149` — inline iTunes lookup, `:151` uses `artworkUrl100`, `:241` uses `np.art_url`.
- Same gate: skip the lookup when `content_class` is imaging; fall back to the logo.
- Deploy: `C:\openair\ec-deploy.sh` (`wrangler pages deploy . --project-name ether-cast`).
- Verify the same way.

### 5.3 · `C:\ether-dashboard` — app.ether-technologies.com — **LAST** (operator-facing, not public)
- `src/components/StationDetail.tsx:52` and `src/components/StationList.tsx:14` — iTunes lookups.
- Same gate. Deploy: wrangler Pages project **ether-dashboard**.

---

## 6 · Rules for this job

- **ONE repo at a time.** Built → deployed → Jeff confirms on the live surface → next repo.
- **No deploy until Jeff confirms the working-tree files are deploy-ready** (§4).
- **Verify against the public surface**, not the source. A grep proves the tree, never the product — that
  is precisely how this bug survived: the code was right and the site was old.
- **Do not touch the desktop app or D1.** Different repos entirely; see
  `docs/D1-handoff-2026-08-05.md` for that job, which is separate and unstarted.

---

## 7 · State at handoff

- `C:\ether-backend` — no change needed, no change made.
- `C:\ether-listener` — untouched by this session. Still ahead 8 with 7 modified files.
- `C:\ether-cast`, `C:\ether-dashboard` — untouched.
- `C:\openair` — untouched by this job.
