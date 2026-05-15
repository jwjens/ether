# Sync Backend Design v0

**Status:** DRAFT — decisions locked 2026-05-14  
**Companion doc:** `docs/sync-protocol-v0.md` (client-side protocol, N-01..N-123)  
**Rule prefix:** B-01..B-24

---

## 1. Scope and Purpose

This document specifies the server-side architecture for the Ether Radio sync backend. It covers database design, multi-tenant model, auth, endpoint contracts, storage, and operations. It does **not** cover client-side merge logic, HLC semantics, or the mutation wire format — those are locked in sync-protocol-v0.md.

The backend is an append log with filtered read access. It does not merge, resolve conflicts, or apply LWW — all of that is client-side. The server's job is:

1. Accept batches of mutations from authenticated clients.
2. Assign a globally monotonic `server_seq` to each accepted mutation.
3. Return ordered mutation slices to clients on demand.

The server is stateless between requests. All state lives in PostgreSQL.

---

## 2. Wire Contract (locked by client)

These are non-negotiable. The client implementation in `electron/sync/transport-http.js` defines them. The server must satisfy them exactly.

### 2.1 Endpoints

```
POST  /sync/mutations
GET   /sync/mutations?client_id=<uuid>&since_seq=<int>[&station_id=<text>]
GET   /health
```

### 2.2 Auth header

Every request carries:

```
x-license-key: <raw license key string>
```

### 2.3 POST /sync/mutations — request body

```json
{
  "client_id": "<uuid>",
  "station_id": "<text> | null",
  "batch": [ <WireMutation>, ... ]
}
```

### 2.4 POST /sync/mutations — response body

```json
{
  "accepted": ["<mutation_id>", ...],
  "rejected": [{ "id": "<mutation_id>", "reason": "<string>" }]
}
```

### 2.5 GET /sync/mutations — response body

```json
{
  "mutations": [ <WireMutation>, ... ],
  "server_hlc": "<hlc_string>",
  "server_seq": <int>
}
```

### 2.6 WireMutation fields (14, per sync-protocol-v0.md §3 + amendment N-123)

| Field                | Type    | Notes                                                    |
|----------------------|---------|----------------------------------------------------------|
| `id`                 | TEXT    | Client-assigned UUID                                     |
| `client_id`          | TEXT    | UUID of originating client                               |
| `station_id`         | TEXT    | Nullable; null for install-scoped tables                 |
| `operator_id`        | TEXT    | Nullable; references operators.id; see N-123             |
| `table_name`         | TEXT    | One of the 37 synced table names                         |
| `row_id`             | TEXT    | UUID of target row                                       |
| `op`                 | TEXT    | `insert` \| `update` \| `delete` \| `checkpoint` (N-10) |
| `payload_before`     | JSONB   | Full row state before; null for op=insert                |
| `payload_after`      | JSONB   | Full row state after; null for op=delete                 |
| `created_at`         | TEXT    | ISO 8601 UTC at originating client                       |
| `hlc`                | TEXT    | Hybrid logical clock value (protocol §6)                 |
| `parent_mutation_id` | TEXT    | Nullable; causal parent UUID (N-103)                     |
| `schema_version`     | INTEGER | DB schema version at originating client                  |
| `conflict_resolution`| JSONB   | Nullable; JSON merge record                              |

The three local-only fields (`applied_at`, `origin`, `sync_status`) are stripped by the client before sending and are never present on the wire. JSONB is the PostgreSQL-native equivalent of the protocol's TEXT JSON columns — semantically identical.

---

## 3. Database and Schema

**B-01 — Database: PostgreSQL.**  
BIGSERIAL for `server_seq`, composite indexes for tenant-filtered range scans, row-level isolation via `WHERE license_key_id = ?`, and horizontal scale available later without rearchitecting. No alternative is worth the tradeoff at any expected scale.

**B-02 — Schema layout: single `mutations` table, `license_key_id` as tenant discriminator.**  
Per-tenant schemas (`CREATE SCHEMA tenant_<uuid>`) require DDL per customer and make cross-tenant analytics impossible. A single table with a `license_key_id` FK column is the proven pattern and scales to millions of mutations without partitioning. PostgreSQL table partitioning by `license_key_id` is available as a future escape hatch if needed.

**B-03 — server_seq: global BIGSERIAL on the `mutations` table.**  
The seq is globally monotonic — not per-tenant. Pull queries are `WHERE license_key_id = ? AND server_seq > ?`, which the index (B-04) makes efficient. A per-tenant sequence adds operational complexity (one sequence object per license key) with no benefit at this scale.

**B-04 — Indexes:**

```sql
-- Primary pull pattern: all mutations for a tenant since cursor
CREATE INDEX idx_mutations_pull
  ON mutations (license_key_id, server_seq);

-- Station-filtered pull (optional station_id query param)
CREATE INDEX idx_mutations_pull_station
  ON mutations (license_key_id, station_id, server_seq)
  WHERE station_id IS NOT NULL;
```

The `UNIQUE (license_key_id, id)` constraint on the `mutations` table (see §10) covers dedup lookups without an additional index.

---

## 4. Multi-Tenant Model

**B-05 — Identity hierarchy: accounts → licenses → mutations.**  
A tenant is an account. An account has one or more licenses (one per installation in practice, but the schema is not artificially restricted). Licenses are the auth unit. This hierarchy adds a single `accounts` table and FKs in v0, and avoids a structural migration when the Control Center feature lands.

The `accounts` table carries a `tier` column (TEXT NOT NULL DEFAULT 'free'). The column exists now so tier-gated features can read it without a migration. The specific tier values, what they gate, and upgrade semantics are deferred — the column is a placeholder for a future arc.

The existing `licenses` table is extended (not replaced) with `account_id`, `key_prefix`, and `key_hash` columns. See §10 for the migration shape.

**B-06 — Data isolation: row-level, enforced at query time.**  
Every query that reads or writes `mutations` is filtered by `license_key_id`. The `license_key_id` is resolved from the `x-license-key` header by the auth middleware before any handler runs. No client-supplied `license_key_id` is trusted. Cross-tenant data is not accessible by any query path.

**B-07 — Provisioning: Stripe Checkout via Railway `ether-backend` service (existing infrastructure).**  
The `ether-backend` service on Railway is already live with `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `PRICE_PRO`, `PRICE_STATION`, `RESEND_API_KEY`, `DATABASE_URL`, and `ADMIN_SECRET` configured. Payment links for Ether Pro ($19/mo) and Ether Station ($79/mo) are active.

Primary provisioning path: customer completes Stripe Checkout → `ether-backend` webhook fires → license key generated and inserted into `licenses` → key emailed to customer via Resend.

A manual admin CLI exists as a backstop for edge cases (refunds, comped accounts, internal testing). It is not the primary path.

**B-08 — Rate limits: 1 push/sec, 1 pull/sec, uniform across all tiers in v0.**  
There is no sync-speed differentiation between tiers. Sync rate is not a monetization lever.

At 1 push/sec with the client's 500-mutation batch ceiling:
- Initial catch-up of 5,645 pending mutations: ~12 pushes = ~12 seconds.
- Steady-state live feel between two clients: ~1 second.

The rate limiter is keyed on `license_key_id` (resolved from the auth header). The tier column is not consulted for rate decisions in v0. When product decides to differentiate sync speed by tier, the only change is a lookup in a rate-limits config — no schema migration required.

Rate limit responses: HTTP 429 with `Retry-After: 1` header. The client's `SyncScheduler` backs off on 429 (existing behavior in `electron/sync/sync-scheduler.js`).

---

## 5. Multi-Station Handling

**B-09 — station_id passes through verbatim.**  
The server stores `station_id` from the wire mutation as received. It does not validate station_id against a registry of known stations. Null station_id means the mutation is install-scoped (per N-89). The server is not a station registry — station lifecycle is managed entirely by the client.

**B-10 — Station-filtered pull is supported.**  
`GET /sync/mutations?client_id=X&since_seq=0&station_id=Y` returns only mutations where `station_id = Y` for the authenticated license key.

`GET /sync/mutations?client_id=X&since_seq=0` (no `station_id` param) returns all mutations for the license key — both install-scoped (null station_id) and all stations. The client currently omits the station_id param on GET (transport-http.js line ~97), so this is the active pull pattern.

Both patterns must work. The station-filtered index (B-04) covers the filtered case.

---

## 6. Auth and Identity

**B-11 — Auth: x-license-key header, stateless per-request.**  
No sessions, no JWTs, no OAuth flows. Every request presents the raw license key in the `x-license-key` header. The auth middleware validates it on every request. There is no persistent session state on the server.

**B-12 — Key storage: bcrypt-with-prefix.**  
The raw key is never stored. The `licenses` table carries two new columns:
- `key_prefix`: first 8 characters of the raw key, plaintext, used for the initial lookup (avoids a full-table bcrypt scan).
- `key_hash`: bcrypt hash of the full raw key.

Auth flow:
1. Extract `x-license-key` from header.
2. Take first 8 chars as prefix; query `WHERE key_prefix = ?` (fast indexed lookup).
3. bcrypt-compare the full raw key against `key_hash`.
4. If no match or `active = false`: return 401.
5. Attach resolved `license_id` and `account_id` to the request context.

bcrypt verify cost is ~100ms. This is acceptable for a machine-to-machine protocol that sends one request per second at most. Plain SHA-256 is never used for auth tokens.

**B-13 — client_id: stored per-mutation, not validated.**  
The `client_id` field in the mutation comes from the client. The server stores it as-is. Multiple `client_id` values under one `license_key_id` are valid and expected (e.g. reinstall generates a new client_id). The server does not maintain a registry of client_ids.

**B-14 — license_activations serves as the installs registry.**  
The existing `license_activations` table (columns: `id`, `license_key`, `machine_id`, `machine_name`, `os`, `ip_address`, `activated_at`, `last_seen`) already tracks per-machine activation state. No separate `installs` table is created in v0. Future arc: add a `client_id` column to `license_activations` to formally link a sync peer (by its `client_identity.client_id`) to a licensed machine.

---

## 7. Endpoint Contracts

**B-15 — POST /sync/mutations: per-mutation accept/reject, idempotent.**

Processing steps for each mutation in the batch:
1. Validate required fields present (`id`, `table_name`, `row_id`, `hlc`, `client_id`, `op`, `schema_version`, `created_at`). Missing required field: reject with `"malformed_mutation"`.
2. Validate `op IN ('insert', 'update', 'delete', 'checkpoint')`. Invalid op: reject with `"invalid_op"`. Note: `license_key_id` is resolved by auth middleware from the request header — it is NOT accepted from the client body.
3. Attempt INSERT. On `UNIQUE (license_key_id, id)` violation: treat as accepted (the mutation is already stored; the client needs to mark it sent). This makes the push idempotent — retrying a batch after a network timeout has no effect.
4. Successful insert: add `id` to `accepted` list.

The batch is processed in a single transaction. If the transaction fails entirely (e.g. DB down): return 503. Do not return partial results.

Maximum batch size: 1,000 mutations. Exceeding this: reject the entire request with 413 before opening a transaction.

**B-16 — GET /sync/mutations: ordered slice, paginated by server_seq.**

Query: `SELECT * FROM mutations WHERE license_key_id = ? AND server_seq > ? [AND station_id = ?] ORDER BY server_seq LIMIT 500`.

Response:
- `mutations`: array of WireMutation objects (server_seq is NOT included in the wire format; it is local to the server).
- `server_seq`: the `server_seq` of the last returned row. If zero rows returned: echo back the `since_seq` param (no advancement).
- `server_hlc`: the `hlc` field of the last returned row. If zero rows: return the server's own current HLC (`<now_ms>:0:<server_uuid>`).

If 500 rows are returned, the client re-pulls immediately (its sync loop re-fires when mutations were returned). This handles the initial catch-up batch flood without a dedicated catch-up endpoint.

**B-17 — GET /health.**

```json
{ "ok": true, "version": "0.1.0", "uptime_s": 12345 }
```

Always returns 200 if the process is running. Database connectivity is checked asynchronously and not gated here (the transport uses this for basic aliveness checks only).

**B-18 — Error response shape:**

```json
{ "error": "<code>", "detail": "<optional string>" }
```

| Status | Code                       | When                                    |
|--------|----------------------------|-----------------------------------------|
| 400    | `malformed_payload`        | Body is not valid JSON or missing fields|
| 401    | `invalid_license_key`      | Key not found or revoked                |
| 413    | `batch_too_large`          | Batch exceeds 1,000 mutations           |
| 429    | `rate_limited`             | Exceeds 1 req/sec; `Retry-After: 1`    |
| 500    | `internal`                 | Unexpected server error                 |
| 503    | `database_unavailable`     | DB connection failure during transaction|

---

## 8. Storage and Retention

**B-19 — Retention: keep forever in v0.**  
No TTL, no pruning job in v0. The server is the canonical log for catch-up from cold start (e.g. reinstall after hardware failure, new install joining an existing license). Pruning adds complexity and risk before the real storage cost profile is visible. A pruning strategy will be designed when the first account approaches a threshold that matters. At ~500 bytes/mutation average: 10 million mutations = ~5 GB — years away at expected usage.

**B-20 — Blob refs: reference strings only, blobs are out-of-band.**  
When a mutation's `val_type` is `blob-ref`, `val` contains a storage key (e.g. an R2/S3 object path). The server stores this string verbatim. It never fetches, validates, re-hosts, or sizes blob content. Blob lifecycle — upload, expiry, access control — is entirely the client's concern. The sync backend is not a blob proxy.

**B-21 — Storage estimate:**

| Scenario                    | Mutations    | Est. storage |
|-----------------------------|-------------|--------------|
| Current live DB             | 5,645       | ~2.7 MB      |
| 1 active install, 1 year    | ~3.6 M      | ~1.8 GB      |
| 10 active installs, 1 year  | ~36 M       | ~18 GB       |
| 100 active installs, 1 year | ~360 M      | ~180 GB      |

PostgreSQL on a Lightsail instance handles single-digit GB without tuning. Partitioning by `license_key_id` (range or hash) is the first scale lever if needed at 100+ installs.

---

## 9. Operational Concerns

**B-22 — Deployment: AWS Lightsail.**  
Single stateless Node.js process. Lightsail instance running Docker (or direct Node.js). PostgreSQL on Lightsail managed database or RDS. The process is stateless: all request state is derived from the DB. Horizontal scale (multiple processes behind a load balancer) requires no code changes — just point additional instances at the same DB.

No Kubernetes, no ECS, no Lambda in v0. Lightsail is the locked deployment target per infrastructure architecture commitment.

**B-23 — Observability: structured JSON logs + Prometheus metrics.**

Every push and pull request logs:
```json
{
  "ts": "2026-05-14T...",
  "method": "POST",
  "path": "/sync/mutations",
  "license_key_prefix": "abcd1234",
  "mutation_count": 87,
  "accepted": 87,
  "rejected": 0,
  "duration_ms": 14,
  "status": 200
}
```

Prometheus endpoint at `/metrics` exposes:
- `sync_mutations_pushed_total` (counter, label: `license_key_prefix`)
- `sync_mutations_pulled_total` (counter, label: `license_key_prefix`)
- `sync_push_duration_ms` (histogram)
- `sync_pull_duration_ms` (histogram)
- `sync_active_license_keys` (gauge, count of distinct keys with activity in last 24h)
- `sync_db_query_duration_ms` (histogram, label: `query`)

No external APM in v0. Add if/when the Prometheus data shows a bottleneck.

**B-24 — Schema versioning: numbered SQL migration files, applied on startup.**

```
server/migrations/
  001_initial.sql
  002_add_revoked_at.sql
  ...
```

A `schema_migrations` table tracks applied versions. On startup: apply all unapplied migrations in order, each in a transaction. If a migration fails: abort startup with a clear error. No ORM migration framework — raw SQL files only, matching the pattern used by the client (`electron/main.js` `runMigrations()`).

---

## 10. Reference SQL Schema

```sql
-- ── New table ────────────────────────────────────────────────────────
-- Accounts (minimal in v0; Control Center will expand)
-- tier column exists for future feature gating; semantics TBD
CREATE TABLE IF NOT EXISTS accounts (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT        NOT NULL,
  tier       TEXT        NOT NULL DEFAULT 'free',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Extensions to existing licenses table ────────────────────────────
-- ALTER TABLE licenses ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES accounts(id);
-- ALTER TABLE licenses ADD COLUMN IF NOT EXISTS key_prefix  TEXT;  -- first 8 chars, plaintext
-- ALTER TABLE licenses ADD COLUMN IF NOT EXISTS key_hash    TEXT;  -- bcrypt of full raw key
--
-- Existing columns preserved: id (INTEGER PK), license_key, email, plan,
-- stripe_customer_id, stripe_subscription_id, status, active, created_at, dates.
-- license_key TEXT is legacy (plain-text, for existing activations pre-bcrypt).
-- New keys issued by webhook populate key_prefix + key_hash instead.

-- ── Mutation log — core sync table (existing table, amended) ─────────
-- Amendments applied via migration SQL (see session notes 2026-05-15):
--   TRUNCATE (8 test rows removed)
--   RENAME actor_id → operator_id
--   ADD license_key_id INTEGER NOT NULL REFERENCES licenses(id)
--   PRIMARY KEY moved from id → server_seq
--   ADD UNIQUE (license_key_id, id)
--   ADD CHECK (op IN ('insert','update','delete','checkpoint'))
--   Indexes rebuilt (see below)

CREATE TABLE mutations (  -- shape after migration
  server_seq          BIGSERIAL    PRIMARY KEY,
  license_key_id      INTEGER      NOT NULL REFERENCES licenses(id),
  received_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  -- WireMutation fields (14, per sync-protocol-v0.md §3 + N-123)
  id                  TEXT         NOT NULL,
  client_id           TEXT         NOT NULL,
  station_id          TEXT,
  operator_id         TEXT,
  table_name          TEXT         NOT NULL,
  row_id              TEXT         NOT NULL,
  op                  TEXT         NOT NULL
    CHECK (op IN ('insert','update','delete','checkpoint')),
  payload_before      JSONB,
  payload_after       JSONB,
  created_at          TIMESTAMPTZ  NOT NULL,
  hlc                 TEXT         NOT NULL,
  parent_mutation_id  TEXT,
  schema_version      INTEGER      NOT NULL,
  conflict_resolution JSONB,
  UNIQUE (license_key_id, id)
);

-- Pull indexes (B-04)
CREATE INDEX idx_mutations_pull
  ON mutations (license_key_id, server_seq);

CREATE INDEX idx_mutations_pull_station
  ON mutations (license_key_id, station_id, server_seq)
  WHERE station_id IS NOT NULL;

CREATE INDEX idx_mutations_client_id
  ON mutations (client_id);

-- ── license_activations (existing, no structural change in v0) ────────
-- Serves as the installs registry per B-14. Existing columns:
--   id, license_key, machine_id, machine_name, os, ip_address,
--   activated_at, last_seen
-- Future arc: ADD COLUMN client_id TEXT to link sync peer to activation.
```

---

## 11. Open Questions / Future Work

These are not decisions for v0. They are tracked here so the design doc remains honest about what's deferred.

**Tier semantics (deferred to future arc)**  
The `tier` column exists on `accounts`. The specific values, what each tier unlocks, upgrade/downgrade flows, and how tiers map to subscription state are not yet designed. No code should gate on tier values until the tier arc is executed.

**Stripe provisioning wiring (scaffolding task)**  
`ether-backend` on Railway handles Stripe webhooks and Resend emails today. The scaffolding task is connecting the webhook handler to the Lightsail sync backend so it can write to `accounts` and `licenses`. The schema is already designed for this — no migration required.

**operator_id presence UX (future arc)**  
`operator_id` is captured on the client, transmitted on the wire, and stored on the backend in v0 (per N-123). The presence UX — Jason/Alison edit badges, per-row activity feed — is a future arc. In v0 the field is queryable but no UI renders it.

**license_activations → formal installs link (future arc)**  
`license_activations` tracks machine activations by `license_key` (TEXT). When a sync client sends its first push, the backend can upsert a row keyed by `client_id` to formally link a sync peer to a license. Schema change deferred: add `client_id TEXT` column to `license_activations` when this link is needed.

**Stage 4 client wiring (client-side, tracked in electron/sync/sync-engine.js)**  
The client's `SyncEngine` and `SyncScheduler` are not wired into `main.js` startup. This is a client-side task (Stage 4 per the sync-protocol-v0.md staging plan). The server must be live before Stage 4 lands.

**Blob proxy (if needed)**  
If `blob-ref` mutations require server-assisted blob transfer (e.g. for cross-install logo sync), a separate blob endpoint will be designed. The sync backend does not handle this in v0.

**Retention / pruning (review at scale)**  
No TTL in v0. When any account approaches a storage threshold that matters, design a pruning policy. Candidate: LWW-aware pruning (keep only the highest-HLC mutation per `(license_key_id, table_name, row_id, col)`) to collapse history while preserving current state.

**Multi-region (future)**  
Single Lightsail region in v0. Multi-region active-active would require either a distributed DB (CockroachDB, PlanetScale) or a regional-primary model. Deferred entirely.

---

*Last updated: 2026-05-15*  
*All 24 decisions locked. Wire format corrected to match sync-protocol-v0.md. Next action: run schema migration on Railway, rewrite sync.js handlers.*
