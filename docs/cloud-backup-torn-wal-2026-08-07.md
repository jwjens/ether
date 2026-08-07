# Cloud backup is taken without the WAL — torn backups, failed restores, silent data loss

**Date:** 2026-08-07 · **Status: TRACED (read-only). FIX TO FOLLOW IN THE SAME SESSION.**
Follows the OV licence work — the 401 is resolved; this is the next failure on the same machine.

Jeff's report, verbatim:

> "The license 401 is GONE (progress), but cloud RESTORE fails with 'malformed database schema' and
> rolls back to the previous DB (the rollback working correctly — data safe)."

Screenshot: **"restore failed; rolled back to the previous database: malformed database schema
(429310a3-7544-4bc1-8460-c4ab621e07ba)"**

---

## 1. The cause — the backup is a raw read of the main file, mid-flight

`electron/cloud-backup.js:241`, inside `runBackup()`:

```js
const dbData = fs.readFileSync(dbPath);      // openair.db ONLY
```

**There is no WAL checkpoint anywhere in `electron/`** — grep for `wal_checkpoint` returns zero hits.

Ether runs SQLite in WAL mode. Committed transactions — **including schema changes** — live in
`openair.db-wal` until a checkpoint moves them into the main file. Reading only the main file therefore
captures the database *mid-flight*.

## 2. Measured on the live install (read-only)

```
openair.db       448,516,096 bytes
openair.db-wal    18,193,952 bytes   ← committed data present in NO backup
openair.db-shm        32,768 bytes
```

**Proven, independent of the restore failure: every cloud backup this code produces is missing whatever
is in the WAL at that instant.** Right now that is 18 MB of committed work. A restore from such a backup
silently rolls the station back to an older state even when it succeeds.

## 3. Why "malformed database schema" — mechanism, and the honest limit

Reading the main file while a checkpoint/write is in progress can capture `sqlite_master` in an
inconsistent state — an index recorded whose page is not yet there, or a half-visible object. SQLite
rejects that at open with `malformed database schema (<object>)`, which is exactly the reported error;
the value in the parentheses is the object it choked on while parsing.

**Direct precedent, same session:** copying `openair.db` without its `-wal` produced literally
`malformed database schema (idx_metadata_definitions_station_uuid) - index already exists`. Same error
class, different object.

**Limit, stated plainly:** when `runBackup`'s exact read was reproduced on the live DB during this
trace, the resulting file happened to open cleanly (205 schema objects, 511 songs). **The tear is
intermittent** — which fits a restore that fails on one backup and not another — and it was NOT
reproduced in that run. The WAL omission is proven; the malformed-schema mechanism is strongly
evidenced by precedent, not reproduced on demand.

## 4. Answers to the four questions asked

1. **What schema does the backup carry?** Whatever was in the main file at read time, **minus the WAL**.
   Not a version mismatch — an incomplete file.
2. **Is this the songs→view migration again?** **No.** Unrelated. A view-era backup would restore fine on
   4.4.157+, because `repairSchema()` fixes that shape on open.
3. **Does restore bring an old backup forward?** It would. `swapDatabaseFile()` (`main.js:1141`) copies
   the file in, drops stale sidecars, and calls `initDb()` — which runs `repairSchema()` and the
   migration chain. **But it never gets there:** the file fails at *open*, before any migration can run.
   The rollback then does its job, which is why the data is safe.
4. **Which build made the bad backup?** Irrelevant. Any build carrying this backup code can produce a
   torn file. The bug is version-independent.

## 5. What is working correctly

`swapDatabaseFile()` deserves credit: it copies the live DB to `.pre-restore` **before** closing, and on
any failure restores it, re-inits, and verifies with a real read before declaring success. That is why a
failed restore left the station intact rather than bricked. The rollback is not the bug.

## 6. The fix

Use SQLite's **online backup API** (`db.backup(destination)`, available in better-sqlite3 12.8.0)
instead of `fs.readFileSync`. It produces a **consistent, self-contained** snapshot that includes
everything in the WAL, safely, while the database is in use — no checkpoint race, no torn file, nothing
missing.

Rejected alternative: `PRAGMA wal_checkpoint(TRUNCATE)` immediately before `readFileSync`. It closes
the data-loss hole (demonstrated on a copy: WAL → 0 bytes, main file then opens standalone) but leaves a
race — a write between the checkpoint and the read reopens the same tear. The backup API has no such
window.

## 7. Verification planned for the fix

- The produced file **opens standalone** and passes `PRAGMA integrity_check`.
- Its row counts **match the live database including WAL content** — proving the 18 MB is no longer lost.
- Repeat while the app is actively writing, to confirm the consistency guarantee under load.
- Existing backups in R2 are not retroactively fixed; the next backup after the fix is the first good one.
