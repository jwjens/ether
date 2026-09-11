# Relay brief — identify OV's 4 "missing" rows (READ-ONLY)

**For:** the Claude Code session running on **OV** (Opportunity Village).
**From:** the OVEVENTS session. I cannot read OV's database from here, so this is the brief rather
than the answer.
**Date:** 2026-09-11.

Copy everything below the line into the OV session.

---

## Task

OV's Health Monitor reports **4 missing**. Identify exactly which 4 rows, and for each one establish
whether it was already on this machine or arrived from OVEVENTS through sync.

**This is READ-ONLY. Investigate and report. Change nothing, repair nothing, and do not offer to.**

## Hard rules

1. **NEVER write the live `openair.db`.** OV is a production station and Ether is probably on air.
   External writes against the live DB while Ether holds it open corrupt it. If you need SQLite
   access, copy `openair.db` **and** `openair.db-wal` to a temp directory and read the copy. Never
   open the live file read-write, and never run a repair.
2. **No inline `node -e` / `electron -e`** — quoting breaks. Write a `.js` file and run it.
3. OV is a **packaged install**: there is no `C:\openair`, no `npm`, no `node_modules` on disk
   outside the app. Two workable routes:
   - **DevTools on the running app** — `await window.ether.db.query(sql, params)` runs arbitrary
     SELECTs through the app's own connection. Safest, and needs no file access. Returns
     `{rows:[...]}` — unwrap `.rows`.
   - **A script under the packaged Electron**, if you need `fs` checks:
     `ELECTRON_RUN_AS_NODE=1 "<install>\Ether.exe" yourscript.js`, requiring better-sqlite3 from
     `resources\app.asar.unpacked\node_modules\better-sqlite3`.
4. Report findings; do not act on them.

## Where things are

- Active profile: read `%LOCALAPPDATA%\Ether\profiles\active` → gives `<PROFILE>`.
- Database: `%LOCALAPPDATA%\Ether\profiles\<PROFILE>\openair.db`.
- Catalogue root (where audio is supposed to live): `%LOCALAPPDATA%\Ether\profiles\<PROFILE>\music-dir.txt`,
  or the path shown under Preferences → Backup & Restore → Advanced → **WHERE YOUR AUDIO LIVES**.

## What "missing" means

From `electron/library-health.js` `classifyRow()`. A row is **`dead`** — what the Health Monitor
shows as missing — when **all** of these hold:

- it has a `file_path`, and
- that file does not exist on disk, and
- the catalogue index cannot find a file of the same basename anywhere in the catalogue
  (`resolvesElsewhere` would be the class if it could), and
- it has no `file_key` (`r2Only` would be the class if it did).

Audio tables scanned, from `electron/audio-library-index.js`:

```
songs · announcements · spots · cart_slots · library_asset · published_episodes · voice_tracks
```

Only tables that actually have a `file_path` column are scanned; rows with `deleted_at` set are
excluded.

## Step 1 — find the 4

For each of the seven tables, list rows with a non-empty `file_path`, then check each path with
`fs.existsSync`. Keep the ones that do not exist, that have no `file_key`, and whose basename does
not appear anywhere under the catalogue root.

Report for each of the 4: **table · id · uuid · title (or name) · file_path verbatim**.

Report `file_path` **exactly as stored** — do not normalise slashes, do not shorten, do not tidy the
drive letter. The literal string is the evidence.

## Step 2 — old business, or newly arrived?

This is the question that matters. For each of the 4, get its `updated_at` and `created_at`, then ask
whether it ever came in through the mutation stream.

Inbound mutations are written by `electron/sync/merge-engine.js:92` with `origin='remote'`.
**`mutations.row_id` holds the row's UUID, not its integer id** — join on uuid.

```sql
SELECT id, origin, op, sync_status, created_at, applied_at, client_id
FROM mutations
WHERE table_name = ?      -- 'songs', 'cart_slots', …
  AND row_id = ?          -- the ROW'S UUID
ORDER BY created_at;
```

- **Any row with `origin='remote'`** → this row arrived from another machine. Note the earliest
  remote `created_at`.
- **Only `origin='local'`, or no mutations at all** → the row originated here.

Also useful, once, for context:

```sql
SELECT origin, COUNT(*) n FROM mutations GROUP BY origin;
SELECT MIN(created_at), MAX(created_at) FROM mutations WHERE origin='remote';
```

That last one tells us when this install started receiving, which dates the boundary between "old
business" and "arrived since sync went on".

## Step 3 — what it means

- **Row was already on OV, only local mutations** → old business. A pre-existing local gap, nothing
  to do with sync. Say so and stop.
- **Row arrived (`origin='remote'`) and its `file_path` is a path shaped like another machine's** —
  anything under `C:\Users\jensj\…`, or any directory that is not OV's catalogue root — **that is
  [N-23a] failing.** The receiver is supposed to take the sender's basename and rebuild the path as
  `<OV catalogue>/<basename>`; a foreign directory in the stored value means it stored the sender's
  path verbatim instead.
- **Row arrived and its `file_path` IS `<OV catalogue>/<basename>`, but the file is not there** →
  [N-23a] worked and the row is correct; the **audio** simply has not arrived yet, or never went up
  from the sender. Different problem, and a much less serious one. Check whether the basename exists
  in the cloud (Preferences → Backup & Restore shows the catalogue's cloud count) before concluding.

Distinguishing those last two is the entire point of the exercise — do not collapse them.

## Report back

For each of the 4, one block:

```
table · id · uuid
title:        …
file_path:    <verbatim>
exists:       no
file_key:     null | <value>
created_at:   …
updated_at:   …
mutations:    N local, M remote   (earliest remote: …)
verdict:      already here | arrived + path rebuilt correctly | arrived + FOREIGN PATH ([N-23a] failing)
```

Plus the one-line context: total `origin='local'` vs `origin='remote'` mutation counts, and the date
range of remote ones.

Paste raw output. Do not summarise, do not round, do not tidy paths.

---

## Note for Jeff, not for the OV session

The Health Monitor says "4 missing" and cannot say **which 4**. `library-health.js:245` builds a
`foreignSample` but no equivalent for `dead`, so the count is reportable and the rows are not — which
is why answering this needs a second machine and a relayed prompt at all.

That is a product gap of exactly the kind the build-the-sense rule is about: the panel that raises
the alarm should be able to name what it is alarmed about. Proposed, not built: carry a `deadSample`
alongside `foreignSample` and let the Health Monitor expand "4 missing" into the four rows, with
table, title and path. Small change, and it retires this whole relay procedure.
