# v4.4.84 — Spot panel truth + break↔category sense (4.4.83) + Generate anchor-fit

**Artifact:** `C:\openair\dist-electron\Ether Setup 4.4.84.exe` (built `--publish never`, local only).
**Status:** built + gated. NOT committed, NOT installed — STOP before install. Carries the 4.4.83 spot fixes
AND the anchor-fit (one installer for both).

## Part A — Spots panel truth + empty-break sense (was v4.4.83)

1. **`Spots.tsx` list filters `deleted_at IS NULL`** — the panel no longer shows soft-deleted spots, so Delete
   stops looking dead (the row leaves the list) and the panel stops reporting deleted spots as live. This was
   the entire "dead controls" illusion: the handlers always wrote (proven — both of Jeff's spots carried
   `deleted_at` timestamps, and spot #1 carried edit-only date fields); the list just never dropped the row.
2. **Break↔category sense** — silent empty breaks become visible facts:
   - Spots panel: amber banner naming each active-clock break whose category has 0 eligible spots; flags a
     *foreign* category (another station's id, a leftover from the per-station category split) and points to
     Clocks → Timed Spot Breaks.
   - Clock break editor (`Scheduler.tsx`): inline **⚠ 0 eligible spots** per break; category dropdown shows
     each category's eligible count; a break pointing at a foreign id renders unselected so re-picking writes
     the correct station-scoped id.

Root cause of "breaks place nothing" (receipts, `scripts/diag-spot-raw.js`): both spots were soft-deleted AND
halloVeen's breaks pulled `spot_category_id=2` (Magical Forest's Sponsors) while the spot was tagged 3
(halloVeen's). Data fixes ride the UI — Jeff re-picks the break category and re-creates the spot via Mark-as-Spot.

## Part B — Generate fits songs to break anchors (new)

**Problem (receipts, `scripts/measure-break-drift.js`):** break-mode filled music by LRP order then dropped the
break at the nearest song boundary — the last song's duration is arbitrary, so mid-hour anchors (:20/:40)
drifted p90 ≈ 1.5 min, worst 4.5 min; under half within ±15s.

**Fix (`electron/main.js`, break-mode fill + `selectMusic`):** within a song-length of the anchor
(`FIT_WINDOW_S=360`), the last pick is chosen by **closest-fit duration** toward the target minute (ties keep
the existing random order — rotation preserved). Nearest-boundary remains the hard floor (never worse than
before). Clock law + separation are constraints, never overridden — fit is a tiebreaker WITHIN the compliant
pool. `FIT_TOL_S=15` = on-time.

**Honest signal:** a landing still > tolerance is stamped `generate-break-drift` to the health ledger via
`library-health.js noteGenerate` (`{hour, minute, driftSec, direction}`) + a per-generate summary — an
un-fittable anchor (thin/long-only library) is visible, never silent.

**Proof (`scripts/prove-anchor-fit.js`, real durations, 400 hrs):** Open Format p90 1m56s→**0m05s** (13%→96%
within ±15s); halloVeen 1m49s→**0m05s** (16%→99%); Magical Forest 1m28s→0m25s (16%→78%, floored by a 76-song
pool — residual fires the health event and shrinks as duration variety grows).

**Seam with §2.7:** this is the static/generation-time sibling of the future live auto-fitter — same scoring
idea (`|target − projected|`), different trigger. Pre-fitting keeps §2.7's live corrections small. The live
re-fitter is NOT built here.

## Not built
Live auto-fitter; non-anchor rotation changes; the sequential (no-break) path (structurally untouched — the fit
code lives entirely inside the `breaks.length > 0` branch); re-fit on edit; external DB repair of the deleted
spots / stale break category (rides the UI).

## Gates
- `node --check` main.js + library-health.js OK. `npx tsc --noEmit` — 3 pre-existing errors
  (App/OnboardingFlow/PhoneDesk), zero in touched files.
- `scripts/test-station-identity-leak.js` — baseline 14 holds.
- `npm run build` + `electron:build:win --publish never` — signed installer.
- Help: `docs/help-spots.md` updated (deleted-row truth, empty-break sense).

## Live verify (post-install, after GO)
Regenerate halloVeen (with a real eligible spot + the break category re-picked) → gold rows at :20/:40 within
±15s of the minute; re-run `scripts/measure-break-drift.js` for the real after-picture; break-drift health
events (if any) name the residual.
