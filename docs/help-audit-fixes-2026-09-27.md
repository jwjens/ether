# Help-audit code defects — fix report (2026-09-27)

Fixes for the 28 numbered defects in `docs/help-audit-2026-09-27.md`. Branch `log-reader-flip`, local commits only
(nothing pushed, nothing tagged). Each commit is `fix: <n> — …`. Each fix started from a test that failed on the old
code. After every commit: `tsc --noEmit` 0 errors, vitest, all 11 smokes, meter-contract and the leak guard, all green.

## Fixed — 22 commits (21 items fully, plus the header part of 12)

| # | Commit | What changed | Proof it fails on the old code |
|---|---|---|---|
| 6 (+7 for BMI/ASCAP) | `0a8897f` | Royalty CSVs carry each play's real length and every play in the period (no 200 cap) | `src/components/logs/royalty.test.ts` (1,000-play day) |
| 7 | `06cfb70` | Printable (PDF) play log covers the whole period | same file |
| 2 | `2959351` | Space / B removed; no key starts, pauses or resumes a deck | `src/lib/deckKeys.test.ts` |
| 5 | `a8b1a90` | Library Delete (right-click, row ✕, selected, all) asks in-app instead of `window.confirm` | `src/lib/confirmController.test.ts` |
| 1 | `c5893b7` | Pop-out MASTER drives the engine and opens at the engine's level; its VU no longer applies the fader twice | `src/components/broadcastMonitorMaster.test.ts` |
| 25 | `c5e0f70` | Wild meter picker uses board letters, not S1–S5 | `src/lib/boardLabels.test.ts` |
| 26 | `319c9c7` | Mic Inputs rows use board letters | `src/lib/micInputsLabels.test.ts` |
| 9 | `1238f71` | Edit Spot has Cart # and ISCI fields, saved separately | `src/lib/spotEditPatch.test.ts` |
| 27 | `460369e` | Show+ G picks Grab (the "snap" branch only drew a guide line) | `src/lib/studioToolKeys.test.ts` |
| 28 | `b74a2f6` | Show+ C picks Splice (splitting at the playhead stays on S) | same file |
| 3 | `09c8dc3` | Shortcut lists drop X (crossfade) and Esc (stop all decks) | `src/lib/shortcutList.test.ts` |
| 16 | `95ae9eb` | Schedule Manager pane titled "Sweepers" (the stored id is unchanged) | `src/components/schedule/paneTitles.test.ts` |
| 17 | `7408a0f` | Spots empty state no longer says "Import jingles" | `src/lib/spotsEmptyState.test.ts` |
| 24 | `cffa02d` | HelpPanel's Schedule Manager entry describes the eight dockable panes | `src/lib/helpPanelScheduleManager.test.ts` |
| 22 | `84361d6` | Backup switch no longer claims audio syncs "both directions" | `src/lib/backupWording.test.ts` |
| 23 | `c22c94d` | ☰ menu opens Health Monitor and Announcements | `src/lib/drawerDoors.test.ts` |
| 12 (header only) | `3491f1b` | Pool grid declares the 3 columns it draws; phantom UNDERLAP header gone | `src/lib/sweeperPoolGrid.test.ts` |
| 13 | `a2edd38` | A sweeper can be renamed in the push-up (Library rename path) | `src/lib/sweeperRename.test.ts` |
| 14 | `cd7c19c` | Dead "Set up sweepers" plumbing removed (its button went in 5540bd3) | `src/lib/deadSweeperDoor.test.ts` |
| 10 | `6514e9f` | Deck / Up Next "Mark as Spot" opens the Library's dialog and creates the spots record | `src/lib/markAsSpot.test.ts` (fake `ether`) |
| 8 | `742333c` | A rename retitles the song's **pending** log rows on every station; played, missed and playing rows are kept; `schedule:changed` fires | `scripts/smoke-rename-log.js` (`npm run test:rename-log`, real SQLite) |
| 21 | `36a7b9c` | A refused profile migration writes `profile-migration-failed` to the health ledger (Live events, red) | `electron/profile-migration-ledger.test.js` |

Each commit updates the help doc for its fix wherever the wording changed.

## What Jeff verifies on screen (the runtime checks)

These are UNVERIFIED until seen in the running app. The tests stand in; they do not replace these checks.

1. **Library → right-click a song → Delete.** An in-app "Delete "…"?" dialog appears. Click **Delete** and the row
   leaves the list; search for it and it is gone. **Cancel** or **Esc** keeps it. (Audit check #1.)
2. **Pop-out Master Output → drag MASTER.** The PGM level moves. The docked Master Out's MASTER follows. Reopen
   the pop-out and MASTER opens where the engine is, not at 100%. (Audit check #2.)
3. **Rename a song that is in today's filled Program Log (not yet aired).** Its row shows the new name at once, in
   the docked and the pop-out log. A row that already aired keeps the old name. (Audit check #3.)
4. **Wild meter list and Preferences → Mic Inputs.** No "S1…S5" anywhere; a mic channel shows its board letter.
5. **Edit Spot.** Type a Cart # and an ISCI, save, then reopen. Both are still there, each with its own value.
6. **Show+ DAW.** **G** lights Grab and **C** lights Splice; press either again to go back to Smart. **S** still
   cuts the selected clip at the playhead.
7. **Deck or Up Next → right-click → Mark as Spot.** The category dialog appears. After confirming, the spot is
   listed in Spots & Promos under that category.
8. **Sweepers push-up → pick a pool → EDIT on a cut.** The rename shows in the pool and in the Library.
9. **☰ menu.** Health Monitor and Announcements are listed, and each opens its window.

Audit checks #4 (docked MONITOR follows the pop-out) and #5 (a trial lapsing while open) are not covered by any
fix here; they are still open.

## Not built — each needs Jeff's ruling

| # | Why it isn't a fix-only change | Receipts |
|---|---|---|
| 4 | The premise is out of date. `crossfadeDuration` no longer times any audio: it only paces preloads after a rotate and sizes the foreign-deck guard window. The manual crossfade was retired 2026-09-07, and the slider was removed as "a control for a thing that no longer happens". **Recommendation: close as no-change.** Optionally rename the field `preloadCadenceSec` (a pure rename). | `audiod/engine.js:1222,1253,2528`; `src/App.tsx` comment "MANUAL CROSSFADE removed (2026-09-07)" |
| 11 | AUTO-POST shipped as a UI-less opt-in on one category ("Exactly one category gets 'auto_post'"). Where its switch lives is a design call: a category-row control in the Sweepers push-up is the obvious home. | `docs/imaging-shortest-path-to-air-2026-09-08.md:27,36,85`; `electron/main.js` `wantsAutoPost` |
| 12 (LEAD-IN) | Making the engine read the pool LEAD-IN changes what airs (which wins, pool or category lead?). Until ruled, the help's known issue ("no effect on air") stays true. Options: remove the box, or define the precedence. | `SweepersPanel.tsx` comment above the LEAD-IN input; `docs/help-sweepers.md` Known issue |
| 15 | A sweeper armed/firing sense is a new Health Monitor sense: what it measures and its red and yellow thresholds need designing. | none in the tree |
| 18 | Per-row pick reasons need a surface: in the Program Log row, or in Rotation Analytics? | `RotationAnalytics.tsx:233-235` (audit) |
| 19 | AUTO ON (auto-generate) only exists in the Log-Reader Flip Canary panel. Where it belongs permanently is a placement decision tied to the flip's phase plan. | `HealthMonitor.tsx:1811-1829` (audit) |
| 20 | A door for `kill_designation` (a safety bypass) is a design decision: who may see it, and where. | memory: kill_designation is local-only, a separate writer |

## Noticed in passing (not investigated)

- There are 41 other `confirm()` / `window.confirm()` calls in `src/` across 25 files: layout delete, auto-populate,
  cart clash, bulk category, CloudBackup, Settings, schedulers and more. If the browser confirm no-ops in the
  packaged build (main.js says it does; runtime check 1 settles it), each is the same defect as item 5. The in-app
  confirm (`useConfirm`, `src/components/ConfirmDialog.tsx`) is ready to take them.

## Rulings applied (2026-09-27, second pass)

- **4** — CLOSED, no change (Jeff: "the setting times no audio").
- **11** — built: `40cad13` — AUTO-POST station switch in the Sweepers panel (`overlay_auto_post`), with its help section.
  Screen check: Sweepers → AUTO-POST ON → Fill Day → a pool sweeper ends where the next song's vocal starts.
- **12** — LEAD-IN box removed: `a119e8c`. "Pool lead-in, pool wins over category" is filed in `docs/backlog.md`.
- **15, 18, 19, 20** — proposals in `docs/held-items-proposals-2026-09-27.md`, awaiting one ruling.
- **41 other confirm() calls** — wait on Jeff's check #1. If the browser confirm is dead in the packaged app, one
  commit replaces all of them, with a grep test that no `window.confirm` remains.
