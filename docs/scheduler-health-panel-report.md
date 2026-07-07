# Scheduler Health panel + actionable diagnostics — build report

**This is a NEW report (not the reconciliation doc).** Covers the diagnostics rewrite, the category-health
visualizer, layer #2 auto-extend, and the movable Tools panel. Commit hashes below so it's unambiguous.

Receipts rule in force: every claim cites a commit / `file:line` / build output, or it's false.

---

## Commits this batch (stack on staged v4.4.37)

| Commit | What |
|---|---|
| `996c2ae` | Layer #2 — runway + auto-extend |
| `9da077d` | Structured diagnostics data model + `schedule:categoryHealth` IPC |
| `8d974fe` | Movable Scheduler Health panel (Tools) + calendar feed |
| `docs`    | `scheduler-rework-status.md` (reconciliation), this file |

Build receipt: `vite build ✓ 8.91s`; `node --check electron/main.js` OK.

---

## 1. Your four asks — all in

**(a) Diagnostics are actionable now (was "13 hours have no show" — a count, not a diagnosis).**
`schedule:generateDay` returns STRUCTURED diagnostics (`main.js`): per-day **date + hour RANGES** per gap
TYPE — `noShow`, `noClock`, `emptyCats`, `emptyClocks` — plus the **relaxed-pick list** (hour · song ·
category). Rendered as sections, each gap **clickable → jumps the calendar to that day**. Example:
"Wed, Jul 9 · 2 AM–7 AM" instead of "13 hour(s)".

**(b) It's a movable panel, not a locked modal.**
New `SchedulerHealthPanel` floats, **drag the header**, stays open while you work, close with ✕. The old
full-screen backdrop modal is deleted.

**(c) Category health — "how much room before the scheduler runs out of options."**
`schedule:categoryHealth` IPC: per category, active **songs** + **distinct artists** (the binding
constraint — a 60-min artist separation locks out an artist's whole catalog after one spin) + status
`healthy` / `tight` / `at_risk` (target 10+ distinct artists) + `ON AIR` flag. The panel shows a bar per
category with an `ADD SONGS` flag on at-risk ones. This is your import shopping list, live.

**(d) A constant window under Tools.**
**Tools → Scheduler Health.** I did **NOT** hijack "Stream Manager" — that's your functional Icecast/
Shoutcast encoder config (`StreamManager.tsx`), and both menu entries open it. I added a new entry beside
Smart Scheduler (admin / music_director).

## 2. Layer #2 — runway + auto-extend (also in this batch)

`_autoExtendTick` (`main.js`): every 30 min (first tick 60s after boot), any station whose runway drops
**< 48h** gets Generate run ahead to a **14-day** target (both env-configurable:
`ETHER_RUNWAY_THRESHOLD_H`, `ETHER_RUNWAY_TARGET_DAYS`). Publishes `runway` + `autoextend` on the `:3400`
SSE (Phase-3 watchman telemetry). Only stations with an active show+clock. Never touches playout.

The panel shows the active station's runway, color-coded (red < 2d, amber < 4d, green otherwise).

## 3. What I verified vs. what your click verifies

- **Verified (receipts):** it all compiles — `node --check` on `main.js`, `vite build ✓ 8.91s`. The
  category-health SQL and the structured-diagnostics shape are code-reviewed.
- **NOT verified by me (needs the app running):** that the panel renders correctly, the numbers are
  right, and the diagnostics feed end-to-end. **Your click is the test.**

## 4. Your walkthrough

1. **Relaunch Ether** — `main.js` and the renderer both changed; fully restart.
2. **Tools → Scheduler Health** — the panel opens (drag it wherever). Category-health tab shows every
   category's distinct-artist headroom; 2ks / 70s should read `at_risk` / `ADD SONGS` right now.
3. **Import your songs** (single-file import shipped in the 4.4.36 line — no folder ceremony).
4. **Calendar → Generate a day.** The panel's **Last generate** tab fills with named gaps + the relaxed-
   pick list. Before/after proof: the relaxed list for 2ks/70s should shrink toward **empty**, and their
   category-health bars should climb out of `at_risk`.

## 5. Standing rule I just violated + corrected

Last turn's report was long and I put it inline instead of a file — so Desktop had no fresh `.md` and
pulled an old one. Corrected: this report is a new file. Going forward, long reports = a new dated/named
file in `docs/`, and the file is what travels.
