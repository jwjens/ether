# Backups — how they run today, and the settings-based plan (2026-10-20)

## Jeff's request (verbatim)

> Backups: tell me how often local and cloud backups run today, how many are kept, and where. Then make it settings-based: I set how often backups run (down to every few minutes) and how many are kept, on each computer. The restore screen lists every backup with its date and time so I can pick the one from just before a mistake. Include it in the build after 4.6.60.

Status: findings (read-only: the code at e9b02ff, ether-backend, OVEVENTS' live DB and folders) + plan. Nothing changed.

## Today

### Local ("Roll back this computer", Settings → Backup & Restore)
- **How often:** **never automatically.** Only when someone presses the button (`backup_db`, `electron/main.js:7832`; also `db:backup` `:7610`). No timer anywhere.
- **Kept:** everything **7 days**, then deleted at the next manual backup (`:7839-7843`). No count limit.
- **Where:** `%LOCALAPPDATA%\Ether\profiles\<profile>\backups\openair-backup-<unix seconds>.db`.
- **On OVEVENTS now:** **zero** snapshot backups. The folder holds only `sync-queue-purge-20261013-061404.db` (209 MB, from the 10-13 queue cleanup).
- **Defect found:** the local backup is `fs.copyFileSync` of the live database — no WAL. Ether runs SQLite in WAL mode, so a local backup can miss recent changes or be unreadable. This is the exact defect fixed for the cloud backup on 2026-08-07 (`docs/cloud-backup-torn-wal-2026-08-07.md`); the local path never got the fix.
- **Restore screen:** `list_backups` (`:7855`) returns file names only (newest first); restore = `restore_db` / `db:restore` → `swapDatabaseFile`.

### Cloud
- **How often:** **every 6 hours** (`cloud_backup_interval_hours`, starting value 6, `electron/cloud-backup.js:42,497-501`), counted from when Ether started — so a computer restarted more often than every 6 h never makes a scheduled cloud backup; plus one after every manual local backup (`triggerUpload`). Gated by the **active station's** `sync_enabled`, a pro+ plan, and a license key (`cloud-backup.js:57-78`).
- **Kept:** **all of them, forever** — nothing in the backend deletes from the backup prefix.
- **Where:** R2 bucket `ether-backups`, `<license id>/backups/<ISO time>.db.gz` + `.meta.json` (`ether-backend src/index.js:4874-4875`). Per **account**, not per computer: every computer on the account writes into the same folder.
- **Restore from cloud:** only "the newest" (`/backup/download-url`, `index.js:4912-4930`) — which may be **another computer's** database. It lists with one `ListObjectsV2` call (max 1,000 keys) and takes the last, so past 1,000 backups "newest" is wrong. No list, no choice.
- **On OVEVENTS now:** last cloud backup **2026-10-19 12:36:59 PDT** (`station 2 cloud_backup_config`: success, every 6 h).

## Plan (build after 4.6.60, with the sync work)

### Settings — per computer, never synced
Settings → Backup & Restore, **This computer**:
- **Local backups:** every **N minutes/hours** (down to 5 minutes; Off allowed), **keep the last K**.
- **Cloud backups:** every **N minutes/hours** (down to 5 minutes; Off allowed), **keep the last K for this computer**.
- Shown next to each: the database's current size × K = the space it will take (local disk / cloud), and when the last and next backup are/were.
- Stored in `install_config_kv` as **local-only keys** (the existing local-only mechanism; `electron/sync/handlers/local-only-keys.test.js`), so one computer's choice never reaches another.
- **Starting values:** the values each computer has today — local **Off** (today: manual only) keep 7 days' worth → expressed as a count; cloud **every 6 h**, keep **all**. Every number shown, every number Jeff's (no hidden defaults).
- Cloud on/off: no longer read from the active station's `sync_enabled` — its own switch on this computer (ties into the computer-wide sync switch ruling).

### Making the backups trustworthy
- Local backups use SQLite's online backup (`db.backup()`) like the cloud does, then open-and-`integrity_check` the copy before it counts; a failed one is deleted and reported.
- A schedule that survives restarts: "next due" is stored, so a restart never resets the clock.
- Safe while on air: the online backup is consistent while the database is in use.
- Senses: Health Monitor line per computer — last local / last cloud backup, OK or the failure in plain words; a backup overdue by 2× its interval is a yellow line; ledger event per backup and per prune.

### Cloud: per computer
- Key: `<license id>/backups/<computer id>/<ISO time>.db.gz` + meta (computer name, station names, song count, size, app version). Old keys stay readable as "account backups (before 4.6.6x)".
- Backend: list endpoint (paginated, all keys), download by key, prune to K **for that computer only** after each upload. **Needs an ether-backend deploy — Jeff's GO.**
- "Install from cloud" keeps working (newest of the account, or pick).

### The restore screen
- One list: **every** local and cloud backup — **date and time** (local time, to the minute), **which computer**, local/cloud, size, song count, app version. Newest first; a search/scroll that reaches every one.
- Pick one → confirm (names its time) → restore. Admin PIN as today.
- Ties into the sync rulings: restore expects sync OFF; after a restore every unsent change is discarded; then "Send this restore to every machine" (admin) or catch-up.

## Questions for Jeff
1. **Starting values:** keep today's (local Off, cloud every 6 h and keep all), or set your own now?
2. **Backend deploy** for per-computer cloud backups, the list and pruning — OK to include (deploy only on your GO)?
