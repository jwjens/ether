# Ether sync protocol v0

**Status:** Locked. Decisions enumerated here are committed. Open questions are called out explicitly in [§13](#open-questions).
**Owner:** Jeff
**Scope:** Defines the mutation log schema, wire format, clock strategy, payload conventions, schema-version compatibility rules, and migration requirements for Ether's custom CRDT sync engine. This document is the source of truth for sync-ready principle #3 (mutations event log) and is the specification that every piece of sync-related code must conform to.

Normative statements are numbered `[N-nn]`. When a code review or bug report references a rule, use that number. Example: *"this violates [N-12]"* is unambiguous.

**Numbering stability.** Rule numbers are permanent. Once this document is committed, a rule that is superseded or removed is replaced with a placeholder of the form *"[N-NN] Deleted — reason. Number reserved, do not reuse."* New rules always get the next unused number; numbers are never shifted to close gaps. This convention takes effect at commit; the initial numbering is sequential without gaps.

---

## Table of contents

1. [Purpose and non-goals](#purpose)
2. [Terminology](#terminology)
3. [Mutation record schema](#schema)
4. [Payload categories](#payload-categories)
5. [Payload conventions](#payload-conventions)
6. [Hybrid logical clock (HLC)](#hlc)
7. [Wire format](#wire-format)
8. [Schema version rules](#schema-version-rules)
9. [Schema version compatibility](#schema-compat)
10. [Migration requirements](#migration-requirements)
11. [Client identity](#client-identity)
12. [Compaction intent](#compaction)
13. [Open questions](#open-questions)
14. [Appendix A — worked HLC examples](#hlc-examples)
15. [Appendix B — field quick-reference table](#field-table)

---

## 1. Purpose and non-goals <a id="purpose"></a>

**Purpose.** Specify the data structures and rules that allow Ether instances running on different devices to exchange mutations and converge to the same state, without relying on a central authority and without losing data under concurrent edits or offline operation.

**Non-goals (explicitly out of scope for v0).**

- `[N-01]` This document does not specify peer discovery, transport, authentication, or authorization between peers. Those are separate concerns addressed in later protocol versions.
- `[N-02]` This document does not specify conflict detection or resolution semantics beyond the structural hooks (`parent_mutation_id`, `conflict_resolution`) needed to support future resolution strategies.
- `[N-03]` This document does not specify how blobs (audio files, images, waveform caches) are replicated between peers. It specifies only how mutations *refer* to blobs. A separate blob-sync protocol is anticipated.
- `[N-04]` This document does not specify sync cursors, batching, or delivery guarantees. The mutation log schema supports these; the sync engine adds them.

**What v0 does specify.** Everything required so that when the sync engine is written, the mutation log it reads from and writes to is already correct, complete, and stable.

---

## 2. Terminology <a id="terminology"></a>

- **Mutation.** A single INSERT, UPDATE, or DELETE operation against a row in a synced table. Each mutation is recorded as one row in the `mutations` table.
- **Synced table.** One of the 27 tables enumerated in `electron/sync/synced-tables.js`. Mutations on non-synced tables are not logged and do not participate in sync.
- **Infrastructure table.** A table that supports the sync mechanism itself: `mutations`, `client_identity`, `system_state`. See [N-05](#schema).
- **Client.** One install of Ether on one machine, identified by a `client_id` UUID generated at migration time. A single person may have multiple clients (studio workstation, laptop, backup rig). Each is a distinct peer.
- **Station.** A tenant scope within Ether (see Phase 3 work). Mutations are always station-scoped; sync is always station-scoped.
- **Actor.** The operator (user) who initiated the mutation, identified by `operator_id`. Distinct from `client_id`: one operator may work on multiple clients; one client may be used by multiple operators over time.
- **HLC (Hybrid Logical Clock).** A timestamp combining wall-clock time with a logical counter, used to causally order mutations across clients. See [§6](#hlc).
- **Wire format.** The subset of mutation fields that is serialized and transmitted between peers. See [§7](#wire-format).
- **Payload.** The JSON representation of a row's state, stored in `payload_before` and `payload_after`. See [§4](#payload-categories) and [§5](#payload-conventions).
- **Transformer.** A function associated with a schema migration that converts a payload from one schema version to the next. See [§10](#migration-requirements).
- **Quarantine.** A store (outside the mutations table) for mutations that cannot be applied at the current schema_version. See [N-64](#schema-compat).

---

## 3. Mutation record schema <a id="schema"></a>

- `[N-05]` Writes to infrastructure tables (`mutations`, `client_identity`, `system_state`) SHALL NOT themselves generate mutation log entries. These tables support the sync mechanism; they are not synced data. This rule prevents recursive logging.
- `[N-06]` The mutations table SHALL have exactly the 17 fields listed below. No additional fields in v0.
- `[N-07]` Every field is either required (non-nullable in SQLite) or nullable with documented meaning for NULL. The table below is authoritative. **The Wire column is the single source of truth for wire-format membership; [§7](#wire-format) references this table rather than re-enumerating.**

| # | Field | SQLite type | Nullable | Wire | Purpose |
|---|---|---|---|---|---|
| 1 | `id` | TEXT PRIMARY KEY | No | Yes | UUID v4 identifying this mutation globally. |
| 2 | `client_id` | TEXT | No | Yes | UUID of the client that created this mutation. |
| 3 | `station_id` | TEXT | No | Yes | Tenant scope; matches Phase 3 `station_id` on the target row. |
| 4 | `actor_id` | TEXT | Yes | Yes | Operator UUID if known; NULL for `origin='system'` or `'migration'`. |
| 5 | `table_name` | TEXT | No | Yes | One of the 27 synced table names. |
| 6 | `row_id` | TEXT | No | Yes | UUID of the target row (not the integer `id` PK — the `uuid` column added in sync-ready 1/7). |
| 7 | `op` | TEXT | No | Yes | One of `'insert'`, `'update'`, `'delete'`, or reserved `'checkpoint'`. See [N-10]. |
| 8 | `payload_before` | TEXT | Yes | Yes | JSON of row state before mutation. NULL for `op='insert'`. See [§5](#payload-conventions). |
| 9 | `payload_after` | TEXT | Yes | Yes | JSON of row state after mutation. NULL for `op='delete'`. See [§5](#payload-conventions). |
| 10 | `created_at` | TEXT | No | Yes | ISO 8601 UTC wall-clock time at originating client. For display and audit only — do not use for ordering. |
| 11 | `applied_at` | TEXT | No | **No** | ISO 8601 UTC wall-clock time the mutation was applied to the local DB. For local mutations equals `created_at`. For remote mutations (future) equals arrival time. |
| 12 | `hlc` | TEXT | No | Yes | Hybrid logical clock value. Primary ordering key across clients. Format in [§6](#hlc). |
| 13 | `parent_mutation_id` | TEXT | Yes | Yes | UUID of the mutation this one causally depends on, or NULL if none. Used for causality chains and undo graphs. |
| 14 | `schema_version` | INTEGER | No | Yes | The schema version of the originating client at creation time. Used by receivers to interpret the payload. See [§9](#schema-compat). |
| 15 | `origin` | TEXT | No | **No** | One of `'local'`, `'remote'`, `'system'`, `'migration'`. Each receiving peer sets this for itself. |
| 16 | `sync_status` | TEXT | No | **No** | One of `'pending'`, `'syncing'`, `'synced'`, `'conflicted'`. Per-peer state; each peer tracks its own. |
| 17 | `conflict_resolution` | TEXT | Yes | Yes | JSON describing how a conflict was resolved, if this mutation is the product of a merge. NULL otherwise. |

- `[N-08]` Fields marked "No" in the Wire column above are LOCAL-ONLY and SHALL NOT be included in the wire format. Fields marked "Yes" ARE included. Any edit to this table's Wire column is a protocol change.
- `[N-09]` `id`, `client_id`, `station_id`, `actor_id`, `row_id`, and `parent_mutation_id` are all UUIDs stored as lowercase hex strings with dashes (standard RFC 4122 format). Implementations SHALL reject non-conforming UUIDs at write time.
- `[N-10]` `op` SHALL be enforced by a CHECK constraint: `CHECK (op IN ('insert', 'update', 'delete', 'checkpoint'))`. The `'checkpoint'` value is RESERVED for future compaction use (see [§12](#compaction)) and SHALL NOT be written by v0 code. Including it in the CHECK constraint now avoids a schema bump when compaction lands.
- `[N-11]` `origin` SHALL be enforced by a CHECK constraint: `CHECK (origin IN ('local', 'remote', 'system', 'migration'))`.
- `[N-12]` `sync_status` SHALL be enforced by a CHECK constraint: `CHECK (sync_status IN ('pending', 'syncing', 'synced', 'conflicted'))`.
  - **Cross-reference:** Quarantine-forward state ([N-64]) is NOT a `sync_status` value. Quarantined-forward mutations live in a separate store (structure defined by the sync-engine spec, out of scope for v0). Do not conflate quarantine with `sync_status`.

### 3.1 Required indexes

- `[N-13]` The following indexes SHALL exist on the mutations table at schema version 3:
  - `idx_mutations_table_row_hlc` on `(table_name, row_id, hlc)` — reconstruct row history in order.
  - `idx_mutations_client_hlc` on `(client_id, hlc)` — per-device sync cursor queries.
  - `idx_mutations_station_created` on `(station_id, created_at)` — tenant-scoped audit queries.
  - `idx_mutations_sync_status` on `(sync_status)` — find pending mutations quickly.
  - `idx_mutations_created` on `(created_at)` — time-range queries.
- **Naming note.** Mutations indexes use `idx_mutations_<purpose>` naming because the table needs several specialized indexes. Other sync-ready indexes (e.g. `idx_songs_uuid`, `idx_play_log_uuid` from sync-ready 1/7) use `idx_<table>_<column>` because each table has a single uuid index. The divergence is intentional; do not "fix" it.

### 3.2 Row count and retention notes

- `[N-14]` v0 implementations SHALL NOT delete from the mutations table. All deletions are reserved for future compaction ([§12](#compaction)).

---

## 4. Payload categories <a id="payload-categories"></a>

Every column on a synced table falls into exactly one of four categories. The writer module and the wire format handle each category differently.

### 4.1 Scalar

`[N-15]` **Scalar columns** are TEXT, INTEGER, REAL, or NULL values that represent simple values. They are included verbatim in payloads. Examples: `title`, `bpm`, `is_active`, `created_at` on the target row (not the mutations row).

### 4.2 JSON-text

`[N-16]` **JSON-text columns** are TEXT columns whose contents are JSON documents (per convention, not per SQLite column type). Examples: `raw_metadata`, `slots_json`, `slots`, any `*_json` or structured-blob-as-text field.

- `[N-17]` JSON-text columns SHALL be included in payloads as nested JSON structures — not as escaped strings. The writer module is responsible for `JSON.parse` on read and `JSON.stringify` on write when constructing payloads. This keeps payloads queryable via SQLite's JSON1 extension without a second parse pass.
- `[N-18]` If a JSON-text column contains malformed JSON at payload construction time, the writer SHALL store the raw string under a key `{"__raw_text": "<original string>", "__json_parse_failed": true}` and log a warning. This preserves the data without blocking the mutation.

### 4.3 BLOB-ref

`[N-19]` **BLOB-ref columns** hold references to binary content (audio files, images, waveforms) that are large enough that inlining them in payloads would bloat the mutation log and the wire format past usable limits.

- `[N-20]` Any column of SQLite type BLOB is automatically a BLOB-ref column.
- `[N-21]` TEXT columns that hold file paths to binary assets (e.g. a `file_path` column pointing to an audio file on disk) are BLOB-refs *by convention*, and SHALL be declared as such in the per-table registry (see [§4.5](#per-table-registry)).
- `[N-22]` In payloads, BLOB-ref columns SHALL be represented as an object:
  ```json
  {
    "__blob_ref": "<content-hash or opaque reference>",
    "__blob_size": <bytes>,
    "__blob_origin": "<path or URL on originating client>"
  }
  ```
- `[N-23]` In v0, the content hash is NOT computed (the blob-sync engine does not yet exist). Writers SHALL set `__blob_ref` to the value of the original path/reference and `__blob_size` to the byte count if readily available, or `null` if not. A future migration will backfill real content hashes.

### 4.4 Local-only

`[N-24]` **Local-only columns** are columns whose value is not meaningful outside this client and SHALL be excluded from payloads entirely. Examples: cache timestamps, UI state flags specific to a client, computed fields that each peer recomputes from other data.

- `[N-25]` Local-only columns SHALL be declared in the per-table registry. The writer SHALL omit them from both `payload_before` and `payload_after`.

### 4.5 Per-table column category registry <a id="per-table-registry"></a>

- `[N-26]` `electron/sync/synced-tables.js` SHALL export, for each of the 27 synced tables, a declaration that categorizes every column as scalar, json-text, blob-ref, or local-only. Example shape:
  ```js
  {
    tableName: 'songs',
    columns: {
      id: 'scalar',
      uuid: 'scalar',
      station_id: 'scalar',
      title: 'scalar',
      artist: 'scalar',
      file_path: 'blob-ref',
      raw_metadata: 'json-text',
      last_scanned_at: 'local-only',
      // ...
    },
  }
  ```
- `[N-27]` Every column present in the live DB schema SHALL appear in its table's registry. A column missing from the registry is a bug and SHALL cause the writer to throw at mutation-log time, not silently include or exclude the column.

---

## 5. Payload conventions <a id="payload-conventions"></a>

### 5.1 Full snapshots, not diffs

- `[N-28]` `payload_before` and `payload_after` SHALL each contain the full post-category-filter row state at their respective points in time. v0 DOES NOT support diff payloads.
- `[N-29]` For `op='insert'`, `payload_before` SHALL be NULL and `payload_after` SHALL be the full new row.
- `[N-30]` For `op='update'`, both SHALL be populated: `payload_before` is the row state as read immediately before the UPDATE statement ran in the same transaction; `payload_after` is the row state as read immediately after.
- `[N-31]` For `op='delete'`, `payload_before` SHALL be the full row state as read immediately before the DELETE, and `payload_after` SHALL be NULL.

**Rationale for full-snapshot over diff.** Full snapshots simplify conflict detection (receivers can directly compare `payload_before` to their current state to detect divergence), simplify replay (a single mutation is enough to reconstruct either state), and simplify debugging. Storage cost is real but acceptable at Ether's scale (see [§12](#compaction)). Diff payloads are a defensible optimization for a later protocol version if the log grows unwieldy, but they are not v0.

### 5.2 Reading payload_before

- `[N-32]` For `op='update'` and `op='delete'`, the writer SHALL read `payload_before` from the database *inside the same transaction as the mutation*, immediately before the data operation. Reading before the transaction begins is incorrect (another txn may have changed the row).
- `[N-33]` If `payload_before` read yields no row (target row does not exist), the writer SHALL throw. An UPDATE or DELETE of a nonexistent row is a logic bug upstream, not a soft error; the mutations log must remain consistent.

### 5.3 Reading payload_after

- `[N-34]` For `op='insert'` and `op='update'`, the writer SHALL read `payload_after` from the database *inside the same transaction*, immediately after the data operation completes. This captures any database-side defaults or type coercions applied by SQLite.
- `[N-35]` Exception: for bulk INSERT operations where reading back every row individually is prohibitively expensive, the writer MAY construct `payload_after` from the input values to the INSERT, PROVIDED the writer can guarantee no database-side modifications occur. In v0, this exception SHALL NOT be used (no bulk optimization needed). Any future protocol version that enables this exception SHALL specify which tables and operations it applies to, and SHALL document the risks of payload drift from DB-computed values.

### 5.4 Atomicity

- `[N-36]` The data operation and the mutation log write SHALL occur inside a single SQLite transaction. If either fails, both SHALL roll back.
- `[N-37]` The writer module SHALL expose a helper `withMutation(db, mutationArgs, dataOpFn)` that opens a transaction, captures `payload_before` if applicable, invokes `dataOpFn`, captures `payload_after` if applicable, writes the mutation row, and commits. This SHOULD be the default API for call sites; direct mutation writes are permitted only for advanced cases (e.g. batch operations that manage their own transaction).

---

## 6. Hybrid logical clock (HLC) <a id="hlc"></a>

### 6.1 Format

- `[N-38]` An HLC value is a TEXT string of the form `<wall_ms>:<logical>:<client_id>` where:
  - `wall_ms` is a non-negative decimal integer representing Unix epoch milliseconds.
  - `logical` is a non-negative decimal integer counter.
  - `client_id` is the originating client's UUID in lowercase hex with dashes.
- `[N-39]` Example: `1713801600123:0:8b2c4d1e-6f3a-4e5b-9c1d-2e7f8a4b3c5d`
- `[N-40]` Implementations SHALL parse HLC strings by splitting on `:` with maxsplit=2, since UUIDs contain dashes but not colons.

### 6.2 Storage

- `[N-41]` The last-issued HLC value SHALL be persisted in the `system_state` key/value table under the key `hlc_last`. There is exactly one row for this key.
- `[N-42]` On migration 3, after `client_identity` is seeded, `system_state` SHALL be seeded with `hlc_last = '0:0:<this_client_id>'` (see [N-77]).

### 6.3 Generation rule

- `[N-43]` The HLC generation function (`nextClock()`) SHALL execute inside the same transaction as the mutation it stamps. It SHALL:
  1. Read the current row for `hlc_last` from `system_state`.
  2. Parse it into `(last_wall, last_logical, last_client)`.
  3. Read the current wall-clock time in milliseconds: `current_wall = Date.now()`.
  4. Compute `new_wall = Math.max(last_wall, current_wall)`.
  5. Compute `new_logical`:
     - If `new_wall > last_wall` (time advanced): `new_logical = 0`.
     - If `new_wall === last_wall` (same ms or clock skew backward): `new_logical = last_logical + 1`.
  6. Construct `new_hlc = new_wall + ':' + new_logical + ':' + this_client_id`.
  7. Write `new_hlc` back to `system_state` under `hlc_last`.
  8. Return `new_hlc`.
- `[N-44]` The rule `new_wall = max(last_wall, current_wall)` is essential. It ensures monotonicity across clock skew: if the system clock moves backward (NTP adjustment, user intervention), the HLC continues advancing via the logical counter rather than regressing.
- `[N-45]` There is no upper bound enforced on `new_logical` in v0. If a client generated 2^53 mutations within a single millisecond, the logical counter would overflow JavaScript's safe integer range; this is not a realistic concern at Ether's scale.

### 6.4 Comparison rule

- `[N-46]` Two HLC values are compared by:
  1. Comparing `wall_ms` numerically (higher is later).
  2. If equal, comparing `logical` numerically (higher is later).
  3. If both equal, comparing `client_id` lexicographically (purely to break ties deterministically; has no semantic meaning).
- `[N-47]` Two HLC values with the same `(wall_ms, logical)` but different `client_id` are considered *concurrent* for causality purposes, even though the tie-break orders them deterministically. A sync engine reading the log SHALL treat them as concurrent, not strictly ordered, when resolving conflicts.

Worked examples are in [Appendix A](#hlc-examples).

---

## 7. Wire format <a id="wire-format"></a>

### 7.1 Field inclusion

- `[N-48]` The wire format of a mutation is the JSON serialization of a mutation record with the fields marked "No" in the Wire column of [§3](#schema)'s table OMITTED. [§3](#schema)'s table is the single source of truth for wire-format membership; this section does not re-enumerate.
- `[N-49]` Sanity check: the wire format SHALL contain exactly 14 fields; 3 fields are LOCAL-ONLY. If a reviewer counts differently against [§3](#schema)'s table, either the table has been edited without updating this count, or the reviewer has miscounted — both warrant investigation.

### 7.2 Serialization

- `[N-50]` Wire format is JSON (RFC 8259) with UTF-8 encoding.
- `[N-51]` `payload_before` and `payload_after` SHALL be serialized as nested JSON objects, not as JSON-encoded strings. (That is: the on-disk TEXT representation of the payload is parsed to an object, which is then nested in the wire JSON. Double-encoding is forbidden.)
- `[N-52]` Field order in the wire JSON is not semantically significant but SHOULD follow the order in [§3](#schema)'s table for consistency and diffability.
- `[N-53]` All UUIDs in the wire format SHALL be serialized in RFC 4122 lowercase-hex-with-dashes format. This matches [N-09]'s write-time requirement. Receivers that observe uppercase or non-standard UUID formats SHALL reject the mutation as malformed rather than normalize silently; normalization on receive would mask bugs in the originating client.

### 7.3 Writer module exposure

- `[N-54]` The writer module SHALL expose a function `toWireFormat(mutationRow)` that accepts a full 17-field row (as read from the mutations table) and returns a 14-field wire-format object. In v0, this function is used primarily by tests and by future sync code; production code paths do not invoke it yet.

### 7.4 Receiver obligations (forward reference)

- `[N-55]` The v0 wire format is defined; v0 does not specify a receiver. When the sync engine is added in a future version, receivers SHALL:
  - Set `origin = 'remote'` on received mutations.
  - Set `applied_at` to the receiver's current wall-clock time at application.
  - Set `sync_status = 'pending'` initially, advancing through states per the receiver's own sync state machine.
  - Preserve all other fields byte-exact.

---

## 8. Schema version rules <a id="schema-version-rules"></a>

### 8.1 What schema_version refers to

- `[N-56]` `schema_version` in a mutation record refers to the *overall Ether DB schema version* of the originating client at the time the mutation was created. Not per-table, not per-column. There is one global schema version.
- `[N-57]` The current DB schema version is maintained in the existing `schema_version` table (used by sync-ready 1/7 and 2/7). The mutation writer SHALL read this value at mutation-write time.

### 8.2 When to bump

- `[N-58]` The schema_version SHALL be incremented when any of the following changes is made to a synced table:
  - A column is added, removed, or renamed.
  - A column's type or constraint changes.
  - A new table is added to the synced-tables list.
  - A table is removed from the synced-tables list.
  - Semantics of a column change in a way that payload transformation logic must be aware of (e.g., a field that previously held seconds now holds milliseconds).
- `[N-59]` Changes that do NOT require a schema_version bump:
  - Index additions or removals on a synced table.
  - Changes to non-synced tables.
  - Changes to local-only columns on synced tables, provided those columns are already marked local-only. (A local-only column's contents are not in payloads, so old mutations remain interpretable.)
- `[N-60]` When in doubt, bump. A superfluous bump costs one identity transformer ([§10](#migration-requirements)); a missed bump causes silent data corruption across peers. The asymmetry decides it.

### 8.3 Current version

- `[N-61]` At the time of this document (Session A), the current schema_version is 2 (sync-ready 2/7 complete). Session A2 advances it to 3 by creating the mutations, client_identity, and system_state tables and is therefore a schema_version bump.

---

## 9. Schema version compatibility <a id="schema-compat"></a>

When two peers with different schema versions exchange a mutation, the receiver must decide how to interpret it. v0 adopts a split policy: backward-compat by replay, forward-compat by reject-and-quarantine.

### 9.1 Backward compatibility (receiver is newer)

- `[N-62]` When a peer at schema_version M receives a mutation tagged with schema_version N where `N < M`, the receiver SHALL interpret the mutation by replaying payload transformers forward from N through M. Specifically:
  1. Start with the received payload (`payload_before` and `payload_after`).
  2. For each integer `v` in `[N, N+1, ..., M-1]`, apply the payload transformer associated with migration `v → v+1` to both payloads.
  3. After the transformer chain completes, the payloads are interpretable at schema_version M and may be applied to local tables.
- `[N-63]` If any transformer in the chain throws or returns an invalid payload, the receiver SHALL reject the mutation, set `sync_status = 'conflicted'`, and surface the error for operator review. It SHALL NOT apply a partially-transformed payload.

### 9.2 Forward compatibility (receiver is older)

- `[N-64]` When a peer at schema_version M receives a mutation tagged with schema_version N where `N > M`, the receiver SHALL:
  1. NOT apply the mutation to local tables.
  2. NOT record the mutation in the local mutations log as applied.
  3. Preserve the raw wire-format bytes in a quarantine store (structure defined by the sync-engine spec, out of scope for v0).
  4. Expose a count of quarantined-forward mutations via the operator-facing sync status (UI defined by operator-UI spec, out of scope for v0).
  5. When the receiver is later upgraded to schema_version ≥ N, it SHALL drain the quarantine, replay each quarantined mutation through the backward-compat path ([N-62]) if applicable, and apply. Successful drain mutations enter the mutations log with `origin='remote'` at that point.
- `[N-65]` Rationale: an older peer cannot correctly apply a payload written for a newer schema without speculative logic. Rejecting-and-quarantining is safer than guessing, AND preserves offline-tolerance: a laptop that has been offline for a month and comes back with mutations tagged at an unupgraded schema version does not lose those mutations — they drain after upgrade.

### 9.3 Same version

- `[N-66]` When `N === M`, the receiver applies the mutation to local tables and records it in the local mutations log, with no payload transformation.

### 9.4 Transformer chain integrity

- `[N-67]` The backward-compat policy ([N-62]) REQUIRES that a payload transformer exists for every adjacent version pair. See [§10.2](#transformer-harness) for the harness that enforces this.

---

## 10. Migration requirements <a id="migration-requirements"></a>

### 10.1 Every migration includes a payload transformer

- `[N-68]` Every schema migration script (under `scripts/` with the naming convention `migrate-*-phase-sync-N.js` or equivalent) SHALL export a function `payloadTransformer(payload, fromVersion)` where:
  - `payload` is a JSON object representing a `payload_before` or `payload_after` at schema_version `fromVersion`.
  - `fromVersion` is the schema_version the payload is currently at; the function transforms it to `fromVersion + 1`.
  - The function returns the transformed payload object. It SHALL NOT mutate the input.
- `[N-69]` For migrations that do not require payload transformation (index additions, non-synced-table changes, or no-op schema bumps), `payloadTransformer` SHALL be the identity function. An identity transformer SHALL still be explicitly exported; its presence is mandatory. Absence is treated as a bug.
- `[N-70]` A payload transformer handles the full payload for any synced table affected by its migration. If a migration adds a column `foo` to table `bar`, the transformer for that migration SHALL, when transforming a payload from table `bar`, add `foo` with its default value. Transformers on payloads from tables not touched by the migration SHALL return the payload unchanged.

### 10.2 Transformer chain harness <a id="transformer-harness"></a>

- `[N-71]` A test harness (`scripts/verify-transformer-chain.js` or equivalent) SHALL verify that the set of migration scripts collectively provides a payload transformer for every adjacent version pair from 1 to the current schema_version.
- `[N-72]` The harness SHALL:
  1. Enumerate all migration scripts in `scripts/` matching the recognized migration naming convention.
  2. For each script, require it and assert `typeof module.exports.payloadTransformer === 'function'`.
  3. Assert that the set of migrations covers every integer gap from 1 to the current schema_version with no holes and no duplicates.
  4. Exit non-zero with a clear error message if any assertion fails.
- `[N-73]` The harness SHALL run as a pre-commit hook. The check is fast (require()-ing migration scripts and asserting function existence — milliseconds) and catches the "I'll push the migration now and add the transformer before release" class of solo-dev bug when memory is freshest.

### 10.3 Schema version advancement

- `[N-74]` A migration that bumps schema_version SHALL insert a new row into the `schema_version` table (existing convention) AND contain a payload transformer per [N-68]. Both are required; a migration missing either is rejected by code review and by the transformer-chain harness.

---

## 11. Client identity <a id="client-identity"></a>

### 11.1 Table

- `[N-75]` A `client_identity` table SHALL exist at schema_version 3 with the following shape:
  ```sql
  CREATE TABLE client_identity (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    client_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    label TEXT
  );
  ```
  The `CHECK (id = 1)` enforces at most one row.
- `[N-76]` The `label` column is a human-readable device name (e.g. "Studio workstation", "Laptop"). Optional; may be set by the operator via a settings UI. v0 does not specify the UI.

### 11.2 Seeding (migration-time, atomic)

- `[N-77]` Migration 3 SHALL, within the same transaction that creates the `client_identity` and `system_state` tables:
  1. Generate a new UUID v4 via `crypto.randomUUID()`.
  2. INSERT a row into `client_identity` with that UUID, the current ISO 8601 UTC timestamp, and NULL label.
  3. INSERT a row into `system_state` with key `hlc_last` and value `'0:0:<generated_client_id>'`.

  Schema creation and seeding SHALL be atomic: if any step fails, the entire migration rolls back. A partial state (tables exist but rows missing) is not a recoverable condition, as migrations run exactly once per DB file.

### 11.3 Boot-time assertion

- `[N-78]` On every application startup, the writer module's initialization SHALL verify that `client_identity` contains exactly one row AND that `system_state` contains the `hlc_last` row. If either is missing, the writer SHALL refuse to initialize and SHALL:
  1. Log a fatal error to stderr naming the exact missing table/row.
  2. Expose the error via a documented error code (`ERR_SYNC_INFRA_MISSING`) so the application's startup logic can surface it to the operator via the UI rather than silently starting without sync.
  3. Prevent any mutation-logged write from succeeding until the condition is resolved.

  This is a boot-time assertion, not a seeding path. A missing row indicates DB corruption and requires operator action (restore from backup, reinstall, or manual recovery — all outside this spec). Self-repair via regeneration is explicitly forbidden: silently regenerating a lost `client_id` would look like two different clients from the sync engine's perspective — every mutation before regeneration orphaned, every mutation after attributed to a ghost client.

### 11.4 Persistence and lifetime

- `[N-79]` The `client_id` is stable for the life of the database file. Ether application upgrades SHALL NOT change it.
- `[N-80]` If the database file is deleted or replaced (reinstall, migration to new machine without DB copy), a new `client_id` will be generated by the next migration 3 run on the fresh DB. This is the expected behavior: the new install is a new client from the sync engine's perspective.
- `[N-81]` Operators MAY relabel a client via `label`. Operators SHALL NOT manually edit `client_id`; doing so breaks causality tracking across peers.

### 11.5 Reading

- `[N-82]` The writer module SHALL read `client_id` once per process (at module initialization or first use) and cache it in memory. Subsequent reads are from the cache. The DB is not consulted per mutation.

---

## 12. Compaction intent <a id="compaction"></a>

Compaction is not implemented in v0. This section documents what it will eventually do so that schema and wire-format decisions now do not foreclose it later.

### 12.1 Expected shape

- `[N-83]` Compaction is anticipated to reduce the size of the mutations log by deleting mutations whose information is no longer needed for convergence, while preserving the ability to reconstruct current row state.
- `[N-84]` A representative compaction strategy (illustrative, not prescriptive):
  - For each (table, row) pair, once all peers have acknowledged receipt of mutation `M`, and no open conflict references `M` via `parent_mutation_id`, all mutations older than `M` on that row may be replaced with a single *checkpoint* mutation that records the row's state at `M`.
  - Checkpoint mutations SHALL use the `op='checkpoint'` value reserved by [N-10], and SHALL carry `payload_after` but `payload_before = NULL`.
- `[N-85]` Alternative strategies (time-windowed deletion, per-client retention policies) are not ruled out. The schema supports compaction of any shape, provided the compacting code preserves causality for unsynced mutations.

### 12.2 Implications for v0

- `[N-86]` v0 SHALL NOT delete from the mutations table ([N-14]).
- `[N-87]` v0 SHALL NOT add foreign keys from other tables pointing into mutations. Any such FK would block future compaction.
- `[N-88]` The writer module SHALL export a `compactMutations()` function stub that throws `"compaction not implemented in v0"`. Its presence reserves the API and prompts future-Claude to implement it rather than invent a new one.

---

## 13. Open questions <a id="open-questions"></a>

These are questions deliberately deferred. None are v0 blockers. Each SHALL be resolved before the sync engine itself is implemented.

- `[Q-01]` **Blob store layout.** Where do binary blobs physically live, and how are they addressed (content hash, UUID, path)? Decision needed before the first real `__blob_ref` value is used in production.
- `[Q-02]` **Peer discovery and transport.** How do peers find each other, and over what protocol do they exchange mutations? LAN-only? Via a coordinator? Via a Tailscale-style overlay? User choice?
- `[Q-03]` **Authentication and authorization.** How are peers authenticated? Can a peer refuse mutations from another peer? Per-operator or per-client authorization?
- `[Q-04]` **Conflict detection semantics.** What constitutes a conflict? Two concurrent updates to the same row? Two updates to the same field? Define formally when conflict-resolution strategies are designed.
- `[Q-05]` **Conflict resolution strategies.** Last-write-wins by HLC? Per-field merges? Operator prompt? Likely a per-table-or-per-column policy; v0 defers entirely.
- `[Q-06]` **Sync cursor format.** How does a peer express "I have all mutations up to point X from every other peer"? Vector of HLCs? Per-peer `hlc_last` map? Design with peer discovery.
- `[Q-07]` **Delivery guarantees.** At-least-once? Exactly-once via idempotent application? Ether's target is exactly-once via `id` idempotency, but spell this out when the sync engine is written.
- `[Q-08]` **Mutation log size pressure.** At what log size does compaction become urgent? Benchmark once a realistic corpus exists.
- `[Q-09]` **JSON1 extension availability.** Confirm better-sqlite3's bundled SQLite has JSON1 enabled on all target platforms (Windows, macOS, Linux). Resolve before any code path uses JSON1-specific functions (`json_extract`, `json_tree`, etc.). The nested-JSON payload format in [§4.2](#payload-categories) does NOT require JSON1; it uses plain `JSON.parse`/`JSON.stringify`. v0 does not depend on JSON1.
- `[Q-10]` **Operator UI for sync state.** Where and how does the operator see sync progress, conflicts, pending mutations? UX design, post-v0.
- `[Q-11]` **64-bit integer payload handling.** SQLite INTEGER can hold 64-bit values; JavaScript's Number type loses precision above 2^53 - 1. No synced column in Ether currently exceeds this range. If a future column does (e.g. nanosecond timestamps), payloads SHALL store it as a string, and the column registry in [§4.5](#per-table-registry) SHALL mark such columns with a `'big-int'` sub-category. Deferred until a real case appears.
- `[Q-12]` **Quarantine store structure.** The forward-compat rule ([N-64]) requires a quarantine store for mutations tagged at an unupgraded schema version. Its structure, location, and drain mechanism are defined by the sync-engine spec, not v0. Quarantine is deliberately outside the mutations table and does not use `sync_status` values ([N-12]).
- `[Q-13]` **Sensitive-column handling.** Some columns hold credentials or secrets (e.g. streaming keys, broadcast passwords). v0 handles this by marking known-sensitive columns as `local-only` in the per-table registry (§4.5), which excludes them from both `payload_before` and `payload_after` and therefore from the wire format. This is conservative: secrets don't propagate, each device configures its own. A future protocol version may support cross-device secret propagation via payload-level encryption, a dedicated secrets channel, or operator-gated approval flow. Deferred until a real use case appears that can't be served by per-device config.

---

## 14. Appendix A — worked HLC examples <a id="hlc-examples"></a>

Given a client with `client_id = 8b2c4d1e-6f3a-4e5b-9c1d-2e7f8a4b3c5d`, and an initial `hlc_last = '0:0:8b2c4d1e-6f3a-4e5b-9c1d-2e7f8a4b3c5d'`.

### Example 1 — Normal advance

- Current `hlc_last = '1713801600000:0:8b2c...'`.
- Wall-clock reads `1713801600100`.
- `new_wall = max(1713801600000, 1713801600100) = 1713801600100`.
- Wall advanced, so `new_logical = 0`.
- Result: `'1713801600100:0:8b2c...'`.

### Example 2 — Same-millisecond batch

- Current `hlc_last = '1713801600000:0:8b2c...'`.
- Wall-clock reads `1713801600000` (same ms as last write).
- `new_wall = max(1713801600000, 1713801600000) = 1713801600000`.
- Wall equal, so `new_logical = 0 + 1 = 1`.
- Result: `'1713801600000:1:8b2c...'`.

- A third mutation in the same ms produces `'1713801600000:2:8b2c...'`.
- A fourth: `'1713801600000:3:8b2c...'`.

### Example 3 — Clock skew backward

- Current `hlc_last = '1713801600100:0:8b2c...'` (last mutation happened at wall_ms 1713801600100).
- User's system clock is adjusted by NTP, now reads `1713801599050` (about 1 second earlier).
- Wall-clock reads `1713801599050`.
- `new_wall = max(1713801600100, 1713801599050) = 1713801600100` (HLC holds steady).
- Wall equal to last, so `new_logical = 0 + 1 = 1`.
- Result: `'1713801600100:1:8b2c...'`. Monotonicity preserved; the HLC "runs ahead" of wall time briefly.
- When wall time catches up past 1713801600100, HLC resumes using wall time.

### Example 4 — Comparison across clients

- Client A mutation: `'1713801600000:5:aaaa-...-aaaa'`.
- Client B mutation: `'1713801600000:5:bbbb-...-bbbb'`.
- These have equal `wall_ms` and equal `logical`. They are *concurrent* in causality terms.
- For deterministic tie-breaking (ordering in a list, for example), compare `client_id` lexicographically: A < B, so A's mutation sorts first. But a sync engine SHALL NOT infer that A *caused* B or vice versa; they happened in parallel.

---

## 15. Appendix B — field quick-reference table <a id="field-table"></a>

For reviewers and implementers who just need the field list without the prose.

| # | Field | Type | Null? | Wire | One-line purpose |
|---|---|---|---|---|---|
| 1 | `id` | TEXT | N | Y | Mutation UUID |
| 2 | `client_id` | TEXT | N | Y | Originating client |
| 3 | `station_id` | TEXT | N | Y | Tenant scope |
| 4 | `actor_id` | TEXT | Y | Y | Operator who made the change |
| 5 | `table_name` | TEXT | N | Y | Target table |
| 6 | `row_id` | TEXT | N | Y | Target row UUID |
| 7 | `op` | TEXT | N | Y | insert/update/delete (+ reserved checkpoint) |
| 8 | `payload_before` | TEXT | Y | Y | JSON row state before |
| 9 | `payload_after` | TEXT | Y | Y | JSON row state after |
| 10 | `created_at` | TEXT | N | Y | ISO 8601 UTC at origin |
| 11 | `applied_at` | TEXT | N | **N** | ISO 8601 UTC at local apply |
| 12 | `hlc` | TEXT | N | Y | Hybrid logical clock |
| 13 | `parent_mutation_id` | TEXT | Y | Y | Causal parent |
| 14 | `schema_version` | INTEGER | N | Y | DB schema at origin |
| 15 | `origin` | TEXT | N | **N** | local/remote/system/migration |
| 16 | `sync_status` | TEXT | N | **N** | pending/syncing/synced/conflicted |
| 17 | `conflict_resolution` | TEXT | Y | Y | JSON merge record |

Wire = 14. Local-only = 3 (`applied_at`, `origin`, `sync_status`).

---

*End of sync-protocol-v0. Locked.*
