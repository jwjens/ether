# Ether Development Roadmap

**Status:** Updated 2026-05-27  
**Source of truth:** This document supersedes any roadmap references in chat memory or session notes. Mirrored to the GitHub wiki Roadmap page automatically (`.github/workflows/sync-roadmap-wiki.yml`).

---

## Current Phase

**Active arc: Multi-Tenant Control Center (Item 5), Phase 2 — remote editing.** Phase 1 (auth, dashboard, live station view, remote sign-in for the install's own users) is complete and in production at `app.ether-technologies.com`. Phase 2a (remote station/branding settings) shipped; Phase 2b (remote category editing — the first install-authoritative write-back) is ✅ **complete — verified bidirectionally on OV (2026-05-26)**: a category created in the dashboard applied on the install and reflected back. The write-back channel is proven both ways. Next: Phase 2c (clocks/dayparts).

Completed since the 2026-05-15 lock: **Sync backend** (Item 1, ✅), **High Availability** (Item 3, ✅), and **Listener Platform Tier 1** (Item 9 — branded PWA + per-station now-playing, ✅ live at `listen.ether-technologies.com/<slug>`). **OV is deployed and in active production** on the v4.2.x line.

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

**Status:** OV deployed and in active production (v4.2.x) — pushing live state (now-playing, users, Control Center data) to the backend daily. The formal exit criterion below — a second cold-start install converging on identical local state via full CRDT pull — has **not yet been run**; the full sync engine remains off-by-default, and production cloud pushes currently use the lighter per-table push pattern (now-playing/users/CC mirror). Two-client CRDT convergence is the remaining gate for this item.

Once the smoke test passes, the first real deployment: one live Ether install (OV station) pushes mutations to Railway; a second install pulls and replays them. This is the first time the sync engine runs against real broadcast data with two live clients.

**Why this is its own roadmap item:** Deploying to a live station with real traffic is categorically different from a local smoke test. It validates that the client-side merger handles edge cases that only appear with real mutation history, that the HLC ordering is correct across machines with clock drift, and that the backend handles the pull-scope behavior correctly. Any schema transformer bugs surface here before the sync engine is in wider use.

**Exit criteria:** Two installs converge on identical local state from a cold start on the second machine.

---

### 3. High Availability Architecture

**Status:** ✅ COMPLETE (2026-05-24). All phases shipped: **Phase 1** (`/health`), **Phase 2** (crash/hang watchdog), **Phase 2.5** (mutual supervision), **Phase 3** (startup registration — per-user logon Scheduled Task), **Phase 5** (health dashboard UI + runbook, commit a22fd33), and **Phase 4** (auto-logon installer — Settings "Keep My Station On Air", native `ha-setup.exe` for the LSA secret + Winlogon keys, commit 16414c4). Remaining is manual validation only (packaged-build logout/login + the elevated enable/disable round-trip). Full phase history in `docs/session-state.md §8–§9`. Design captured 2026-05-15 (RCS HA research, 5-phase failover sequence). Formerly called "Rust watchdog."

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

**Status:** **Feature-complete and in production** — Phases 1–4 all shipped (view · remote editing · analytics + listeners · billing). Live at `app.ether-technologies.com`. Ongoing work is polish + the listener-stream-count add-on, not new phases. (Did not wait on Item 2's two-client convergence: the CC arc deliberately rides the lighter push + command-bus pattern rather than the full CRDT pull, so it's decoupled from the sync engine's on/off state — see Architecture below.)

The Control Center is a web dashboard giving an account owner visibility and control across all their licensed Ether installs. Distinct from the Ether desktop app UI — this is a browser-based admin surface.

The accounts table added in Item 1's schema migration (B-05) exists specifically so this arc has a structural anchor. An account has one or more licenses; each license is an install; the Control Center aggregates state across all installs for that account.

**Why sync must be solid first:** Control Center reads are pulled from the same mutation log. If the pull scope (Item 1 Step 5), quarantine (Step 6), and transformer replay (Step 7) have bugs, Control Center state will be stale or incorrect. There is no point building a display layer until the data layer is reliable.

**Scope this arc covers:** Account login and dashboard, per-install status (last seen, sync cursor, schema version), cross-install analytics (combined play logs, scheduling reports), remote command dispatch via the existing SSE cmd-stream, and license management.

**Phases & status (2026-05-25):**

- **Phase 1 — Foundation (✅ complete, in production).** Backend per-license operators (`account_users` table) + JWT auth; **self-service admin bootstrap** (paste license key → create first admin, no manual provisioning); `ether-dashboard` (React/Vite on Cloudflare Pages) at `app.ether-technologies.com`. Operator login (PIN), all-stations view with **live now-playing**, and a read-only Users tab. The install's existing console users (Settings → Users & Security) **mirror up** so the same people sign into the dashboard with the same name + PIN — single source of truth is the install.
- **Phase 2 — Remote editing (✅ complete).** Two halves: a **read path** (the install pushes its tables to a generic backend mirror so the dashboard can view install-owned data) and a **write path** (the dashboard issues commands over the SSE command bus; the install applies them through its existing sync handlers, producing normal HLC mutations, then re-pushes).
  - **2a — Station / public-page settings (✅ shipped).** Display name, slug (with live availability), colors, logo upload, stream URL, socials, public on/off. Backend-authoritative (`station_metadata`) → live on the listener page instantly; no install round-trip.
  - **2b — Rotation categories (✅ complete — verified bidirectionally on OV, 2026-05-26).** First install-authoritative write-back — proved the general channel end to end (create in dashboard → applied on install → reflected back).
  - **2c — Clocks / dayparts (✅ shipped).** *2c-1 (v4.2.9):* view every daypart (day/hour range + assigned clock) and every clock (slot breakdown); admins **reassign which clock a daypart plays**. *2c-2 (dashboard-only):* full **slot-level clock building** — create / rename / delete clocks, and add / edit / reorder / remove their slots (type, category, duration, segue-stop chaining). Both ride the generic `db:apply` channel, so 2c-2 needed no new install release.
  - **2d — Song library (in progress; full scope = browse + edit + upload + sync).** The shared library (`songs`/`artists`/`albums`) is install-wide; per-station *treatment* (category, rotation, energy, daypart) lives in `station_programming`. So the install mirrors a **per-station "library view"** — each shared song annotated with that station's treatment. *2d-1 (✅ shipped, v4.2.10):* **browse & search** — the Library panel reads that view with client-side search; this also brought the **bulk multi-row insert** the ~5,600-row scale needs. *2d-2 (✅ shipped, v4.2.11):* edit a song — treatment (category/rotation/energy) → `station_programming` for that station, base facts (title/genre/bpm/explicit) → `songs`. *2d-3 (✅ shipped, v4.2.12):* upload new songs — pick a file in the dashboard, it goes straight to Cloudflare R2 and the install creates the playable record (fetched from the cloud on first play). *2d-4 (✅ shipped, v4.2.13):* cloud sync — a dashboard upload auto-pulls down to the studio machine (so it joins rotation, not just on-demand cloud playback); the Library card shows cloud coverage (in-cloud / cloud-only / local-only) and a "Pull from cloud" button. **Phase 2 (remote editing) is complete: settings → categories → clocks/dayparts → library (browse · edit · upload · sync).**
- **Phase 3 — Analytics (✅ complete).** *3a (✅ shipped, v4.2.14):* **playout analytics** — the install pushes its play history up (append-only, incremental), the backend aggregates server-side, and the dashboard shows per-station plays / hours aired / top songs & artists / category mix / daily trend / recent playout log over a date range. *3b (✅ shipped):* **listener metrics + world map** — the listener page reports its country (via Cloudflare's `/cdn-cgi/trace`), the backend counts live listeners + samples concurrency, and the dashboard shows "listening now," peak, a by-country world map, and a concurrent trend. **Private** — only the authenticated dashboard sees counts; the public listener page reports its country and displays nothing. (Counts page connections; external-player/Icecast stream counts would be a later add via stream-server polling.)
- **Phase 4 — Billing (✅ shipped).** Self-service subscription management in the dashboard via Stripe's hosted Customer Portal — the Account page shows live status + renewal and a "Manage billing" button (update card / invoices / change / cancel). The browser never touches Stripe; it's dashboard → backend → Stripe (secret key server-side). Purchase/provisioning (Stripe Checkout → webhook → license) was already in place; this adds the management half. *(One-time: enable the Customer Portal in Stripe settings.)*

**Architecture (locked 2026-05-25):**
- **Read path** — install pushes CC-relevant tables to a generic backend mirror table (`station_cc_data`: `station_uuid, table_name, row_uuid, payload JSONB, deleted_at`) the same way now-playing and users are pushed. Decoupled from the full Phase-F sync engine (which stays off by default), so the CC works regardless of sync state.
- **Write path** — dashboard (admin only) issues `db:apply` commands via `POST /api/cmd` (the existing SSE command bus, now JWT-admin-capable; offline queue is per-license). The install routes them to its existing typed sync handlers (`<table>.create/update/delete`) which wrap writes in `withMutation` → HLC mutation → syncs; then re-pushes the changed table so the dashboard reflects it.
- **Gotcha (recorded):** the `window.ether.<table>.list()` IPC handlers return `{ rows: [...] }`, not a bare array — unwrap `.rows` before pushing (this silently zeroed the categories mirror until v4.2.6).
- **Repos:** `ether-dashboard` (frontend, Cloudflare Pages), `ether-backend` (API, Railway). Releases on the v4.2.x line.

---

### 6. Plugins + Open-Source Core + BYO-Cloud

**Status:** Not started. Long-term extensibility arc.

The terminal arc for Ether's architecture. It has three components that must be delivered together:

**Plugin system** — third-party developers can extend Ether with new content sources, trigger adapters, scheduler integrations, and output targets. The Iris adapter model (Item 4) is the internal precursor — a clean adapter interface is a prerequisite for a plugin interface.

**Open-source core** — the scheduler, format clock, CRDT sync engine, and audio engine become an open-source foundation. Proprietary features (Iris AI, cloud sync backend, Control Center) remain closed. The open core drives adoption, external auditing of the sync protocol, and community contributions to the broadcast automation primitives.

**BYO-Cloud** — accounts can point Ether's sync engine at their own backend (self-hosted or a cloud provider they control) instead of Ether's Railway backend. The sync protocol (sync-protocol-v0.md) is the interoperability contract. A self-hosted backend needs only to implement the two endpoints (POST/GET /sync/mutations) and the auth contract.

**Why this is last:** BYO-Cloud requires the sync protocol to be stable and the client-side engine to be proven across real deployments (Items 1–2). Plugins require the Iris adapter pattern to be real (Item 4). Open-source requires the proprietary/open split to be clearly defined, which is only visible once Items 4–5 have made the proprietary surface clear.

---

### 7. AirLogger (Compliance Recorder)

**Status:** Not started.

**Purpose** — Continuous compliance/audit recording of the air signal, and proof-of-performance for advertisers (traffic pulls air-checks showing a spot ran).

**Capture** — Taps the program output bus (same tap that feeds Icecast). Per-station; each station logs its own bus independently. Local-first: rolling archive on local disk on the engine machine; R2 dedicated bucket for offsite/retention copy, separate from ether-backups.

**Storage** — Fixed-length indexed segments, one DB row per segment with start/end timestamps; retrieval is an indexed lookup, not a scan of one large file. Requires its own schema table for segment/retention metadata — a numbered migration on the existing chain.

**UI** — Two-region GarageBand-style layout. Top: a play_log browser, spot/ad-filtered by default (date, daypart/hour, advertiser dropdowns) — proof-of-performance is the primary use, so the list shows the log entries being proven; a secondary time-browse mode covers open-ended audit ("what aired 3-4pm"). Bottom: a docked waveform transport — play/pause, scrub, jog; the spot's known duration pre-marks a rough in/out when a row is cued.

**Workflow** — Click a play_log row → bottom player cues the audio at that timestamp → traffic trims in/out on the waveform → Export Clip writes a named air-check file for sales.

**Design requirements** — (1) Segment-boundary stitching: a spot straddling two segment files must scrub and export as continuous audio. (2) Export is copy-out to a separate permanent location, never a reference into the rolling archive — retention rotation must not delete saved air-checks. (3) The play_log row already carries the advertiser; v1 exports a plain file, but advertiser linkage on export is the natural next step.

---

### 8. Onboarding & Library Distribution

**Status:** Not started. Requires Item 2 (metadata sync confirmed working).

Item 2 proves Milestone A (metadata sync). This item is the two pieces that build on it:

**Milestone B — R2 audio distribution** — makes a synced library actually playable. Pieces: audio files uploaded to R2 (mechanism per the Open Decision below), per-song R2 object keys on song records, a download manager that pulls missing files to local disk with visible progress, and the file-present air-eligibility gate (a song is never eligible to air until its file is confirmed on local disk — always on, every station).

**Onboarding flow** — new-station vs. connect-to-existing choice on first launch. The "Connect" path: user enters one credential (email + password or license key); client authenticates, pulls full mutation history (Milestone A), then bulk-downloads all audio from R2 (Milestone B). Both green → station opens. R2/Railway credentials are infrastructure — the user never sees them.

**Open decision (must settle before Milestone B):** how audio files reach R2 initially — one-time backfill script, standing background uploader on every import, or both. Unresolved.

**Full design:** docs/onboarding-and-library-distribution-v0.md

---

### 9. Listener Platform

**Status:** **Tier 1 SHIPPED (2026-05-25).** The branded PWA player (`ether-listener`, React/Vite on Cloudflare Pages) is live at `listen.ether-technologies.com/<station-slug>` with per-station branding (logo, colors, name, now-playing, up-next) and the backend per-station metadata + now-playing service (unauthenticated `GET /public/station/:slug` + an SSE stream that pushes on each song change). Now-playing reliability hardened across v4.2.1–v4.2.6 (live deck reads, full upcoming-order queue, and a backend INTEGER-column bug that had silently dropped every `playing=true` report). **Tiers 2–4** (custom domain, "Ether Radio" directory app, white-label native apps) — not started. Several Tier-1 open decisions below are now resolved (hosting = Cloudflare Pages; per-station metadata API = built).

Today every Ether station streams via Icecast (e.g. `44.244.52.207:8000/live` and equivalent per-customer streams). A listener who opens that URL gets whatever default UI their browser provides — usually a black screen with bare transport controls. There is no branded listener experience, no per-station UI, and no audience-discovery layer. The Listener Platform closes that gap: a branded, installable listener experience delivered across tiers, plus an Ether-owned discovery directory.

**Competitive landscape** — Cirrus Streaming (cir.st) sells white-label native apps to stations, but with significant friction: ~$80/mo base plus listener-based pricing plus royalty bundling, and the customer must obtain their own Apple ($99/yr) and Google ($25) developer accounts, navigate the submission paperwork themselves, then hand credentials back to Cirrus to ship. Customization is limited. Ether's opening: a better branded listener experience, PWA-first so the small/mid-station tier carries zero submission friction, with a native-app pipeline reserved for Enterprise where the operational cost is justified.

**Vision (maps to the existing Solo / Studio / Network / Enterprise pricing):**

- **Tier 1 — PWA player at an Ether-hosted URL (Studio).** `listen.ether-technologies.com/<station-slug>`. Branded page (logo, colors, station name, now-playing, recent songs, schedule), installable to the home screen via "Add to Home Screen" so the listener gets a station icon that opens the player. Zero per-customer operational cost. The host URL is invisible once installed — listeners see the station's icon, name, and UI, not the domain — so a separate per-station domain solves a problem that does not exist at this tier.
- **Tier 2 — PWA player on the customer's own domain (Network).** `listen.<customer-domain>.com` via a DNS CNAME to Ether. Same PWA, no Ether branding visible — a fully custom-domain experience.
- **Tier 3 — Ether Radio directory app (cross-tier, Ether's own platform).** A native iOS/Android app in the app stores called "Ether Radio" where listeners discover stations they don't already know — the iHeartRadio / TuneIn-style discovery layer. Any station can opt into the directory; the gating model is TBD.
- **Tier 4 — White-label native app (Enterprise).** Real app-store presence under the customer's station name — their listeners download "Power 95 Radio," not Ether. Ether provides tooling that makes Apple/Google submission less painful than Cirrus, an auto-update pipeline that rolls new underlying code out to every white-label app automatically, and customization through the Ether dashboard rather than back-and-forth email. Enterprise pricing justifies the operational cost.

**Implementation order (ship listener value progressively):**
1. PWA framework at the Ether-hosted URL (Tier 1) — the wedge product.
2. Custom-domain support (Tier 2).
3. Ether Radio directory app (Tier 3) — the platform play.
4. White-label native-app pipeline (Tier 4) — upmarket, the biggest operational lift.

**What this arc does NOT cover:** Royalty bundling. Ether stays out of BMI / ASCAP / SoundExchange filing — the customer files their own, and the existing disclaimer covers liability. Royalty bundling would require a legal team Ether does not have.

**Open decisions (captured, not resolved):**
- PWA hosting infrastructure — Cloudflare Pages, Railway, or separate hosting?
- Custom-domain SSL / CNAME automation (Tier 2).
- Per-station metadata API (now-playing feed, schedule, branding config) — needs new backend endpoints.
- Directory-app opt-in model — Solo tier listed for free, or a paid feature?
- Discovery / curation logic — genre, geography, featured.
- Mobile platform priority — iOS first, Android first, or parallel?
- Backend stack for the directory API.

---

### 10. Out-of-Process Audio Engine (Seamless Updates)

**Status:** Scoped 2026-05-27. Not started. The recommended ("clean") path of three options for surviving app updates/restarts without dropping on-air audio.

**Problem:** The Rust audio engine (`ether-audio.node`) is loaded *inside the Electron main process*, and the ffmpeg→Icecast encoder is a child of that process. Any app update (electron-updater quits + relaunches) or main-process crash takes the engine and the stream down for the relaunch window — dead air on every update. The HA watchdog recovers *crashes* but cannot make an *update* gapless, because the audio lives in the process being replaced. (Playback is local-file — R2 songs are fetched down to disk first — and there is exactly one encode → one Icecast mount; this item changes neither.)

**Target architecture:** A standalone, long-lived **audio daemon** (`ether-audiod`) that owns the mixer, the program-bus drain, the ffmpeg child + Icecast push, local-file decode, the broadcast delay/dump, levels, and the queue/deck **state** — all per-station, as the Rust engine already is. The Electron app (main + renderer) becomes a **client** of the daemon over a local IPC channel (Windows named pipe). The UI can update, restart, or crash while the daemon keeps decoding local files and pushing the single Icecast stream with **no sample dropped**. Bonus payoffs: UI crashes no longer touch air, true headless operation, and multiple UI windows can attach to one engine.

**Phases:**
- **Phase 0 — Spike / de-risk.** Prove the napi addon loads, drives cpal output, spawns ffmpeg, and pushes to Icecast in a bare Node process (no Electron). Pick the IPC transport (named pipe) and draft the command/state/levels protocol. Decide daemon lifecycle + supervisor (extend the existing HA watchdog). Cheapest validation of the whole approach before the heavy lift.
- **Phase 1 — Extract the engine (the heavy lift).** Stand up `ether-audiod` hosting `ether-audio.node`; move the mixer, drain, ffmpeg spawn, Icecast push, delay/dump, levels, AND queue/deck state ownership (today split between `engine-rodio.ts` in the renderer and the Rust state) into the daemon. Biggest design call: where the scheduler (`loggen`) runs — in the daemon, or the daemon requests fills from a client. Daemon exposes an IPC API mirroring the current `engine-rodio` surface.
- **Phase 2 — App as client.** Re-point `engine-rodio.ts` + the main-process `audio:*` IPC at the daemon, keeping the `window.ether.audio.*` shape unchanged so the UI barely changes. Levels/state arrive from the daemon. On launch: attach to the running daemon (start it if absent); on quit/update: leave it running.
- **Phase 3 — Supervision + seamless update.** Extend the HA watchdog to start + keep the daemon alive. App auto-update relaunches the UI while the daemon streams through it. The daemon updates separately, only at a safe moment (or with a brief backup-audio bridge if the daemon itself must restart).
- **Phase 4 — Hardening.** Daemon persists queue/deck state and resumes after its own (rare) restart; lifecycle/shutdown policy when no station + no UI is attached; the only residual gap (a daemon-level restart) optionally covered by a backup bridge.

**Risks / open questions:** cpal device ownership outside Electron (expected fine); relocating the ffmpeg child + Icecast push into the daemon; the queue/deck/scheduler state-ownership migration (the largest design call); the IPC protocol + UI reconnect after its own restart; Windows packaging of the daemon binary and supervision via the existing HA infra. **Two lighter alternatives were considered and rejected as the long-term answer:** (1) *scheduled/deferred updates* applied only at a safe moment — a pragmatic interim, but still a timed gap, not seamless; (2) *dual-instance handoff* (two engines, Icecast mount handoff, crossfade) — most of this item's complexity with less payoff.

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
| 2026-05-18 | AirLogger (Compliance Recorder) added as Item 7. No existing items renumbered. FCC/compliance recording, local-first disk archive, R2 offsite, traffic workflow UI, schema migration required. |
| 2026-05-18 | Onboarding & Library Distribution added as Item 8. No existing items renumbered. Covers Milestone B (R2 audio distribution, per-song keys, download manager, air-eligibility gate) and the onboarding flow (new-station vs. connect-to-existing, single-credential path). Requires Item 2 (metadata sync). Open decision: how audio files reach R2 initially — unresolved. Full design in docs/onboarding-and-library-distribution-v0.md. |
| 2026-05-24 | Listener Platform added as Item 9. No existing items renumbered. Branded listener experience across tiers: Tier 1 PWA at `listen.ether-technologies.com/<station-slug>` (Studio), Tier 2 PWA on custom domain (Network), Tier 3 "Ether Radio" discovery directory app (cross-tier), Tier 4 white-label native apps (Enterprise). PWA-first to undercut Cirrus's submission friction. Tier 1 host URL locked (invisible once installed — no separate per-station domain needed). Explicitly excludes royalty bundling. Independent of all current work — Tier 1 can ship in parallel. Open decisions captured (hosting, Tier-2 CNAME/SSL automation, per-station metadata API, directory gating, discovery logic, mobile platform priority, directory backend stack). |
| 2026-05-25 | **Listener Platform Tier 1 SHIPPED.** `ether-listener` PWA (React/Vite, Cloudflare Pages) live at `listen.ether-technologies.com/<slug>`; backend per-station metadata + now-playing (public `GET /public/station/:slug` + SSE), now-playing keyed by `station_uuid`. Now-playing reliability fixes v4.2.1–v4.2.6: live deck reads (not React snapshots); queue = full upcoming order incl. cued standby decks; and the backend bug that silently dropped every `playing=true` report (fractional position/duration rejected by INTEGER columns — now rounded). |
| 2026-05-25 | **Control Center (Item 5) → active development; Phase 1 complete + in production.** `account_users` + JWT; self-service license-key admin bootstrap; `ether-dashboard` on Cloudflare Pages (`app.ether-technologies.com`); operator login, live all-stations view, read-only Users tab; install console users mirror up for remote sign-in (same name + PIN). Deliberately decoupled from the full sync engine — uses a lighter per-table push + the SSE command bus — so it did NOT require Item 2's two-client convergence first. |
| 2026-05-25 | **Control Center Phase 2 (remote editing) underway.** 2a station/branding settings shipped (backend-authoritative `station_metadata`, JWT-gated). 2b rotation categories — the write-back channel (dashboard → `/api/cmd` SSE → install sync handlers → HLC → re-push via the `station_cc_data` mirror) — shipped and under verification on OV. Full functional parity with the desktop (clocks/dayparts/library) is the stated goal; library push must use bulk INSERT at ~5,600-song scale. Releases v4.2.1–v4.2.6. |
| 2026-05-27 | **Out-of-Process Audio Engine added as Item 10.** No existing items renumbered. Decouples the audio engine + ffmpeg/Icecast into a standalone daemon (`ether-audiod`) so app updates/restarts/crashes don't drop on-air audio; the Electron app becomes an IPC client. Chosen as the "clean" path over scheduled-update and dual-instance-handoff alternatives. Phased: 0 spike → 1 extract engine + state → 2 app-as-client → 3 supervision/seamless-update → 4 hardening. Playback stays local-file + single Icecast stream (unchanged). |
| 2026-05-26 | **Control Center Phase 2b COMPLETE — write-back channel proven bidirectionally on OV.** A category created in the dashboard applied on the install and reflected back. Write-path fix took v4.2.7 (the SSE command channel never connected on boot — checked for the license key once and never retried; now retries until present). Separately, GitHub's "Latest" badge was pinned to v4.1.7 (API-published releases don't auto-promote), which had been silently blocking electron-updater auto-update and forcing manual reinstalls — fixed by setting `make_latest` on v4.2.7 (now standard). Next: Phase 2c (clocks/dayparts), then the song library. |
