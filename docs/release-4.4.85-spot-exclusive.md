# v4.4.85 — Spots are exclusive program (clean edges) + real duration + import differential

**Artifact:** `C:\openair\dist-electron\Ether Setup 4.4.85.exe` (built `--publish never`). Supersedes the
un-installed 4.4.84 — carries 4.4.83 (spot truth + break sense), 4.4.84 (anchor-fit), and this. STOP before install.

## Bug — top-of-hour spot fired OVER the first song (co-start / overlap)

**Trace (receipts):**
1. `audiod/engine.js _segueTick` starts the incoming deck early whenever the playing deck has ≤ segueOverlap
   (3s) left — with **no content_class check**. So a spot's tail overlaps the next song, and a song's tail
   overlaps an incoming spot. That is the co-start.
2. `_placeJingles` binds jingles only to MUSIC rows, but the jingle bound to the *first song after the spot*
   arms via `readJingleForSeam` while the **spot is the playing deck** → imaging fires over the commercial.
3. The calendar "12:00 stack + two ▶" is minute-resolution display of spot(12:00:00) + jingle + first song,
   with two rows lit = the overlap.

**Fix (Jeff's ruling: CLEAN EDGES — no music overlap in or out, no jingle over a spot):**
- New `deckContentClass[A|B|C]`, set in the single load funnel `loadToDeck` from the queue item's
  `contentClass` (carried end-to-end since 4.4.84).
- `_segueTick`: if the outgoing OR incoming deck is a SPOT → **no early overlap** (log: `clean spot edge`).
  The spot plays alone; the natural-end rotate is a clean cut.
- `_jingleTick` arm path: if the outgoing OR incoming deck is a SPOT → **suppress the seam**
  (`clearScheduled("spot-seam")`). A jingle never rides over/into a commercial under any policy.
- Structurally music↔music behavior is unchanged (`deckContentClass` null for music → guards inert).

## Bug — fake spot duration (30s default, real file 11s)

`getFileDuration` (native, returns seconds — proven: Jeff's spot = **11.47s**, not 30) now probes the real
length at creation:
- Mark-as-Spot (`App.tsx confirmSpotMark`) and Spots-panel file/folder import (`Spots.tsx`) store the probed
  `length_sec`.
- Existing spots **self-heal**: `Spots.tsx load()` re-probes any row with null/30s length and updates it via
  `spots.updateById`, then re-loads once (second pass finds nothing → terminates).
- Why it mattered: the deck plays real duration via native `_dur`, but the **generator's spacing + anchor-fit
  math** used the fake 30s — corrupting the schedule and the calendar.

## Bug — Add-file import works on Magical Forest, fails silently on halloVeen (differential)

**Root (receipts, `scripts/prove-import-dedup.js`):** the import dedup `SELECT id FROM spots WHERE file_path=?`
did **not** filter `deleted_at IS NULL`. halloVeen carried **2 soft-deleted** rows for that file → dedup
matched → silent skip. Magical Forest had no prior rows → it created one, so it "worked."
```
station 2 (halloVeen): OLD dedup match=2 → SKIPS (silent) · NEW match=0 → CREATES ✓
station 3 (Magical Forest): OLD match=1 → skips · NEW match=1 → skips (a LIVE dup, correct)
```
**Fix:** all four import dedup queries (file / folder / traffic-ISCI / traffic-title) now add
`AND deleted_at IS NULL` — a soft-deleted spot never blocks re-import. And the import **names its result**:
`Imported N spots · M already in the library (skipped)` + a failure toast — no silent 0.

## Gates
- `node --check` engine.js OK. `tsc` — 3 pre-existing errors, zero in touched files.
- Leak-guard baseline 14 holds. Renderer + signed installer built.
- Proofs: `prove-spot-duration.js` (11.47s), `prove-import-dedup.js` (2/0 vs 1/1). Daemon clean-edge behavior
  verified live via the new `clean spot edge` / `spot-seam` log receipts.
- Help: `docs/help-spots.md` — clean-edges + real-duration section.

## Live verify (post-install)
Next generated hour with a :00 or mid-hour break: **spot plays alone**, no song under it, no jingle over it;
first song follows at the spot's natural end. Daemon log shows `clean spot edge` at the spot seams and
`spot-seam` where a jingle was suppressed. Re-importing the same file to halloVeen now creates a live spot
(status names the result). Calendar shows the spot's real length.

## Not built
Live auto-fitter; any change to music↔music segue/jingle behavior; external DB repair of the deleted rows
(the UI paths — re-import + self-heal — cover it).
