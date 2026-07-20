# HalloVeen library exclusion — data-first diagnosis (read-only) 2026-07-20

**Symptom:** half the HalloVeen library never airs (same ~60 songs repeat, violating separation) and
the A/B/C deck buttons silently refuse those songs — yet the cue editor opens and plays their audio
fine. **Method:** partition the library by ACTUAL airplay (`play_log`, 7d), then mechanically diff the
two halves' attributes to find the gate by data. Tools: `scripts/diag-library-spins.js`,
`scripts/diag-library-exclusion.js` (both read-only). **No changes. STOP for GO.**

## (1) Spin partition — the two halves
Station 2 (halloVeen) active library = **172 songs**. Spins over the last 7 days:
- **SPUN (≥1 spin): 59 songs**, 1042 total spins, **avg 17.7 spins/7d** — heavy repeaters: *Ghostbusters
  ×41, Popular ×35, Hauntleyween ×34, Hungry Like the Wolf ×34, Juanita ×34.*
- **ZERO-SPIN: 113 songs (66% of the library never aired).**

A 59-song pool is cycling where 172 should be — that is exactly the "same songs twice/hour, separation
violated" report.

## (2) Mechanical attribute diff — the gate, found by data
Share of each set carrying each attribute:

| attribute | SPUN | ZERO-SPIN | partitions? |
|---|---|---|---|
| **local file EXISTS on disk** | **100%** | **1%** | **← CLEAN GATE** |
| has `file_key` (R2 copy) | 100% | 100% | no |
| `duration_ms` present | 100% | 100% | no |
| `content_class = MUSIC` | 100% | 100% | no |
| rotation active (`!= 'inactive'`) | 100% | 100% | no |
| in on-format category | 100% | 100% | no |
| import batch (`created_at`) | **2026-07-06** | **2026-07-06** | no (same day) |

**Every candidate predicate is identical across the two halves except one: whether the local audio
file is on disk.** Station-library link, category membership, `file_key`, duration, `content_class`,
`deleted_at`, and even the import date are the SAME for both. The zero-spin half is **not** a distinct
import, a scoping miss, a category problem, or a metadata defect — it is the **same 2026-07-06 import,
partially materialized**: 59 of 172 files landed locally, 113 did not (they exist only in R2 via
`file_key`).

## (3) Verify — 3 zero-spin songs through each door
E.g. **"Addams Groove" (id 217)**, "Agatha's Theme" (218), "Anthem" (219) — all identical shape:
```
file_path = C:\Users\jensj\Music\ether music library\Addams Groove_spotdown.org.mp3
local-exists = false   file_key = YES   duration = 239099   class = MUSIC   rotation = active   cat = 7 (in-format)
Generate / live-pick (baseConditions):  SELECT = TRUE   ← file_path IS NOT NULL passes even though the file is ABSENT
A/B/C deck-load (_fileOk → fs.existsSync): FALSE  → loadToDeck returns FALSE = silent skip
Cue editor (audio:resolve-local-path):  local-first → R2-by-file_key → RESOLVES → plays
```
So one gate, opening differently at each door:
- **Generate + live-pick (`audiod/loggen.js baseConditions`, line 40):** the eligibility filter only
  requires `s.file_path IS NOT NULL` — a **set-but-absent** path passes, so these songs ARE selected
  and placed/queued.
- **Deck-load (`audiod/engine.js _fileOk`, line 625 → `loadToDeck` line 640):** `fs.existsSync(fp)` on
  the absent path returns false → `loadToDeck` returns **false** → the queue advance / A/B/C button
  **skips** it. Net: selected then dropped at load → **0 spins**; the 59 resolvable songs re-cycle.
- **Cue editor (`src/components/TrackEditor.tsx` line 470):** calls `audio:resolve-local-path`
  (local-first → **R2-by-`file_key`**) → gets a loadable path → plays. It also surfaces a **loud**
  error on failure (`setLoadError`, line 472).

### Where the A/B/C refusal dies SILENTLY
`src/App.tsx loadDeck` (line 1816): `if (!s.file_path) return;` then passes the **raw** `s.file_path`
to `deckCue`/`loadToDeck` — it does **not** call `audio:resolve-local-path` (no R2 resolution) and
**never checks the load result**. The daemon `loadToDeck` returns `false` with no event to the
renderer, so nothing is shown. Two gaps: (a) no R2 resolution on the deck path, (b) no surfaced reason.

## (4) Fix proposal
1. **Root fix — resolve via R2 on the playout/deck path.** Make `loadDeck` (and the daemon's
   queue-fill/`loadToDeck`) resolve the file the SAME way the cue editor does
   (`audio:resolve-local-path` / `r2:fetch-track` by `file_key`) before loading, so R2-only library
   songs air on the decks and in rotation — not just in the cue editor. This makes the full 172-song
   library usable and ends the 59-song repeat.
2. **Immediate relief — backfill/materialize.** One-time: download the 113 R2 files by `file_key` into
   `C:\Users\jensj\Music\ether music library\` so `file_path` resolves locally. (The "relink the gate.")
3. **Loud refusals (honest-UI).** `loadDeck` must check the result and show a visible reason
   ("not on this machine — fetching from cloud…" / "unavailable"), mirroring the cue editor's
   `setLoadError`. The daemon should emit a health event when it skips an unresolvable row (e.g.
   `[LOAD] skipped "<title>" — file not local`) so the operator sees "N songs skipped," never silence.
4. **Rotation honesty.** Prefer the R2-resolve fix so the pool is full; if a song is genuinely
   unresolvable, exclude it from SELECTION explicitly AND health-event the shrunken pool, so separation
   is never silently violated by a phantom pool.

### Station-library scoping — NOT implicated
The data clears scoping: the zero-spin songs are correctly linked to HalloVeen (in-format category =
100%, `category_id = 7`). Scoping is working; the gate is file **materialization/resolution**,
independent of scoping. **No station-library scoping acceptance test is implicated** — this is a
local-file-vs-R2 resolution gap, not a scoping regression.

## Verdict
One gate, found by data: **113/172 HalloVeen songs have no local file (only an R2 `file_key`).**
Generate/live-pick select them (the `file_path IS NOT NULL` check passes an absent path); the deck /
daemon `_fileOk` silently skips them at load; only the cue editor — which R2-resolves — plays them.
Fix = resolve-via-R2 on the deck/rotation path (+ materialize backfill) + loud refusals. Read-only; no
source or data changed.

*Tools added (read-only): `scripts/diag-library-spins.js`, `scripts/diag-library-exclusion.js`.*
