# Drift diagnosis — why playout runs ahead of scheduled_at (read-only, pre-Phase-3) 2026-07-20

**Tool:** `scripts/diag-drift.js` (read-only) against the live install (4.4.70 airing). No changes.
Answers the pre-Phase-3 open item: the calendar ▶/decks air content scheduled 15–65 min in the future.

## Headline: it is NOT a Generate-density problem. It is drift **accumulation with no re-anchor**, dominated by jumps/skips/off-log — exactly what a time-anchored playhead (Phase 3) fixes.

## Receipts

### (1) Generate density — NOT the driver
Audio-seconds scheduled per wall-hour (target 3600), full hours only (the 19:00 and 01:00 partials are
edge buckets):

| Station | Full-hour density | Model |
|---|---|---|
| 1 Open Format | 96–107% (~100%) | ratio (gap/duration) = **1.00** → duration-based |
| 2 halloVeen | 99–105% (~100%) | 1.00 |
| 3 Magical Forest | 100–103% (~101%) | 1.00 |

`scheduled_at` = cumulative song durations, and each hour holds ~60 min of audio. **The schedule is
already real-time-dense.** Over-density is not the cause (companion fix (e) is effectively already met).

### (2) Overlap (segue) — small, ~5–10% of the drift
Median actual airtime / song duration = **99% / 98% / 99%** — songs air nearly full length. Segue
overlap is only ~1–2% ⇒ **~0.6–1.2 min/hr** of drift. Real, but minor.

### (3) Drift accumulates with NO effective re-anchor — the amplifier
Drift (`scheduled_at − played_at`) over the last ~hour of airtime, and the current standing drift:

| Station | Drift growth (last ~1 hr) | Current drift | Off-log airs |
|---|---|---|---|
| 1 | −0:42 → +4:47 (**+5.5 min/hr**) | **+17 min** | 30% |
| 2 | −2:39 → +13:35 (**+16 min/hr**) | **+65 min** | 63% |
| 3 | −1:27 → +6:15 (**+7.7 min/hr**) | **+15 min** | 0% |

The current drift (17–65 min) is **larger than one hour's growth**, and drift grows monotonically —
so the **top-of-hour hard-cut re-anchor is not resetting it** (station 2's +65 min ≈ ~4 hours of
un-reset +16 min/hr). Nothing pulls playout back to the clock, so even a few min/hr compounds into an
hour of drift.

### (4) The dominant driver — jumps/skips/off-log advancement
Drift-trend **minus** overlap leaves the remainder, and it tracks the off-log rate:

| Station | Total drift/hr | − overlap | = jumps/skips/off-log | off-log |
|---|---|---|---|---|
| 1 | 5.5 | ~0.6 | **~4.9 min/hr** | 30% |
| 2 | 16 | ~1.2 | **~14.8 min/hr** | 63% |
| 3 | 7.7 | ~0.6 | **~7.1 min/hr** | 0% |

Station 2 (63% off-log) drifts ~3× station 1 — operator deck-loads + live-picks **advance the schedule
cursor past rows that never aired at their slot**, pushing the playhead ahead. Station 3 drifts 7 min/hr
at **0% off-log**, so there is also a baseline non-overlap advance (queue read-ahead / preload cursor /
brief skips) independent of operator activity. `diag-drift` flagged **2 large jumps per ~14 boundaries**
on every station — a minority of boundaries carrying most of the drift.

## Drift budget (per station)
- **Density: ~0 min/hr** — schedule is ~100%, duration-based. Not the cause.
- **Overlap: ~0.6–1.2 min/hr** (~5–10% of drift) — songs air ~99% of length.
- **Jumps / skips / off-log: ~5–15 min/hr (the bulk, ~85–95%)** — cursor advances past un-aired /
  substituted rows; scales with off-log rate.
- **Amplifier: NO effective re-anchor** — accumulation is never reset, so the above compounds to the
  standing 17–65 min.

### Honest caveat on the tool
`diag-drift.js`'s per-song "median gain/song = 4–5 min" is **internally inconsistent** with the 99%
airtime (which implies ~2–3 s/song) — the median is contaminated by the jump outliers, so it is **not**
used as a receipt. The budget above is derived from the reliable measures (density %, airtime %,
drift-trend, off-log %). A cleaner per-boundary attribution can be added later; it doesn't change the
conclusion.

## Which fix this implies
- **NOT a Generate-density fix** — density is already ~60 min/hr, duration-based. (e) is effectively met.
- **Phase 3 time-anchor IS the fix.** Making the playhead **the row scheduled for ~now** kills this
  entirely: (a) it re-anchors at *every* boundary, so nothing accumulates (no reliance on the broken
  hourly hard-cut); (b) jumps/skips/off-log can no longer push the playhead ahead of the wall clock,
  because the playhead is *defined by* the wall clock. The 17–65 min drift cannot exist under §2.7.
- **Auto-fitter (post-Phase-3)** then makes the required boundary corrections graceful (swap
  shorter/longer same-category ahead of air) instead of hard drops.
- **Side finding worth a separate look:** the top-of-hour hard-cut re-anchor appears not to be
  resetting drift today (drift exceeds 60 min). Phase 3's continuous anchor supersedes it, so this is
  informative rather than a separate fix — but worth confirming in code when Phase 3 lands.

## Verdict
The drift is **~0 density, ~5–10% overlap, ~85–95% jumps/skips/off-log, amplified by a non-functioning
re-anchor.** The single correct fix is **Phase 3's time-anchored playhead** (drop-fallback first, then
the auto-fitter), NOT a Generate-density change. This validates the §2.7 sequencing.

*Read-only. `scripts/diag-drift.js` added. No source/behaviour changed.*
