# Phase A — Amendment 1: Path C (Defer Typed `stations:*` Migration)

> **Amendment to**: `phase-a-execution-plan.md`  
> **Date**: 2026-04-29  
> **Trigger**: Step 0-A discovery pass for "Resolve duplicate stations:* handler registration"  
> **Decision**: Path C selected — defer typed stations handler migration to a dedicated post-Phase-A phase

---

## Discovery Summary

The Step 0-A discovery pass read `electron/main.js` lines 3444–3504, `electron/sync/handlers/stations.js` (full file), `electron/sync/handlers/index.js`, `electron/preload.js`, and `electron/preload-handlers.js`.

**The original audit finding was incorrect.**

The original `phase-a-discovery-audit.md` stated:

> *"Typed handlers in `electron/sync/handlers/stations.js` (same channel names, installed via `installAll()`). Both attempting to register same ipcMain.handle channels = collision. Whichever registers second will throw."*

The actual state:

- `electron/sync/handlers/index.js` exports `installAll(ipcMain, db)` and its own comment says "main.js calls installAll(ipcMain, db)"
- `installAll` is **never called** from `main.js`
- `main.js` installs exactly three typed handlers at lines 1024–1034: `installStationProgramming`, `installStationConfigKv`, `installOperators`
- `installStations` is not in that list
- The typed `stations.js` handler exists on disk but is **never registered**

**There is no runtime collision.** The legacy handlers at lines 3445–3504 are the only handlers active for all `stations:*` channels. The collision was a future trap — it would have materialized the moment anyone added `installStations` to the opt-in block without first removing the legacy handlers.

---

## What the Typed Migration Would Actually Require

Discovery also surfaced that completing the typed migration is substantially larger work than a prerequisite slot can accommodate.

Differences between legacy and typed handler sets:

| Aspect | Legacy | Typed |
|---|---|---|
| Primary key | integer `id` | `uuid` string |
| `list` response | raw `[]` | `{ ok: true, rows: [] }` |
| `create` response | `{ ok: true, id: N }` | `{ ok: true, row: { ...full row } }` |
| `update` response | `{ ok: true }` | `{ ok: true, row: { ...full row } }` |
| `delete` behavior | hard DELETE | soft-delete (`deleted_at = now`) |
| Write logging | none | `withMutation` on every write |
| INSERT audit gate | yes (legacy `create`) | absent — must be ported |
| `deleted_at` filter on reads | no | yes (`WHERE deleted_at IS NULL`) |

**Callsite scope**: All renderer calls to `stations.create`, `stations.update`, `stations.delete` pass an integer `id`. Migrating to uuid requires touching every callsite in the renderer that constructs or passes station identifiers. This is a renderer-wide change.

**Response shape changes**: Every callsite that reads `result.id` (from create) or checks `result.ok` must be updated. `stations.list()` returning `{ ok: true, rows }` instead of a raw array is a breaking change for all current consumers.

**Soft-delete behavior change**: The typed handler's `stationsDelete` sets `deleted_at` rather than issuing a hard `DELETE`. The station row persists. All queries that do not filter `deleted_at IS NULL` would start returning "deleted" stations. This requires a read-side audit across the renderer.

**No typed equivalent for `stations:get-active` or `stations:switch`**: These channels must remain as standalone handlers regardless; their absence from the typed file means they are always legacy-only.

---

## Path Analysis

Three paths were considered:

**Path A — Complete typed migration now (original Step 0-A)**  
Port audit gate into typed handler; migrate all renderer callsites from integer id to uuid; update response shape handling throughout; change delete to soft-delete; add `stations:get-active` typed alias; install typed handler; remove legacy handlers. Estimated scope: 2–3 days of renderer callsite work before any Phase A engine work begins. Delays Phase A start.

**Path B — Shim layer**  
Add a translation shim in `preload.js` that accepts the legacy integer-id call shape and internally translates to uuid before invoking the typed handler. Hides the migration from renderer callsites. Creates a shim that must be maintained until all callsites are eventually migrated. Adds a hidden complexity layer. Rejected: shims outlive their welcome.

**Path C — Defer typed migration**  
Keep legacy `stations:*` handlers for Phase A. Confirm the INSERT audit gate is sound (the only real safety check in Step 0-A). Widen AD-9 to acknowledge that existing legacy handlers are excluded from the typed handler requirement. Create a dedicated post-Phase-A phase for the typed migration. Phase A proceeds immediately after Step 0 prerequisites.

**Decision: Path C.**

Rationale: Phase A's core work (engine map, per-station streaming, renderer station context) does not depend on which handler set owns `stations:*`. The typed migration is correctness/sync work, not Phase A unblocking work. Running them in parallel adds risk without benefit.

---

## Changes Applied to `phase-a-execution-plan.md`

### 1. Step 0-A rewritten (narrower scope)

**Before**: "Resolve duplicate `stations:*` handler registration" — required deleting six legacy handlers, installing typed handler, updating preload.js, and adding `stations:get-active` typed alias.

**After**: "Confirm INSERT audit gate is sound" — read-only verification that the legacy `stations:create` gate check is correct and the key name/query match what the renderer uses to lift the gate. No code changes unless the gate check has a bug.

### 2. AD-9 amended

**Before**: "All Phase A writes that need to sync go through `withMutation`..."

**After**: "All **new** Phase A writes that need to sync go through `withMutation`..." with explicit acknowledgment that existing legacy `stations:*` handlers do not use `withMutation` and that migration is deferred.

### 3. Success Criteria — item 6 removed

**Original 8 success criteria** (with item 6 as it existed before this amendment):

1. Both stations in the DB have distinct `icecast_mount` values.
2. Both stations stream simultaneously to their respective Icecast mounts without conflict.
3. Station switch in the renderer UI does not interrupt audio or streaming for either station.
4. Per-station engine state is isolated — deck play on one station does not affect the other's queue or playback.
5. All station-scoped writes (`play_log`, `stream_sessions`, `mutations`) carry the correct `station_id`.
6. ~~All `stations:*` IPC channels route through typed handlers (single canonical IPC surface).~~ **Removed — moves post-Phase-A.**
7. INSERT audit gate (`multistation_insert_audit_complete`) passes or is intentionally lifted after callsite audit completes.
8. No crash or regression in single-station mode; existing station-1-only workflow is unaffected.

**Applied**: item 6 removed; old item 7 → item 6; old item 8 → item 7. Plan now carries items 1–7.

### 4. New entry in "Open Items Carried Forward"

See section below — exact text as added to the execution plan.

---

## Open Items Carried Forward (exact plan text)

### Typed `stations:*` handler migration (deferred from Step 0-A)

Discovery (Amendment 1) surfaced that completing the typed migration requires work that exceeds a prerequisite slot:
- Integer-id-to-uuid migration across all renderer callsites for `stations.create`, `stations.update`, `stations.delete`
- Response shape changes (`{ ok: true, id: N }` → `{ ok: true, row: {...} }`) at every callsite
- Hard-delete-to-soft-delete behavior change for `stations.delete`; read-side audit needed for `deleted_at IS NULL` filter gaps
- INSERT audit gate port from legacy `stations:create` into typed `stationsCreate()`
- `stations:get-active` has no typed equivalent; typed handler or renderer-side workaround required

**Next step**: After Phase A ships, create a dedicated discovery + plan document for "Phase B: Typed `stations:*` handler migration" covering callsite inventory, response shape migration, and soft-delete rollout.
