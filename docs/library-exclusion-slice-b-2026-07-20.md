# Library exclusion — Slice B (loud refusals) build report, 2026-07-20 (v4.4.72)

Context: `docs/library-exclusion-diagnosis-2026-07-20.md` + `docs/library-exclusion-fix-2026-07-20.md`
(Slice A shipped 4.4.71: R2 prefetch + senses; the 165-file backfill made tonight's air whole). Slice B
is the **loud-refusals** half — a deck load / rotation skip must never be silent again.

## Blast-radius audit — this touches the load path all three stations air through
- **`audiod/engine.js refillIfNeeded`** — the fill filter changed from local-only (`_playable`) to
  file_key-aware. **Queue content is IDENTICAL to before** (only local-playable rows enter); the change
  is purely *why* a dropped row is dropped: R2-only (fileKey present) = prefetch-lag → deferred quietly;
  no-local-**and**-no-fileKey = **dead** → dropped LOUDLY (a `loadskip` health event). Zero change to
  what airs. Lowest risk.
- **4 load-time skip points** (`top-of-hour`, `resume-playout`, `handleLoadNext`, `preload`) — each
  now also emits a structured `loadskip` beside its existing `error`. Additive. Low risk.
- **`electron/main.js`** — routes `m.event === "loadskip"` → `_libHealth.noteSkip` (Slice-A sense +
  `health-events.jsonl`). Additive. (Also fixed: `_libHealth` was `const`-scoped inside its init `try`,
  invisible to the event handler — hoisted to the enclosing scope.)
- **`audiod/loggen.js`** — items now carry `fileKey` (SELECT + `toItem` + `COALESCE(gs.file_key,
  s.file_key)` in the two generated_schedule reads). Additive field. Verified read-only:
  `fillQueue` returns `fileKey` on every item for all 3 stations.
- **`src/App.tsx loadDeck` (A/B/C buttons)** — now resolves via `audio:resolve-local-path` (local→R2)
  like the cue editor, CHECKS the result, and surfaces a visible reason. Behaviour change, but the
  **manual** load path only — NOT the auto-rotation air chain. Moderate, and it is the fix.

**Net:** the automatic playout path (fill/advance) has **no change to what airs** — only added
observability. The only behavioural change is the manual A/B/C button gaining R2 resolution + a visible
refusal. That was the silent-failure bug.

## What shipped

### (1) Daemon: every unresolvable skip is LOUD
`_noteLoadSkip(title, reason)` emits `loadskip {stationId, title, reason}`. Fired at each of the 4
load-time skip points ("unplayable at load (<where>)") AND at fill for genuinely-dead rows
("unresolvable — no local file, no file_key"). Main routes it to the skipped-at-load sense.

### (2) Renderer: A/B/C never die silently
`loadDeck` resolves the file (local-first → R2-by-file_key), and:
- resolves → loads the returned path onto the deck (so R2-only library songs now load);
- fails → a red toast: `Can't load "<title>" — unavailable, needs re-import` (or the resolver's error);
- in-flight → a blue toast `Loading "<title>" onto <deck>…`, cleared on success.

### (3) Rotation honesty
Genuinely-dead rows (no local file AND no file_key) are dropped at SELECTION with a loud `loadskip`
instead of silently phantom-filling the pool; R2-only rows are deferred to the prefetch (Slice A),
tracked by the prefetch-lag sense — so separation is never violated by rows that can never air.

## Gates
- `node --check` on engine.js / loggen.js / main.js: OK.
- `npx tsc --noEmit`: zero new errors (3 pre-existing; App.tsx unaffected by the loadDeck change).
- `npm run build` + installer: OK.
- Read-only harness: `loggen.fillQueue` carries `fileKey` on all items (the field the engine filter needs).

## Artifact
`C:\openair\dist-electron\Ether Setup 4.4.72.exe` — `--publish never`. Install + fully close/reopen
(daemon doesn't hot-reload). Read the skipped-at-load sense in the Health Monitor / `health-events.jsonl`
(`kind:"load-skip"`); A/B/C on an unavailable song shows the red toast.

## Files
- `audiod/engine.js` — `_noteLoadSkip` + 4 skip emits + refillIfNeeded file_key-aware filter.
- `audiod/loggen.js` — `fileKey` on items.
- `electron/main.js` — `loadskip` → `noteSkip` route; `_libHealth` scope hoist.
- `src/App.tsx` — `loadDeck` resolve/check/toast + deck-load toast render.
- `package.json` 4.4.71 → 4.4.72.

## Still open (fresh session)
- **Slice C** — Health Monitor LIBRARY section, Library PLAYS column (plays + last-played + rest
  countdown, fixing "—"), live queue lint + Generate-time separation lint (off `library-health:eligibility`).
- **Filed follow-ups** — 2 unresolvable Open Format songs (need re-import); OF's ~69
  locally-present-but-zero-spin songs (rotation-coverage question).

Nothing committed; nothing pushed. STOP before install.
