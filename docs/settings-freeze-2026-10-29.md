# Settings freezes Ether for 5+ seconds — cause and fix (2026-10-29)

**Jeff (verbatim):** "On the installed 4.6.68, opening Settings still freezes Ether for at least 5 seconds. I just opened it
on this computer around 8:30 AM. … find what runs when Settings opens and blocks the window, and fix the root cause so
Settings is usable the moment it appears; anything slow loads in the background and fills in when ready."

## What Ether recorded (installed 4.6.68, OVEVENTS, health ledger)

- `main-stall` at 15:29:27Z: **Main was blocked 9,018 ms**, held by `q electron/main.js:13841` (~8,827 ms); IPC in flight:
  **`ipc sync:preflight 8836 ms`**.
- Again at 15:30:07Z: IPC **`sync:preflight 9962 ms`**.
- The same moments: `watchdog-late` 8.1 s and 9.3 s (the output watchdog on main ran late), and every station's health
  went YELLOW "event-loop lag 9871ms" / "11250ms". Main carries the board, the announcement tick and every engine command.

## Cause

Opening Settings mounts the multi-machine sync section, which calls `sync:preflight` at once. That handler counted the
sync journal (`mutations`) synchronously on main. On this computer the journal holds 200,695 rows in a 713 MB database,
and `byOrigin` (`GROUP BY origin`) has no index to use, so it reads the whole table. Timed read-only on the live database:

| query | cold | warm |
|---|---|---|
| byOrigin | **12,801 ms** | 1,265 ms |
| byStatus | 209 ms | 71 ms |
| songDeletes | 191 ms | 64 ms |
| total | 254 ms | 24 ms |
| pending / pendingPushable | 2 ms | 1 ms |

## Fix

- `sync:preflight` returns only the instant part (this computer, stations, switch, engine running, baseline). It reads
  nothing from the journal.
- New `sync:preflight-journal`: the journal counts run on the screen-read worker's own read-only connection
  (`electron/screen-read-queries.js` `syncJournal`, same SQL, same answers); main only waits on its message.
- Settings shows the section straight away, "counting…" where the numbers go, and fills them in when they arrive. CLEAR
  PENDING… stays disabled until then, because its confirmation quotes the counts.

Not done: an index on `mutations.origin` (a schema migration). With the read off main it is no longer on any window's path.

## Measured

- Before (installed 4.6.68, ledger): main blocked **8,836 ms** and **9,962 ms** by `sync:preflight`.
- After (source, real worker, a copy of this computer's database — `scripts/smoke-screen-reads.js` D): the counts equal
  the old in-thread read (200,714 journalled) and took **1,215 ms on the worker**, with main's timers running throughout
  (78 ticks).
- **UNVERIFIED on the installed build:** the after-time there needs a build with this change (Jeff: "Don't build until I
  say"). The check that settles it: install it, open Settings, then read the ledger — no `main-stall` naming
  `sync:preflight` / `sync:preflight-journal`, and no `watchdog-late` at that moment.

Tests: `electron/settings-sync-preflight.test.js` (3 of 4 fail on the previous code); `scripts/smoke-screen-reads.js` D.
Unrelated, already failing before this change: `test:one-switch` flags a hand-written insert in
`src/audio/attach-restore-sequence.test.ts:37`.
