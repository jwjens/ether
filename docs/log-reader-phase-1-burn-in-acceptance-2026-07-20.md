# Log-Reader Flip — Phase 1 burn-in acceptance (2026-07-20)

**Read-only run of `scripts/diag-playhead-shadow.js` against the LIVE install (4.4.69 airing).**
Acceptance for the Phase 1 shadow playhead writer (design §7 Phase 1;
`docs/log-reader-phase-1-shadow-2026-07-20.md`). **VERDICT: acceptance MET — the shadow is faithful.**
Nothing mutated; no new phase started.

## Result per station (22:00–22:02, all three airing)

| Station | Playhead (`state='playing'`) | played rows | stamped last hr | Playhead == latest Play History |
|---|---|---|---|---|
| 1 | "Latch" (row 20512, sched 22:03:08, played_at 22:00:00) | 5,060 | 4 | **YES ✓** — title + played_at identical |
| 2 | "Little Shop Of Horrors" → "The Nightmare Before Christmas — This Is Halloween" | 6,186 | 5 | **YES ✓** |
| 3 | "Scrooge" → "Like It's Christmas" | 5,938 | 6 | **YES ✓** |

Between the diag run (22:02:18) and the Play-History cross-check (~22:02:42) stations 2 and 3 rotated
songs; the playhead moved in lockstep with `play_log` — the shadow tracks in real time.

## Acceptance checks — all green
1. **Exactly one playhead per airing station** — `playing=1` on all three; duplicate-playhead guard
   (`GROUP BY station_id HAVING COUNT(*)>1`) returned **none**.
2. **`played` accumulating with `played_at`** — 5,060 / 6,186 / 5,938 played rows; 4 / 5 / 6 freshly
   stamped in the last hour.
3. **Current playing row identified** — correct per station.
4. **Playhead matches Play History (the acceptance)** — the stamped `state='playing'` row equals the
   most-recent `play_log` entry **exactly (title + played_at) on all three stations.** Faithful in
   real time (verified across a rotation).

**Conclusion: the shadow playhead writer records the true playhead in the one file, faithfully. Phase
1 acceptance MET.**

## Two findings from the run

### A. Diag metric bug — found and fixed mid-run (not a shadow defect)
First pass reported **0% on-log for every station**. Cause: the on-log metric matched
`play_log.file_path` against `generated_schedule.file_path`, which is **NULL for song rows** (the path
resolves through the `songs` join). Tell-tale: the "off-log examples" were the *same titles as the
playheads* ("Latch", "Scrooge"), which are stamped `playing` via `schedId` and therefore on-log by
construction. Fixed the metric to `COALESCE(gs.file_path, s.file_path)` via the songs join and re-ran.
(Repo script only — the diag is run from `C:\openair\scripts`, not bundled in the app runtime, so no
rebuild.) File: `scripts/diag-playhead-shadow.js`.

### B. On-log rate = the pre-flip divergence baseline (NOT a Phase 1 fault)
With the corrected metric, share of the last 20 airs that map to a calendar (`generated_schedule`) row
within 15 min:

| Station | On-log rate |
|---|---|
| 1 | **60%** |
| 2 (HalloVeen) | **20%** ⚠ |
| 3 | **90%** ✓ |

This measures a **different** thing than shadow fidelity — it's how much of what airs comes from the
calendar plan vs. live-picks. Phase 1's job was to measure it faithfully, which it does.

**⚠ CAVEAT (Jeff 2026-07-20): this baseline is NOT the Phase 3 yardstick.** Jeff live-adds songs via
the deck loader as normal operation, so the on-log rate is *contaminated by legitimate operator
inserts* — a low number here mixes real off-log live-picks (the disease) with intentional live-radio
loads (correct behavior). The real Phase 3 acceptance is **every air is a log row** — machine-placed
OR operator-inserted — i.e. `queue == calendar by construction`, zero *un-logged* airs. That requires
Phase 4's live-deck-load path (deck A/B/C + cue-to-deck WRITE a `generated_schedule` row at the
playhead, stamped operator-inserted) to land no later than the flip. So 60/20/90 is a *directional*
pre-flip snapshot, not the pass/fail gate. (Design §7 Phase 3 acceptance; §2.5 live deck load.)

## How this was run (reproducible, read-only)
```
ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/diag-playhead-shadow.js
```
Play-History cross-check via `sqlite3 -readonly` comparing each station's `state='playing'` row title
to its newest `play_log` title. (Electron node ABI required — system node's better-sqlite3 mismatches.)

## Status
Phase 1 acceptance is clean. Per the standing rule (flag off until Phase 3's shadow burn-in is clean)
this satisfies the Phase 1 gate. **Holding for the go on Phase 2 (read-path unification behind a
flag).** Nothing committed; nothing pushed.
