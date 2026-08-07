# OV has no content — the cloud restore received a mis-assembled file

**Date:** 2026-08-07 · **Status: DIAGNOSED with forensic evidence. Fixes written locally, UNBUILT.**
Companion to `backup-sync-restore-three-rails-2026-08-07.md` (which covers backup/sync/restore generally).
This doc is the OV-specific diagnosis, made possible by Jeff copying OV's actual database files to `P:\`.

---

## 1. What Jeff supplied (the thing that made this solvable)

> "P:\openair.db-wal P:\openair.db-shm P:\openair.db these are the files form OV that done work"
> "P:\jensj these are the db working good files from the jensj machine for comparison"
> "not sure if that helps"

It was decisive. Two real databases — one broken machine, one working machine, same account — turned a
source-reading hypothesis into a measured conclusion. All analysis below was done **read-only on copies**
(all three files copied together each time, so no WAL was orphaned).

Earlier receipt that framed it:

> "i just tried a sync on the jensj computer which was also a very old version and its working so its
> only something specific on the OV machine"

An **old** build restoring the **same** backup successfully rules out both the version and the backup.

## 2. OV is not broken — it is empty

```
OV database: opens YES · integrity_check ok · 202 schema objects · journal_mode wal
             page_size 4096 · page_count 249 · 36 migrations applied
             songs is a TABLE (not the view-shape that stranded the other customer)
             account_license_key ETH-STN-BAA8-E056-6FC8 · license_state ok
             plan_tier station_lifetime · account_jwt present (209 chars)
             mutations 25 — all station_config_kv, latest 2026-08-07T17:24:57 (running right now)
```

The 1 MB file size (vs 452 MB on jensj) is the **empty pre-restore database it correctly rolled back to**.
`swapDatabaseFile`'s rollback did its job; the station was never bricked.

## 3. Side by side — the fault is isolated to ONE rail

| | OV | jensj (works) |
|---|---|---|
| `songs_v2` (library snapshot rail) | **350** | **350** |
| `library_snapshot_version` | 350 | 350 |
| `schema_version` | 36 | 36 |
| `account_license_key` | ETH-STN-BAA8-E056-6FC8 | same |
| `license_state` | ok | ok |
| **songs** | **0** | 543 |
| **stations** | **0** | 4 |
| clocks / categories / shows | 0 / 0 / 0 | 4 / 14 / 4 |
| generated_schedule | 0 | 97,958 |
| play_log | 0 | 39,677 |
| mutations | 25 | 301,301 |

**The library snapshot rail works identically on both machines.** `songs_v2` = 350 on OV, same as jensj —
this is the rail Jeff remembers working, and it still does. It writes to `songs_v2`
(`electron/sync/library-client.js`), a content-hash store separate from the `songs` table the app plays
from — which is why a working snapshot pull produces no visible library on a fresh install.

**Everything OV lacks arrives via one mechanism: the cloud DB restore** (`station:install-from-cloud`).

Backend check with OV's own credentials — OV and jensj are **indistinguishable to the server**:

```
/account/connect (OV key)   200 · 4 stations · plan station_lifetime · attachments 0
/account/connect (this key) 200 · 4 stations · plan station_lifetime · attachments 0
/backup/download-url        both return the SAME object: 24/backups/2026-08-07T16-52-09Z.db.gz
```

Not the licence, not the account, not the plan, not the backup.

## 4. Proof the file OV received was mis-assembled

OV's error: **`malformed database schema (429310a3-7544-4bc1-8460-c4ab621e07ba)`**

SQLite's message is `malformed database schema (<object being parsed>)`. That parenthetical is normally an
index or table name. Here it is a UUID. Tests:

```
UUID present anywhere in OV's database?            no
UUID-shaped schema objects in jensj's database?    0
UUID-shaped schema objects in this machine's DB?   0
UUID present as DATA in the working database?      YES — metadata_definitions.uuid (1 row)
```

**SQLite was reading `metadata_definitions` row data while parsing `sqlite_master`.** A database only does
that when its pages are in the wrong places. The bytes were genuine station data landing where schema
pages belong — i.e. the file was **truncated or mis-assembled on arrival**, not merely missing a WAL and
not a schema/migration mismatch.

Consistent precedent from earlier this session: copying `openair.db` without its `-wal` produced
`malformed database schema (idx_metadata_definitions_station_uuid) - index already exists` — the same
table, the same failure class.

The source backup is independently proven good: downloaded and opened it — 543 songs, 4 clocks, 14
categories, 97,958 schedule rows, 204 schema objects, `integrity_check: ok`.

**Therefore the damage occurred between R2 and OV's disk.**

## 5. Where that damage most likely happened, and what was fixed

`main.js` staged the downloaded 449 MB database at `app.getPath("userData")` = `%APPDATA%\Ether` —
**Roaming**. `getDbPath()` (`main.js:955`) carries the reason this matters in its own comment: *"Managed/OV
profiles redirect Roaming AppData to a network H:\ share."* The database was deliberately moved to
`%LOCALAPPDATA%` for that reason; the restore's staging file was left behind on Roaming. On jensj, Roaming
is local and a 449 MB write is fine. On a box whose Roaming is a redirected network share, that write is
where a file arrives truncated.

**This specific mechanism remains a hypothesis** — OV's redirection and free space cannot be measured from
here. The check that would settle it, on OV: Help → About shows the app data folder; if it is on `H:\`
rather than `C:\`, that is it. What is NOT a hypothesis: the file OV opened had pages in the wrong places
(§4), so it was damaged locally regardless of which local cause did it.

Three guards were added this session, each of which would independently have turned OV's dead end into a
clear message:

1. **Stage on local disk** — the temp file now goes to `_etherDir()` = `%LOCALAPPDATA%\Ether\com.ether.radio`,
   never Roaming, on the same volume it is copied to next.
2. **Verify the bytes** — staged file size is compared against the download; a short write reports
   *"the downloaded backup didn't save completely (X of Y bytes) — check free disk space and try again"*.
3. **Validate before swapping** (`validateDatabaseFile`) — the file must open and its schema must parse
   before the live database is closed. Proven against 5 damage cases (truncated, head-only, junk, empty,
   plus a real database accepted).

Note: a restore transiently needs ~3× the DB size on the local volume (staged + `.pre-restore` + live).
At 449 MB that is ~1.3 GB.

## 6. What OV needs

A build carrying the three guards, then run the cloud install again. Nothing has been built, bumped,
committed, or pushed.

**Rejected shortcut:** copying jensj's 452 MB `openair.db` straight onto OV. It would work, but it carries
jensj's `client_id`, which `station:install-from-cloud` deliberately re-stamps so the two machines remain
distinct sync seats. A raw copy makes OV a clone of jensj and causes downstream identity problems.

## 7. Verification status

| Claim | Evidence |
|---|---|
| OV's database is intact, just empty | Opened it: integrity ok, 202 objects, 36 migrations |
| OV's licence/account/plan are correct | `/account/connect` with OV's key: identical to jensj |
| The library snapshot rail works on OV | `songs_v2` 350 = jensj's 350; version 350 both |
| The cloud backup is complete and restorable | Downloaded and opened it; integrity ok |
| The file OV received was mis-assembled | Error's UUID is `metadata_definitions.uuid` DATA in the good DB |
| Roaming/H:\ is the specific local cause | **HYPOTHESIS** — needs Help → About on OV |
| The three guards fix OV's restore | **UNVERIFIED** — needs a build and a run on OV |

Typecheck: the two standing baseline errors only (OnboardingFlow, PhoneDesk). No new errors.
