# Log-Reader Flip — Phase 2 (read-path unification) — build report, 2026-07-20

**Design:** `docs/log-reader-single-source-playout-design-2026-07-20.md` §7 Phase 2 + §2.7.
Phase 0 (schema) v4.4.68, Phase 1 (shadow writer) v4.4.69. **Phase 2 is OBSERVATIONAL** — it adds the
log-derived read path and a shadow-compare, with **no render or playout change**. The flag stays OFF
until Phase 3's shadow is clean. **SHIPPED v4.4.70. STOP at this boundary for review.**

## What shipped

### 1. `schedule:playhead-view` IPC — `electron/main.js`
Returns the playhead view straight from `generated_schedule` (the SAME source the calendar reads):
`{ playing, upNext[] }` where `playing` = the `state='playing'` row and `upNext` = the next N
`pending` **music** rows (JIN/SWP excluded — they're seam overlays, never deck tracks), station-scoped,
ordered by `scheduled_at`, with the same cross-station foreign-category guard as `schedule:get`.
READ-ONLY.

### 2. `health:playhead-divergence` ledger — `electron/main.js`
Appends divergence records to `userData/playhead-divergence.jsonl` — an honest, greppable "sense" for
the read-path burn-in that gates Phase 3.

### 3. Always-on shadow-compare — `src/components/UpNext.tsx`
Every 5s (and on `ether:queue-changed`) it fetches the log-derived up-next and diffs it against
`engine.getQueue()` by title, positionally; any mismatch (count + head samples + the log's playing
title) is written to the divergence ledger. **No render/playout effect** — it only measures whether
the log view and the live queue agree yet.

### Why the flag-gated render switch is deferred to Phase 3 (not a cop-out)
Phase 2 as designed also flips UpNext + the ▶ marker to *render* the log behind a flag. That render is
only **correct and useful once the playhead is TIME-ANCHORED** (§2.7 — the row-for-now). Today the
playhead drifts (41 min ahead observed), so rendering the log view now would just show the same
drifted rows behind a flag nobody should flip until Phase 3. So the render switch folds into Phase 3,
where the log view becomes the row-for-now. This is consistent with the standing rule "flag stays OFF
until Phase 3's shadow is clean." The **shadow-compare** — the part that produces the gating data — is
what ships in Phase 2.

## The core reframing this phase surfaced (§2.7)
Jeff, watching the live app: **3:19 PM wall-clock, ▶/deck airing the 4:00 PM row — 41 min ahead** —
crystallised that *a single source that isn't time-anchored is just a playlist, not a schedule.* So
§2.7 is now the arc's core invariant: **the playhead = the row scheduled for ~NOW; what airs at T is
the row for T → calendar == queue == real-time by construction.** RULING: an **auto-fitter**
(deterministic look-ahead, no LLM) is the primary corrector — swaps upcoming pending rows for
shorter/longer same-category songs (`source='autofit'`, written to the log minutes ahead, visible on
the calendar before air) to hit hard anchors; boundary drop (`missed`) is last-resort; never dead-air
when ahead. Sequencing: **Phase 3 flip ships first with the simple drop-fallback; the fitter is the
immediate follow-on module** (own design doc after Phase 3 burn-in); Generate ~60 real-min/hour is the
companion fix.

## Gates
- `node --check electron/main.js`: OK.
- `npx tsc --noEmit`: zero new errors (3 pre-existing; no UpNext errors).
- `npm run build` + installer: OK.

## Artifact
`C:\openair\dist-electron\Ether Setup 4.4.70.exe` — `--publish never`. Install + fully close/reopen
(daemon doesn't hot-reload). On a running install, read the divergence ledger at
`%LOCALAPPDATA%\Ether\...\playhead-divergence.jsonl` (or Roaming) to see the read-path burn-in.

## Committed + pushed
Branch **`log-reader-flip`** for the reviewing session — `81a8c02` (Phase 0-1) + `a8e52fb` (Phase 2).
Feature branch, **not `main`, no `v*` tag → no release CI.** Phase 0's missing `payloadTransformer` was
caught by the verify-schema pre-commit hook and fixed (it now strips the local-only lifecycle columns
inbound — hardening §5). Note: `main.js` on the Phase 2 commit also carries this session's in-flight
Show+ DAW pop-out handlers (shared file, separate feature).

## Files
- `electron/main.js` — `schedule:playhead-view` + `health:playhead-divergence` IPCs.
- `src/components/UpNext.tsx` — always-on shadow-compare.
- `docs/log-reader-single-source-playout-design-2026-07-20.md` — §2.7 time-anchor invariant + auto-fitter ruling.
- `docs/log-reader-phase-1-burn-in-acceptance-2026-07-20.md` — baseline-contaminated caveat.
- `package.json` 4.4.69 → 4.4.70.

## Next — the drift diagnosis (before Phase 3)
The headline open item is **why playout runs 41 min ahead** — over-dense Generate (>60 audio-min/hour)
vs. pure segue-overlap accumulation. That read-only diagnosis decides whether the immediate fix is
scheduling-side, the time-anchored playhead (Phase 3), or both. Then Phase 3 (time-anchored flip,
drop-fallback) on Jeff's go + a clean read-path burn-in.
