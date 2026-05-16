# Ether Development Roadmap

**Status:** Locked 2026-05-15  
**Source of truth:** This document supersedes any roadmap references in chat memory or session notes.

---

## Current Phase

Sync backend implementation (Item 1) is fully complete as of 2026-05-16 — all 8 steps done, 38/38 tests green. Roadmap Item 2 (Deploy OV + 2nd Client) is now unblocked.

---

## Roadmap Items (in execution order)

### 1. Sync Backend Implementation

**Status:** All 8 steps complete. Item 2 (Deploy OV + 2nd Client) is unblocked.

The sync engine is a CRDT mutation log backed by PostgreSQL on Railway. Every local change in Ether generates a mutation with a hybrid logical clock timestamp. Mutations push to the backend and pull back across clients. LWW merge runs locally; the server is a dumb append log with filtered read access.

**Completed steps:**
1. Protocol doc (sync-protocol-v0.md) and backend design doc (sync-backend-design-v0.md) locked — 17 on-disk fields, 14 wire fields, operator_id, payload_before/after row-level JSONB, HLC format.
2. Railway schema migration — TRUNCATE test rows, add accounts table, extend licenses (key_prefix, key_hash), rename actor_id→operator_id, add license_key_id FK, fix PK to BIGSERIAL, UNIQUE(license_key_id, id), op CHECK, rebuild indexes. sync.js rewritten to match locked wire contract.
3. bcrypt auth (B-12) — two-path lookup (12-char prefix+bcrypt for new keys, plaintext for legacy), bcrypt-only storage on new INSERTs (no plaintext retained), transaction-wrapped Stripe webhook (INSERT + email in one tx so Stripe retry is safe), SSE routing key fixed to license.id, cmd-stream auth gap patched. Client wiring: station_config_kv drives sync_backend_url and sync_enabled gate; SyncScheduler starts on boot.
4. Smoke test — 5,669 mutations pushed to Railway (openair aa6e7c4, ether-backend 0806ffb). Two bugs found and fixed during smoke: missing UNIQUE(license_key_id, id) index on Railway (0806ffb), _saveCursor() missing updated_at causing NOT NULL crash after every push tick (aa6e7c4). Idempotency confirmed: restart shows pushed=0. Plaintext license key backward-compat path (ETHER-OWNER-2026, plan=station) validated.
5. Pull scope fix (92eb50d) — `getStationId` getter wired through `SyncEngine.pull()`; `main.js` owns resolution via `getActiveStationId()`; SyncEngine stores only the getter and calls it per tick so mid-session station switches are handled without restart. Station-scoped mutations (station_id='1', 3,564 Railway rows) now delivered to pulling clients. Backend pull handler and transport already implemented station_id correctly — no server changes needed.
6. Quarantine store — quarantine_mutations table (schema v16, de0fd8f). Forward-schema-version mutations now land in a recoverable local table instead of being warn-logged and lost. _quarantine() throws on DB failure so the transaction rolls back and cursor does not advance past an unquarantined mutation [N-102]. retry_count semantics: increments only on genuine apply failure; mutations still ahead of local schema_version are never touched by drain logic.
7. Transformer replay + quarantine drain (4d93321) — electron/sync/transformer-chain.js discovers migration scripts by regex (same pattern as verify-transformer-chain.js pre-commit hook), loads on demand (require.main guard confirmed zero side effects on plain require), caches per process lifetime. merge-engine.js Step 3 now runs both payload_before and payload_after through the transformer chain on schema_version mismatch [N-62]; failure → sync_status='conflicted', cursor advances, no re-pull [N-63]; conflicted mutations are fully queryable for a future operator-review UI. drainQuarantine() in SyncEngine replays quarantine_mutations whose foreign_schema_version <= local; TransformerMissingError → immediate dead-letter (no retry — retrying is pointless until a deployment ships the script); other failures retry up to 3× then dead-letter with ERROR log. Drain triggered from SyncScheduler.start() before _schedule(), wrapped in try/catch so drain failure cannot block sync.

**Step 7 caveat (now partially resolved by Step 8):** All current payloadTransformers are identity functions; the quarantine table is empty on the live DB. The transformer chain and drain logic are implemented and structurally correct. Step 8 (T-36..T-38) now synthetically proves the backward-compat transform path [N-62], the forward-quarantine path [N-64], and the conflicted path [N-63] using setScriptsDir()/clearCache() test seams. The one still-unexercised path is a real non-identity transform on a real payload from a future schema migration — that happens when the next schema bump ships.

8. Test suite — T-01..T-38 per sync-protocol-v0.md §23 (ce9e1ef) — 38/38 green. Covers HLC ordering (A), writer (B), LWW merge (C), causal ordering (D), tombstones (E), security/filter (F), idempotency (G), retention (H), schema compat incl. synthetic transformer replay and quarantine (I).

**Cleanup item (non-blocking):** Test fixtures in `electron/sync/tests/helpers/create-test-db.js` were verified against migration-script source and the REGISTRY — not against the live `openair.db`, because the better-sqlite3 ABI mismatch blocked the direct query during development. Migration source and live DB should agree, but "should agree" has been wrong before on this project. Before the test suite is treated as authoritative: dump the actual schema for `system_state`, `monitor_routing`, `mutations`, and `albums` from the live `openair.db` via Electron's Node (ABI matches there) and diff against the fixtures. The `albums` fixture deserves special attention — it is `wire-mutation.js`'s default table (~20 tests inherit it) and no migration file defines `albums` directly, so its DDL provenance is unconfirmed; the production schema was built up by a chain of `ALTER TABLE` calls across multiple migration scripts.

**Cleanup item (non-blocking):** The canonical migration script `scripts/migrate-quarantine-store-phase-sync-16.js` was never executed — the better-sqlite3 NODE_MODULE_VERSION mismatch (145 vs 137, Electron Node vs system Node v24) blocked it, and migration v16 was applied via a Python workaround. The committed JS script is therefore unverified against a real execution path. Before any fresh-install deployment: either (a) run the v16 JS migration under Electron's embedded Node to confirm it executes clean, or (b) establish a dev workflow for running migration scripts that avoids the version mismatch (npm rebuild better-sqlite3 against system Node, or a small Electron runner shim). This Node-version tax has recurred across the session and needs a proper solution.

**Cleanup item (non-blocking):** Railway mutations table contains orphaned rows from early development: ~36 rows with `station_id='system'` (pre-refactor `station_config_kv` that used the string 'system' as a global-scope sentinel — dead code path, the current handler throws if station_id is not an integer) and ~60 rows with `station_id='3'` (real station "US Phenomenon", is_active=0; mutations are legitimate but for an inactive station). Both sets are harmless to the current pull scope (clients pull `station_id='1'` and never receive these). Before multi-station production: confirm no live code path writes non-integer station_ids, and purge the 'system' rows as they are permanently unreachable by any valid client.

---

### 2. Deploy OV + 2nd Client

**Status:** Ready to start. Item 1 (sync backend) is fully complete as of 2026-05-16.

Once the smoke test passes, the first real deployment: one live Ether install (OV station) pushes mutations to Railway; a second install pulls and replays them. This is the first time the sync engine runs against real broadcast data with two live clients.

**Why this is its own roadmap item:** Deploying to a live station with real traffic is categorically different from a local smoke test. It validates that the client-side merger handles edge cases that only appear with real mutation history, that the HLC ordering is correct across machines with clock drift, and that the backend handles the pull-scope behavior correctly. Any schema transformer bugs surface here before the sync engine is in wider use.

**Exit criteria:** Two installs converge on identical local state from a cold start on the second machine.

---

### 3. High Availability Architecture

**Status:** Design conversation captured 2026-05-15 (RCS HA research, 5-phase failover sequence, Ether-branded approach). Architecture doc not yet written. Formerly called "Rust watchdog."

The original Rust watchdog concept (crash recovery for the Ether main process) has been absorbed into a broader HA arc. The scope is: what does it take for a live station to stay on air through a process crash, OS restart, hardware failure, or Railway downtime?

**RCS Zetta research** (conducted prior to this session) established the standard: broadcast automation must survive every failure mode without human intervention during a live shift. The Program Director Test — "would a PD be comfortable leaving the station unattended overnight?" — is the exit criterion for this arc.

**Scope this arc will cover:**
- Process supervisor (crash → restart → resume from last known playout position)
- Sync engine reconnect on Railway downtime (mutations buffer locally; push resumes when connectivity returns — already partially in place via SyncScheduler backoff)
- Graceful audio crossfade across process restart
- Health dashboard showing live system state (process uptime, last sync tick, deck states)
- Operational runbook for station operators

**What this arc does NOT cover:** Multi-region backend failover, hot standby Ether processes, or hardware redundancy. Those are out of scope for v1 HA.

---

### 4. Iris-as-Platform

**Status:** Architecture captured in docs/iris-as-platform-content-types.md. Not started.

Iris evolves from a voice-track generator into a named-content-type platform. The architecture observation that drove this arc: a third-party RadioDJ user built a 6-agent external pipeline to approximate what Iris can do natively. Every weakness of that approach (latency, state inconsistency, failure surface multiplication, no real-time reactivity) is an Iris architectural advantage — but only if Iris exposes the right primitives.

**Core additions this arc delivers:**
- Named content categories with per-category templates: Music Tease, Station Promo, Rad Rewind, Caller Shoutout, Weather Insert, Dead Air Fill. Templates are first-class, versioned, per-station overridable.
- Three approval modes per content category: AUTO (no human review), REVIEW (approval before air), HOLD (approval + manual scheduling). Approval from dashboard and mobile push.
- Iris trigger adapters: time-based (format clock slots), event-based (NWS alerts, schedule changes), operator-initiated (dashboard commands), system-initiated (dead air detection).
- Read-only workflow visualization per content category — operators can see the pipeline Iris executes for trust and discoverability.
- Audit log (non-deletable): every generated piece of content records template version, voice ID, LLM backend, script text, approval state, and air timestamp. FCC compliance basis.

**Open design questions before code starts:** process model (in-process vs supervised child for TTS crash isolation), template storage (DB rows vs code), per-station Iris instances vs shared, approval queue blob sync semantics.

---

### 5. Multi-Tenant Control Center

**Status:** Not started. Requires Item 1 (sync solid) and Item 2 (second client live).

The Control Center is a web dashboard giving an account owner visibility and control across all their licensed Ether installs. Distinct from the Ether desktop app UI — this is a browser-based admin surface.

The accounts table added in Item 1's schema migration (B-05) exists specifically so this arc has a structural anchor. An account has one or more licenses; each license is an install; the Control Center aggregates state across all installs for that account.

**Why sync must be solid first:** Control Center reads are pulled from the same mutation log. If the pull scope (Item 1 Step 5), quarantine (Step 6), and transformer replay (Step 7) have bugs, Control Center state will be stale or incorrect. There is no point building a display layer until the data layer is reliable.

**Scope this arc covers:** Account login and dashboard, per-install status (last seen, sync cursor, schema version), cross-install analytics (combined play logs, scheduling reports), remote command dispatch via the existing SSE cmd-stream, and license management.

---

### 6. Plugins + Open-Source Core + BYO-Cloud

**Status:** Not started. Long-term extensibility arc.

The terminal arc for Ether's architecture. It has three components that must be delivered together:

**Plugin system** — third-party developers can extend Ether with new content sources, trigger adapters, scheduler integrations, and output targets. The Iris adapter model (Item 4) is the internal precursor — a clean adapter interface is a prerequisite for a plugin interface.

**Open-source core** — the scheduler, format clock, CRDT sync engine, and audio engine become an open-source foundation. Proprietary features (Iris AI, cloud sync backend, Control Center) remain closed. The open core drives adoption, external auditing of the sync protocol, and community contributions to the broadcast automation primitives.

**BYO-Cloud** — accounts can point Ether's sync engine at their own backend (self-hosted or a cloud provider they control) instead of Ether's Railway backend. The sync protocol (sync-protocol-v0.md) is the interoperability contract. A self-hosted backend needs only to implement the two endpoints (POST/GET /sync/mutations) and the auth contract.

**Why this is last:** BYO-Cloud requires the sync protocol to be stable and the client-side engine to be proven across real deployments (Items 1–2). Plugins require the Iris adapter pattern to be real (Item 4). Open-source requires the proprietary/open split to be clearly defined, which is only visible once Items 4–5 have made the proprietary surface clear.

---

## Cross-Cutting Design Principles

### UX
- **Program Director Test.** Any automation feature must pass: "would a PD be comfortable leaving this running unattended overnight?" Features that require active human monitoring to prevent failures do not ship.
- **Name features for outcomes, not mechanisms.** Users see what the feature does for them, not how it works underneath. "Keep My Station On Air" beats "High Availability Slots." "Backup Mode" beats "Failover Sequencer Replication." The implementation name lives in design docs; the user-facing name describes the outcome.
- **Operator trust through visibility.** Operators must be able to see what the system is doing and why. Invisible automation that produces correct output is worse than visible automation that produces understandable output. Iris's workflow view (Item 4) is the template.
- **No silent failures.** Every failure mode surfaces to the operator via a status indicator, push notification, or dashboard alert. A station should never be in an error state the operator doesn't know about.

### Engineering
- **Discovery before code.** Every arc begins with a read-only audit pass. No code is written before the current state is understood. The verify:schema gate — checking actual DB columns before writing migration SQL — applies to every schema touch.
- **Two-commit boundary.** Protocol docs and design docs lock in commit 1. Code lands in commit 2. Docs are never amended to retroactively match code — if the code differs from the locked doc, either the code is wrong or a new doc amendment is needed first.
- **Local state is authoritative; cloud is the log.** The CRDT sync engine exists so Ether works fully offline. Cloud connectivity improves the experience; it is never on the critical path for broadcast operations. This principle applies to Iris (Item 4) as well — LLM and TTS outages fall back gracefully, they do not halt playout.
- **ALTER TABLE pattern.** Schema migrations use ALTER TABLE for existing installs and CREATE TABLE for fresh installs. Migration scripts are standalone, atomic (BEGIN/COMMIT), and include post-verification checks. Never a destructive DDL without a preflight check confirming the column or constraint does not already exist.
- **No plaintext secrets at rest.** License keys are bcrypt-hashed; raw keys are emailed to customers and never stored. This pattern applies to any future credential: generate, hash, send, discard.

### Deployment
- **Deployment portability.** v1 ships as Model A: Jeff-hosted sync service, multi-tenant on a central Railway-hosted backend. The architecture MUST stay open for a radio station to take control of their own backend later. The backend MUST remain a clean implementation of the sync protocol with no hard dependency on being the single central instance — no hardcoded assumption that the database is shared across all customers, no logic that only works as the one central server. A station SHALL be able to self-host with no client changes beyond the `sync_backend_url` config value (the client already reads this from `station_config_kv`, not hardcoded). SaaS-shaped pieces — accounts/license_key_id multi-tenancy, Stripe-driven subscription licensing, bcrypt validation against the central licenses table — are correct and acceptable for Model A, but are flagged as requiring a self-hosting mode before any boxed/self-hosted SKU ships. Test for every new backend feature: does this still work if one station runs this exact code for only themselves? If no, that's a portability flag.

---

## Parking Lot — Future Concepts (Unscheduled)

Ideas worth preserving. Not committed to any roadmap item or timeline.

**Fuzzy-matching metadata importer** — RCS G-Selector 5.1.2 (observed 2026-05-16) shipped a bulk Excel/CSV importer with column-mapping templates and match-on-media-ID-or-title+artist. On their own livestream, RCS explicitly declined to validate incoming artist names against the existing library — their importer is deliberately "blind," no fuzzy matching, no dedup. Consequence: spelling variance creates duplicate artist entities. Ether's Phase 4 library already models artists and albums as install-scoped first-class entities — the foundation to do what RCS won't: an importer that fuzzy-matches incoming names against existing entities and surfaces "did you mean X?" before creating a duplicate. Competitive gap RCS publicly confirmed they're leaving open.

**Future-date rotation preview ("demand date")** — G-Selector 5.1.2 added a preview showing how library rotation will look on a chosen future date, accounting for song run-dates and expiry, without scheduling for that date. Use cases: format-switch planning, monthly song swaps, turnover auditing. When Ether builds scheduling/rotation intelligence, a "show me my rotation as of \<future date\>" time-travel preview is a program-director-intuitive feature worth including.

**Positioning observations (no action required)** — RCS's headline feature is live integration between Zetta (automation) and G-Selector (scheduler), two separate products wired together. Ether is a single application — library, scheduling, automation, DAW, audio engine, one process, one database — so RCS's integration selling point is a seam Ether doesn't have. Also: RCS's new "Active Stations" library column (which stations a song is currently active on) is multi-station visibility that Ether's station-aware schema and `station_programming` entity already support natively. Ensure the library and Station Monitor UI surfaces per-station programming status so this advantage is visible to operators.

---

## Roadmap Revision Log

| Date       | Change                                                                                                                          |
|------------|---------------------------------------------------------------------------------------------------------------------------------|
| 2026-05-15 | Sync backend moved to position 1 (was position 3). Urgency: 5,645 mutations queued locally, second client blocked on sync live. |
| 2026-05-15 | Rust watchdog absorbed into High Availability Architecture (position 3, was position 2). Scope expanded from crash recovery to full Program Director Test HA model per RCS Zetta research. |
| 2026-05-16 | Sync steps 4 (smoke test) and 6 (quarantine store) complete. Two smoke-test bugs fixed: Railway missing UNIQUE constraint (ether-backend 0806ffb), _saveCursor NOT NULL crash (openair aa6e7c4). Quarantine store committed as de0fd8f, schema v16. Cleanup item added: JS migration v16 unverified under Electron Node due to NODE_MODULE_VERSION mismatch. |
| 2026-05-16 | Sync step 7 (transformer replay + quarantine drain) complete (4d93321). transformer-chain.js implemented; merge-engine Step 3 now transforms both payload_before and payload_after [N-62]; transformer failure → conflicted [N-63]; drain triggered from SyncScheduler.start(). Pre-commit harness: 16/16 PASS (v2→v16). Caveat: all transformers currently identity functions, quarantine table empty — behaviorally unexercised until first non-identity migration or test suite T-01..T-38. |
| 2026-05-16 | Deployment model decision: v1 = Model A (Jeff-hosted multi-tenant SaaS). Self-hosting / boxed option preserved as an architectural requirement — backend stays a clean sync-protocol implementation, station can run their own later with only a config change. Not building self-hosting now; keeping the door open. |
| 2026-05-16 | Sync step 8 (test suite T-01..T-38) complete (ce9e1ef). 38/38 tests green across 9 categories: A=HLC, B=Writer, C=LWW, D=Causal ordering, E=Tombstone, F=Security/filter, G=Idempotency, H=Retention, I=Schema compat. Three DDL bugs in test fixture fixed during suite construction. T-36..T-38 synthetically prove the transformer chain and quarantine paths via setScriptsDir()/clearCache() seams. |
| 2026-05-16 | Correction: previous roadmap update (after context compaction) incorrectly listed Step 5 (pull scope fix) as a remaining blocker. Step 5 was completed earlier the same day as commit 92eb50d — getStationId getter wired through SyncEngine.pull(), main.js passes getActiveStationId(). All 8 steps of Item 1 are complete. Item 2 (Deploy OV + 2nd Client) is unblocked. |
