# Backup / Sync / Restore — what each one actually is, what broke, what was fixed

**Date:** 2026-08-07 · **Status: FIXED LOCALLY (uncommitted). Bucket cleanup BLOCKED — see §6.**
Follows `cloud-backup-torn-wal-2026-08-07.md` and the OV licence work.

---

## 1. There are two different things called "sync" — and I traced the wrong one

Jeff's report, verbatim:

> "the original install on the OV machine was a successful sync so something has been adjusted in the
> code it has worked before"
> "i have used sync before and watched the songs populate so i dont knwo where you are looking"

He is right, and there was no contradiction — there are two separate mechanisms:

| | **The one that works (Jeff's)** | **The one I traced** |
|---|---|---|
| What | Cloud install: R2 backup → download → `swapDatabaseFile` | CRDT mutation engine |
| Entry point | `station:install-from-cloud` (`main.js`), screen at `OnboardingFlow.tsx:1435` — the one that says **"Sync failed"** | `sync_enabled` / `mutations` / `/sync/mutations` |
| History | Delivered OV's original content (see the OV licence-migration record: "cloud backup + Sync-from-cloud") | **Has never run on any machine** |
| State | Was broken (torn backups); input now verified good | Dormant. 297,975 local mutations, all pending/origin=local, no cursor, backend `server_seq=0` |

**Reporting "sync never ran" was wrong-headed** — accurate about the dormant engine, irrelevant to the
mechanism that delivers content. Enabling the mutation engine is NOT what fixes OV and is not proposed
here. (If it is ever turned on, note it would push ~298k queued mutations, 81% of them
`generated_schedule` rows — a separate decision with its own risks.)

## 2. The cloud backup is now verified good

Downloaded the account's current backup and ran OV's exact restore probe against the real file:

```
backup timestamp   2026-08-07T16:23:36Z      ← after the 4.4.161 online-snapshot fix
82 MB gz → 449 MB
OPENS OK — songs 543 · clocks 4 · categories 14 · schedule 97,958
204 schema objects · integrity_check: ok
```

The 4.4.161 backup fix took. The torn file that produced OV's "malformed database schema" is superseded.
**Remaining step is on OV** (no access from here): run the cloud install again — it now pulls this file.

## 3. Restore can no longer dead-end (`main.js`, `validateDatabaseFile`)

Previously `swapDatabaseFile` closed and overwrote the live DB *first*, discovered the file was bad on
reopen, then rolled back. Data survived — the operator got a failed restore and a scary error.

Now the source file is validated **before anything is touched**: open read-only, force the schema parse
(exactly where a torn file throws `malformed database schema`), probe `system_state` and `songs`. A bad
file is refused with *"That backup file is damaged and was not used — your current station is untouched
and still running."* The live DB is never closed. Covers all three restore callers (`db:restore`,
`restore_db`, `station:install-from-cloud`).

Proven against real damage:

```
a real station database            accepted — 205 objects, 511 songs
truncated mid-file (torn upload)   refused — database disk image is malformed
only the first pages landed        refused — database disk image is malformed
not a database at all              refused — file is not a database
zero bytes (failed download)       refused — schema looks truncated (0 objects)
```

**Not built:** fallback to an *older* backup. The backend only exposes `/backup/download-url` (latest);
there is no list endpoint. Needs a backend change.

## 4. The uploader was pushing deleted songs

Jeff's report, verbatim:

> "for one there are 543 songs where did you get 511 thats incorrect"

He was right. Both numbers were real and I failed to reconcile them:

```
uploader's selection (main.js:7593)   543   = 511 live + 32 DELETED
the library itself                    543 rows, 511 live, 32 deleted
deleted rows with a file_path          32
deleted rows with a file_key           32
```

The uploader's `WHERE` had **no `deleted_at IS NULL`**. Deleted songs retain `file_path`/`file_key` (the
row is kept for play history), so all 32 were consolidated, uploaded, counted in the operator's progress
denominator, and would be handed back to any machine restoring from cloud. That contradicts the delete
ruling — *a delete is a delete from the foundation up*, and the cloud is part of the foundation.

**Fixed:** `deleted_at IS NULL` added to both the consolidate query (`main.js:7592`) and the upload query
(`main.js:7674`). The progress bar now counts the real library.

## 5. "Your station is backed up" was claiming something it didn't know

Jeff's report, verbatim:

> "the confusing part is it says yoru safely backed up now but thats database not the song library do
> they both need to be successfully uploaded complete or if the song library is incomplete does it
> break? there needs to be one button for everything or a notification that says song library is
> unfinished if thats the case because its misleading and a cat chase"

**Does an incomplete library break it? No — and that is worse.** The restore succeeds, the station comes
up, every song appears in the library, and the ones whose audio never uploaded simply can't play. No
error, no warning. Same failure class as the R2-materialization gate where half a library never aired.
**This is very likely the OV cat-chase**: pull the database before the audio finishes and you get a
full-looking station with missing audio, which reads as "sync didn't work."

Fixed per Jeff's direction — one button for everything, library backup still available separately, and
nothing claims "backed up" until the transfer is 100%:

- **`library:cloud-status`** (new IPC, `main.js`) — live songs total / uploaded / pending, counted from
  the database. Honest state, observed rather than claimed.
- **`runCloudBackupNow`** (`SettingsPanel.tsx`) — database backup, then any songs still missing from the
  cloud, then **re-reads the counts** before deciding what to report.
- **Status hero** — green ✓ only when the DB backup succeeded AND `pending === 0`. Otherwise amber:
  *"N of M songs aren't in the cloud — they'd arrive on another computer with no audio."* Button becomes
  **Finish backing up**.
- **"Send my music to the cloud"** stays as its own separate action, now with a live count beneath it.

## 5b. Why OV and not the others — the restore staged its download on ROAMING

Jeff's receipt:

> "before we go anyfurther i just tried a sync on the jensj computer which was also a very old version
> and its working so its only something specific on the OV machine"

Screenshot: *"Installing your station… Downloading your music library for halloVeen… 543 tracks, 5%."*

That rules out the version and the backup: an **old** build restored the **same** backup successfully.
The failure is local to OV.

**What the source shows** (`C:\openair` — the code that runs on OV; NOT an inspection of that machine):

- `main.js:148` — `app.setPath("userData", %APPDATA%\Ether)`. That is **Roaming**.
- `main.js:4014` (before this change) — the restore wrote its temporary 449 MB download to
  `app.getPath("userData")`, i.e. Roaming.
- `getDbPath()` (`main.js:955`) carries the reason this matters, in its own comment: *"Managed/OV
  profiles redirect Roaming AppData to a network H:\ share."* The database was deliberately moved to
  `%LOCALAPPDATA%` for exactly that reason — but the restore's staging file was left behind on Roaming.

So on a normal box Roaming is local and a 449 MB write is fine (jensj — works). On a managed box whose
Roaming is a redirected network share, that write is where the file arrives truncated — and a truncated
file fails at open with `malformed database schema`. Fits "works everywhere except OV" exactly.

**Status: HYPOTHESIS from the source, NOT a runtime receipt.** OV's redirection and free space cannot be
confirmed from here. The check that settles it, on OV: Help → About shows the app data folder — if it is
on `H:\` rather than `C:\`, this is it.

> **SUPERSEDED IN PART — see `ov-restore-mis-assembled-file-2026-08-07.md`.** Jeff supplied OV's actual
> database files, which proved the file OV received had pages in the wrong places (SQLite reported a
> `metadata_definitions.uuid` DATA value as a schema object name). Local damage is now a measured fact;
> Roaming/`H:\` remains the most likely local cause but is still the unproven part.

**Fixed regardless, because the temp file has no business on a network share:**

- staging moved to `_etherDir()` = `%LOCALAPPDATA%\Ether\com.ether.radio` — machine-local, never
  redirected, and the same volume the file is copied to next;
- the staged file's size is compared against the download before it goes near the live DB, so a short
  write (full disk, interrupted share) is reported as *"the downloaded backup didn't save completely
  (X of Y bytes) — check free disk space and try again"* instead of surfacing later as corruption.

Note: a restore transiently needs ~3× the DB size on the local volume (staged copy + `.pre-restore` +
the live file). At 449 MB that is ~1.3 GB.

## 6. BLOCKED — removing the deleted songs' audio from R2

Jeff: *"and yes clean out the bad uploads"* — authorized, not yet executed.

Safety check first, and it earned its keep. `file_key` is only a basename, so a deleted song can share a
key with a **live** song:

```
deleted songs with a cloud object : 32
  SAFE to remove                  : 30
  MUST KEEP (shared with a live song) : 2
      Golden_spotdown.org.mp3
      I Like You (A Happier Song) (with Doja Cat)_spotdown.org.mp3
```

Deleting those two would have broken live songs. The safe list of 30 keys is computed.

**The blocker:** this install holds no R2 credentials (`cloud_backup_r2` row absent — customer-side creds
were removed in Phase 1.3f) and the backend exposes no delete route. Uploads go through signed PUT URLs
only. Executing the cleanup needs one of:

1. a backend delete endpoint (`ether-backend`, separate repo — also the right long-term home, so
   deleting a song removes its cloud object as part of the delete foundation);
2. direct Cloudflare R2 credentials for a one-off script (safe list already prepared);
3. manual deletion of the 30 named objects in the Cloudflare dashboard.

Awaiting Jeff's choice. Nothing in the bucket has been touched.

## 7. Verification status

| Claim | Evidence |
|---|---|
| Current cloud backup is complete and restorable | Downloaded and opened it; integrity_check ok |
| Restore refuses damaged files without touching the live DB | 5/5 cases, real damaged files |
| Uploader no longer selects deleted songs | Source change; **runtime UNVERIFIED** — needs a run |
| Status reports both halves honestly | Source change; **runtime UNVERIFIED** — needs the app launched |
| OV restores successfully | **UNVERIFIED — no access to that machine.** Jeff's run settles it |

Typecheck: the two standing baseline errors only (OnboardingFlow, PhoneDesk). No new errors.
Nothing committed; no build cut.
