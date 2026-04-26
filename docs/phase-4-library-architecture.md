# Phase 4 — Library Architecture (Locked Commitments)

**Status:** STUB — locked commitments only, no plan, no design, no implementation
**Locked:** April 25, 2026
**Predecessor:** Phase 3.5 paused (see `phase-3.5-plan.md`)
**Successor:** Phase 4 design begins as its own session arc

---

## Context

Phase 3.5 was drafted to complete the synced-tables registry and build typed IPC handlers under the assumption that all programming-relevant tables (including songs, artists, albums) are station-scoped. That assumption was wrong. This doc captures the architectural commitments that emerged from the April 25 session and supersede that assumption. Phase 3.5 resumes after Phase 4 corrects the data model.

The pivot was triggered by two observations:

1. The existing cloud infrastructure (R2 backups, `library:sync-r2:start`/`:cancel` IPC handlers, `r2:fetch-track` IPC handler, `cloud_backup_history` table, Icecast cloud playout at `44.244.52.207`) already assumes a shared library. Forcing station-isolated libraries on top of cloud infrastructure designed for shared use creates 4× redundancy in storage, bandwidth, and metadata maintenance for a 4-station cluster.

2. Multi-tenant Control Center is locked at item #5 of the post-Phase-3 roadmap (memory line 8). Station-isolation actively obstructs Control Center workflows. Designing against the roadmap is worse than designing for it, regardless of in-flight Phase 3.5 work.

The locked direction is "Direction C" from the April 25 evaluation: shared install-level library, station-scoped programming layer, explicit join table for song-to-category relationships per station.

---

## Locked architectural commitments

1. **Library is install-scoped, shared across stations.** The `songs`, `artists`, and `albums` tables hold canonical metadata at the install level. A single source of truth: fix an artist name once, every station benefits. Storage and cloud bandwidth costs scale with library size, not with library size × station count.

2. **Programming layer is station-scoped.** The `categories`, `format_clocks`, `clock_slots`, `separation_rules`, `smart_schedule_rules`, `generated_schedule`, `scheduled_log`, `play_log`, and `voice_tracks` tables remain station-scoped. Each station has its own programming context (rotation rules, dayparts, format clocks, playout history) operating against the shared library.

3. **Song-to-category relationship requires a join table.** Direction C makes the same song eligible for membership in different categories at different stations (e.g., "Don't Stop Believin'" is Power Gold on the rock station, excluded entirely on the hip-hop station). The current `category_id` column on `songs` cannot represent this; a join table is structurally required. Naming and exact shape are Phase 4 design concerns.

4. **Cloud infrastructure already assumes shared library.** R2 storage, `library:sync-r2` IPC handlers, `r2:fetch-track`, `cloud_backup_history`, and Icecast cloud playout were built around shared-library assumptions and are already shipping. The data model is being corrected to match the infrastructure, not the other way around. This is the receipt that confirms Direction C is structurally consistent with prior commitments, not a new architectural direction.

5. **The synced-tables registry needs a `scope` column.** Each entry in `electron/sync/synced-tables.js` must explicitly declare whether the table is install-scoped or station-scoped. Phase 3.5's audit doc and triage table will be rewritten with this lens; some tables currently in the registry will move from station-scope to install-scope in that pass.

6. **The `executeScopedInsert` wrapper at `src/db/stationScoped.ts` needs splitting or replacing.** Today it auto-injects `station_id` into every INSERT. In Direction C, install-scoped tables (songs, artists, albums) must NOT receive `station_id` injection. The wrapper splits into install-scoped and station-scoped variants, or is replaced by typed handlers that derive the correct scoping from the registry. Same applies to `queryScoped` for SELECTs.

---

## What this stub is not

This is a **commitments doc**, not a plan or design. It does not:

- Define the join-table schema or naming
- Specify the assignment model (auto-discovery via category vs. explicit assignment)
- Address the permission model for cross-station ad-hoc playout (the "tribute scenario")
- Reconcile per-station vs. install-scoped license compliance
- Estimate timelines or session counts
- Identify the renderer-side refactor scope for scoping-wrapper changes

Those are Phase 4 design concerns. They begin in a dedicated, fresh session.

---

## Status of Phase 3.5

Paused. Most of what was committed in 3.5's predecessors survives:

- `docs/sync-protocol-v0.md` (commit `33c3d6a`) — protocol rules are scope-agnostic
- Mutations table schema (17 fields) — operates per-row, scope-independent
- HLC clock generation (`nextClock`, monotonicity) — scope-independent
- Transformer harness + pre-commit hook — verifies migration chain, scope-independent
- Writer module API surface (`withMutation`, `serializePayload`, `deserializePayload`, `toWireFormat`) — scope-independent
- Smoke tests (commit `b917930`) — exercise writer behavior, not registry scope decisions

What gets reworked when Phase 3.5 resumes:

- The synced-tables registry — gains a `scope` column; some tables move install/station boundary
- The `executeScopedInsert` wrapper — splits or replaces
- The Phase 3.5 audit doc — rewrites with install/station as a first-class triage column
- The `multistation_insert_audit_complete` gate at `electron/main.js:3447` — its semantics change because half the audited callsites should NOT have `station_id`
- The Phase 3.5 typed-handler code generator — generates handlers aware of install vs. station scope

What's not rebuilt: the foundation. The work tonight committed (writer module + smoke tests at `b917930`) does not need to be redone.

---

## Next session

Phase 4 design as its own arc. Fresh head. References this stub as the locked starting point.
