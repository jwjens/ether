# Build 4.6.61 (2026-10-20) — the 58-second freeze

## Jeff's request (verbatim)

> URGENT: 4.6.60 freezes the main thread ~58 s every minute (_missingShowSpans electron/main.js:12016 ← _buildShowLogs): per-hour unindexed queries over each station's whole log, 768 steps for 24/7 shows, on every station, before checking whether this machine generates for it. Ether goes Not Responding and Windows kills it.
> Fix it properly for 4.6.61:
> 1. Nothing on the main thread waits on the database for this. One query per station for the hours that already have rows in the window, with an index that covers it. No per-hour loop.
> 2. Look only as far ahead as the current show and the next show, not 32 days.
> 3. Skip stations this machine doesn't generate for before any work.
> 4. A test that times it on a station with 100k+ log rows and fails if it blocks the main thread.
> Then gates, the three release checks, and the launch check run against a COPY of a real database (not an empty one), since an empty one hid this. Installer path, name, sha256. Fast.

Diagnosis (Jeff's, from ovowforestmusic's health-events.jsonl and Windows hang events) taken as given.

## The installer

- **Path:** `C:\openair\dist-electron\Ether Setup 4.6.61.exe`
- **sha256:** `01369beb71b76444ec23dc55a3613fa49ce28867ad14864f91a501b732b0e664`
- 216,194,720 bytes · built 2026-10-20 13:42 PDT · commit `88625a1` on `release/1019` · `--publish never` · not pushed, not tagged.
- Contents = 4.6.60 + this fix.

## The fix (88625a1)

| Jeff's point | What was built |
|---|---|
| 1 · main never waits; one query; covering index; no per-hour loop | `electron/show-log-worker.js`: the check runs on its own thread with its own read-only connection. `main.js _showLogCheck` only posts and awaits (one check at a time; a worker that dies rejects the pending check). `electron/show-log-spans.js`: **one** query per station — a `scheduled_at` range on the existing `idx_gensched_station_at (station_id, scheduled_at)` (widened 6 h each side so a crossing row is never missed), hours matched in memory. No new index to build, so nothing waits for silence on a 24/7 air machine. |
| 2 · current + next show | The window is the show on now and the next show's **occurrence**: a show reaching its own start minute again is a new occurrence, so a 24/7 daily show is the rest of today + tomorrow (≤ 48 h), not 768 h. |
| 3 · gate first | The designation gate (`mayAutoGenerate`) is asked first in the worker; a refused station costs no log query. |
| 4 · test | `npm run test:show-log-check [-- --db <copy>]` (`scripts/smoke-show-log-check.js`): 4 stations × 121,600 rows; the real worker while main ticks every 10 ms; **fails** if main is ever > 50 ms late, if the window is not current + next, if a refused station queries the log, or if any per-hour query is made. |

Unchanged: building the log itself (`_generateRange`) still runs on main for the spans returned (its own stalls, ≤ 334 ms below).

## Gates (88625a1)

tsc 0 · vitest 118 files / 1026 · verify:schema PASS · **test:show-log-check 11/11** (synthetic + a copy of OVEVENTS' real DB: worker 25 ms, main worst 12 ms; for the record 4.6.60's check on the synthetic data: 3,071 ms on main for one station) · test:three-pm 38/38 (rule 6 now reads the new module) · sweeper-assignments, uuid-refs, programlog-reads/-writes, hour-rollover, autopost-switch, sweeper-sense, designation, window-station, copy-on-import, catalogue-r2, sign-filter, undefined-calls, ipc-contract, preload-bridge, spot-edge, queue-rows, stale-rows, calendar-anchor, sync 55/55: PASS. **test:one-switch** fails as before (old test file `src/audio/attach-restore-sequence.test.ts:37`), untouched.

## Release checks

1. **Contents:** 215/215 packages vs 4.6.60, PASS; `electron/show-log-spans.js` and `show-log-worker.js` inside `app.asar`.
2. **Size:** 216.2 MB vs 216.2 MB, PASS.
3. **Launch on a COPY of real data — PASS.**
   - Copy of OVEVENTS' live database (SQLite online backup from a read-only connection; integrity ok; generated_schedule 25,901 / 86,770 / 62,017 / 111,019 rows for stations 1–4).
   - Made unable to act on the account: account session, license keys and secrets removed, sync off. This computer's identity kept, so stations 3/4 take the full path. Stations 3/4's log deleted from 3 h ahead so the check had to find and build it.
   - Opened as profile `ETH-STN-BAA8-E056-6FC8` (682 songs, 5 stations). Window responding in **48/48** samples over 4 minutes. The check built **Magical Forest 558 rows** (31 h × 18) and **Christmas in Jully 806 rows**; skipped Open Format and halloVeen (designated to ovowforestmusic).
   - Stall monitor: 6 main stalls, all in the first 20 s — worst 580 ms at startup; 334 / 205 / 127 ms inside `_generateRange` building the log; **none from the check**; none in the following 3½ min (3 more passes). **0** watchdog rounds skipped (4.6.60: one ~58 s stall a minute).
   - Closed via Stop & Quit: 2.0 s, 0 processes left. Temp copy deleted.
   - **Not isolated:** the test still wrote to the real `%APPDATA%\Ether` (startup log, daemon log, artwork cache folder): `main.js:292` sets userData to `%APPDATA%\Ether` itself, so neither the APPDATA variable nor `--user-data-dir` moves it. It also bound :3400 (the installed Ether was not running). A first attempt fell back to an empty profile because my pointer-file write had silently failed; it was redone and verified.

## Open

- `docs/scheduler-rotation-playout-design.md` §3.9 edit (Jeff-approved) is uncommitted; not part of the build.
- The per-computer logs / Play Log / sync / backups work waits as planned (after 4.6.60 — now after 4.6.61).
