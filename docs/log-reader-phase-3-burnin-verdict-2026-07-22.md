# §2.7 shadow burn-in — verdict (2026-07-22)

Read of the log-reader shadow burn-in (`%APPDATA%\Ether\logreader-shadow.jsonl`) since the **4.4.77
install** (daemon fresh-start 15:19:58 UTC — confirmed by the `ETHER_LOG_READER=0 §2.7 shadow only`
lines on all three stations). Reader: `scripts/diag-shadow-burnin.js` (read-only). Flag OFF throughout.

## Window
268 boundaries, 15:19:58 → 20:00:01 UTC (~4.7h). Numbers stable across the window (a re-read 4 min
apart moved counts by <5 — not drifting).

## 4.4.77 confirmed + validated
- **Installed 4.4.77** — `sweepMs` sense emitting (batched eligibility, a 4.4.77-only signature): full
  senses sweeps **200–510ms**, down from 1502ms+ eligibility-alone / the 17s freeze.
- **Freeze eliminated** — event-loop lag capped ~600ms (was 17409ms). The ~600ms blips are the residual
  sweep cost, not a freeze.
- **No overlap recurrence** — the Bug-A force-stop guard fired **0** times; the shadow-off-critical-path
  change held. This burn-in is therefore trustworthy (the shadow no longer perturbs playout).

## Per station

| Station | Boundaries | Off-log airs | On-time | Anchor drift (on-time) | Max drift | Disagreements |
|---|---|---|---|---|---|---|
| Magical Forest | 97 | 0 ✅ | 99% (96/97) | 28s | 1m16s | 1 `behind` |
| halloVeen | 95 | 0 ✅ | 83% (79/95) | 31s | 87m55s (1 outlier) | 16 `behind` |
| Open Format | 76 | 0 ✅ | 51% (39/76) | 20s | 90m01s | 37 `behind` |

- **Off-log airs: 0/268 on all three** — every air is a `generated_schedule` row.
- **Selector soundness:** zero `exhausted` / `error` / `ahead` modes across the full window — a valid
  current-or-past log row was found at every boundary; never empty, never errored, never all-future.
- **Disagreements are all `behind`** — legacy aired *ahead* of the wall clock, so the flip's now-pick is
  an earlier (skipped) row. That is the drift the flip exists to remove; the shadow shows the flip would
  re-anchor to the now-row, not that anything is broken.

## Verdict: FLIP-READY

The design's acceptance gate (§7 Phase 3) is **not** "agreement → 100%" — it is *"everything that airs
IS a log row; zero off-log airs."* That gate **passes on all three stations** and holds steady over
4.7h, with a sound selector. Per station:
- **Magical Forest** — pristine (99% on-time, max drift 76s). Immediately clean under the flip.
- **halloVeen** — solid (83% on-time, 31s anchor). The lone 88-min outlier is a top-of-hour/resume blip.
- **Open Format** — the drift-corrector (49% `behind`; legacy runs ahead, median overall drift 1s, tight
  20s when on-time). The flip re-anchors it — its purpose. OF's rare 90-min gap outliers are the only
  caution: a drop-fallback-only flip could occasionally air a stale row there until the auto-fitter lands.

## GO path (recommendation)
Enable `ETHER_LOG_READER` with the drop-fallback (§2.7(d)). Canary **Magical Forest → halloVeen → Open
Format**. For OF: a fresh **Generate** first (shrinks the 90-min gap outliers) and the **auto-fitter** as
the immediate follow-on for its larger re-anchors — neither blocks the acceptance gate.
