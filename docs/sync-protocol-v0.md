# Ether sync protocol v0

**Status:** Locked. All architectural decisions are committed. All prior open questions (Q-01..Q-15) are closed in [§13](#closed-questions). New rules added in Stage 1 (Phase F) begin at [N-91].
**Owner:** Jeff
**Scope:** Defines the mutation log schema, wire format, clock strategy, payload conventions, schema-version compatibility rules, migration requirements, push/pull/merge algorithm, transport interface contract, tombstone semantics, idempotency rules, and local retention policy for Ether's custom CRDT sync engine. This document is the source of truth for every piece of sync-related code.

Normative statements are numbered `[N-nn]`. When a code review or bug report references a rule, use that number. Example: *"this violates [N-12]"* is unambiguous.

**Numbering stability.** Rule numbers are permanent. Once this document is committed, a rule that is superseded or removed is replaced with a placeholder of the form *"[N-NN] Deleted — reason. Number reserved, do not reuse."* New rules always get the next unused number; numbers are never shifted to close gaps.

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
13. [Closed questions](#closed-questions)
14. [Appendix A — worked HLC examples](#hlc-examples)
15. [Appendix B — field quick-reference table](#field-table)
16. [Phase 5 amendment — install-scoped mutations](#phase5)
17. [Push protocol](#push)
18. [Pull and sync cursor](#pull)
19. [Merge: apply remote mutations](#merge)
20. [Tombstone semantics](#tombstone)
21. [Transport interface contract](#transport)
22. [Local retention policy](#retention)
23. [Appendix C — Stage 2 test plan](#test-plan)

---

## 1. Purpose and non-goals <a id="purpose"></a>

**Purpose.** Specify the data structures and rules that allow Ether instances running on different devices to exchange mutations and converge to the same state, without relying on a central authority and without losing data under concurrent edits or offline operation.

**Non-goals (explicitly out of scope for v0).**

- `[N-01]` This document does not specify peer discovery. Transport is a pluggable interface ([§21](#transport)); peer discovery is hidden inside each transport implementation.
- `[N-02]` This document does not specify conflict detection or resolution beyond LWW by HLC ([§19](#merge)). The mutation log is the audit trail.
- `[N-03]` This document does not specify how blobs (audio files, images, waveform caches) are replicated between peers. It specifies only how mutations *refer* to blobs. A separate blob-sync protocol is anticipated.
- `[N-04]` This document does not specify authentication or authorization between peers. Auth is the transport layer's responsibility ([N-116]).

**What v0 does specify.** Everything required so that when the sync engine is written, the mutation log it reads from and writes to is already correct, complete, and stable.

---

## 2. Terminology <a id="terminology"></a>

- **Mutation.** A single INSERT, UPDATE, or DELETE operation against a row in a synced table. Each mutation is recorded as one row in the `mutations` table.
- **Synced table.** One of the 37 tables enumerated in `electron/sync/synced-tables.js`. Mutations on non-synced tables are not logged and do not participate in sync.
- **Infrastructure table.** A table that supports the sync mechanism itself: `mutations`, `client_identity`, `system_state`. See [N-05](#schema).
- **Client.** One install of Ether on one machine, identified by a `client_id` UUID generated at migration time. A single person may have multiple clients (studio workstation, laptop, backup rig). Each is a distinct peer.
- **Station.** A tenant scope within Ether (see Phase 3 work). Mutations are always station-scoped or install-scoped; sync is scoped accordingly.
- **Actor.** The operator (user) who initiated the mutation, identified by `operator_id`. Distinct from `client_id`: one operator may work on multiple clients; one client may be used by multiple operators over time.
- **HLC (Hybrid Logical Clock).** A timestamp combining wall-clock time with a logical counter, used to causally order mutations across clients. See [§6](#hlc).
- **Wire format.** The subset of mutation fields that is serialized and transmitted between peers. See [§7](#wire-format).
- **Payload.** The JSON representation of a row's state, stored in `payload_before` and `payload_after`. See [§4](#payload-categories) and [§5](#payload-conventions).
- **Transformer.** A function associated with a schema migration that converts a payload from one schema version to the next. See [§10](#migration-requirements).
- **Quarantine.** A store (outside the mutations table) for mutations that cannot be applied at the current schema_version. See [N-64](#schema-compat).
- **Sync cursor.** A per-peer map of the highest HLC received and successfully processed from each known peer. See [N-96](#pull).
- **Causal hold queue.** An in-memory (or lightweight table) store for received mutations whose `parent_mutation_id` has not yet been applied locally. See [N-103](#merge).
- **LWW (last-write-wins).** The universal conflict resolution strategy: when two mutations target the same row, the one with the higher HLC wins and its `payload_after` is applied to the live table. The losing mutation is still logged.

---

## 3. Mutation record schema <a id="schema"></a>

- `[N-05]` Writes to infrastructure tables (`mutations`, `client_identity`, `system_state`) SHALL NOT themselves generate mutation log entries. These tables support the sync mechanism; they are not synced data. This rule prevents recursive logging.
- `[N-06]` The mutations table SHALL have exactly the 17 fields listed below. No additional fields in v0.
- `[N-07]` Every field is either required (non-nullable in SQLite) or nullable with documented meaning for NULL. The table below is authoritative. **The Wire column is the single source of truth for wire-format membership; [§7](#wire-format) references this table rather than re-enumerating.**

| # | Field | SQLite type | Nullable | Wire | Purpose |
|---|---|---|---|---|---|
| 1 | `id` | TEXT PRIMARY KEY | No | Yes | UUID v4 identifying this mutation globally. |
| 2 | `client_id` | TEXT | No | Yes | UUID of the client that created this mutation. |
| 3 | `station_id` | TEXT | Yes | Yes | Tenant scope; NULL for install-scoped mutations ([N-89]). |
| 4 | `actor_id` | TEXT | Yes | Yes | Operator UUID if known; NULL for `origin='system'` or `'migration'`. |
| 5 | `table_name` | TEXT | No | Yes | One of the 37 synced table names. |
| 6 | `row_id` | TEXT | No | Yes | UUID of the target row (not the integer `id` PK — the `uuid` column added in sync-ready 1/7). |
| 7 | `op` | TEXT | No | Yes | One of `'insert'`, `'update'`, `'delete'`, or reserved `'checkpoint'`. See [N-10]. |
| 8 | `payload_before` | TEXT | Yes | Yes | JSON of row state before mutation. NULL for `op='insert'`. See [§5](#payload-conventions). |
| 9 | `payload_after` | TEXT | Yes | Yes | JSON of row state after mutation. NULL for `op='delete'`. See [§5](#payload-conventions). |
| 10 | `created_at` | TEXT | No | Yes | ISO 8601 UTC wall-clock time at originating client. For display and audit only — do not use for ordering. |
| 11 | `applied_at` | TEXT | No | **No** | ISO 8601 UTC wall-clock time the mutation was applied to the local DB. For local mutations equals `created_at`. For remote mutations equals arrival time. |
| 12 | `hlc` | TEXT | No | Yes | Hybrid logical clock value. Primary ordering key across clients. Format in [§6](#hlc). |
| 13 | `parent_mutation_id` | TEXT | Yes | Yes | UUID of the mutation this one causally depends on, or NULL if none. See [N-103]. |
| 14 | `schema_version` | INTEGER | No | Yes | The schema version of the originating client at creation time. Used by receivers to interpret the payload. See [§9](#schema-compat). |
| 15 | `origin` | TEXT | No | **No** | One of `'local'`, `'remote'`, `'system'`, `'migration'`. Each receiving peer sets this for itself. |
| 16 | `sync_status` | TEXT | No | **No** | One of `'pending'`, `'syncing'`, `'synced'`, `'conflicted'`. Per-peer state; each peer tracks its own. |
| 17 | `conflict_resolution` | TEXT | Yes | Yes | JSON describing how a conflict was resolved, if this mutation is the product of a merge. NULL otherwise. |

- `[N-08]` Fields marked "No" in the Wire column above are LOCAL-ONLY and SHALL NOT be included in the wire format. Fields marked "Yes" ARE included. Any edit to this table's Wire column is a protocol change.
- `[N-09]` `id`, `client_id`, `station_id`, `actor_id`, `row_id`, and `parent_mutation_id` are all UUIDs stored as lowercase hex strings with dashes (standard RFC 4122 format). Implementations SHALL reject non-conforming UUIDs at write time.
- `[N-10]` `op` SHALL be enforced by a CHECK constraint: `CHECK (op IN ('insert', 'update', 'delete', 'checkpoint'))`. The `'checkpoint'` value is RESERVED for future compaction use (see [§12](#compaction)) and SHALL NOT be written by v0 code. Including it in the CHECK constraint now avoids a schema bump when compaction lands.
- `[N-11]` `origin` SHALL be enforced by a CHECK constraint: `CHECK (origin IN ('local', 'remote', 'system', 'migration'))`.
- `[N-12]` `sync_status` SHALL be enforced by a CHECK constraint: `CHECK (sync_status IN ('pending', 'syncing', 'synced', 'conflicted'))`.
  - **Cross-reference:** Quarantine-forward state ([N-64]) is NOT a `sync_status` value. Quarantined-forward mutations live in a separate store (structure defined by the sync-engine spec). Do not conflate quarantine with `sync_status`.

### 3.1 Required indexes

- `[N-13]` The following indexes SHALL exist on the mutations table at schema version 3:
  - `idx_mutations_table_row_hlc` on `(table_name, row_id, hlc)` — reconstruct row history in order.
  - `idx_mutations_client_hlc` on `(client_id, hlc)` — per-device sync cursor queries.
  - `idx_mutations_station_created` on `(station_id, created_at)` — tenant-scoped audit queries.
  - `idx_mutations_sync_status` on `(sync_status)` — find pending mutations quickly.
  - `idx_mutations_created` on `(created_at)` — time-range queries.
- **Naming note.** Mutations indexes use `idx_mutations_<purpose>` naming because the table needs several specialized indexes. Other sync-ready indexes (e.g. `idx_songs_uuid`, `idx_play_log_uuid` from sync-ready 1/7) use `idx_<table>_<column>` because each table has a single uuid index. The divergence is intentional; do not "fix" it.

### 3.2 Row count and retention notes

- `[N-14]` v0 implementations SHALL NOT delete from the mutations table outside of the retention policy defined in [§22](#retention).

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

`[N-24]` **Local-only columns** are columns whose value is not meaningful outside this client and SHALL be excluded from payloads entirely. Examples: cache timestamps, UI state flags specific to a client, computed fields that each peer recomputes from other data, per-machine credentials.

- `[N-25]` Local-only columns SHALL be declared in the per-table registry. The writer SHALL omit them from both `payload_before` and `payload_after`.

### 4.5 Per-table column category registry <a id="per-table-registry"></a>

- `[N-26]` `electron/sync/synced-tables.js` SHALL export, for each of the 37 synced tables, a declaration that categorizes every column as scalar, json-text, blob-ref, or local-only. Example shape:
  ```js
  {
    tableName: 'songs',
    scope: 'install',
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

### 7.4 Receiver obligations

- `[N-55]` Receivers SHALL:
  - Set `origin = 'remote'` on received mutations.
  - Set `applied_at` to the receiver's current wall-clock time at application.
  - Set `sync_status = 'synced'` after successful application per [§19](#merge).
  - Preserve all other fields byte-exact from the wire format.

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
  3. Preserve the raw wire-format bytes in a quarantine store (a separate SQLite table outside `mutations`; structure defined by Stage 2 implementation).
  4. Expose a count of quarantined-forward mutations via the application error log.
  5. When the receiver is later upgraded to schema_version ≥ N, drain the quarantine, replay each quarantined mutation through the backward-compat path ([N-62]) if applicable, and apply. Successful drain mutations enter the mutations log with `origin='remote'` at that point.
- `[N-65]` Rationale: an older peer cannot correctly apply a payload written for a newer schema without speculative logic. Rejecting-and-quarantining is safer than guessing, AND preserves offline-tolerance: a laptop that has been offline for a month and comes back with mutations tagged at an unupgraded schema version does not lose those mutations — they drain after upgrade.

### 9.3 Same version

- `[N-66]` When `N === M`, the receiver applies the mutation to local tables and records it in the local mutations log, with no payload transformation.

### 9.4 Transformer chain integrity

- `[N-67]` The backward-compat policy ([N-62]) REQUIRES that a payload transformer exists for every adjacent version pair. See [§10.2](#transformer-harness) for the harness that enforces this.

---

## 10. Migration requirements <a id="migration-requirements"></a>

### 10.1 Every migration includes a payload transformer

- `[N-68]` Every schema migration script (under `scripts/` with the naming convention `migrate-*-phase-sync-N.js` or equivalent) SHALL export a function `payloadTransformer(payload, fromVersion, mutationEnvelope)` where:
  - `payload` is a JSON object representing a `payload_before` or `payload_after` at schema_version `fromVersion`.
  - `fromVersion` is the schema_version the payload is currently at; the function transforms it to `fromVersion + 1`.
  - `mutationEnvelope` is the full wire-format mutation object (14 fields), passed for cases where the transformer needs the HLC or other mutation metadata to produce correct defaults (see [Q-15] in [§13](#closed-questions)).
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

- `[N-86]` v0 SHALL NOT delete from the mutations table except via the retention policy in [§22](#retention).
- `[N-87]` v0 SHALL NOT add foreign keys from other tables pointing into mutations. Any such FK would block future compaction.
- `[N-88]` The writer module SHALL export a `compactMutations()` function stub that throws `"compaction not implemented in v0"`. Its presence reserves the API and prompts future-Claude to implement it rather than invent a new one.

---

## 13. Closed questions <a id="closed-questions"></a>

All questions from the original open-questions section are now resolved. Decisions are locked. The Q-numbers are preserved for cross-reference stability.

**[Q-01] Blob store layout — CLOSED**
Decision: blob-sync is a separate arc, out of scope for Phase F. v1 sync transports blob-ref metadata only (path + size per [N-22]/[N-23]). Binary replication is explicitly deferred until a blob-sync protocol is defined. No action required before Stage 2.

**[Q-02] Peer discovery and transport — CLOSED**
Decision: pluggable transport interface, defined in [§21](#transport). HTTP is the first implementation; P2P is deferred. The sync engine calls only the transport interface; discovery is hidden inside each transport implementation.

**[Q-03] Authentication and authorization — CLOSED**
Decision: auth is the transport layer's responsibility per [N-116]. The sync protocol is auth-agnostic. SEC1 (unauthenticated backend endpoints) is a hard gate before any sync endpoint is exposed in production. Phase F development proceeds locally without auth enforcement.

**[Q-04] Conflict detection semantics — CLOSED**
Decision: LWW (last-write-wins) by HLC is universal. There is no explicit conflict detection step. A concurrent write to the same row produces a winner (higher HLC, whose `payload_after` is applied) and a loser (lower HLC, whose mutation is logged but not applied to the live table). Both are in the mutation log. The mutation log is the full audit trail.

**[Q-05] Conflict resolution strategies — CLOSED**
Decision: LWW by HLC, no per-table policies, no per-field merge, no operator prompt. See [§19](#merge) Step 5 ([N-105]/[N-106]). Concurrent-write coordination is a staff workflow concern, not an engine concern.

**[Q-06] Sync cursor format — CLOSED**
Decision: a per-peer HLC map. Format: `{ "<client_id>": "<hlc_string>", ... }`. Persisted in `system_state` under key `sync_cursor` as a JSON string. Full specification in [§18](#pull) ([N-96]).

**[Q-07] Delivery guarantees — CLOSED**
Decision: exactly-once via UUID idempotency. A mutation received twice is a no-op at the live table — the second receive is caught by the idempotency check ([N-100]) and the cursor is advanced without re-applying.

**[Q-08] Mutation log size pressure — CLOSED**
Decision: local 90-day rolling window per [§22](#retention). Backend retains forever. No pressure benchmark is planned; the 90-day window is the policy.

**[Q-09] JSON1 extension availability — CLOSED**
Decision: JSON1 is not required by this protocol. All payload construction and reading uses `JSON.parse`/`JSON.stringify`. If JSON1 functions are used in future code, confirm availability at that time. No action required now.

**[Q-10] Operator UI for sync state — CLOSED**
Decision: none in v1. The mutation log is the audit trail. A sync-status UI is deferred to a future arc after the engine is stable.

**[Q-11] 64-bit integer payload handling — CLOSED**
Decision: deferred. No current synced column exceeds 2^53. If a future column does, the registry SHALL mark it with a `'big-int'` sub-category and the payload SHALL store it as a string. No action required now.

**[Q-12] Quarantine store structure — CLOSED**
Decision: deferred to Stage 2 implementation. When built, use a separate SQLite table (outside `mutations`) with columns for raw wire-format bytes, foreign_schema_version, received_at, and a retry-after timestamp for drain scheduling.

**[Q-13] Sensitive-column handling — CLOSED**
Decision: two mechanisms enforced in the registry. (a) `install_secrets_kv` has `syncExcluded: true` — the entire table is excluded from all push payloads at [N-92a]. (b) Individual credential columns (`stream_key` on `rtmp_destinations`, `icecast_password` on `stations`, `mount_pending_provision` on `stations`) are marked `local-only` in the registry — excluded from `payload_before` and `payload_after` per [N-24]/[N-25]. Each device configures these independently.

**[Q-14] Cross-DB station_id resolution — CLOSED**
Decision: deferred. Single-DB operation is currently unambiguous (integer station_ids start at 1 per DB and don't conflict within one DB). Resolution required before any cross-DB multi-operator sync is enabled. Not a Stage 2 blocker.

**[Q-15] Payload transformer default semantics — CLOSED**
Decision: option (β). The transformer function signature now includes the full mutation envelope as its third argument (`mutationEnvelope`) per [N-68]. When a migration adds a NOT NULL column, the transformer SHOULD use the HLC wall-ms component of the mutation (`mutationEnvelope.hlc.split(':')[0]`) as the default value for timestamp-style columns. For non-timestamp columns, the transformer SHALL use a table-specific documented default that is stated in the migration script's comment. The transformer MUST NOT emit null for a NOT NULL column, and MUST NOT use receive time (option α) as it mislabels historical rows.

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
- For deterministic tie-breaking (ordering in a list, for example), compare `client_id` lexicographically: A < B, so B's mutation sorts later and wins LWW. But a sync engine SHALL NOT infer that A *caused* B or vice versa; they happened in parallel.

---

## 15. Appendix B — field quick-reference table <a id="field-table"></a>

For reviewers and implementers who just need the field list without the prose.

| # | Field | Type | Null? | Wire | One-line purpose |
|---|---|---|---|---|---|
| 1 | `id` | TEXT | N | Y | Mutation UUID |
| 2 | `client_id` | TEXT | N | Y | Originating client |
| 3 | `station_id` | TEXT | **Y** | Y | Tenant scope; NULL for install-scoped writes [N-89] |
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

## 16. Phase 5 amendment — install-scoped mutations <a id="phase5"></a>

**[N-89] — `station_id` is NULL for install-scoped table writes.**
Mutations for install-scoped tables (`songs`, `artists`, `albums`, `mood_tags`, `install_config_kv`, `install_secrets_kv`) store NULL in `station_id`. These tables carry no station affiliation — the same row is shared across all stations on the install. Callers MUST pass `null` explicitly; `undefined` remains a programmer error and the writer rejects it. The `String()` coercion in [Q-14] applies only when `station_id` is non-null; null passes through to SQL as NULL. Schema change: `mutations.station_id` was `TEXT NOT NULL` in v3; relaxed to `TEXT` (nullable) in v5 migration `migrate-mutations-null-station-phase-sync-5.js`.

**[N-90] — Receiver semantics for install-scoped mutations (station_id = NULL).**
A sync receiver that receives a mutation with `station_id = NULL` applies it to the install-scoped table without any station filtering. The receiver MUST NOT substitute its own `station_id` into the row or the mutation record. Idempotency checks for install-scoped mutations use `(table_name, row_id, hlc)` only, ignoring `station_id`. Station-scoped mutations continue to use `(station_id, table_name, row_id, hlc)` for idempotency as before.

---

## 17. Push protocol <a id="push"></a>

- `[N-91]` **Push trigger.** The sync scheduler initiates a push after any successful local write that sets a mutation to `sync_status='pending'`, and on a configurable periodic interval as a fallback. The scheduler is defined in Stage 2; this section specifies only what it sends and the rules governing a valid push.

- `[N-92]` **Push filter.** Before building the outbound batch, the engine SHALL exclude:
  - **(a)** All mutations where `table_name` maps to a REGISTRY entry with `syncExcluded: true`. This unconditionally excludes `install_secrets_kv`.
  - **(b)** All mutations where `table_name` maps to a REGISTRY entry with `scope: 'local-only'`. This unconditionally excludes `monitor_routing`.
  - **(c)** All mutations with `sync_status != 'pending'`. Already-synced mutations are not resent.
  
  The filter is applied at the point of batch construction, not at write time. All mutations, including excluded ones, are still written to the local `mutations` table for audit purposes.

- `[N-93]` **Push batch format.** A push request body is a JSON object:
  ```json
  {
    "client_id": "<UUID of this client>",
    "station_id": "<station UUID or null for install-scoped>",
    "batch": [ <wire-format mutation>, ... ]
  }
  ```
  `batch` contains 14-field wire-format objects produced by `toWireFormat()` ([N-54]). The batch SHALL be limited to 500 mutations per request. Larger backlogs are chunked across sequential requests in HLC ascending order (oldest pending mutations push first).

- `[N-94]` **Push response.** On success the backend returns HTTP 200:
  ```json
  {
    "accepted": ["<mutation-id>", ...],
    "rejected": [{ "id": "<mutation-id>", "reason": "<string>" }, ...]
  }
  ```
  For each accepted ID the engine sets `sync_status = 'synced'`. For each rejected ID the engine logs the reason; `sync_status` remains `'pending'` for retry on the next cycle.

- `[N-95]` **Push failure handling.** On HTTP 5xx or network error, the engine SHALL retry with exponential backoff: initial 5 s, doubling each retry, cap 5 min, retry indefinitely. On HTTP 4xx the engine SHALL NOT retry automatically; it logs the error at ERROR level. On HTTP 401/403 specifically, the engine halts the sync cycle and sets its sync state to `auth_error` ([N-116]).

---

## 18. Pull and sync cursor <a id="pull"></a>

- `[N-96]` **Sync cursor.** The local engine maintains a *sync cursor*: a JSON object mapping every known peer's `client_id` to the highest HLC from that peer that has been successfully processed (either applied to the live table, logged as an LWW loser, confirmed as an idempotency duplicate, or quarantined for schema mismatch). The cursor does NOT advance past mutations that are in the causal hold queue ([N-103]).
  ```json
  { "<client_id_A>": "<hlc_string>", "<client_id_B>": "<hlc_string>" }
  ```
  The cursor is persisted in `system_state` under key `sync_cursor` as a JSON text value. It is updated atomically (inside a SQLite transaction) after each successful batch apply.

- `[N-97]` **Pull request.** A pull request sends the current sync cursor to the backend:
  ```json
  {
    "client_id": "<this client's UUID>",
    "station_id": "<station UUID or null>",
    "cursor": { "<peer_client_id>": "<hlc_string>", ... }
  }
  ```
  The backend returns all mutations it holds that the requesting client has not yet seen. For each `client_id` in the cursor, the backend returns only mutations from that client with `hlc` lexicographically greater than `cursor[client_id]`. For any `client_id` not present in the cursor, the backend returns all mutations from that client.

- `[N-98]` **Pull response.** The backend returns HTTP 200:
  ```json
  {
    "mutations": [ <wire-format mutation>, ... ],
    "server_hlc": "<current server HLC>"
  }
  ```
  Mutations are ordered by HLC ascending. `server_hlc` is informational; in v1 the engine logs it but takes no action on it.

- `[N-99]` **Empty pull.** If there are no new mutations, the backend returns `{ "mutations": [], "server_hlc": "..." }`. The engine takes no action and schedules the next poll at the normal interval.

---

## 19. Merge: apply remote mutations <a id="merge"></a>

Applying a remote mutation is the most critical operation in the sync engine. The steps below execute in order, inside a single SQLite transaction per mutation. If any step throws, the transaction rolls back and the mutation remains unprocessed; the engine logs the error and continues with the next mutation in the batch.

### Step 1 — Idempotency check

- `[N-100]` Before any other processing, the engine SHALL query:
  ```sql
  SELECT 1 FROM mutations WHERE id = ? LIMIT 1
  ```
  If a row is found: this mutation has already been processed. Skip all remaining steps. Advance the sync cursor ([N-96]) past this mutation's HLC. Log at DEBUG level. Do NOT apply the mutation again. Do NOT write another row.

### Step 2 — Filter check

- `[N-101]` Apply the same filter rules as push ([N-92]): if `table_name` resolves to `syncExcluded: true` or `scope: 'local-only'` in the REGISTRY, this is a protocol violation — a well-behaved remote client should never send such a mutation. Log at ERROR level. Do not apply. Do not advance the cursor (to allow investigation). Discard after logging.

### Step 3 — Schema version check

- `[N-102]` Compare the mutation's `schema_version` to the local schema version:
  - **Equal:** proceed to Step 4.
  - **Mutation version is older (local is newer):** apply payload transformers forward per [N-62]. If transformation succeeds, proceed to Step 4. If transformation fails, log at ERROR, set `sync_status = 'conflicted'`, write the raw mutation to the mutations table without applying to the live table, advance cursor.
  - **Mutation version is newer (local is older):** move the raw wire bytes to the quarantine store per [N-64]. Advance cursor past this mutation only if quarantine write succeeds. Do not apply to live table.

### Step 4 — Causal ordering check

- `[N-103]` If `parent_mutation_id` is non-null, query:
  ```sql
  SELECT 1 FROM mutations WHERE id = ? LIMIT 1
  ```
  If the parent is NOT found in the local mutations table: the current mutation cannot yet be applied. Place it in the *causal hold queue* along with its full wire-format bytes. Do NOT write it to the mutations table yet. Do NOT advance the cursor past this mutation. The sync scheduler revisits the causal hold queue after each successful apply batch, retrying every held mutation whose parent is now present. A mutation that has been held for more than 30 minutes generates a WARNING log entry. A mutation held for more than 24 hours generates an ERROR log entry. There is no automatic discard; held mutations remain in the queue until their parent arrives or the operator intervenes.

- `[N-104]` If `parent_mutation_id` is null, or if the parent IS found in the local mutations table, proceed to Step 5.

### Step 5 — LWW resolution

- `[N-105]` Query the local mutations table for the most recent mutation on this `(table_name, row_id)` pair:
  ```sql
  SELECT hlc, op FROM mutations
  WHERE table_name = ? AND row_id = ?
  ORDER BY hlc DESC LIMIT 1
  ```
  This query considers ALL prior mutations on the row regardless of `origin` (local or remote). If no rows are found (the row has no prior history locally), the incoming mutation wins unconditionally — skip the comparison and proceed to Step 6.

  If a prior mutation exists, compare `local_latest_hlc` to the incoming `hlc` using [N-46]:
  - **Incoming HLC is higher (incoming wins):** proceed to Step 6 to apply the incoming mutation's `payload_after` to the live table.
  - **Local HLC is higher (local wins):** the incoming mutation loses. Write the incoming mutation to the local mutations table with `origin='remote'`, `sync_status='synced'`, `applied_at=now()`, and all other fields byte-exact from the wire format — but do NOT apply `payload_after` to the live table. Advance cursor. The losing mutation is permanently in the log for audit and causality; the live row is not changed.
  - **Equal HLC** (same `wall_ms` and `logical`, different `client_id`): break deterministically by `client_id` lexicographic order per [N-46]. The mutation with the lexicographically higher `client_id` wins. Apply winner/loser logic as above.

- `[N-106]` The LWW loser's `payload_after` is NOT applied to the live table. It IS written to the mutations table. No special marker is needed beyond the existing `sync_status='synced'` and `origin='remote'`; an audit query can always reconstruct the winner/loser story by sorting `(table_name, row_id)` history by HLC and observing which mutation's `payload_after` matches the live row's current state.

### Step 6 — Apply to live table

- `[N-107]` The engine reconstructs and executes SQL from the winning mutation's payload. The engine does NOT route remote applies through the typed handlers; it uses the payload directly, since the originating client already validated the data.
  - `op='insert'`: `INSERT OR REPLACE INTO <table> (...) VALUES (...)` using all non-local-only fields from `payload_after`. Local-only columns are omitted; the receiving DB either has its own values for them or they remain at their SQLite default.
  - `op='update'`: `UPDATE <table> SET <non-local-only fields> WHERE uuid = ?`. If the row does not exist locally (install history gap), treat as `INSERT OR REPLACE` using `payload_after`.
  - `op='delete'`: `UPDATE <table> SET deleted_at = <value from payload_before.deleted_at>, updated_at = <value from payload_before.updated_at> WHERE uuid = ?`. This is the tombstone write ([§20](#tombstone)). If the target row does not exist locally, this is a no-op — the tombstone is already satisfied.

### Step 7 — Log and advance cursor

- `[N-108]` Write the incoming mutation to the local mutations table:
  - `origin = 'remote'`
  - `applied_at` = current ISO 8601 UTC timestamp
  - `sync_status = 'synced'`
  - All other fields byte-exact from the wire format.

  Then update the sync cursor: `cursor[incoming.client_id] = max(cursor[incoming.client_id], incoming.hlc)` using HLC comparison [N-46]. Persist the updated cursor to `system_state` within the same transaction as the mutations table write.

  **Cursor advance summary:** The cursor advances after: idempotency duplicate (Step 1), filter reject (Step 2, only on success), schema transform success or quarantine success (Step 3), LWW winner applied (Steps 6–7), LWW loser logged (Step 5–7). The cursor does NOT advance when a mutation is placed in the causal hold queue (Step 4 hold path).

---

## 20. Tombstone semantics <a id="tombstone"></a>

- `[N-109]` **Tombstone model.** Ether uses soft-deletes throughout. Typed handlers for `op='delete'` set `deleted_at` to the current UTC timestamp and leave the row in the table. No row in a synced table is physically removed in normal operation. The delete mutation's `payload_before` captures the full row state including `deleted_at`; `payload_after` is NULL.

- `[N-110]` **Remote tombstone propagation.** When a remote `op='delete'` wins LWW (Step 5), the apply step (Step 6) writes `deleted_at` to the live row. Application code that reads synced tables MUST filter `WHERE deleted_at IS NULL`; tombstone propagation is transparent to the UI.

- `[N-111]` **Tombstone precedence under LWW.** A delete mutation wins or loses purely by HLC. There is no "delete wins" or "delete loses" override. If a remote delete arrives with a lower HLC than the most recent local update, the local update wins and the row survives. If the remote delete has a higher HLC, the row is soft-deleted, even if a local update also exists with a lower HLC.

- `[N-112]` **Re-insert after tombstone.** If a row is re-inserted (same `uuid`) after being tombstoned, the `op='insert'` mutation's `payload_after` carries `deleted_at = null`. The `INSERT OR REPLACE` in Step 6 writes this, clearing the tombstone. For the re-insert to succeed under LWW, it must have a higher HLC than the delete mutation.

---

## 21. Transport interface contract <a id="transport"></a>

- `[N-113]` **Pluggable transport.** The sync engine does not call HTTP directly. It calls a transport object conforming to the interface defined in this section. The HTTP transport is the first implementation; a P2P transport is anticipated. Swapping transports requires only changing which transport object is constructed at startup — no changes to the engine or protocol.

- `[N-114]` **Required methods.** A conforming transport MUST implement exactly the following three async methods:
  ```
  push(batch: PushBatch): Promise<PushResult>
  pull(cursor: SyncCursor): Promise<PullResult>
  healthCheck(): Promise<HealthResult>
  ```
  No other methods are required by the engine. Transports MAY expose additional methods for their own management (e.g. `connect()`, `disconnect()`) but the engine does not call them.

- `[N-115]` **Type shapes** (TypeScript notation, normative):
  ```typescript
  type PushBatch = {
    client_id: string;           // UUID of this client
    station_id: string | null;   // Station UUID or null for install-scoped
    batch: WireMutation[];       // 1..500 wire-format objects per [N-93]
  };

  type PushResult = {
    accepted: string[];          // mutation UUIDs accepted by the backend
    rejected: Array<{ id: string; reason: string }>;
  };

  type SyncCursor = {
    client_id: string;           // UUID of this client
    station_id: string | null;
    cursor: Record<string, string>; // { peer_client_id → hlc_string }
  };

  type PullResult = {
    mutations: WireMutation[];   // 0..n mutations, HLC ascending
    server_hlc: string;          // backend's current HLC (informational)
  };

  type HealthResult = {
    ok: boolean;
    latencyMs: number;
  };

  type WireMutation = {          // the 14 wire fields per [N-48]
    id: string;                  // required
    client_id: string;           // required
    station_id: string | null;   // required (null for install-scoped)
    actor_id: string | null;
    table_name: string;          // required
    row_id: string;              // required
    op: 'insert' | 'update' | 'delete' | 'checkpoint'; // required
    payload_before: object | null; // null for insert
    payload_after: object | null;  // null for delete
    created_at: string;          // ISO 8601, required
    hlc: string;                 // required
    parent_mutation_id: string | null;
    schema_version: number;      // required
    conflict_resolution: object | null;
  };
  ```

- `[N-116]` **Authentication at the transport layer.** Auth is the transport's responsibility. The HTTP transport implementation MUST:
  1. Read the auth token from `install_secrets_kv` under key `sync_auth_token` at initialization.
  2. Send it as `Authorization: Bearer <token>` on every request.
  3. On HTTP 401 or 403: halt sync, set sync state to `auth_error`, surface a message prompting the operator to re-authenticate. Do NOT retry 401/403.
  4. The sync engine never sees the token; it receives only `PushResult`, `PullResult`, or a thrown error.

- `[N-117]` **Transport error contract.** Transport methods SHALL throw on errors that require engine-level attention (network failure, unrecoverable backend error). They SHALL resolve with the result type on partial success (some rejected IDs, empty pull). The engine's retry logic sits above the transport and operates on thrown errors; do not swallow errors inside the transport.

- `[N-118]` **Transport instantiation.** The sync scheduler creates exactly one transport instance at startup and holds it for the process lifetime. The transport MAY maintain a persistent connection internally (WebSocket, SSE); the engine does not manage connection state.

---

## 22. Local retention policy <a id="retention"></a>

- `[N-119]` **90-day rolling window.** The sync scheduler SHALL run a retention job on a weekly interval. The job deletes rows from the local `mutations` table that satisfy ALL of:
  - `created_at < (current UTC − 90 days)`
  - `sync_status = 'synced'`
  - No other row in the local `mutations` table references this row's `id` via `parent_mutation_id`

  Rows are evaluated in HLC ascending order. For each candidate, the parent-reference check is re-evaluated after prior deletions in the same job run (so that parent deletion can unlock child deletion in the same pass).

- `[N-120]` **Pending mutations are never deleted.** Any mutation with `sync_status = 'pending'` or `'syncing'` is excluded from retention regardless of age. A mutation that has been pending for more than 90 days indicates a sync problem; the engine logs it at ERROR level on the weekly retention run but does not delete it.

- `[N-121]` **Referenced mutations are never deleted before their children.** A mutation that is referenced by another mutation's `parent_mutation_id` is retained until the child mutation is itself eligible for deletion. The retention job processes children before parents within the same run where possible; if a child is not yet eligible (e.g. still pending), the parent is skipped for that run.

- `[N-122]` **Backend retention.** The backend retains all mutations forever. The 90-day window is local only. A client that comes online after a long absence pulls from the backend and receives mutations older than its local window. These arrive as remote mutations and are applied normally via [§19](#merge); after successful apply they enter the local mutations table. If the applied mutations are already older than 90 days, they are eligible for deletion on the next weekly retention run.

---

## 23. Appendix C — Stage 2 test plan <a id="test-plan"></a>

Every scenario below MUST pass before Stage 3 (transport) begins. Test IDs are permanent; do not renumber. Prefix: T-nn.

### A. HLC unit tests (no DB)

| ID | Scenario | Expected |
|---|---|---|
| T-01 | Clock advances between two calls | `nextClock` returns a higher HLC on the second call |
| T-02 | Clock skew: `Date.now()` returns value < `hlc_last.wall_ms` | HLC wall component stays at `hlc_last.wall_ms`; logical increments |
| T-03 | Same-millisecond batch of N=100 calls | All HLCs unique; logical counter = 0..99; wall component identical |
| T-04 | HLC comparison: equal wall, equal logical, different client_id | Higher client_id (lexicographic) sorts later; both are flagged concurrent |

### B. Writer unit tests (real SQLite, no network)

| ID | Scenario | Expected |
|---|---|---|
| T-05 | `toWireFormat()` on a 17-field row | Returns exactly 14 fields; `applied_at`, `origin`, `sync_status` absent |
| T-06 | `serializePayload` / `deserializePayload` round-trip for scalar column | Value survives round-trip unchanged |
| T-07 | `serializePayload` / `deserializePayload` round-trip for json-text column | Nested object; not a double-encoded string |
| T-08 | `serializePayload` on blob-ref column | Result is `{ __blob_ref, __blob_size, __blob_origin }` object |
| T-09 | `withMutation` — `dataOpFn` throws | No mutation row written; DB state unchanged |
| T-10 | `withMutation` — `payload_before` read after row deleted by concurrent txn | Writer throws `ERR_PAYLOAD_BEFORE_MISSING`; no mutation row written |

### C. LWW apply tests (real SQLite, no network)

| ID | Scenario | Expected |
|---|---|---|
| T-11 | Remote mutation HLC > local latest | `payload_after` applied to live table; remote mutation logged `origin='remote', sync_status='synced'` |
| T-12 | Remote mutation HLC < local latest | Live table unchanged; remote mutation logged but NOT applied |
| T-13 | Equal HLC, remote `client_id` lexicographically higher | Remote wins; `payload_after` applied to live table |
| T-14 | Equal HLC, remote `client_id` lexicographically lower | Local wins; remote logged but not applied |
| T-15 | No prior mutations for `(table_name, row_id)` | Incoming mutation wins unconditionally; applied to live table |

### D. Causal ordering tests (real SQLite, no network)

| ID | Scenario | Expected |
|---|---|---|
| T-16 | Child mutation arrives before parent | Child placed in causal hold queue; cursor does NOT advance past child |
| T-17 | Parent arrives after child is held | Child unblocked on next scheduler tick; applied in correct order; cursor advances past both |
| T-18 | Three-mutation chain C→B→A; C arrives first, then B, then A | All held until A arrives; applied in order A, B, C; cursor advances past all three |
| T-19 | Child held >30 min (simulated by fast-forwarding the hold timestamp) | WARNING log entry generated |
| T-20 | `parent_mutation_id = null` | No causal check; mutation applied immediately in Step 5 |

### E. Tombstone tests (real SQLite, no network)

| ID | Scenario | Expected |
|---|---|---|
| T-21 | Remote `op='delete'` with higher HLC than local latest | `deleted_at` set on live row; row queryable via `WHERE deleted_at IS NULL` = 0 rows |
| T-22 | Remote `op='delete'` with lower HLC than local update | Live row survives; `deleted_at` remains null; delete mutation logged but not applied |
| T-23 | Re-insert mutation (same `uuid`) with HLC > prior delete HLC | `deleted_at` cleared on live row; row visible again |
| T-24 | Remote delete on row that does not exist locally | No-op; mutation logged; no error |

### F. Security and filter tests (real SQLite, no network)

| ID | Scenario | Expected |
|---|---|---|
| T-25 | Build push batch from a DB containing `install_secrets_kv` mutations | `install_secrets_kv` mutations absent from batch; all other pending mutations present |
| T-26 | Build push batch from a DB containing `monitor_routing` mutations | `monitor_routing` mutations absent from batch |
| T-27 | `rtmp_destinations` mutation payload | `stream_key` absent from both `payload_before` and `payload_after` |
| T-28 | `stations` mutation payload | `icecast_password` and `mount_pending_provision` absent from both payloads |
| T-29 | Remote push containing `install_secrets_kv` table_name | Engine logs ERROR; mutation discarded; cursor does not advance |

### G. Idempotency tests (real SQLite, no network)

| ID | Scenario | Expected |
|---|---|---|
| T-30 | Apply the same mutation UUID twice | Live table state after second apply == state after first apply; only one row in mutations table |
| T-31 | Apply same mutation UUID after it was logged as an LWW loser | Second apply is a no-op; cursor advances; live table still reflects the winner |

### H. Retention tests (real SQLite, no network)

| ID | Scenario | Expected |
|---|---|---|
| T-32 | Synced mutation created >90 days ago, no children | Deleted by retention job |
| T-33 | Pending mutation created >90 days ago | NOT deleted; ERROR logged by retention job |
| T-34 | Synced mutation >90 days old referenced as parent by a pending child | NOT deleted; retention skips it because child is not eligible |
| T-35 | Synced parent and synced child, both >90 days, no further references | Both deleted in the same retention run; parent after child |

### I. Schema compatibility tests (real SQLite, no network)

| ID | Scenario | Expected |
|---|---|---|
| T-36 | Receive mutation at schema_version N-1 (local is at N) | Transformer chain applied; result applied to live table at schema N |
| T-37 | Receive mutation at schema_version N+1 (local is at N) | Mutation quarantined; not applied to live table; cursor advances |
| T-38 | Transformer throws during backward-compat replay | Mutation written with `sync_status='conflicted'`; live table unchanged; error logged |

---

*End of sync-protocol-v0. Locked.*
