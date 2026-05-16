# Ether Development Roadmap

**Status:** Locked 2026-05-15  
**Source of truth:** This document supersedes any roadmap references in chat memory or session notes.

---

## Current Phase

Sync backend implementation is active. The first three steps are complete: protocol and design docs are locked, the Railway PostgreSQL schema is live with bcrypt auth, and the client wiring is committed. The remaining five steps (smoke test → pull scope fix → quarantine store → transformer replay → test suite T-01..T-38) must finish before the second client can be deployed against real data.

---

## Roadmap Items (in execution order)

### 1. Sync Backend Implementation

**Status:** Steps 1–3 of 8 complete.

The sync engine is a CRDT mutation log backed by PostgreSQL on Railway. Every local change in Ether generates a mutation with a hybrid logical clock timestamp. Mutations push to the backend and pull back across clients. LWW merge runs locally; the server is a dumb append log with filtered read access.

**Completed steps:**
1. Protocol doc (sync-protocol-v0.md) and backend design doc (sync-backend-design-v0.md) locked — 17 on-disk fields, 14 wire fields, operator_id, payload_before/after row-level JSONB, HLC format.
2. Railway schema migration — TRUNCATE test rows, add accounts table, extend licenses (key_prefix, key_hash), rename actor_id→operator_id, add license_key_id FK, fix PK to BIGSERIAL, UNIQUE(license_key_id, id), op CHECK, rebuild indexes. sync.js rewritten to match locked wire contract.
3. bcrypt auth (B-12) — two-path lookup (12-char prefix+bcrypt for new keys, plaintext for legacy), bcrypt-only storage on new INSERTs (no plaintext retained), transaction-wrapped Stripe webhook (INSERT + email in one tx so Stripe retry is safe), SSE routing key fixed to license.id, cmd-stream auth gap patched. Client wiring: station_config_kv drives sync_backend_url and sync_enabled gate; SyncScheduler starts on boot.

**Remaining steps:**
4. Smoke test — fire 5,645 queued mutations against Railway, verify idempotency on restart.
5. Pull scope fix — wire station_id through SyncEngine.pull() so station-scoped mutations propagate to other clients (currently only install-scoped mutations pull).
6. Quarantine store — local table for mutations that fail transformer application; retry on schema upgrade.
7. Transformer replay — apply pulled mutations through schema-version-aware transformers; replay quarantine on version advance.
8. Test suite — T-01..T-38 per sync-protocol-v0.md §20; covers push/pull idempotency, HLC ordering, merge correctness, and network error recovery.

---

### 2. Deploy OV + 2nd Client

**Status:** Blocked on Item 1, Step 4 (smoke test).

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

---

## Roadmap Revision Log

| Date       | Change                                                                                                                          |
|------------|---------------------------------------------------------------------------------------------------------------------------------|
| 2026-05-15 | Sync backend moved to position 1 (was position 3). Urgency: 5,645 mutations queued locally, second client blocked on sync live. |
| 2026-05-15 | Rust watchdog absorbed into High Availability Architecture (position 3, was position 2). Scope expanded from crash recovery to full Program Director Test HA model per RCS Zetta research. |
