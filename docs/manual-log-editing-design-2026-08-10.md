# Manual Log Editing — non-destructive regenerate + operator-owned rows
**Date:** 2026-08-10 · **Status:** PROPOSED — nothing applied, no files changed
**Audit ref:** Fix 2 · **Constraint honoured:** no new migration (uses the landed `source` column, phase-sync-34)

---

## 1. What already exists — do not rebuild

| Piece | Where | State |
|---|---|---|
| `source` column on `generated_schedule` | `migrate-generated-schedule-source-phase-sync-34.js` | **Landed.** `NULL` = machine-generated |
| Operator rows already written | `engine.js:1279` — "a generated_schedule row at the playhead stamped `source='operator'`" | **Working** for hand-loads |
| `logreader-operator-write` health event | `engine.js:1345` → ledgered at `main.js:626` | **Working** |
| Row lifecycle | `state` ('pending'/'playing'/'played'/'missed'), `played_at` | **Working**, daemon-written |
| `seq REAL` for insert-between | phase-sync-33 | **Present but entirely unused** — see §6 |
| Full CRUD IPC | `generated_schedule:list/create/update/delete` + preload `generatedSchedule.*` | **Exists** |
| Aired history protection | `effStart = max(dayStart, next top-of-hour)` (`main.js:7110`) | **Working** — Generate never touches the past |

So this is not a from-scratch build. The ownership marker, the lifecycle, and the IPC are all in place.

## 2. The defect — one line

`_commitDayRows` (`electron/main.js:7047-7053`):

```js
db.transaction(() => {
  db.prepare("DELETE FROM generated_schedule WHERE station_id = ? AND scheduled_at >= ? AND scheduled_at < ?")
    .run(stationId, effStart, dayEnd);
  generatedScheduleBulkCreate(db, stationId, rows);
})();
```

Generate **deletes the entire future window and re-inserts**. Every operator edit in that window is destroyed, including rows the daemon itself stamped `source='operator'`. The column that says "a human owns this row" already exists and is already written — the delete simply doesn't consult it.

Aired rows are safe (the window starts at the next top-of-hour), so as-run/Traffic history is not at risk.

## 3. Design

### Layer 1 — Ownership (no schema change)

| `source` | Meaning | Generate may… |
|---|---|---|
| `NULL` | machine-generated | delete and replace freely |
| `'operator'` | a human placed, moved or kept this | **never** delete, never overwrite, never place on top of |

This is the existing contract from `engine.js:1279`, applied consistently instead of only at the playhead.

### Layer 2 — Non-destructive regenerate

The delete gains one clause. That single clause is the whole of requirement 3 ("manual edits preserved and never overwritten").

### Layer 3 — Gap-only fill

Preserving operator rows is not enough on its own: the generator would still produce a machine row for the same minute, and both would sit in the log. After the hour-walk, drop any generated row whose time window overlaps a surviving operator row. This is requirement 2 and 5 ("Regenerate only refills empty slots").

Doing it as a post-filter rather than inside the slot walk keeps `_generateDayRows` — and therefore clock law and song selection — **completely untouched**. Nothing about *which song gets picked* changes.

### Layer 4 — Editing operations

| Action | Implementation |
|---|---|
| **Delete** | `generatedSchedule.delete(uuid)` → leaves a gap → next Regenerate refills it |
| **Insert** | `generatedSchedule.create({... source:'operator'})` at the chosen time |
| **Move** | **swap `scheduled_at`** with the row at the target position; stamp both `source='operator'` |
| **Keep** | stamp `source='operator'` without other change — "pin this where it is" |

**Why swap and not ripple:** the log-reader orders by `scheduled_at` (`loggen.js:196-202`). A ripple would rewrite every following row and fight the time-anchored playhead and auto-fitter (§2.7), which exist precisely to absorb timing drift. Swap touches two rows, and the anchor logic absorbs the duration difference exactly as it already does for a long song. Ripple is named in §6 as deliberately not built.

### Layer 5 — Non-blocking rule warnings

`separation-enforce.js` exports only `buildRestMaps` and `pickEnforced` — a *picker*. Requirement 4 needs a *checker*: given a row and its neighbours, does it violate artist/title/song separation? Add `checkSeparation()` beside the existing exports, reusing the same maps so the warning and the generator agree about what a violation is.

The result is a **badge, never a block**. The operator overrides; the log records that they did.

## 4. Exact changes

### 4.1 `electron/main.js` — `_commitDayRows` (line 7047)

```diff
 function _commitDayRows(stationId, effStart, dayEnd, rows) {
   const { generatedScheduleBulkCreate } = require('./sync/handlers/generated_schedule');
   db.transaction(() => {
-    db.prepare("DELETE FROM generated_schedule WHERE station_id = ? AND scheduled_at >= ? AND scheduled_at < ?").run(stationId, effStart, dayEnd);
-    generatedScheduleBulkCreate(db, stationId, rows);
+    // OPERATOR ROWS SURVIVE REGENERATE (2026-08-10). This used to delete the whole future window and
+    // re-insert, so every manual edit was destroyed by the next Generate — while the column that says
+    // "a human owns this row" already existed and was already being written (engine.js:1279).
+    // `source IS NULL` = machine-generated and disposable; anything else was placed or pinned by an
+    // operator and is not Generate's to remove.
+    db.prepare(
+      "DELETE FROM generated_schedule WHERE station_id = ? AND scheduled_at >= ? AND scheduled_at < ? AND source IS NULL"
+    ).run(stationId, effStart, dayEnd);
+
+    // GAP-ONLY FILL. Preserving the operator's rows is not enough: the walk still produced a machine
+    // row for that minute, and inserting it would double-book the slot. Drop any generated row whose
+    // span overlaps a surviving operator row. Deliberately a POST-FILTER, so _generateDayRows — and
+    // therefore clock law and song selection — is not touched at all.
+    const kept = db.prepare(
+      "SELECT scheduled_at, duration_s FROM generated_schedule WHERE station_id = ? AND scheduled_at >= ? AND scheduled_at < ?"
+    ).all(stationId, effStart, dayEnd);
+    const free = (r) => {
+      const aStart = r.scheduled_at, aEnd = aStart + (r.duration_s || 0);
+      return !kept.some(k => {
+        const bStart = k.scheduled_at, bEnd = bStart + (k.duration_s || 0);
+        return aStart < bEnd && bStart < aEnd;          // half-open overlap
+      });
+    };
+    const fill = rows.filter(free);
+    generatedScheduleBulkCreate(db, stationId, fill);
+    if (fill.length !== rows.length) {
+      console.log(`[generate] kept ${kept.length} operator row(s); skipped ${rows.length - fill.length} generated row(s) that would have overlapped them`);
+    }
   })();
 }
```

### 4.2 `electron/sync/handlers/generated_schedule.js` — line 17

```diff
-const PATCHABLE          = ["scheduled_at","song_id","title","artist","file_key","file_path","duration_s","category_id","clock_id","generated_at","updated_at"];
+// `source` is patchable so the editor can stamp a row operator-owned (the marker _commitDayRows
+// preserves). `seq` is patchable for future fractional reordering — see the design doc §6; nothing
+// reads it yet. `state`/`played_at` stay IMMUTABLE from the renderer: they are the daemon's observed
+// record of what aired, and an editable as-run is a falsifiable affidavit.
+const PATCHABLE          = ["scheduled_at","song_id","title","artist","file_key","file_path","duration_s","category_id","clock_id","generated_at","updated_at","source","seq"];
```

### 4.3 `electron/separation-enforce.js` — add a checker

```diff
+// CHECK, not pick. The editor needs to warn about a manual placement without refusing it, and the
+// warning must mean the same thing the generator means — so it reads the SAME maps pickEnforced does.
+// Returns [] when clean, else a list of human-readable violations. NEVER throws, never blocks.
+function checkSeparation(row, cursorTs, maps, win) {
+  const out = [];
+  if (!row || !maps) return out;
+  const mins = (a, b) => Math.round(Math.abs(a - b) / 60);
+  const artistLast = row.artist_id != null ? maps.artistLastTs?.get(row.artist_id) : undefined;
+  if (artistLast != null && Math.abs(cursorTs - artistLast) < (win.artistSepMin || 0) * 60) {
+    out.push(`Same artist ${mins(cursorTs, artistLast)} min away (rule: ${win.artistSepMin} min)`);
+  }
+  const songLast = row.song_id != null ? maps.songLastTs?.get(row.song_id) : undefined;
+  if (songLast != null && Math.abs(cursorTs - songLast) < (win.songRepeatMin || 0) * 60) {
+    out.push(`Same song ${mins(cursorTs, songLast)} min away (rule: ${win.songRepeatMin} min)`);
+  }
+  const titleKey = (row.title || "").trim().toLowerCase();
+  const titleLast = titleKey ? maps.titleLastTs?.get(titleKey) : undefined;
+  if (titleLast != null && Math.abs(cursorTs - titleLast) < (win.titleSepMin || 0) * 60) {
+    out.push(`Same title ${mins(cursorTs, titleLast)} min away (rule: ${win.titleSepMin} min)`);
+  }
+  return out;
+}
+
-module.exports = { buildRestMaps, pickEnforced };
+module.exports = { buildRestMaps, pickEnforced, checkSeparation };
```

Plus a thin IPC in `main.js` so the renderer can ask:

```js
ipcMain.handle('schedule:checkRow', (_, stationId, row, atTs) => {
  try {
    const { buildRestMaps, checkSeparation } = require('./separation-enforce');
    const ctx = _buildScheduleCtx(stationId);
    return { ok: true, warnings: checkSeparation(row, atTs, buildRestMaps(db, stationId), ctx) };
  } catch (e) { return { ok: false, warnings: [], error: e.message }; }   // a failed check never blocks an edit
});
```

### 4.4 `src/components/BroadcastCalendar.tsx` — the editor

`dayRows` currently selects `scheduled_at, title, artist, duration_s, category_id, song_id` (line 214) — no row identity, so nothing can be addressed for mutation. It needs `id`, `uuid`, `source`, `state`.

```diff
-  const [dayRows, setDayRows] = useState<{ scheduled_at: number; title: string; artist: string; duration_s: number; category_id: number | null; song_id: number | null }[]>([]);
+  const [dayRows, setDayRows] = useState<{ id: number; uuid: string; scheduled_at: number; title: string; artist: string; duration_s: number; category_id: number | null; song_id: number | null; source: string | null; state: string | null }[]>([]);
```

Then per row, in the existing day-detail list:
- `draggable` + `onDragStart`/`onDrop` → swap `scheduled_at` between the two rows via `generatedSchedule.update`, stamping both `source:'operator'`
- a **✕ delete** control → `generatedSchedule.delete(uuid)` → gap
- a **📌 pin** control → stamp `source:'operator'` in place
- an operator badge on any row with `source !== null`, so "Generate won't touch this" is visible rather than remembered
- rows with `state='played'` render read-only — the past is a record, not a plan
- after a move, call `schedule:checkRow` and show any warnings as an amber inline note

## 5. Test plan

**A. The headline case (requirement 3)**
1. Calendar → tomorrow → Generate. Note the 3rd item.
2. Drag it two positions later. It shows the operator badge.
3. Press **Generate** again on the same day.
4. **Pass:** it is still where you put it. **Fail (today's behaviour):** it returns to its generated position.

**B. Gap-only refill (requirements 2 + 5)**
1. Delete two items → two gaps.
2. Generate.
3. **Pass:** the gaps fill with new songs; every other row — machine rows included — keeps its time; pinned rows unmoved.

**C. Warning, not block (requirement 4)**
1. Move a track next to another by the same artist, inside the separation window.
2. **Pass:** amber warning naming the artist and the gap, and **the move still applies**.

**D. Clock law untouched**
1. After B, check every filled gap's `category_id` against its clock slot's category.
2. **Pass:** identical. Gap-fill is a post-filter; it cannot pick off-clock.
   Re-run `scripts/prove-of-regen-fix.js` — the cat-1 count must stay 0.

**E. The past is immutable**
1. Generate a day already partly aired.
2. **Pass:** rows with `state='played'` are read-only in the UI and untouched in the DB; Traffic/As-Run figures for that day are unchanged before and after.

**F. Multi-station**
1. Pin a row on station 2, Generate station 3.
2. **Pass:** station 2's pin is untouched (the delete is `station_id`-scoped and stays so).

**G. Gates**
`node --check` main.js + separation-enforce.js · `npx tsc --noEmit` (2 baseline only) · `npm run check:audio-isolation` · the audiod smokes.

## 6. Deliberately NOT building

- **Ripple reorder.** Swap only. A ripple rewrites every subsequent row and fights the auto-fitter. Revisit after the flip's anchor behaviour is settled.
- **Wiring `seq`.** It stays unused. Using it for ordering would mean changing the log-reader's `ORDER BY scheduled_at` — a playout change, which this task explicitly forbids. It is added to `PATCHABLE` only so a future fractional-insert design needs no further plumbing.
- **A new migration.** None. `source` and `seq` already exist.
- **Editing `state`/`played_at` from the renderer.** Left immutable on purpose: they are the daemon's observed record of what aired and feed the Traffic affidavit. An editable as-run is a falsifiable one.
- **A separate log-editor panel.** The editor is the calendar's existing day detail. `LogViewer.tsx` (named in the brief) does not exist, and a new surface would violate doors-before-rooms.

## 7. Risk

The real risk is **operator rows accumulating into a log Generate can no longer heal**: pin enough rows and a day becomes uneditable-by-machine, with no obvious cause. Mitigation shipped with v1 rather than after: the day header shows *"N operator rows preserved"*, and each carries a visible badge with one-click release back to machine ownership (`source = NULL`).

Second risk: `source` is currently written by the daemon for hand-loads (`engine.js:1279`). Those rows become permanent under this change, where today they are transient. That is arguably correct — a jock's hand-load *is* an operator decision — but it is a **behaviour change to an existing path** and should be confirmed, not assumed. If unwanted, use a distinct marker (`'operator-edit'`) for editor rows and preserve only that.

## 8. Compliance

- **No new migration** — as instructed; uses landed `source`/`seq`.
- **Clock law untouched** — `_generateDayRows` is not modified; gap-fill is a post-filter. Selection, separation, dayparting, LRP all unchanged.
- **"Do not change what airs"** — the log-reader is not touched; ordering stays `scheduled_at`; no selection logic changes. What changes is only which rows Generate is permitted to destroy.
- **Doors before rooms** — editing lives in the calendar's existing day detail; no new panel. Ships with a help entry (`docs/help-log-editing.md`) before it is called done.
- **Honest state** — operator ownership is visible on the row, not implicit; warnings are shown and overridable; the past is read-only.
