# 4.6.62 (2026-10-20) — contents, gates, and where the build stands

## Status

- **Installer:** `C:\openair\dist-electron\Ether Setup 4.6.62.exe` · sha256 `2287301da5ba48a8695200c6e7be3267ddcbb586fa342e292f94ddaab9042584`
  · 216,307,158 bytes · built 2026-10-20 16:41 from `e4d7562` (clean tree) · `--publish never` · not pushed, not tagged.
  (The first attempt was stopped by the system for low memory; the second was stopped by me when Jeff's 2026-10-20
  changes — cleanup button, BMI/ASCAP format — came in, so the installer would not be stale.)
- **Release checks:**
  1. Contents: 217 packages vs 215 in 4.6.61 — all present; new: `@tanstack/react-virtual`, `@tanstack/virtual-core`. PASS.
  2. Size: 216.3 MB vs 216.2 MB (0.1 %). PASS.
  3. Launch on a COPY of OVEVENTS' real database (account session, license keys and sync removed; schema v66):
     opened as profile ETH-STN-BAA8-E056-6FC8, 682 songs; **v67 and v68 ran on the real data** (schema 68, 6/6 users
     with ids, play_log.machine_name present); sync switch started OFF as ruled. Responding throughout (run 1: 20/20
     samples until Jeff closed the window at ~100 s; run 2: 18/18; run 3: 12/12). Stalls: run 2 worst **608 ms**
     (4.6.61: 580 ms), 0 watchdog rounds skipped. **First launch in a new folder: one ~10–12 s freeze before the window**
     — proven to be the one-time engine copy into the folder (run 3: migrated copy, fresh folder, 9.8 s; run 2: same
     copy, staged folder, 608 ms), not the migrations. It happens on the first launch after every update (the known
     cold-stage behaviour), before the window; it is not new in 4.6.62. Closed via Stop & Quit, 1.1 s, 0 left. Copies
     deleted. (The test still writes to the real %APPDATA%\Ether startup log — main.js sets userData itself.)

## What is in it (on top of 4.6.61)

| Commit | What |
|---|---|
| `bbd074e` | Sync holds a reference that arrives as another computer's bare number (never filed under ours); Health Monitor "Sync changes held"; read-only per-song category export script |
| `1dba263` | PINs stored with scrypt (old formats still verify and upgrade); users sync to every computer (v67), same name + same station = one person |
| `05484e5` | No builder designation: every computer builds its own log for every station; the R2 deletion sweep is **paused** pending a decision |
| `976a6d1` | Rotation counts the plays that aired on this computer (+ the old unrecorded ones) |
| `6e3040c` | Play Log: Aired on (v68), computer filter followed by every export, From/To times, no row cap (virtual list); local-time date fix |
| `aee6ffd` | Sync: every station by identity with its own position; one sync switch per computer (live), SYNC OFF everywhere; a restore discards unsent changes; "Send this restore to every machine" |
| `1dfb666` | Backups by setting per computer (local + cloud, how often / how many), worker-made, every backup listed to restore from |
| `56c1566` | 4.6.62; audit alias fix |
| `e4d7562` | Cloud audio cleanup is an admin button (nothing claims it); BMI and ASCAP back to each society's exact format (the computer filter still applies) |

ether-backend (local commits, **not deployed**): `c61b6ab` scrypt PIN verify for the dashboard login; `8c30634`
per-computer backup keys, `/backup/list`, `/backup/prune`, download of a chosen backup.
**Deploy the backend before 4.6.62 reaches a computer whose users log into the dashboard** (an upgraded PIN is scrypt).

## Gates (56c1566)

tsc 0 · vitest 115 files / 967 · verify:schema · test:sync 55 · **prove:two-computers 23/23** · test:backups 10/10 ·
test:users-sync 20/20 · test:held-refs 7/7 · test:plays-here 7/7 · test:show-log-check 9/9 · test:three-pm 38/38 ·
uuid-refs, sweeper-assignments, programlog-reads/-writes, hour-rollover, autopost-switch, sweeper-sense, window-station,
copy-on-import, catalogue-r2, sign-filter, spot-edge, queue-rows, stale-rows, calendar-anchor, ipc-contract,
preload-bridge, undefined-calls PASS. Failing as before: test:one-switch (old test file), scheduler gate T3/T15/T18.

## Open for Jeff

1. **Backend deploy** — compatibility written up in `docs/backend-deploy-compat-4.6.61-2026-10-20.md` (4.6.61 keeps
   working; a deploy would also ship park-talk `61852fc`; mixed 4.6.61/4.6.62 computers: 4.6.61 holds 4.6.62's changes
   until it upgrades). Waiting for Jeff's OK.
2. **Backup starting values** were not answered; today's are used (local Off / keep 10; cloud 6 h / keep all), shown
   and changeable.
