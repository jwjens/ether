# Why 4.6.23's files-half fix did not take

**Reported:** Jeff, 2026-09-11, on 4.6.23 — *"The switch was already off, I closed and reopened, and
it's still off on screen — but `(await window.ether.cloudBackup.getR2Config()).enabled` still reads
true."*
**Status:** DIAGNOSED, then FIXED the same day by Option A — the second flag is deleted, not repaired.

## The installed build is the right one

```
installed app.asar   259,813,511 bytes   Sep 11 07:26
package.json         "version": "4.6.23"
cloud_backup_r2 references in the installed electron/cloud-backup.js:  5
```

So this is not a stale install. The code shipped.

## Link 3 — the load path — WORKS, and correctly found nothing

Read-only dump of the live profile DB:

```
cloud_backup_r2      → NO ROW
cloud_backup_config  → NO ROW
sync_enabled         station 1 = false    station 2 = false   (stations 3, 4: no row)
```

`installCloudBackup()` reads the key, finds no row, and keeps the default. That is exactly what it
was written to do. It is not the failure.

## Link 1 — the toggle — never ran

The switch was **already off**. `toggleKeepSynced()` runs on a click, and there was no click, so
`setR2Config` was never called. The 4.6.23 fix only engages on a *transition*.

**This is my error, and it is the one that matters.** I told Jeff the check was "flip the switch off,
restart, confirm it reads false" — but an install already off cannot flip off without first flipping
on. Every existing install is in the already-off-and-never-written state, which is the one state the
fix does not reach. I named this seam in `one-switch-files-half-not-persisted-2026-09-09.md` as a
reason to skip boot-start, and failed to notice it also meant the stored value is never created.

## Link 2 — the write — would have thrown anyway

Even with a click, the row could not have been written. `saveR2Config()` (`cloud-backup.js:409`):

```sql
INSERT OR REPLACE INTO station_config_kv (key, value) VALUES ('cloud_backup_r2', ?)
```

The table:

```sql
CREATE TABLE station_config_kv (
  station_id INTEGER NOT NULL,          -- omitted by the insert
  key        TEXT    NOT NULL,
  value      TEXT,
  uuid       TEXT    NOT NULL,          -- omitted by the insert
  ...
  PRIMARY KEY (station_id, key)
)
```

Running that exact statement against a copy of the live DB:

```
SQLITE_CONSTRAINT_NOTNULL: NOT NULL constraint failed: station_config_kv.station_id
```

`saveR2Config` wraps it in try/catch and reports with `console.error`, which a packaged build
discards — so it has been failing silently for as long as it has existed. The legacy
`cloud-backup:set-config` (`:168`) has the identical shape and throws identically, which is why
`cloud_backup_config` has no row either.

**This is the same defect as the designation upsert bug** — a hand-rolled INSERT omitting the
NOT NULL `uuid` (and here `station_id` too) instead of going through the sanctioned writer,
`stationConfigKvUpsertByKey(db, stationId, key, value)` in `sync/handlers/station_config_kv.js:228`,
which generates the uuid and requires the station id.

## Two shapes for the fix — Jeff's call, nothing built

**A. Delete the second flag.** The files half stops being its own stored boolean and simply reads
the rows half, `sync_enabled`, for the active station. One flag, one writer, no seed question, no
`enabled: true` literal, and the two halves cannot diverge because there is only one. `intervalHours`
keeps its own key, written through the sanctioned writer. This is what "one switch" actually means
and it deletes the defect class rather than repairing an instance.

**B. Repair the instance.** Route `saveR2Config()` through `stationConfigKvUpsertByKey`, decide which
station the install-scoped row belongs to, and add a one-time seed so an install that has never
touched the switch gets a stored value that matches what the card shows. More moving parts, and the
seed question stays open.

A is recommended. Either way `r2Config.enabled`'s hardcoded `true` at `cloud-backup.js:38` stops
being the thing that decides whether a station is sending.

## Separately: "Waiting to sync 4" (now 6) is real, and is not draining

Not a counting problem — the counter is right this time. All six pushable pending rows are
`station_config_kv` updates to the **`designated_generator`** key for stations 3 and 4, and the only
field that changes between them is `last_checked`:

```
1789139026 → 1789140757 → 1789141280 → 1789141465     (15:03, 15:32, 15:41, 15:44 today)
```

`machine_id` and `last_generated` are unchanged throughout. It is a heartbeat writing a timestamp
into a synced table, journalling a pushable mutation every time it ticks. They are not draining
because `sync_enabled` is false on every station, so the engine is not running to send them.

With sync ON they would drain and immediately regenerate. With sync OFF they accumulate without
bound — the same root disease as the 79,341 (the mutation writer journals every write), except this
time in a table the push query does not exclude, so the number is honest about a backlog that should
not exist. **Ticketed, not started:** either the heartbeat stops rewriting a synced row on every
poll, or `designated_generator` joins the local-only key list.

Totals at time of diagnosis: 156,979 mutations · 79,347 pending · 6 pushable · 79,341 journal-only ·
77,477 synced · 155 conflicted.

---

# Resolution — Option A: there is no second flag

Jeff, 2026-09-11: *"Delete the second flag — the files half reads sync_enabled for the active
station. One flag, one writer. intervalHours keeps its own key through the sanctioned writer."*
And on the literal: *"That also kills the hardcoded `enabled: true` at cloud-backup.js:38, which is
the thing that's been arming the gate all along."*

## What changed

`filesHalfEnabled()` in `electron/cloud-backup.js` reads `sync_enabled` for the active station, and
`r2Ready()` asks it. The stored boolean is gone, and with it all three failures at once:

- **Nothing to seed.** A derived value cannot be stale, so an install that has never touched the
  switch is already correct. That was the state every existing install was in, and the one the
  previous fix could not reach.
- **Nothing to write wrong.** There is no flag write left to throw NOT NULL.
- **No default to arm the gate.** `enabled: true` is out of the `r2Config` literal. Absence of a
  `sync_enabled` row now reads as OFF, which is the safe direction: an unset switch sends nothing.

`intervalHours` keeps its own key, `cloud_backup_interval_hours`, written through
`stationConfigKvUpsertByKey`. `cloud-backup:set-r2-config` no longer reads `enabled` out of its
payload and must never do so again; it re-evaluates the timer from `filesHalfEnabled()` on every
call, which is why the one switch still calls it — to start or stop the schedule in the same session
rather than at the next launch.

## The sweep — it was three, not two

Every hand-rolled INSERT into `station_config_kv` in shipped code. The table declares
`station_id INTEGER NOT NULL` (PK) and `uuid TEXT NOT NULL`; an INSERT naming neither throws
`SQLITE_CONSTRAINT_NOTNULL`, and all three callers swallowed it.

| site | key | consequence |
|---|---|---|
| `cloud-backup.js` saveR2Config | `cloud_backup_r2` | the switch could never persist (this bug) |
| `cloud-backup.js` saveConfig + set-config handler | `cloud_backup_config` | backup bookkeeping never persisted; two copies of the same statement |
| `ai-voice.js` setConfig | `ai_voice_config` | **AI Voice settings, including the provider API key, have never survived a restart** |

All three now go through the sanctioned writers. Classification, which the sweep forced:

- `cloud_backup_interval_hours` → `stationConfigKvUpsertByKey` (synced). It is an operator setting
  for the station, like the switch itself.
- `cloud_backup_config` → `stationConfigKvSetLocal`, added to `LOCAL_ONLY_KEYS`. It records when
  THIS machine last backed up; syncing it lets one install overwrite another's account of its own
  work — the same reasoning as `sweep_last_run`.
- `ai_voice_config` → `stationConfigKvSetLocal`, added to `LOCAL_ONLY_KEYS`. **It holds a provider
  API key**, and a credential must not enter the mutation stream, which is a durable journal that
  travels to every peer on the account.

Both reads were also station-scoped to match, since they had been reading an arbitrary station's row.

### Looked at and deliberately left alone

- `main.js:2155` — INSERT inside the v8 migration, against a table the migration has just created
  with the old three-column shape. There is no `uuid` column to name. Marked `GUARD-EXEMPT`.
- `smoke-designation-write.js:86` — a deliberately malformed INSERT that the test requires to throw.
  It is the subject of the test, not a caller. Marked `GUARD-EXEMPT`.
- `main.js:1139`, `:5941` — UPDATEs, not INSERTs, and unscoped by documented intent (sign-out clears
  account keys across all stations; install-from-cloud re-stamps the license after a whole-DB swap).
  No NOT NULL exposure. Both swallow errors silently, which is worth a look another day.
- `main.js:9621` — a station-scoped DELETE of `kill_lease`. Correct as written.
- `scripts/**` — one-shot diagnostics and migrations that run against a known DB, not shipped code.

### The ratchet

`smoke-one-switch.js` §9 scans `electron/**` and `src/**` for any INSERT or REPLACE INTO
`station_config_kv` outside the handler module and fails on it. The only way past is a sanctioned
writer or a `GUARD-EXEMPT(station_config_kv-insert)` marker with a reason. Detection runs on
comment-stripped source so a comment quoting the old statement is not an offence; the marker is read
off the raw lines. **It is a ratchet, not a baseline — there is no count to raise.**

## How to verify it, on an install that is already off

The previous check could not be run on an already-off install, because it required flipping the
switch off and it was already off. This one needs no toggle, no restart, and no DevTools.

**In the app:** Preferences → Backup & Restore → **Advanced**. Beside "How often to send your setup"
there is a read-only **on** / **off**. It is `filesHalfEnabled()`'s answer — what the backup
machinery actually thinks. With the big switch off it must read **off**. Before this fix it would
have read **on**.

**In DevTools, if you want the raw value:**

```js
(await window.ether.cloudBackup.getR2Config()).enabled   // must be false while the switch is off
```

This is the same line that kept returning `true`. It now derives from `sync_enabled`, so it answers
immediately, with no state change and nothing to restart.

**To see the gate itself:**

```js
await window.ether.cloudBackup.setR2Config({})   // → { ok: true, ready: false } while off
```

An empty payload writes nothing — the handler only saves an interval that is valid and different —
so this is a read of `r2Ready()` with no side effect.

**Both directions, one session:** flip the switch on, re-run either check (true / ready), flip it
off, re-run (false / not ready). No restart, because nothing is cached.

## Still not built

Boot does not start the backup timer; it only starts when the switch is flipped during a session.
`installCloudBackup` auto-starts from the legacy `config.enabled` only, which nothing sets. The seam
that made this risky is gone now that the flag is derived — an install reading OFF can no longer
start a timer at boot — so this is a clean one-line change whenever Jeff wants it. Not taken in this
commit because it was not asked for.
