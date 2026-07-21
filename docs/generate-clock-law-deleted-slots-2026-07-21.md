# Generate: clock is law — stop walking deleted slots (v4.4.76, 2026-07-21)

Follow-up to `docs/log-reader-of-preflip-2026-07-21.md`. Jeff's ruling: **the clock is law; Generate is
the violator.** Fix Generate to fill the clock's slots from the clock's categories — never import
off-clock songs. This is the build; the empty-category off-clock stamp is deferred to the flip's
`source`-column work (one schema change, not two).

## (1) Diagnosis — a deleted-slot leak (receipts)
OF's "Open Format" clock (clock 1) was re-categorized from the cat-1 catch-all to per-decade categories.
That re-categorization **soft-deleted the old cat-1 music slots and added new ones**. Clock 1 today
carries, at every position, a **`deleted` cat-1 music slot** plus a **live** slot with the real category
(`[5,5,2,5,5,5,3,5,5,4,5,5,8,…]`).

**Generate read the deleted slots.** The prepared statements that walk the clock had **no `deleted_at`
filter**:
- `schedule:generate` — `main.js:5709`
- `_buildScheduleCtx` (used by `schedule:generateDay`, the calendar Generate button) — `main.js:~5932`

So Generate walked the deleted cat-1 slots too and filled them (music rows carry `category_id =
slot.category_id`, `main.js:6100/6217`) → **52% of OF's schedule was cat-1** (194 rows today, all
`clock_id=1`, `gs.category_id == s.category_id == 1`). The daemon's on-format guard `getFormatCategoryIds`
(`loggen.js:87-91`) **does** filter `deleted_at` → sees only `[2,3,4,5,8]` → drops the cat-1 rows → the
§2.7 shadow gap. Right beside `stmtSlots`, `stmtClockBreaks` already filtered `deleted_at` — so this was
an inconsistency, **not a designed fallback and not the `_lrpFallback` ladder** (both of which already
work strictly within `slot.category_id`).

## (2) The fix
1. **Root — `deleted_at IS NULL` on `stmtSlots` and `stmtShows`, both Generate paths** (`schedule:generate`
   + `_buildScheduleCtx`). Generate now reads the clock exactly as the UI and the on-format guard do. A
   re-categorized clock's dead slots are never walked. This *is* "clock is law."
2. **Loud thinness → Health Monitor** (`library-health.js noteGenerate`, called from `schedule:generateDay`):
   the run's within-category relaxation (`ctx.relaxed`) and empty categories (`ctx.diag.emptyCats`) now
   emit health events (`generate-relaxed` / `generate-empty-category` → `health-events.jsonl`) and a
   per-station "Last Generate" summary — visible on the Health Monitor, not just the calendar panel. The
   already-correct behavior (relax separation *within* the category; never off-clock) is unchanged — it's
   now **audible**.
3. **Per-clock-slot depth sense** (`library-health.js depthCheck`, in the 120s senses tick): per LIVE
   clock music-slot category, songs available vs slots asked/hr vs the separation window
   ("Feel Good: 37 songs for ~10 slots/hr"). Surfaced in the Health Monitor LIBRARY section as
   "Rotation depth" (warn when a category is thinner than its demand). A programmer's fact, on the panel.

**Deferred (as agreed):** the empty-category *off-clock* "best available + stamp the row" — needs a
`source`/`relaxed` column; it joins the flip's operator-insert `source`-column work (one migration). OF
never hits it (its categories are thin, not empty — item 2/3 cover that).

## (3) Proof — DB copy, live DB untouched (`scripts/prove-of-regen-fix.js`)
Regenerated OF on a clean snapshot using the FIXED slot query + a faithful port of Generate's music
selection (song/artist/title separation, per-hour dedup, `_lrpFallback`):

```
REGENERATED OF 5 PM→end-of-day: 109 music rows
by category:  cat 5: 81 · cat 8: 7 · cat 4: 7 · cat 3: 7 · cat 2: 7
>>> cat-1 (off-clock catch-all) rows after regen: 0   ✅ ZERO
empty categories: none · within-category relaxation: 0

§2.7 selector on the regenerated copy:
  5:41 PM → "I'm Still Standing" @ 5:41 PM · drift 1m · on-time
  7:12 PM → "Chandelier"        @ 7:12 PM · drift 0m · on-time
```

Only `[2,3,4,5,8]`, **cat-1 = 0**, and the selector **re-anchors** (drift ~0, on-time) — on the LAW's
terms, not by legalizing the violation.

## Gates
- `node --check` main.js / library-health.js: OK.
- `npx tsc --noEmit`: zero new errors (2 pre-existing — OnboardingFlow, PhoneDesk).
- Leak-guard: **14** (baseline holds).
- `npm run build` + installer: OK.

## Artifact — STOP before install
`C:\openair\dist-electron\Ether Setup 4.4.76.exe` — `--publish never`. After install (full close/reopen),
click **Generate** for OF → the cat-1 rows vanish, the calendar/queue fill with `[2,3,4,5,8]`, and the
§2.7 shadow agreement recovers. The Health Monitor's LIBRARY section shows the new Rotation-depth +
Last-Generate rows.

## Files
- `electron/main.js` — `deleted_at IS NULL` on `stmtSlots`/`stmtShows` (both Generate paths); `noteGenerate` call.
- `electron/library-health.js` — `depthCheck`, `noteGenerate`, `depth`/`lastGenerate` in the snapshot.
- `src/components/HealthMonitor.tsx` — Rotation-depth + Last-Generate rows.
- `package.json` 4.4.75 → 4.4.76.
- `scripts/prove-of-regen-fix.js`, `diag-of-*.js` — read-only proofs (gitignored, re-runnable).

## Note — a sibling to sweep later
`loggen.pickFromClock` (`loggen.js:128`, the daemon's clock-tier refill fallback) also reads
`clock_slots` without a `deleted_at` filter. It's a rarely-hit fallback, but it's the same law violation
— worth the one-line filter in a follow-up for consistency.
