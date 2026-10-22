# Sync / station swap: Ether's own connections kept -wal/-shm locked (2026-10-21)

## Jeff's report (verbatim)

> Bug, 4.6.62: on my work PC, joining HalloVeen by sync fails with "openair.db-wal and openair.db-shm could not be
> released ... something outside Ether is holding those files". It's Ether itself: Windows said the file was in use, and
> with Ether closed the -wal file was gone.

**The defect:** joining a station by sync fails, and the message blames outside software when Ether is the holder.

## Cause (from the code, reproduced on real files)

`swapDatabaseFile` (`electron/main.js`, the one path every restore / sync / cloud install uses — 4 callers) released two
connections: main's own and the audio daemon's (`releaseDb`). It did not touch the rest:

| Connection | Where | Released before this fix? |
|---|---|---|
| Main's own | `electron/main.js` `openDb` | Yes; the restore gate stops `getDb()` reopening it |
| Audio daemon | `audiod/ether-audiod.js` `getDb()` | Closed by `releaseDb`, **but reopened by the next timer** — `getDb()` reopens lazily, and the Remote Link reads its keys every 3 s (also board and station lookups) |
| **Show-log worker** (4.6.61) | `electron/show-log-worker.js` | **No** — read-only connection held for the life of the app |
| **Library-health worker** (2026-10-12) | `electron/library-health-worker.js` | **No** — read-only connection held for the life of the app (sweeps + the 60 s library mirror, `db:query-offmain`) |
| Local backup / cloud backup (4.6.62) | `electron/backup-worker.js` via `backups.js`, `cloud-backup.js` | **No** — can be mid-run |
| Startup background work, sync cleanup (button + automatic) | `startup-heavy-worker.js`, `sync/purge-excluded-queue-worker.js` | **No** — can be mid-run |
| Verify / migrate probes | `db-verify-worker.js`, `profile-migrate.js` | Not holders: short-lived, on the source file or after the copy |

On Windows any one open connection keeps `-wal`/`-shm` undeletable. The smoke test reproduces it: with main's connection
closed, the show-log and library-health workers alone make Windows refuse the delete.

The old message assumed anything still holding the files was outside Ether ("antivirus or backup software is the usual
cause"). Nothing checked.

## Fix

- **`electron/db-holders.js` (new):** one registry of every worker connection. Persistent holders `register` a
  release/reacquire pair; one-job workers are `track`ed. `releaseAll()` closes the persistent ones, waits (5 s) for
  running jobs and then stops them, and reports one line per holder. While released, a newly started job worker is
  stopped at once. `reacquireAll()` lets them reopen.
- **Registered / tracked:** show-log worker (asked to close, then ended; the next check starts a fresh one), library-health
  worker (`release` / `reacquire` messages; refuses to reopen while released), local backup, cloud backup, startup
  background work, sync cleanup (button and automatic).
- **Audio daemon:** `releaseDb` sets a flag so `getDb()` refuses to reopen; new `reacquireDb` clears it.
- **`swapDatabaseFile`:** after the daemon's release, `dbHolders.releaseAll()` (each result in the restore log); in its
  `finally`, after main reopens, `dbHolders.reacquireAll()` and `reacquireDb` to the daemon — on success, abort and rollback.
  `_buildShowLogs` and `_showLogCheck` do nothing while a swap holds the file.
- **The message (`stuckFilesMessage`):** if files are still locked, Ether asks Windows who holds them
  (`electron/file-lockers-win.js`, the Restart Manager — the API behind Windows' own "file in use by …"), logs the answer,
  and says what was observed:
  - an Ether part that did not release, or Windows names Ether → "Ether itself is still holding …" + close Ether
    completely (tray too), reopen, sync again;
  - Windows names another program → that program by name and process id;
  - Windows names no one → says so; blames no one.
  Every case ends "Your current station is untouched and still running."

## Tests

- `electron/db-holders.test.js` (vitest, runs in CI on every tag): 8 tests — release/reacquire, a holder that never
  answers is named (no hang), a running job waits then is stopped, a job started mid-swap is stopped, and the message in
  all four cases (Ether holding is never reported as outside software).
- `npm run test:db-release` (`scripts/smoke-db-release.js`, Electron as Node, local — better-sqlite3 is built for
  Electron, as with `test:sync`): real WAL database, the real show-log worker and the real library-health host/worker.
  **11/11 PASS** on this Windows machine:
  reproduces the lock (Windows refuses the delete) → Windows names this process as the holder → message says "Ether
  itself" → release → `-wal`/`-shm` removed → nothing reopens while released → after reacquire both read the new database.
- Full suite: vitest 116 files / 976 tests pass; `tsc --noEmit` 0 errors.

## Not verified

- **The sync on your work PC.** The one check: install the next build there, join HalloVeen by sync. The restore log
  should show `quiesce: show-log worker — closed`, `quiesce: library-health worker — closed`, then
  `quiesce: journal files removed and unlocked`.
- **The daemon flag** has no test (the daemon is its own process). The daemon log should show `releaseDb — … db CLOSED`,
  no `opened library` until `reacquireDb — the database may be reopened`.
- The daemon does not reload on auto-update: until Ether is fully closed and reopened after installing, an older daemon
  answers `reacquireDb` as an unknown command (logged, harmless) and still reopens on its own as before. The installer
  closes Ether, so a normal install starts the new daemon.

## Architecture compliance

- One swap path stays one path: everything goes through `swapDatabaseFile`; the restore gate (`main.js`, "RESTORE GATE")
  is extended to the workers, not duplicated.
- Built-in sense, not scaffolding (CLAUDE.md "BUILD THE SENSE"): who held the files is observed (Restart Manager) and
  written to the restore log at the moment of failure; no watcher, no poller.
- Offline-first: nothing here touches the network.
- Not built: no change to account/profile switching (a different file per profile, not this report).
