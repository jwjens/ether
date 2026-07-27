# v4.4.82 — Spot-breaks Generate regression fix + gold spot cues

**Artifact:** `C:\openair\dist-electron\Ether Setup 4.4.82.exe` (built `--publish never`, local only)
**Status:** built + gated locally. NOT committed, NOT installed — STOP before install (live verify #4 after install).

## The regression

Spot breaks stopped populating in Generate. **Root cause was not** the v4.4.76 `deleted_at` clock filter
(clock_breaks read fine — 3 live, 0 wrongly deleted per `scripts/diag-spot-breaks.js`). The real cause:
**Mark-as-Spot was minting spots with `is_active = NULL` (and no category).** Generate's
`SPOT_SELECT_BY_CATEGORY` (`main.js:5908`) requires `is_active = 1 AND spot_category_id = ?`, so every
break's category query returned **0 rows → the break placed nothing** (silent). halloVeen had 2 such
orphaned spots (`is_active != 1`), OF/MF had 0 spots at all.

## The fix (4 parts, as approved)

1. **`spots.create` defaults `is_active ?? 1`** (+ `max_plays_day ?? 999`) — a created spot AIRS by
   default; callers may still pass `is_active:0` for a parked spot. `electron/sync/handlers/spots.js`.
2. **Mark-as-Spot passes `is_active:1` explicitly and now REQUIRES a category** — the dialog's *Mark as
   Spot* button is disabled until a category is picked/typed (`*required` label, tooltip), and
   `confirmSpotMark` alert-guards a null category. `src/App.tsx`.
3. **One-time orphan repair = surface, don't guess.** The Spots & Promos list now flags any spot a break
   can't pull with an amber **⚠ WON'T AIR** chip (reason in tooltip: inactive and/or no category), so Jeff
   fixes today's 2 orphans in-UI with the right categories rather than me guessing them. `src/components/Spots.tsx`.
4. **Gold/amber spot cues (#fbbf24) in the log** —
   - **Calendar:** spot rows (`!song_id`) render with an amber left-border, amber wash, amber title, and a
     **SPOT** chip. `src/components/BroadcastCalendar.tsx`.
   - **Live Up Next queue:** spot items render amber left-edge + wash + **SPOT** chip.
     `src/components/UpNext.tsx` (detects `contentClass === 'SPOT'`).
   - To make the queue cue honest, `content_class` is now **carried end-to-end**: Generate already tags the
     3 spot `generatedRows.push` with `content_class:'SPOT'`; the daemon read-path (`audiod/loggen.js`
     `toItem` + `readGeneratedSchedule`/`fillFromHour`/`readLogAnchored` SELECTs) and the renderer path
     (`src/audio/loggen.ts`) now select+carry it; `engine-rodio.ts` preserves it on the daemon queue event.

## Proof (read-only, live DB untouched)

`scripts/prove-spot-breaks-fix.js` — backs up the live DB read-only, writes only to the copy:
```
BEFORE: SPOT_SELECT (cat 3) → 0 rows  → break places NOTHING (the regression)
AFTER (active+categorized): 2 eligible → :00 → #1, :20 → #2, :40 → #1  (LRP rotation)
[PASS] break query returns eligible spots after the fix
[PASS] every break places a spot at its minute
[PASS] LRP rotation
```

## Gates

- `npx tsc --noEmit` — 3 errors, all pre-existing (App.tsx, OnboardingFlow.tsx, PhoneDesk.tsx). **Zero** in
  touched files. (A JSX label-close typo from the prior Mark-as-Spot edit was caught by the vite build and
  fixed — `src/App.tsx:5102`.)
- `node --check` — loggen.js, spots.js OK.
- `node scripts/test-station-identity-leak.js` — baseline 14 holds, no new leaks.
- `npm run build` — renderer OK. `electron:build:win --publish never` — installer signed + built.

## Architecture Compliance

- **Clock is law for spots** (`docs/jingles-content-class-design-2026-07-09.md`): spots are clock-placed via
  `spot_break`/`clock_breaks` → `_pickSpot` LRP, a different rotation than music. Fix keeps that path intact;
  it only restores spot *eligibility* (active + categorized) and adds honest cues. No new placement logic.
- **content_class isolation**: `SPOT` carried on the same rails as `JIN`/`SWP`; music-fill still excludes
  non-MUSIC. The gold cue reads the existing class, doesn't invent a parallel flag.
- **Honest UI**: the WON'T-AIR flag reflects observed row state (is_active/category), never a claim; the
  queue SPOT chip only lights when the item genuinely carries `content_class='SPOT'` from the log.
- **Help**: `docs/help-spots.md` updated — required category, the ⚠ WON'T AIR flag, and the gold calendar/
  queue cues.

## Remaining (post-install, after GO)

Live verify #4: on a flipped station, confirm a spot airs at its break minute (daemon receipts) and renders
gold in the live queue.
