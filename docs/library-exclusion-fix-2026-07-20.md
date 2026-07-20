# Library exclusion — fix release (backfill + Slice A senses/prefetch) 2026-07-20

Diagnosis: `docs/library-exclusion-diagnosis-2026-07-20.md`. Root cause: **113/172 HalloVeen songs (and
39/76 Magical Forest, ~13 Open Format) had a `file_path` pointing at a local file that isn't on disk,
but the audio exists in R2 (`file_key`)** — one 2026-07-06 import, partially materialized. Rotation/
Generate/deck-load check the local `file_path` (`fs.existsSync`) and silently skip; only the cue editor
R2-resolves. Effect: a ~59-song pool cycled where 172 should, violating separation.

## (2) IMMEDIATE RELIEF — materialize backfill (DONE tonight)
`scripts/backfill-missing-audio.js` downloaded every library song whose local file was absent but had a
`file_key`, to its **exact `file_path`** (the backend-signed `/audio/download-url` flow, files only —
never the DB). Result: **165/165 fetched, 1177 MB, 0 failures.** The daemon's `fs.existsSync` now finds
them → they're rotation-eligible + deck-loadable immediately. **Tonight's air has the full library.**

Cross-station diff (`scripts/diag-library-spins.js`) — the gate confirmed by data:
| Station | zero-spin | local-file gate |
|---|---|---|
| 2 halloVeen | 113/172 (66%) | **clean** — 100% spun local / ~0% zero-spin local |
| 3 Magical Forest | 39/76 (51%) | **clean** — 100% / 0% |
| 1 Open Format | 85/163 (52%) | **partial** — 81% of zero-spin DO have local files (a separate rotation-coverage question); only ~13 were file-missing |

## (1)(5) SLICE A — R2 prefetch + library/rotation senses (SHIPPED v4.4.71)
New main-process module `electron/library-health.js`, wired at the health-monitor lifecycle
(`main.js`), running deterministically off the DB + disk. **No playout-path change.**
- **R2 PREFETCH (durability, so the bug can't recur):** every 45s, background-materialize upcoming
  R2-only `generated_schedule` rows (next 2h) to their `file_path`, bounded + deduped + concurrency 3.
  Non-blocking by construction — it only ever writes files ahead of playout, never on the deck-load path.
- **Senses → `health-events.jsonl` + IPC `library-health:get` / `:eligibility`:**
  1. **Materialization** — resolvable/total (local OR file_key); red on any truly-dead song, yellow on r2-only.
  2. **Pool health** — spun-pool(24h)/library + top song spins/24h (repetition signal); yellow when pool <70%.
  3. **Skipped-at-load** — per-hour counter (fed by the daemon's loud skip event in Slice B).
  4. **Prefetch lag** — upcoming rows not yet local.
  5. **Rotation eligibility** — per song last_played + rest_remaining (from the ACTUAL separation rules:
     `no_repeat_hours` + artist-separation), status ELIGIBLE|RESTING|NEVER_PLAYED|UNRESOLVABLE, summarized
     per station; `library-health:eligibility(stationId)` returns the per-song list for Slice C.

### Verified read-only against live data (post-backfill)
- halloVeen **172/172 resolvable [GREEN]**, Magical Forest **76/76 [GREEN]** — backfill confirmed.
- Open Format **161/163 [RED]** — the sense caught **2 genuinely unresolvable songs** (no local file AND
  no file_key) — cannot be prefetched; they need re-import. (A real find the sense surfaces.)
- Pool-health yellow on all three (spun pool <70%, will grow as the materialized songs air); JSONL written.

## Gates
- `node --check` on `library-health.js` + `main.js`: OK.
- `npx tsc --noEmit`: zero new errors (3 pre-existing; changes are main-process JS).
- `npm run build` + installer: OK.

## Artifact
`C:\openair\dist-electron\Ether Setup 4.4.71.exe` — `--publish never`. Install + fully close/reopen.

## Remaining slices of this release (sequenced — NOT in A)
- **Slice B (playout-path, careful):** loud refusals — daemon emits a health event on every `loadToDeck`
  false (`load-skip` → `_libHealth.noteSkip`), and `App.tsx loadDeck` resolves via `audio:resolve-local-path`,
  checks the result, and surfaces a visible reason (mirroring the cue editor); **rotation honesty** —
  exclude truly-dead songs at selection + shrunken-pool health event.
- **Slice C (renderer surfaces):** Health Monitor LIBRARY section per station (mini-panel dot when
  non-green) reading `library-health:get`; Library page PLAYS column grows up (plays + last-played + rest
  countdown, fixing the "—" via the repaired `play_log` join); live queue lint + Generate-time lint
  ("placement violates separation, N min early") from `library-health:eligibility`.

## Filed follow-ups (Jeff's call — NOT fixed here)
1. **2 unresolvable Open Format songs** — no local file AND no `file_key`, so neither the backfill nor
   the prefetch can materialize them; the materialization sense flags Open Format RED because of them.
   They need a **re-import** (re-add the audio so they get a local file / R2 key). Jeff's call when.
2. **Open Format's locally-present-but-zero-spin set (~69 songs)** — distinct from the file-missing
   bug: these HAVE local files yet had 0 spins in the trailing 7 days (station 1's zero-spin was only
   ~19% file-missing; the rest are here). Open question — why aren't they airing? Candidates: daypart
   masks, rotation coverage over a large library (78/163 aired in 7d ≈ half the library/week), clock
   category coverage, or separation. Filed for a dedicated rotation-coverage look, separate from this
   release. The rotation-eligibility sense (5) is the instrument to answer it (status per song +
   rest-remaining).

## Scripts added (read-only diags + the one-shot backfill)
`diag-library-spins.js`, `diag-library-exclusion.js`, `diag-drift.js`, `backfill-missing-audio.js`.

Nothing committed; nothing pushed. Slice A shipped; B and C sequenced next.
