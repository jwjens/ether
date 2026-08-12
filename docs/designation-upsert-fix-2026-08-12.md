# Designation record never written — root cause and fix (2026-08-12)

**Status:** FIXED, local commit pending Jeff's verification. Affects 4.4.188 → 4.4.192.
**Files:** `electron/main.js`, `src/components/HealthMonitor.tsx`, `electron/smoke-designation-write.js` (new),
`docs/help-designated-generator.md` (new), `package.json`.

---

## The report

Jeff: *"the flicker is version-wide on all machines."* The Health Monitor's **Designated generator**
row showed **None** on every machine, every version, forever.

## The receipt

Read-only query against the live install (`%LOCALAPPDATA%\Ether\com.ether.radio\openair.db`,
running 4.4.192):

```
=== designation-related rows ===
[]
total rows: 64        (all 64 have a non-null uuid)
```

Zero `designated_generator` rows. Zero `kill_designation` rows. The feature had never once written.

## Root cause

`_kvPut` in `electron/main.js` (added 4.4.188 with the designation system):

```js
INSERT INTO station_config_kv (station_id, key, value, created_at, updated_at)
VALUES (?,?,?,datetime('now'),datetime('now'))
ON CONFLICT(station_id,key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
```

The live table:

```sql
CREATE TABLE station_config_kv (
  station_id INTEGER NOT NULL,
  key        TEXT    NOT NULL,
  value      TEXT,
  uuid       TEXT    NOT NULL,        -- <-- NOT NULL, NO DEFAULT
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch()),
  deleted_at INTEGER, station_uuid TEXT,
  PRIMARY KEY (station_id, key)
)
```

**The INSERT omits `uuid`, which is `NOT NULL` with no default.** Every first write of
`designated_generator` threw `NOT NULL constraint failed: station_config_kv.uuid`. Because the row
was therefore never created, the `DO UPDATE` arm was unreachable — the statement could never succeed
on any machine, on any tick. The caller's `try/catch` printed to a console nobody reads and moved on.

### Correction to the earlier diagnosis

The note carried into this session said the throw was caused by **`ON CONFLICT(station_id, key)` with
no matching unique index**. That is **wrong**, and the correction matters because it would have sent
the fix at the wrong target.

`PRAGMA index_list(station_config_kv)` on the live DB:

```
idx_station_config_kv_station_uuid   unique=0  origin=c   cols=[station_uuid]
idx_station_config_kv_uuid           unique=1  origin=c   cols=[uuid]
sqlite_autoindex_station_config_kv_1 unique=1  origin=pk  cols=[station_id, key]
```

The autoindex **is** the unique index on `(station_id, key)` — it is the table's primary key. The
conflict target was valid all along. The `uuid` column was the only fault.

## The fix

### 1. Sanctioned writers, and there are TWO of them

`_kvPut` is deleted. The two keys this code writes have **opposite sync policy**, so they take
different writers:

| Key | Writer | Why |
|---|---|---|
| `designated_generator` | `stationConfigKvUpsertByKey` | mutation-logged → **syncs**. Designation exists to tell two machines apart; a local record cannot. |
| `kill_designation` | `stationConfigKvSetLocal` | in `LOCAL_ONLY_KEYS`. A synced kill switch would disable ownership on every machine at once. |

**This is the trap in the fix.** `stationConfigKvUpsertByKey` *silently skips* local-only keys and
returns `{ok: true, skippedLocalOnly: true}`. A wholesale replacement of `_kvPut` with the upsert
would have compiled, passed review, and turned the emergency bypass into a no-op that reports
success — the same class of defect being fixed. `_desigWriteRecord` also throws if it ever gets back
`skippedLocalOnly`, so `designated_generator` landing in `LOCAL_ONLY_KEYS` becomes loud rather than
silent.

### 2. The write error is reported, not swallowed

On failure the tick now: sets a per-station error, logs `WRITE FAILED` with the station name, writes
`station-designation-write-failed` to the health ledger, and surfaces a red **Designation record —
NOT SAVED** row in the Health Monitor carrying the reason.

### 3. Read-back after write

A writer that returns success while the row does not change is the same defect in a different coat.
After a write, the tick re-reads the record; if it is not this machine's, that counts as a failure
with the reason *"write reported success but the record did not change on disk"*.

### 4. The tick says it ran

Every path through `_designationTick` was silent unless a holder changed, which is why *"did it even
fire?"* was unanswerable from the log. It now prints exactly one line per tick, including when it
decides to do nothing and when it bails out early:

```
[designation] startup tick: 4 station(s) · designate 0 · stamp 0 · observe 4 · skip 0 · wrote 0 · failed 0 · machine 8e8f6181 (JENSJ)
[designation] tick: SKIPPED — no client_identity row, this machine has no id
```

Call sites are labelled `startup tick` / `tick` / `refresh (operator)`.

### 5. `_kvGet` filters `deleted_at IS NULL`

Every other reader of this table does. Without it a tombstoned row reads back as a live designation
belonging to a machine.

## Why nothing caught this

`tsc` cannot see a SQL constraint. The existing designation tests are pure functions over
`(record, machine, flags)` — correct, and blind to whether the record can be stored. The one thing
that catches this class of bug is a real write against the real schema.

`electron/smoke-designation-write.js` (`npm run test:designation`) now does that. It builds a table
with the live schema verbatim and asserts:

1. the 4.4.188 hand-rolled INSERT still throws — **and throws on `uuid`, not the conflict target**
   (if that ever changes, the schema drifted and the rest of the test is measuring something else)
2. `stationConfigKvUpsertByKey` creates the row with a uuid, and the record round-trips
3. a second tick stamps the same row — one row, `designated_at` preserved, `last_generated` not
   clobbered by a non-generating tick
4. writing it logs a mutation, so it can sync
5. `kill_designation` is refused by `upsertByKey` (leaving no row) and written by `setLocal` with
   **no** mutation logged

This is the **fourth** silent-write defect on this one table: `auto_generate_enabled` (4.4.183/184),
`schedule_layout_v1` (since 4.4.171), `grid_widths_*` (since 4.4.177), and now
`designated_generator`. The shape is identical every time — the write is refused or throws, nobody
reads the verdict, and the UI renders the absent value as a legitimate state. Items 2–4 of this fix
exist to break that shape, not just this instance.

## Gates

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | **0 errors** |
| `node --check electron/main.js` | OK |
| `npx vitest run` (designation + local-only-keys) | **20 passed** |
| `npm run verify:schema` | **PASS** (8/8) |
| `npm run test:designation` (new) | **ALL PASS** (19 checks) |

## Not verified

**No runtime receipt yet.** Everything above is static analysis plus a smoke test against a
replica schema. Whether the row appears in the running app is **UNVERIFIED**.

The one check that settles it: launch the app, and confirm the log carries

```
[designation] startup tick: N station(s) · ...
```

then open the Health Monitor for a station with auto-generation **on** and confirm **Designated
generator** reads *This machine* rather than *None*.

Note that on Jeff's box `auto_generate_enabled` is `'0'` for station 1 and **absent** for stations
2–4, and unset resolves to OFF. So on that machine the correct post-fix result is
`observe 4 · wrote 0` and the rows still read **None** — switching auto-generation on for a station
is what turns it into a designation.

## Architecture compliance

- `docs/single-writer-election-design-2026-08-11.md` §0 — Phase A observes, gates nothing. Unchanged:
  `_autoExtendTick` still runs on every switched-on machine, and this fix adds no gate.
- `electron/sync/handlers/station_config_kv.js:45` — *"NEVER ADD `designated_generator`"* to
  `LOCAL_ONLY_KEYS`. Honoured; it is written through the ordinary synced path, and the smoke test
  asserts a mutation is logged. `electron/sync/handlers/local-only-keys.test.js:36` still passes.
- **Build the sense, not the scaffold** — the failure is now visible in three permanent places (log
  line, health ledger event, Health Monitor row). No watcher, poller, or scheduled task was created,
  so there is nothing to tear down.
- **Doors before rooms** — `docs/help-designated-generator.md` added; the feature shipped in 4.4.188
  without a help entry.
