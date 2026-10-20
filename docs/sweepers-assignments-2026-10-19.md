# Sweepers: the dropdowns decide (2026-10-19)

Branch `release/1019`. Findings read-only from OVEVENTS' database (profile ETH-STN-BAA8-E056-6FC8, station 2 halloVeen); fixes and tests on fixtures.

## Jeff's report (verbatim)

> Sweepers: Ether ignores the category assignment dropdowns in Sweepers. It still places sweepers on everything, and something took them off HV, Kids and Disney. No temporary fixes:
> 1. Find where sweeper placement decides which categories get sweepers (file:line) and why it doesn't read the dropdown assignments.
> 2. Find whatever removed sweepers from HV, Kids and Disney (code, data or a setting, which commit) and remove that special case. Nothing in code decides which categories get sweepers.
> 3. The dropdowns are the only thing that decides: Ether places sweepers exactly per the assignments the user sets, and every dropdown is live and saved.
> 4. Test on the test stations with assignments on and off per category.
> Include it in the one build.

## 1. Where placement decides, and why the dropdowns were "ignored"

`electron/main.js` `_placeJingles` (installed build b02a58b lineage; on this branch before the fix: the fallback read at the top of the function, and the `if (!kind) { if (fallbackCatId) { kind = 'pool'; poolId = fallbackCatId; … } else continue; }` branch in the per-song loop). It **does** read each category's dropdown (`categories.overlay_kind / overlay_category_id / overlay_song_id / overlay_active_hours`). Two things made the dropdowns not decide:

1. **The station fallback pool overrode every "none".** halloVeen has `station_config_kv overlay_fallback_category_id = 3` (the Halloween pool, set 2026-09-15). A category whose dropdown said **— none (clean segue) —** was given the fallback pool instead. On OVEVENTS' log for the last day, sweepers placed on seams of categories set to none: **HV 1,355, Kids 618, Disney 500** (all from pool 3, Halloween). So "it still places sweepers on everything".
2. **A dropdown change never reached the log already built.** Sweepers are written onto the log when it is generated; changing a dropdown changed nothing on air until the next Fill Day. The panel also swallowed a refused save (`catch {}`, the handler's `{ ok:false, error }` was never read).

## 2. What took HV, Kids and Disney off

**Data, written through the Sweepers dropdown on this machine (OVEVENTS, client 8e8f6181), not code.** From the sync `mutations` record:

| When (UTC) | Machine | Category | Change |
|---|---|---|---|
| 2026-10-19 17:38:01 | OVEVENTS | HV | Halloween pool → **none** |
| 2026-10-19 17:38:07 | OVEVENTS | MOVIE SDTK | none → Halloween |
| 2026-10-19 17:38:13 | OVEVENTS | Movie&tv | none → Halloween |
| 2026-10-19 17:38:19 | OVEVENTS | Kids | Halloween pool → **none** |

(10:38 AM PDT, six seconds apart, each a separate `categories.updateById` from the panel's dropdown — the only writer of these columns in the app; the web dashboard never writes them.) **Disney was never assigned** on either machine: OV created it unassigned on 2026-10-18 03:46 UTC and no later change exists. Whether the 10:38 writes were a person's choice or a mis-click cannot be told from the record — they are the panel's own writes. No code special-cases any category (searched: no category name/code appears in placement, the engine or the reader).

Found while tracing it — **a defect of today's own UUID-reference fix (c2c9409, not installed anywhere):** `electron/sync/synced-tables.js` declared `categories.overlay_category_id` as a reference to **categories**; it is a sweeper **pool** (`jingle_categories`). With that build, an assignment would have travelled as a music category's uuid and landed on the wrong pool or none on the other machine. Fixed; the UUID-refs gate now covers it (SW.2 fails on the old declaration, passes on the fix).

## 3. The fix

- **`_placeJingles`: none means none.** The station fallback is gone from placement; a category whose dropdown is none gets no sweeper. The stored `overlay_fallback_category_id` values are left in the database (no live-data write) and read by nothing.
- **Live:** new `_replaceSweepers(stationId)` + IPC `sweepers:replace` (`window.ether.schedule.replaceSweepers`). After every change in the panel (OVERLAY, LEAD, ACTIVE HOURS, AUTO-POST) the station's pending machine-placed sweepers from now on are removed and placed again by the assignments as they now stand. Played/playing/didn't-play rows and hand-placed rows are never touched. Health event `sweepers-replaced`. The resulting log rows sync like any Generate.
- **Saved, honestly:** the panel checks every write; a refused write shows in red with the reason and the dropdown re-reads what is stored. A status line says what each change did ("KIDS: sweeper saved. Log ahead updated: N sweepers placed").
- **Panel:** the "Fallback for unassigned categories" control is removed; the none option reads **— none (no sweeper) —**.
- **Sense:** `electron/sweeper-sense.js` no longer counts the fallback as an assignment; Imaging's empty-state text updated.
- **Sync:** `overlay_category_id` → `jingle_categories`.

### What changes on air after install — needs Jeff

- **halloVeen:** HV, Kids and Disney are set to none in the data, so with this build they get **no sweepers** until their dropdowns are set. Adult, MOVIE SDTK, Movie&tv → Halloween and Upbeat → Magic keep theirs.
- **Christmas in Jully (station 4)** has a fallback (pool 4, Summer Christmas): every category of it that is set to none loses its sweepers (552 a day were placed). Set those dropdowns if the station should keep them.
- The pending log ahead keeps its old sweepers until a dropdown is changed or the log is regenerated (install alone does not rewrite the log).

### Named and not done

- A sweeper already armed for the very next seam (~90 s) may still play once after a change.
- The placement tally behind Health's skip counts adds up across regenerates and re-places (it already did before this change: 5,637 "placed" on 10-19).

## 4. Tests (fixtures only, nothing on the air machine)

- **New `npm run test:sweeper-assignments`** (`scripts/smoke-sweeper-assignments.js`): a test station on the real schema — HV, KIDS, DISNEY, ADULT, UPBEAT; pools Halloween and Magic; a specific sweeper; the old fallback still stored (a real pool uuid). The product's own `_placeJingles` / `_replaceSweepers` and the panel's category writer. **22 passed, 0 failed**: saved values = set values; none → no sweeper (fallback present); pool / specific / active-hours exact; the old fallback sweeper removed; hand-placed and aired sweepers kept; switched the other way round (HV off, KIDS and DISNEY on) → exact, nothing doubled; every category none → nothing anywhere, in Generate's placement too; panel has no fallback, checks writes, every control re-places.
- **`npm run test:uuid-refs`** 30/30 incl. new SW.0–SW.3: pools numbered differently on the two machines; an assignment made on each side lands on the same pool; none travels.
- tsc 0 · vitest 118 / 1028 · test:sync 55/55 · test:sweeper-sense 9/9.

Runtime: **UNVERIFIED** on a running app — the check is opening SWEEPERS on a test station, changing a dropdown, and seeing the status line and Up Next's SWP rows follow it.

## Architecture Compliance

- Imaging home = the SWEEPERS push-up (CLAUDE.md "Imaging & production surfaces"): the controls stay there; no new surface.
- ONE scheduler: placement stays in Generate's `_placeJingles`; the re-place calls the same function — no second placement path. The daemon still only reads placements.
- `feedback_no_hidden_defaults` / Jeff's "nothing in code decides": the fallback branch was a second decider; removed.
- References by UUID (docs/sync-uuid-references-2026-10-19.md): pool references now declared against the right table.
- Live data untouched: no write to any installed database; the stored fallback values remain for older builds.

## Help

`docs/help-sweepers.md` (none means none, live changes, no fallback, troubleshooting), `docs/help-imaging.md`.
