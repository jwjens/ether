# Ether — Close-Out Tracker

> **Last updated:** 2026-05-10 (Item 10 — Tablet Polish arc — closed)
>
> Canonical list of every open arc, parked item, and known issue. Update this file at the start of each new arc, not at the end.

---

## Phase 3.5 — Sync follow-up (non-blocking, post-v4.1.0)

| # | Item | Notes |
|---|------|-------|
| ~~S0~~ | ~~**`songs.station_id` drop (Item 8)**~~ | ~~16 renderer SQL filters + 4 JOIN conditions removed. songs.js INSERT + Spotify import INSERT cleaned. `stationTables` alterSafe loop updated. Registry entry removed. Migration script v12 shipped. Live DB migrated (381 songs). schema_version = [1..12].~~ ✓ 8270bdc. Note: v11 schema_version row was missing (DDL ran via main.js startup but INSERT was never written); fixed via one-off script before v12 ran. Future DDL-only migrations must explicitly INSERT their version. |
| S1 | **Group 4 — `published_episodes` typed handler** | Feature not yet built. Belongs to Show+ podcast publishing arc. Write handler when feature ships. |
| S2 | **Group 8 — `smart_schedule_rules` typed handler** | Schema audit needed first. SmartScheduler writes go through guard but not mutation log yet. |
| S3 | **Group 9 — CloudBackup restore protocol** | Privileged batch restore needs dedicated IPC channel (not db:execute). Own arc. |
| ~~S4~~ | ~~**main.js mutation log integration**~~ | ~~All direct `db.prepare().run()` writes in main.js routed through typed handlers with `withMutation`/`logMutation`. Commit A: bootstrap + deck-configs reset + RTMP + playout server (4247b4d). Commit B: discogs + library track writes (486b861). Commit C: stations CRUD (6989985). Commit D: schedule:generate bulk clear + bulk insert (3f1280a).~~ ✓ |
| S5 | **Lazy UUID backfill** | Rows that existed before sync was added retain integer-only state. Untouched rows generate no mutations so acceptable for sync, but worth a one-time bulk backfill before any audit-heavy use case. |
| S6 | **UPDATE-fallback INSERT OR REPLACE can collide on integer pk** | `merge-engine.js` _applyToLiveTable: when a row is absent locally, an UPDATE mutation falls back to `INSERT OR REPLACE`. If the payload carries a concrete `id` (e.g. Mornings UPDATE id=1), that fallback INSERT OR REPLACE will displace any row that already occupies id=1 via autoincrement (e.g. "test show" landed at id=1 after its id=null INSERT). Observed live: test show displaced by Mornings on fresh-client drain. No live-data impact (test show is deleted in real DB), but the same collision class that caused the mid day / overnight6 bug (fixed N-108d). Fix: UPDATE-fallback path should INSERT with id excluded (or NULL), letting SQLite assign a fresh autoincrement, then apply the id via a follow-up UPDATE — same intent as the lazy-payload fix applied to showsCreate. |

---

## Performance arc (P-series)

| # | Item | Measured cost | Notes |
|---|------|---------------|-------|
| ~~P1~~ | ~~**`detect_song_cue_points` IPC handler missing**~~ | ~~~200 ms stall per autoCue click~~ | ~~Handler not registered in main.js. AutoCueSong calls fail silently.~~ ✓ 3180cfb |
| ~~P2~~ | ~~**MacroEngine clock-trigger polling unindexed**~~ | ~~~150–565 ms DB hit per poll~~ | ~~Add composite index on `macros(station_id, trigger_type)` or similar.~~ ✓ 5532bc2 — indexes added, clock watcher converted to `useMacroClock` hook (pure-JS check, no DB hit per tick), hotkey watcher event-driven via `ether:macros-changed` |
| ~~P3~~ | ~~**`crash_recovery` saveQueue event-driven debounce**~~ | ~~~30s recovery staleness today~~ | ~~`onQueueChange` was a no-op; writes fired every 30s via interval. Replaced with debounced `ether:queue-changed` event + `engine.on()` status-diff + 30s fallback. All 11 mutation sites wired.~~ ✓ 02bd358 |
| P4 | **RemoteCmd polling** | 2 s poll / 4 s timeout | SSE migration planned. |

---

## Security arc

| # | Item | Notes |
|---|------|-------|
| SEC1 | **Backend command endpoints unauthenticated** | `/api/cmd` and `/api/pending-cmds` have no auth. Must address before external pilot promotion. |

---

## ether-backend follow-ups

| # | Item | Notes |
|---|------|-------|
| EB1 | **`license_activations.license_key` should migrate to `license_key_id INTEGER` FK** | Match the mutations table pattern (`license_key_id INTEGER REFERENCES licenses(id)`). Today the column is `TEXT NOT NULL` carrying the raw key string, which works for legacy plaintext rows where `licenses.license_key` is non-null. For new bcrypt-only rows the `licenses.license_key` column is NULL, so `/account/create` falls back to the raw key from the request body to satisfy the NOT NULL + UNIQUE(license_key, machine_id) constraint — meaning license_activations stores plaintext for bcrypt rows. Behavior is correct (matches what `/validate` writes), but the underlying schema mismatch should be retired. Tracked, not blocking. |
| EB2 | **Station-count cap by tier should be enforced server-side** | `/account/add-station` (and `/account/create` for the first station) currently does not enforce a per-license station limit. Per onboarding-spec-v1.md "multi-station is a Pro+ feature; tier gating is existing behavior, not new work for this spec" — so today the cap relies on client UI cooperation (tier-gated "Add a station" button). A determined or buggy client calling `/account/add-station` directly can create arbitrary stations regardless of `licenses.plan`. Add server-side cap lookup (likely a `PLAN_STATION_LIMITS = { free: 1, pro: 1, station: N }` shape) inside the same transaction as the INSERT, returning 403 station_limit_reached. Tracked, not blocking. |
| EB3 | **Stripe webhook silent fallback to `"pro"` on unknown priceId** | `src/index.js:995` has `const plan = priceId === PRICE_STATION ? "station" : "pro";`. If a new Stripe product is added and the webhook isn't updated, every new customer of that product silently lands on pro tier. Should error (or log loudly) on unknown priceId rather than defaulting. Not blocking — the two current products (`PRICE_PRO` / `PRICE_STATION`) map correctly. |
| EB4 | **`/admin/issue` endpoint accepts arbitrary `plan` strings** | `src/index.js:960` reads `const { email, plan = "pro" } = req.body;` with no PlanTier-enum validation. An admin could type `"banana"` and it would write to `licenses.plan` as-is; the renderer's `TIER_RANK["banana"]` is `undefined` so `requirePlan(any, "banana")` returns false for every check (worse-than-free behavior). Should reject any plan not in the canonical PlanTier union (`free`/`pro`/`pro_lifetime`/`station`/`station_lifetime`/`operator`) with a 400. Not blocking. |
| EB5 | **No automated CI on branch pushes** | `.github/workflows/build.yml` only triggers on `v*` tag push or `workflow_dispatch`. Branch pushes to `main` run no automated tests, no type-check, no smoke build. The pre-commit `verify:schema` gate catches schema-migration issues but nothing else — syntax errors, TypeScript errors, broken imports, runtime bugs all ship to `main` un-gated. Fix: add a CI workflow that runs on every push to `main` with at minimum `npm install` + `tsc --noEmit` + `verify:schema`. Optional adds: smoke tests via Playwright, ESLint. Not blocking; the manual verify-before-commit discipline has worked, but CI is the safety net for when discipline slips. Affects both **openair** and **ether-backend** (same gap on the backend repo). Discovered while pushing Phase B (2026-05-22). |

---

## Library polish (L-series, parked from v4.0.0)

| # | Item | Notes |
|---|------|-------|
| Y1 | **Deck-direct loads with on-air lock (Y1-take-2)** | Proper discovery needed before implementation. Parked. |
| ~~Y3~~ | ~~**ON AIR slot polish — progress fill**~~ | ~~Deck label bars (Deck A/B/C) animate left→right in deck color as song plays, representing duration. Rust backend survival case handled via `durQueried` + `setDeckDuration()`.~~ ✓ 9c70558. Marquee scroll on long titles deferred. |
| X1.2 | **Library panel refinements** | Minor UX polish items identified during v4.0.0 build. |

---

## UX restoration (parked)

| # | Item | Notes |
|---|------|-------|
| U1 | **Schedule generation UI buttons** | "Generate Hour / Day / Week" buttons not rendered in Shows & Dayparts. Backend `scheduleOneHour`/`fillDay` functions intact and verified via DevTools. UI restoration is its own focused commit. |
| U2 | **MIDI mapping UI** | MIDI mappings table exists; UI review needed. |
| ~~U3~~ | ~~**Menu / nav rename pass (Item 7)**~~ | ~~Schedule submenu: "Format Clock"→"Clocks", "Music Categories"→"Categories" (Zetta-style). ✓ 5aecebe. ClocksTab v1 upgraded with TYPE/CATEGORY/CHAIN inline editing, 10-column grid, `chain_type` schema column. ✓ 51ffe7d. ClocksV2 beta deleted, v1 canonical. ✓ 9ec5a7e.~~ |

---

## PlayLog arc

| # | Item | Notes |
|---|------|-------|
| ~~PL1~~ | ~~**Manual plays silently unlogged**~~ | ~~All music-deck plays (manual + auto) now log via engine state-transition hook.~~ ✓ ba1cbfd |
| PL2 | **PlayLog typed handler migration** | play_log schema aligned in v4.1.0. Any remaining db:execute writes to play_log not yet audited. |
| PL3 | **`notifyPlayStart` / `onPlayStart` dead code** | Removed from all call sites in ba1cbfd. The `notifyPlayStart()`, `onPlayStart()`, and `playStartCallbacks` members in engine-rodio.ts are now unused. Remove in a cleanup commit. |

---

## Tablet / mobile polish arc

| # | Item | Notes |
|---|------|-------|
| ~~T1~~ | ~~**Responsive layout pass (Item 10)**~~ | ~~5-phase arc: P1 pointer events (f890ce2) → P2+P3 touch targets + global touch CSS (818e94d) → P4 tablet layout breakpoint / isTablet / header 96→64px (26bd017) → P5 swipe gestures, Scheduler tab swipe + queue toggle swipe (0cf8932).~~ ✓ |

---

## Startup arc (SP-series)

| # | Item | Notes |
|---|------|-------|
| SP1 | **Splash screen progress is fake — runs on setTimeout, not real startup events** | Splash runs two independent 10-second setTimeouts (`electron/main.js:1061-1065` and `splash.html:236`) with no connection to real startup events. Status lines and schema version are hardcoded strings (says "schema v5 OK" while actual schema is v16). Real boot work runs in parallel but doesn't drive the splash. Should be reworked to watch actual startup events (DB open, migrations complete, IPC handlers registered, audio engine ready). Cleanup arc after OnboardingFlow ships — the `onProgress` pattern built for Screen 4 is the model. |

---

## Onboarding arc (OB-series)

| # | Item | Notes |
|---|------|-------|
| ~~OB1~~ | ~~**`ETHER_BACKEND_URL` inlined in four components — hoist to `src/lib/etherBackend.ts`**~~ | ~~The Railway base URL is duplicated as a string constant in `OnboardingFlow.tsx`, `SubscriptionPanel.tsx`, `CloudBackup.tsx`, and `ShowPlus.tsx` — four copies of the same Railway URL.~~ ✓ Consolidated to `src/lib/etherBackend.ts` (renderer) + `electron/lib/etherBackend.js` (electron-main) — two physical sources, one per module bundle. Renderer-side actual count was 13 sites across 8 files by the time Phase B landed (not 4 as the original entry noted): the 4 named-const files + 2 `API_URL` aliases + 4 inline literals in App.tsx + 2 path-appended constants in BetaProgram + 2 function-scope copies in main.js. All consolidated; `API_URL` aliases renamed to `ETHER_BACKEND_URL` for single canonical name. See commit. |
| OB5 | **Playout-server still needs customer R2 credentials post-migration** | `electron/main.js:903-924` POSTs the customer's R2 credentials to a remote playout server (`44.244.52.207:3500/api/playout/r2config`) on every startup so the cloud playout service can fetch audio from R2. Once Phase 1.3h clears the credentials from `station_config_kv`, this auto-push hits its "credentials not configured" branch and no-ops silently — but the playout server still needs R2 credentials to operate. Downstream architectural gap: the playout service needs its own R2 provisioning (env vars on the playout host, or a separate backend-mediated config endpoint that the playout service polls). Not blocking Milestone B; logged so it doesn't get forgotten when the playout service is next touched. |
| OB6 | **Audio sync makes 2 backend calls per file for signing** | Per song uploaded via `library:sync-r2:start` (Phase 1.3g) or downloaded via `r2:fetch-track` (Phase 1.3i): one POST to `/audio/upload-url` or `/audio/download-url` to get a signed URL, then one PUT/GET to that URL. For a ~6000-song library that's ~12k backend hits per full sync. Backend signing is fast (no R2 traffic — just URL signing), but a batch-sign endpoint that returns N URLs per request would cut the call count by ~100x. Optimization candidate when real customers report sync duration concerns. Not blocking; current throughput is fine for the existing customer pattern. |
| OB7 | **`r2-cache` grows unbounded under `<userData>/r2-cache/`** | No LRU, TTL, max-size, or "Clear cache" UI. Network-tier stations running for a year could accumulate tens of GB. Need either an LRU eviction policy (cap at N GB), a TTL (evict files unaccessed for M days), or both, plus a "Clear cache" button in Settings. Not blocking; ship as existing behavior in 1.3i, fix in a follow-up arc. |
| OB8 | **`r2:fetch-track` concurrent-fetch deduplication** | Two `audio:load` calls for the same missing file (e.g., user clicks Play while the scheduler queues the same track) both miss the cache, both POST `/audio/download-url`, both fetch the bytes. Files are atomic via temp+rename so playback isn't broken, but bandwidth is wasted. Fix: in-flight `Map<fileKey, Promise>` inside `r2:fetch-track` that dedupes parallel calls. ~10 lines. Not blocking; current behavior is "downloaded twice, one wasted." Add when concurrent-fetch patterns become real. |
| OB9 | **Picker-cancel leaves orphan `onboarding_library_source='computer'` KV** | B.3's `handleComputer` writes `'computer'` to KV BEFORE the folder picker opens (crash-safety design). If the user cancels the picker without picking a folder, KV stays `'computer'` but no `file_path` UPDATEs happen. On next launch, resumption routes past `pickAudioLocation` (source is set) to `pulling` and eventually `done`. Customer ends with peer-machine `file_path` values in the songs table and no local files. For Network+ customers this self-heals via `audio:load`'s R2 fallback (1.3k). For Free/Pro customers it does NOT — the fallback gates on Network+, so library entries appear but Play silently fails on every track. Fix: reset the KV flag if picker returns null/empty, OR check "songs has any local file_path that exists on disk" before treating `source='computer'` as a completed action. Small follow-up; not blocking the routing fix. |

---

## Big arcs (future, no timeline)

| Arc | Description |
|-----|-------------|
| **Phase F — CRDT sync** | Full multi-client CRDT-based sync using mutation log. Foundation locked in Phase 3.5. Implementation arc is its own project. |
| **AUX / Live DJ deck** | Slot D (or configurable) set to type="music" and enabled. Infrastructure identical to A/B/C — no schema or engine changes needed. Play logging, sync, and PRO reporting all inherit automatically via deckConfig.type filter. UI work: deck-order display, crossfade behavior for live DJ handoff. |
| **AoIP console** | Dante / AES67 audio-over-IP integration. No spec. |
| **Multi-station operator tier** | Multiple simultaneous stations per install. Schema partially supports it (station_id everywhere). |
| **PD dashboard** | Program director analytics view over play_log / scheduled_log data. |
| **Show+ podcast publishing** | Published episodes pipeline (Group 4 handler belongs here). |

---

## How to use this file

1. **Starting an arc** — pull the relevant rows into the arc's working doc; mark them `[in progress]` here.
2. **Closing an arc** — strike through or delete resolved rows; add the version in the Notes column.
3. **New discoveries** — append to the relevant section immediately, not at session end.
4. **Priority** — rows have no inherent priority order. Prioritize in the arc planning doc, not here.
