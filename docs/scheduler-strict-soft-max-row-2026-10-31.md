# STRICT / SOFT and max-in-a-row in Generate (dead-controls item 36) — 2026-10-31

Jeff's rulings (2026-10-30): **5b** — SOFT rules are relaxed first; STRICT is broken only as a last resort, marked on the
log and in Health. **6c** — when max-in-a-row is hit: STRICT takes the slot from the next different category; SOFT keeps
the category and marks the rule broken; a STRICT rule that still can't be met follows 5b.

## What changed
- `audiod/scheduler-core.js`: `stationRules` reads `is_hard` per rule and `max_same_category` (`maxRow {n, hard}`);
  `breach(..., strictOnly)` / `pick(..., {strictOnly})` skip SOFT rules; `overMaxRow(run, cat, rules)`.
- `electron/generate-core.js` `_pickMusic`: every rule (slot, fallback) → SOFT relaxed (slot, fallback; row
  `pick_reason.soft`) → least recently played (STRICT broken; row + `ctx.relaxed` → Health). `placeMusic`: max-in-a-row
  per 6c using the clock's next music categories (`_catsAfter`, wrapping); row `pick_reason.maxRow`.
- `audiod/loggen.js` air check: STRICT rules only (a SOFT-relaxed row would otherwise be refused on air).
- Settings → Music Scheduling Rules: legend says what STRICT/SOFT really do; the retired gender rule no longer shows
  (and deleted rules are filtered). Help: `docs/help-music-scheduling-rules.md`.

## Receipts
- Unit: `audiod/scheduler-core.test.js` (21), `electron/generate-rules.test.js` (3).
- Scheduler gate on fixtures (2 days): everything as before except **T15 17 → 18** — T15 counts settings the pick reads
  while no settings registry exists; the pick now reads `max_same_category` / `is_hard` as ruled. **Ratchet NOT updated —
  Jeff's call.** T18 (fixture station 2 breaks off ±30 s) was already failing.
- Gate on a read-only copy of this computer's database, HalloVeen (max 3, SOFT), 1 day: T1 PASS (0 separation
  violations); 26 rows kept their category and are marked `maxRow: {broken, max 3, strict: false, inRow 4}`; 58 least
  recently played. T2 "not the longest-waiting": 141 with the change, **142 without it** (stash, same run) — pre-existing.

## Heads-up for Jeff
- Rules that were saved but never read now take effect on the next Generate: on this computer station 1 has
  **max 3 in a row = STRICT, active** (slots will move to the next category); stations 2 and 4 have it SOFT (marked
  only); station 3 has song separation SOFT.
- Max-in-a-row counts songs only (spots don't end a run) and starts at 0 each Generate run.
- The retired `max_same_gender` rows are still in the table, active, on stations 2 and 4 (the 2026-07-24 tombstone
  migration didn't catch them); nothing reads them. Not changed.
