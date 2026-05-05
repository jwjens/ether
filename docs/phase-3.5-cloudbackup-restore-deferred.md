# Phase 3.5 — CloudBackup restore path deferred

**Status:** Deferred  
**Files:** `src/components/CloudBackup.tsx` lines 309–315  
**Commit:** phase-3.5 Session C cluster B (partial)

---

## The problem

Two `db.execute()` calls in the cloud backup restore path write to `play_log` directly:

1. **Line 309** — `DELETE FROM play_log` — unconstrained hard-delete wipe (no `station_id` guard)
2. **Line 312** — `INSERT OR IGNORE INTO play_log (id,title,artist,deck_id,played_at)` — restore insert using old column names predating the current schema (`id` instead of `uuid`, missing `station_id`, `deck`, `duration_ms`, `session_id`)

After Commit 2 installed the `db:execute` lock on synced tables, **both of these will log `[db:execute LOCKED]` errors and return `ERR_SYNCED_TABLE_WRITE`** when a restore runs. The restore will silently skip play_log data.

---

## Why not migrated in this commit

The typed handler (`window.ether.playLog.*`) is designed for normal app writes — one row at a time, station-scoped, mutation-logged. Cloud restore is architecturally different:

- It replaces an entire table's contents (or a station's worth) in one operation
- It sources data from a backup snapshot, which may have a different schema version than the current install
- It should NOT generate per-row sync mutations — restore is an authoritative replacement, not a change to propagate to peers

Cramming restore into the normal typed-handler pattern would produce hundreds of spurious mutations in the log, confuse the sync engine, and require mapping old column names to the new schema inline in the restore path.

---

## The three options

### (a) Add a `play_log:restore-batch` handler

A dedicated IPC channel that accepts an array of raw backup rows, maps old schema to current, performs the DELETE + batch INSERT in one transaction, and writes a single `'checkpoint'`-style mutation (or no mutation — restore is local-authoritative).

**Pro:** clean, auditable.  
**Con:** requires defining restore semantics in the sync protocol (currently an open question). The `op='checkpoint'` value is reserved for compaction, not restore — using it here is a misuse. A new op type would need the protocol amended.

### (b) Route restore through a dedicated restore IPC outside the typed-handler pattern

A `db:restore-play-log` channel in `main.js` that is explicitly NOT covered by the `db:execute` lock and does its own raw SQLite write, bypassing mutation logging entirely.

**Pro:** correct semantics — restore is not a sync event, so no mutation logging is right.  
**Con:** bypass requires whitelisting a channel in the lock or the lock must have a "privileged" mode.

This is probably the right architecture. A restore should be treated like a migration — it runs raw SQL and produces a `origin='migration'` mutation (or none at all). The sync engine, when it lands, would treat a restored DB as a new baseline, not as a delta.

### (c) Allowlist the two CloudBackup execute() calls in the db:execute guard

Add an escape hatch to the guard in `main.js` that recognizes the CloudBackup context and allows the writes.

**Pro:** minimal change.  
**Con:** the guard exists to prevent accidental raw writes, not intentional ones. Allowlisting by SQL text is fragile. Doesn't solve the schema mismatch (old column names).

---

## Recommendation

**Option (b)** — dedicated restore IPC — is architecturally correct. Restore is not sync; it should not produce sync mutations. Implement as its own arc after the sync protocol's restore semantics are defined.

In the meantime, the schema mismatch (old column names in the INSERT) means the restore path was already broken before phase 3.5 — it predates the `uuid` column and `station_id` requirement. The deferred work must fix the column mapping regardless of which option is chosen.

---

## Tracking

Until this is resolved, cloud backup restores will fail silently for `play_log` (the lock returns an error, the restore loop swallows it and continues with other tables). Operators who restore from backup will have an empty play log.
