# 4.6.62 (2026-10-20) — contents, gates, and where the build stands

## Status

- **All work committed locally** on `release/1019` (HEAD `56c1566`, version 4.6.62). Not pushed, not tagged.
- **The installer build was STOPPED by the system for low memory** (Claude Code's memory guard, ~2.7 GB free) right as
  electron-builder started. The renderer build had finished (`dist/`, 16:27); no 4.6.62 installer exists, and
  `dist-electron/win-unpacked` is still the untouched 4.6.61 package (no torn package). **Not restarted** — it needs a
  moment with more free memory (e.g. Ether or other apps closed on OVEVENTS).
- The release checks (contents, size, launch on a copy of real data) have **not run** for 4.6.62. A sanitized copy of
  OVEVENTS' live database is ready in the scratchpad (`realcopy462`, schema v66 — the launch will also run v67/v68 on
  real data).

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

1. **R2 deletion sweep is paused** (it was the one designation-gated cleanup that deletes cloud audio): which computer
   may release cloud audio?
2. **Backend deploy** (`c61b6ab`, `8c30634`) — before this build is installed anywhere.
3. **Starting values for backups** were not answered; today's are used (local Off / keep 10; cloud 6 h / keep all), all
   shown and changeable in Backups on this computer.
4. Run the build again when memory allows; then the three release checks.
