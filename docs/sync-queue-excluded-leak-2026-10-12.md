# Sync queue: an excluded table leaked into the send queue (2026-10-12)

Branch `fix/monitor-local-output`. Found by the stall sense in the performance pass (`docs/perf-pass-round2-2026-10-12.md` §10–11).

## Jeff's request (verbatim, relayed)

> After the reading, fix the sync queue properly: generated_schedule is excluded from sync, yet 217,002 entries for it sit in the send queue. Find where they get queued and stop it at the source so excluded tables never enter the queue. Back up, then remove the already-queued generated_schedule rows with a one-time cleanup, counting before and after. Check that no other excluded table has the same leak. Keep the new index. Run the tests. No version bump, no tag, no CI. Write it up in docs/sync-queue-excluded-leak-2026-10-12.md and explain the result to Jeff in plain words.

## The counts (OVEVENTS, live database, read-only, 2026-10-12)

Live file: `%LOCALAPPDATA%\Ether\profiles\ETH-STN-BAA8-E056-6FC8\openair.db`.

| Excluded table | Why excluded | Rows in `mutations` (any status) |
|---|---|---|
| `generated_schedule` | `syncExcluded: true` — ruling A (the backend refuses it; derived data) | **217,002, all `pending`** (first 2026-08-22, last 2026-10-11) |
| `install_secrets_kv` | `syncExcluded: true` — [Q-13], never leaves the device | **0** |
| `monitor_routing` | `scope: 'local-only'` — AD-10, per machine | **0** |

All pending in the queue: 217,002, i.e. **every pending row was a `generated_schedule` row**. Rows in `mutations` overall: 358,232.

So the leak is `generated_schedule` only. The other two excluded tables have no code that journals them: no handler or writer anywhere in `electron/` or `audiod/` names them outside the registry.

## Cause

`electron/sync/mutation-writer.js` `logMutation` (line 220 before the fix) journals any table in `REGISTRY`, and only checks that the table is known. The exclusion rule lived only in the PUSH (`sync-engine.js` `EXCLUDED_TABLES`), which refuses to send those rows. So:
1. Every Generate wrote its `generated_schedule` rows through `electron/sync/handlers/generated_schedule.js`: create/update/delete via `withMutation`, and bulk create/clear via `logMutation` directly. Each row became a `'pending'` mutation.
2. The push never sent them, so nothing ever marked them synced, and they stayed `'pending'` forever.
3. Every 10 s push tick read through all of them to filter them out. On this data that cost 290–580 ms of main per tick for 0 rows, the stall the sense named. The `mutations` table also grew by about 123 MB of payload nobody will ever read.

Ruling A (2026-06) stopped the push from sending the table. It did not stop the writer from queueing it; that half was missed.

## The fix

**At the source** (`electron/sync/mutation-writer.js`, `electron/sync/synced-tables.js`):
- `isSyncExcluded(table)` in `synced-tables.js` is the ONE rule: `syncExcluded: true` or `scope: 'local-only'`. The push's `EXCLUDED_TABLES` is now built from the same function, so writer and push cannot disagree.
- `logMutation` returns `null` without writing a queue entry for an excluded table. The table write itself is unchanged; only the queue entry is not made. Checkpoints (`__checkpoint__`) are unaffected.
- `withMutation` on an excluded table runs the write in its transaction with no queue entry, and does **not** become the causal parent of nested writes. Otherwise a synced child write would carry a `parent_mutation_id` that is never written.
- The audio engine process (`audiod/playlog.js`) uses the same writer, for `play_log` only, which is a synced table. It is unaffected, and its staged copy picks the change up by content.

**The one-time cleanup** (`electron/sync/purge-excluded-queue.js`, run by `electron/sync/purge-excluded-queue-worker.js`):
- **When:** 60 s after launch, once (`system_state` key `sync_excluded_queue_purged_v1` holds the report). It runs on its own worker thread with its own database connection, so it never runs on main. A run cut short (the app closed) resumes on the next launch.
- **What:** only rows that are BOTH `pending` AND of an excluded table. Nothing else in the queue is touched, and no table data.
- **Order:**
  1. COUNT: pending rows per excluded table, all pending rows, all rows.
  2. BACKUP: every row to be removed is copied, all 18 columns, into `…\profiles\<profile>\backups\sync-queue-purge-<time>.db` (table `mutations_removed`, plus `purge_report`). The copy is counted, and a short copy aborts before anything is deleted. The file must not already exist.
  3. DELETE in small, time-sized batches (target 30 ms each, 100 ms pause between, a PASSIVE checkpoint after each). Its connection uses `synchronous = NORMAL` and no automatic checkpoint, both restored afterwards. These settings exist so the app's own writes are not held up; see the measurements below.
  4. COUNT again.
- **Report:** in the startup log (`[sync-queue] …`) and the health ledger (`sync-queue-excluded-purged`, or `sync-queue-purge-error`).

**Kept:** the push's partial index (`idx_mutations_push_pending_2c34aa53`, from `docs/perf-pass-round2-2026-10-12.md` §11). The shared rule produces the same exclusion list, so it is the same index. Re-proven: 734 → 0.92 ms on the live data, same rows.

## Proof

- **Sync suite** (`npm run test:sync`): **52/52**, including the new `electron/sync/tests/t50-t52-excluded-never-queued.test.js`:
  - T-50: all three excluded tables are refused by `logMutation`, nothing queued.
  - T-51: `withMutation` on `generated_schedule` still writes the row, queues nothing, and a nested synced write gets parent `null`, not a phantom id.
  - T-52: a synced table is queued exactly as before (`pending`, `local`).
- **Cleanup smoke on a copy of the live data** (`npm run test:purge-queue <database copy>`; runs the real worker while the main thread plays the app, writing every 50 ms):

| | Before | After |
|---|---|---|
| `generated_schedule` pending | **217,002** | **0** |
| `install_secrets_kv` / `monitor_routing` pending | 0 / 0 | 0 / 0 |
| All pending (incl. 300 synced rows seeded by the smoke) | 217,302 | 300 |
| All rows in `mutations` | 358,067 | 141,065 |

  - Removed 217,002, exactly the ids that were queued. The backup holds the same 217,002 rows, all 18 columns.
  - The 300 synced pending rows are all still pending, untouched.
  - Running it a second time does nothing and makes no second backup.
  - Duration on this machine: about 12 min (4,437 batches; slowest batch 69 ms, slowest checkpoint 158 ms).

- **What the app feels while it runs:** the main thread's writes during the cleanup, 11,553 writes over 12 minutes:
  - **one waited 128 ms**, every other ≤ 83 ms;
  - with no cleanup running, the same writes take ≤ 9 ms (control).

  So the one-time job can hold a database write by the app just over the 100 ms stall bar, about once. Earlier pacings were measured and rejected:

| Pacing | Worst app write wait |
|---|---|
| 2,000-row batches | 732 ms |
| 250-row batches | 306 ms |
| + passive checkpoints every 8 batches | 235 ms |
| + 100 ms pauses | 195 ms |
| + time-sized batches, no-fsync connection | 232 ms |
| + a checkpoint after every batch (chosen) | **128 ms, once** |

- Also green: tsc 0 errors; vitest 878/878; verify:schema, undefined-calls, ipc-contract PASS; leak-guard at its baseline; push-index smoke 5/5.

## Not done / not changed (one line each)

- The database file does not shrink: SQLite reuses the freed pages. A VACUUM is a separate decision; on a 750 MB file it takes minutes with the app closed.
- `scripts/smoke-generated_schedule-handlers.js` is an old generated scaffold, not in any gate, and it opens the live database. It still expects one queued mutation per `generated_schedule` write. Those checks are now wrong by design; it should be regenerated or retired.
- The cleanup runs only on an install that runs this build. Other machines (OV) get it with the next build they install.
- No version bump, tag or CI. The installer is not rebuilt for this yet.
