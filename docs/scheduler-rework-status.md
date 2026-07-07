# Scheduler rework — status of record + reconciliation

Written to settle the contradiction: the Phase 2/3 plan says layers #2/#3 "aren't built"; an earlier
report claimed them script-verified (10/10, 12/12, 15/15).

## Reconciliation (from git, not memory)

- `git log --oneline --all` + `git reflog`: **zero trace** of auto-extend, a runway layer, a dumb
  emergency floor, or a log-reader flip. **Layers #2 and #3 were never committed.**
- The code has no auto-extend timer, no emergency loop, no log-reader. The only `runway` reference is the
  4 lines added to `_generateRange` for Iris's `generate` command.
- **The 10/10 / 12/12 / 15/15 numbers are unrelated work**, conflated in the earlier report:
  - `10/10` = provisioning/sign-in materialization proof — `docs/v2-progress.md:354`.
  - `12/12` = the v8 schema-migration steps — `scripts/migrate-phase-a-v8.js:397`.
  - `15/15` = not found anywhere in repo.
- **Conclusion:** #2/#3 were **not** built-and-lost in the Desktop crash, and the report wasn't wrong
  about #2/#3 specifically — it **borrowed verification numbers from provisioning + migration work** and
  attached them to the scheduler rework. Nothing was lost; #2/#3 were simply never built.

## What IS built + verified for "AUTO never stops"

| Layer | State | Evidence |
|---|---|---|
| #1 Ladder into Generate (LRP fallback) | BUILT | `13df91d` (staged for v4.4.37) |
| Daemon never-empty selector (station-scoped separation) | BUILT + TESTED | `5075894` / v4.4.36 `26dfc60`; invariant test 50 rounds, 0 empties |
| #2 Runway + auto-extend | **NOT BUILT** | — |
| #3 Emergency floor (dumb LRP loop) | **NOT BUILT** | — |
| #4 Flip playout → pure log-reader | NOT BUILT | — |
| #5 Visualizer runway gauge | NOT BUILT | — |

## What jensj has armed TODAY (the trustworthy line)

**IF v4.4.36 is installed and the daemon was restarted:** jensj is protected — the daemon's never-empty
selector **live-picks from the 350-song pool the moment the generated log runs out** (Priority 1 = log;
log empty → the never-empty ladder, Tier 1 compliant → Tier 2/3 least-recently-played), so **run-out is
NOT dead air** — backed by the older stall-recovery watchdog. **That protection is only real if v4.4.36
is actually running** (the daemon does not hot-reload on auto-update; it needs a full close+reopen or a
staged-copy + daemon restart). I cannot verify the running daemon version from here — **confirm it on
jensj.**

If jensj is on an OLDER build, the old selector halts on empty and a run-out log **is** dead air.

## Why still build #2/#3 (they're not redundant with the daemon ladder)

The daemon ladder is the *current* floor, but the approved architecture is cleaner and safer:
- **#2 auto-extend** keeps the generated log deep (runway ≥ 48h) so exhaustion is *theoretically
  unreachable* — the daemon should almost never fall to live-pick at all.
- **#3 emergency floor** is the *dumb* last-resort (LRP, zero rules, screams, auto-disengages) that the
  Phase-2/3 plan wants the daemon to use instead of a smart in-daemon selector (avoids "two schedulers").
- Together they also **produce the telemetry Phase 3's watchman needs** (runway, auto-extend results,
  emergency engagements) — so this track unblocks Iris Phase 3.

## Build plan (parallel track, priority)

1. **#2 Runway + auto-extend** (main process): runway = `MAX(scheduled_at) − now` per station; a timer
   that runs Generate ahead when runway < threshold (default 48h, configurable); tops back up to a target
   depth. Publish runway on the `:3400` SSE (Phase-3 telemetry).
2. **#3 Emergency floor**: dumb LRP loop in the daemon, engages on log exhaustion, emits an `emergency`
   scream, auto-disengages when the log has items. Publish engagements (Phase-3 telemetry).
3. (Later, per plan) #4 flip playout to pure log-reader; #5 runway gauge.
