# Log-Reader Flip — Phase 1 (shadow playhead writer) — build report, 2026-07-20

**Design:** `docs/log-reader-single-source-playout-design-2026-07-20.md` §7 Phase 1. Phase 0 shipped
v4.4.68 (schema). **Phase 1 is OBSERVATIONAL** — the daemon stamps the playhead into
`generated_schedule`'s local-only lifecycle columns as decks go live, changing NO playout/queue
behavior. Flag stays OFF (none introduced yet; Phase 3 introduces `ETHER_LOG_READER`). **STOP at this
boundary for review.**

## The screenshots confirm the disease
2026-07-20 shots: HalloVeen decks played *Monster Mash / Pink Elephants* while the calendar's ▶ sat on
*Black Magic* at 02:18 (the wall-clock fallback firing because the aired item is off-log). That is the
two-representations divergence. Phase 1 doesn't fix it (Phase 3 does) — it **measures** it.

## What shipped

### 1. `schedId` carried on log-sourced queue items — `audiod/loggen.js`
Tier-0 fills (`fillQueue`, `fillFromHour`) now put `schedId = gs.id` on each item. Live-picked items
(Tiers 1-4) omit it — that absence IS the off-log signal.

### 2. Shadow playhead writer — `audiod/engine.js`
- `deckSchedId[id]` side-table, captured in `loadToDeck` alongside `deckSched`.
- `_fireStart` (the single "deck went live" point, already stamping `play_log`) now calls
  `_shadowStampPlayhead(deckSchedId[deck])`.
- `_shadowStampPlayhead(schedId)`: a **direct local write on the daemon's own DB handle** (same pattern
  as `playlog.logPlay`, NOT the sync mutation path — the columns are `local-only`, §5). If `schedId`
  present → that row `state='playing'` + `played_at`, any other `playing` row for the station →
  `played`. If absent (off-log) → retire the prior playhead + count/log the divergence. Wrapped so it
  can **never throw into playout**.

### 3. Burn-in reader — `scripts/diag-playhead-shadow.js` (read-only)
Per station: lifecycle distribution, the current playhead row, recent shadow activity, and the
**ON-LOG RATE** — the share of the last 20 actual airs (`play_log`) that map to a `generated_schedule`
row within 15 min. High = decks track the calendar (the goal); low = the divergence.
Run: `ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/diag-playhead-shadow.js`.

## Verification (offline — the live burn-in is Jeff's running install)

Could not run the daemon burn-in in-session (needs the daemon airing over time). Validated the exact
stamp SQL + the reader on a COPY of the live DB (under Electron's node ABI):
- **All 7 shadow-stamp transitions PASS** — first row → sole playhead (+played_at); rotate → prev
  `played`, next sole `playing`; off-log → 0 playing, prior `played`; back-on-log → new sole playhead.
- The diag reads the simulated playhead correctly and reports the **on-log rate = 0%** on the current
  live data (expected: 4.4.68 has no shadow writer yet — this is the pre-Phase-1 divergence the
  screenshots show; the daemon offLog examples were *Monster Mash*, *Somebody's Watching Me* — the
  same off-log tracks from the shot).

### Phase 0 migration made truly idempotent (bug found during Phase 1 validation)
The v33 `seq` backfill guarded on `WHERE seq IS NULL`; re-running on a DB with partial seq (existing
rows numbered + new runway rows NULL) collided (591), because `ROW_NUMBER` restarts at 1. Version-
gating means the live single run was fine, but "idempotent" was false. Fixed to **re-number all rows**
each run. Re-verified on a fresh copy: run 1 and run 2 both PASS, **0 seq collisions, every row seq'd
(31,275)**. (Version-gated, so it won't re-run on a DB that already applied v33 — those got a correct
single-run seq; new post-migration rows carry NULL seq until Generate-side assignment in a later
phase, which the Phase 3 read resolves via a scheduled_at fallback.)

## How to read the burn-in (Phase 1's actual acceptance, on the running install)
Install 4.4.69, **fully close + reopen Ether** (the daemon does NOT reload on auto-update), let it air
for a while, then run the diag. Expect: exactly one `playing` row per on-air station tracking the deck;
`played` rows accumulating with `played_at`; and the on-log rate quantifying divergence. Compare the
stamped playhead against Play History — that is the Phase 1 acceptance the design calls for.

## Gates
- `node --check` on `engine.js`, `loggen.js`, `diag-playhead-shadow.js`: OK.
- `npx tsc --noEmit`: zero new errors (3 pre-existing; changes are daemon JS).
- `npm run build` + installer: OK.

## Artifact
`C:\openair\dist-electron\Ether Setup 4.4.69.exe` — 202,612,377 bytes, `--publish never`. Install
manually; **must fully close + reopen** so the new daemon loads.

## Files
- `audiod/loggen.js` (schedId on log items), `audiod/engine.js` (deckSchedId + `_shadowStampPlayhead`)
- `scripts/diag-playhead-shadow.js` (new, read-only)
- `scripts/migrate-generated-schedule-playhead-lifecycle-phase-sync-33.js` (seq backfill → idempotent)
- `package.json` 4.4.68 → 4.4.69
- `docs/log-reader-single-source-playout-design-2026-07-20.md` §2.4a (RESET re-cues non-playing decks)

Nothing committed; nothing pushed. Flag stays off.

## Next — Phase 2 (read-path unification, behind flag), on your go + a clean burn-in
Point UpNext + the ▶ marker at the same log query the calendar uses; shadow-compare the log-derived
up-next against `engine.getQueue()` and log divergences. Still no playout change. Then STOP.
