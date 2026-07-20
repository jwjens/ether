# Log-Reader Flip — Phase 0 (additive schema) — build report, 2026-07-20

**Design:** `docs/log-reader-single-source-playout-design-2026-07-20.md` (APPROVED with §6 answers:
per-row state + derived playhead; `seq REAL`; RESET semantics confirmed; lifecycle columns
local-authoritative / never CRDT-merged; CLEAR-regenerate window confirmed; one CLEAR button → two-verb
choice).

**Phase 0 is ADDITIVE + INERT. No runtime behavior changed.** It adds the columns the playhead needs
and backfills existing rows. Nothing reads or writes them yet (shadow writer = Phase 1; read flip =
Phase 3, behind a flag). **STOP at this phase boundary for review before Phase 1.**

## What shipped

### 1. Migration v33 — `scripts/migrate-generated-schedule-playhead-lifecycle-phase-sync-33.js`
Auto-runs via the existing `runMigrationChain` (`electron/main.js:1016,1312`) on next app launch —
version-gated, idempotent. Adds to `generated_schedule`:
- `state TEXT DEFAULT 'pending'` — `pending | playing | played | skipped`. The **playhead** is the
  derived row where `state='playing'` (§2.2).
- `played_at INTEGER` — unix seconds the row actually aired (engine-stamped in Phase 1).
- `seq REAL` — explicit monotonic play-order, decoupled from `scheduled_at` (§6.2).
- Index `idx_gensched_playhead (station_id, state, seq)` for the future playhead read.

**Backfill:** existing past rows (`scheduled_at < now`) → `played`; future rows → `pending`;
`seq` = dense `ROW_NUMBER() OVER (PARTITION BY station_id ORDER BY scheduled_at, id)`.

### 2. Sync: lifecycle columns are LOCAL-ONLY (§5) — `electron/sync/synced-tables.js`
`state`, `played_at`, `seq` registered `'local-only'` in the `generated_schedule` registry. Mechanism:
`serializePayload` **skips `local-only` columns** (`mutation-writer.js:456`), so these are NEVER put in
a mutation payload — the always-on local engine owns the playhead per-machine; it is never CRDT-merged
(avoids the peer-sync last-write-wins fight, `[[project_peer_sync_station_uuid]]`). Precedent:
`is_active`, `icecast_password`, legacy `slots` are already `local-only`. The plan columns
(`scheduled_at`/`song_id`/…) stay synced. `seq`'s sync treatment is revisited at Phase 4 (reorder).

## Verification — on a COPY of the live DB (never the live DB; Ether was running)

Copied `openair.db` (+WAL) to scratch and ran the actual migration under Electron's node ABI
(`ELECTRON_RUN_AS_NODE=1` — system node hit a NODE_MODULE_VERSION mismatch since `better-sqlite3` is
built for Electron). Real data: **28,615 rows across 3 stations.** All 12 self-checks PASS:

```
schema_version = 33 · state/played_at/seq exist · idx_gensched_playhead exists
no NULL/empty state · all state in {pending,playing,played,skipped}
all past rows → played · all future rows → pending
every row got a seq (0 NULL of 28615) · seq unique within each station · row count unchanged
```
Distribution after backfill: **17,288 played (past) / 11,327 pending (future).** Idempotent: re-run →
`+0 columns`, identical split, all PASS. Copies deleted after.

### Bug caught + fixed during verification (receipt of the process working)
First run backfilled **all** rows to `pending` (0 played). Root cause: `ADD COLUMN … DEFAULT
'pending'` pre-fills every existing row with the default, so the original NULL-guarded `played`
backfill matched nothing. Fixed: backfill guards on `state='pending'` (the default) instead of NULL —
past rows flip correctly, and the guard keeps it idempotent + safe against clobbering a runtime
`playing`/`skipped`/`played`. Added two verify checks (past→played, future→pending) that catch exactly
this class of unit/default trap. Re-verified clean on a fresh copy.

## Gates

- `node --check` on the migration + `synced-tables.js`: OK.
- `npx tsc --noEmit`: **zero new errors** (3 pre-existing: `App.tsx:4908`, `OnboardingFlow.tsx:2039`,
  `PhoneDesk.tsx:777`; Phase 0 touched JS only).
- `npm run build` + installer: OK.

## Artifact

`C:\openair\dist-electron\Ether Setup 4.4.68.exe` — 202,608,016 bytes, `--publish never`. Install
manually. On first launch the v33 migration runs against the live DB (the app itself, safely) — the
copy verification proves the exact behavior it will perform.

## Files

- `scripts/migrate-generated-schedule-playhead-lifecycle-phase-sync-33.js` (new)
- `electron/sync/synced-tables.js` (registry: 3 local-only columns)
- `package.json` 4.4.67 → 4.4.68

Nothing committed; nothing pushed. Flag stays off (no flag introduced yet — Phase 3 introduces it).

## Next — Phase 1 (shadow writer), on your go

The engine stamps `state='playing'`/`'played'` + `played_at` on the `generated_schedule` row as it
advances — observational only, WITHOUT changing how the queue is sourced. Verify the stamped playhead
matches `play_log` over a burn-in. Then STOP again.
