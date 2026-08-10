# Phase 3 — wiring `scheduler-core` into the live generator
**Date:** 2026-08-10 · **Status:** PROPOSED — nothing applied. Three corrections to the brief below; one item should NOT be built.

---

## 1. Correction A — item 4 (widen `getFormatCategoryIds`) must NOT be built

The design doc called this the CRITICAL risk (R1) and "non-negotiable." **That analysis is now obsolete, and acting on it would re-open a fixed bug.**

R1 was written before `scheduler-core` existed. The engine as built is **bounded to the hour's own clock categories**:

```js
const clockCategoryIds = [...new Set(musicSlots.map(s => s.categoryId))];   // scheduler-core.js
```
and goal mode ranks only across that set — unit-tested as *"never selects a category the clock's hour does not use."*

The guard it would supposedly trip over:

```js
// loggen.js getFormatCategoryIds — DISTINCT music-slot categories of the ACTIVE SHOW'S CLOCK
SELECT DISTINCT category_id FROM clock_slots
 WHERE clock_id = ? AND slot_type='music' AND category_id IS NOT NULL AND deleted_at IS NULL AND station_id = ?
```

Both sets are derived from **the same clock**. A goal-mode row's category is therefore always already on-format, and the daemon can never drop it. **R1 does not exist for this engine.** The bound I built is the mitigation, and a stronger one than widening.

**Widening would be actively harmful.** That guard is the Christmas-leak fix: an off-format category in a *dormant* clock leaked in via auto-fill, and the fix was to restrict the universe to active-show clocks. Widening to "all station categories" re-opens exactly that hole — and it is the same class of defect as v4.4.76, where off-clock rows were generated and silently dropped.

**Consequence:** `audiod/loggen.js` needs **no change in Phase 3**, which also satisfies the R3 constraint (the daemon must not become goal-aware) for free — the daemon does not learn that scheduler modes exist.

---

## 2. Correction B — item 2's storage is wrong three ways

The brief: *add a `scheduler_mode` column to `stations` via `electron/db/schema.js`.*

1. **`electron/db/schema.js` does not exist.** Schema lives in `scripts/verify-main-schema.js` plus `alterSafe(...)` calls in `main.js`.
2. **`stations` is a SYNCED table** (`electron/sync/synced-tables.js:901`). A column there propagates across installs — but scheduler mode is a *local rollout* decision. Syncing it would flip a station's scheduler on another machine as a side effect of sync.
3. **The approved design already specified the alternative** (§3.6): per-station KV, mirroring `enforce_separation` (`main.js:6573`).

**The precedent is exact and already in the product.** The Log-Reader Flip canary is a per-station rollout flag stored in `station_config_kv` and written through a dedicated local-only IPC:

```js
// src/components/HealthMonitor.tsx:340,370
invoke("station_config_kv:get-value", sid, "log_reader_flip")
invoke("station_config_kv:set-local", sid, "log_reader_flip", "1")   // LOCAL-ONLY, never syncs
```

**Use `station_config_kv` key `scheduler_mode`** (`clock` | `goal`), read exactly like `enforce_separation`. No migration, no sync surface, no new column — and the UI slot sits beside the existing canary toggle.

---

## 3. Correction C — items 1 and 6 are mutually exclusive

- **Item 1:** replace the live selection loop with `scheduler-core`.
- **Item 6:** run both for a week and diff; only switch when the diff is zero.

**You cannot diff against code you have deleted.** Parity must be proven *before* replacement, which means both implementations have to run at once, with the existing loop still authoritative.

The engine also *cannot* be parity-identical by construction — the live generator draws candidates `ORDER BY RANDOM()`, so identical output requires identical candidate order. That is exactly why it must be measured rather than assumed.

### Corrected sequencing

| Step | What | Airs differently? |
|---|---|---|
| **3a** | `scheduler-core` runs **beside** the live loop in clock mode; every decision compared and recorded. Live loop still authoritative. | **No** — pure addition |
| **3b** | After a clean week, flip authority to `scheduler-core` and delete the old loop. | No (proven identical) |
| **3c** | Goal mode in shadow, per-station flag, compared against clock mode. | **No** — log only |
| **3d** | Per-station activation. | Yes — explicit, per station |

The brief's item 6 is 3a, item 1 is 3b, item 3 is 3c. **This document specifies 3a only.** 3b and 3c are gated on its results and should not be written yet.

---

## 4. Phase 3a — exact changes

### 4.1 `audiod/scheduler-core.js` — expose slot-level selection

`planHour` is the wrong entry for a shadow: the live loop interleaves spot breaks whose real durations come from `_pickSpot`, so a parallel whole-hour plan would drift on *timing* and report false divergence. Comparing at the **slot** level isolates the selection decision, which is what parity actually means.

```diff
 module.exports = {
   planHour,
   createState,
+  // Slot-level entry for the Phase 3a differential. Deliberately does NOT commit — the caller owns
+  // state — so a shadow can be handed the LIVE generator's own maps and read them without touching
+  // them. That is what makes running it beside the real loop provably side-effect free.
+  pickForCategory,
   // exported for targeted tests — all pure
   rankCategories,
   lrpFallback,
   violationOf,
   daypartAllows,
 };
```

### 4.2 `electron/main.js` — `_buildScheduleCtx`: load the shadow config

```diff
   const { buildRestMaps } = require('./separation-enforce');
   const restMaps = enforceSeparation ? buildRestMaps(db, stationId) : { restByFile: new Map(), restByArtist: new Map(), restByTitle: new Map() };
+
+  // ── PHASE 3a — scheduler-core differential (2026-08-10) ────────────────────────────────────────
+  // The pure engine decides in parallel with the live loop; the live loop still airs. Default ON:
+  // a shadow that defaults off gathers nothing, and the week-long parity clock never starts. It only
+  // reads, and every call is wrapped, so the worst case is a recorded error rather than a bad log.
+  // Kill switch: station_config_kv 'scheduler_core_shadow' = '0'.
+  let coreShadow = true;
+  try {
+    const t = db.prepare("SELECT value FROM station_config_kv WHERE key='scheduler_core_shadow' AND station_id=? AND deleted_at IS NULL").get(stationId);
+    if (t && (t.value === '0' || t.value === 'false')) coreShadow = false;
+  } catch {}
+  // enforce_separation routes the live pick through separation-enforce.pickEnforced, which the core
+  // does not implement. Comparing against it would manufacture divergence that says nothing about
+  // the core. Skip, and SAY the station was skipped rather than reporting a silent 100% agreement.
+  const coreComparable = !enforceSeparation;
+  const core = coreShadow ? require('../audiod/scheduler-core.js') : null;
```

and in the returned ctx object:

```diff
   return {
     activeStationId: stationId, artistSepMin, songRepeatMin, titleSepMin, stmtSpotsByCategory, stmtClockBreaks,
     enforceSeparation, restByFile: restMaps.restByFile, restByArtist: restMaps.restByArtist, restByTitle: restMaps.restByTitle,
+    coreShadow, coreComparable, core,
+    coreDiff: { agree: 0, differ: 0, skipped: 0, errors: 0, samples: [] },
```

### 4.3 `electron/main.js` — the hour loop: build a read-only state view

Immediately after the per-hour sets are created (`:6777`):

```diff
     const usedSongIds = new Set(), usedArtistIds = new Set(), usedTitles = new Set();
+    // A VIEW over the live loop's own maps — same object references, not copies, so the core sees
+    // exactly the state the live pick sees. pickForCategory never writes, so this is read-only in
+    // practice as well as intent. spinsByCategory is core-only and unused in clock mode.
+    const coreStateView = ctx.core ? {
+      usedSongIds, usedArtistIds, usedTitles,
+      songLastTs, artistLastTs, titleLastTs,
+      spinsByCategory: new Map(),
+    } : null;
```

### 4.4 `electron/main.js` — the differential, in the music branch

Inserted after the live `picked` is resolved (`:6981`) and **before** the commit block, so both see identical state:

```diff
       }
+      // ── PHASE 3a DIFFERENTIAL — the core decides too; only the live loop's answer is used. ──────
+      if (ctx.core && coreStateView) {
+        if (!ctx.coreComparable) { ctx.coreDiff.skipped++; }
+        else {
+          try {
+            const r = ctx.core.pickForCategory(
+              slot.category_id, candidates, currentTs, coreStateView,
+              { songRepeatMin, artistSepMin, titleSepMin }, h);
+            const liveId = picked ? picked.id : null;
+            const coreId = r.song ? r.song.id : null;
+            if (liveId === coreId) ctx.coreDiff.agree++;
+            else {
+              ctx.coreDiff.differ++;
+              if (ctx.coreDiff.samples.length < 25) {
+                ctx.coreDiff.samples.push({ hour: h, ts: currentTs, categoryId: slot.category_id,
+                                            live: liveId, core: coreId, poolSize: candidates.length,
+                                            coreRelaxed: r.relaxed });
+              }
+            }
+          } catch (e) { ctx.coreDiff.errors++; ctx.coreDiff.lastError = e.message; }
+        }
+      }
       if (picked) {
```

### 4.5 `electron/main.js` — report the result where the operator can see it

In `schedule:generateDay` / `generateDays`, beside the existing `noteGenerate` call:

```diff
     try { _libHealth && _libHealth.noteGenerate(activeStationId, { relaxed: ctx.relaxed, emptyCatIds: [...ctx.diag.emptyCats], breakDrift: ctx.breakDrift }); } catch {}
+    // Parity is a FACT to be measured, never an assumption. Same honest-ledger path the flip's own
+    // shadow used (main.js:626 → health-events.jsonl), so a week of runs is queryable afterwards.
+    try {
+      const d = ctx.coreDiff;
+      if (d && (d.agree || d.differ || d.skipped || d.errors)) {
+        const total = d.agree + d.differ;
+        console.log(`[core-shadow s${activeStationId}] agree=${d.agree} differ=${d.differ}` +
+                    `${total ? ` (${Math.round((d.agree / total) * 100)}%)` : ""}` +
+                    ` skipped=${d.skipped} errors=${d.errors}`);
+        require('fs').appendFileSync(
+          path.join(app.getPath('userData'), 'scheduler-core-shadow.jsonl'),
+          JSON.stringify({ t: new Date().toISOString(), stationId: activeStationId, ...d }) + "\n");
+      }
+    } catch { /* a lost ledger line is cosmetic */ }
```

### 4.6 What Phase 3a does NOT touch

- **`audiod/loggen.js`** — no change (Correction A). The daemon stays mode-blind.
- **`stations` schema / sync** — no change (Correction B).
- **Selection, clock law, separation, dayparting, spots, jingles** — untouched. The live loop is unmodified except for the inserted read-only block.
- **No UI.** 3a needs none; the mode toggle belongs to 3c, beside the existing flip canary.

---

## 5. Test plan

**A. Purity of the shadow (must pass before anything else)**
1. Generate a day with the shadow ON, export `generated_schedule` for the range.
2. Set `scheduler_core_shadow = '0'`, regenerate the same day, export again.
3. **Pass:** the two exports are byte-identical. This proves the shadow cannot change what airs.

**B. The differential itself**
4. Generate a week. Read `scheduler-core-shadow.jsonl`.
5. **Expect divergence, and read the samples rather than the headline.** `ORDER BY RANDOM()` means the live loop's *candidate order* varies per query; where several songs are equally compliant, live and core will legitimately choose differently. A non-zero `differ` is not automatically a bug.
6. **The real acceptance test:** for each sample, does the core's pick satisfy every constraint the live pick satisfied? Divergence on a tie is fine. Divergence where the core picked something the live loop had *vetoed* is a defect.

**C. Enforce-separation stations**
7. On a station with `enforce_separation = 1`, confirm `skipped` climbs and `agree`/`differ` stay 0 — the shadow declines to compare rather than pretending.

**D. Failure isolation**
8. Temporarily make the core throw. **Pass:** generation completes normally, `errors` increments, the log is unaffected.

**E. Regression**
9. `npx tsc --noEmit` (2 baseline) · `node --check main.js` · `npx vitest run audiod/scheduler-core.test.js` (25) · `scripts/prove-of-regen-fix.js` — cat-1 must stay 0 · the audiod smokes.

**Exit criterion for 3b:** one week, all stations, `errors = 0`, and every sampled divergence explained as a tie. Not "diff is zero" — that is unreachable while candidates arrive in random order, and holding out for it would stall the phase forever.

---

## 6. Risk

The shadow runs inside the generator, which froze main once already (2026-08-03, chunked-generate fix). It adds one function call per music slot over an already-materialised candidate array — no query, no allocation beyond a small result object. It is wrapped, and killable per station without a rebuild. If the `[core-shadow]` line ever shows generation time climbing, set `scheduler_core_shadow = '0'` and it is gone.

## 7. Compliance

- **R3 honoured** — the daemon is not touched and never learns that modes exist.
- **Clock law untouched** — `_generateDayRows`'s selection is unmodified in 3a.
- **"Nothing airs differently"** — proven by test A, not asserted.
- **Honest state** — divergence, skips and errors are counted and ledgered; an incomparable station is reported as skipped rather than as agreement.
- **Conflict surfaced** — item 4 identified as harmful and not built; item 2's storage corrected to the approved design; items 1/6 resequenced.
