# Station UUID re-key — build plan (for Jeff's review; NO code until GO-on-plan)

Approved decisions: **1B** (UUID above the daemon + one process-private handle at the daemon),
**2A** (keep `stations.id` as private DB PK; re-key scoping to `station_uuid`), **3** (per-station
subscription, **multi-subscription per window required**), **4b** (UUID re-key ships first, own release;
ownership after). Mandates: **leak-guard test in CI**, **Iris contract amendment included**.
Facts: `station-id-census-2026-07-07.md`. Design: `station-identity-redesign-proposal-2026-07-07.md`.

Standing rules honored throughout: copy-first migration; one instance per DB; deck-mapping sacred; Esc
never kills audio; never-empty/offline lessons; **netgeak + cristianmalliani untouchable**; receipts on
every "done"; reports as files; push as commits land, tag gates the release.

**Release target: v4.5.0** (standalone UUID re-key; ownership → v4.6). **APPROVED 2026-07-07.**

**Approved refinements (2026-07-07):**
- Subscription API = **replace-semantics** (`setStationSubscriptions(uuids[])` replaces the set).
- **FORWARD-WHOLE-FRAMES INVARIANT (mandatory):** main relays/routes the daemon's frame **whole** — it
  never reconstructs, reshapes, or strips fields off a station frame. Routing selects *which windows* get
  a frame; it never rewrites the frame's contents. (This is the exact class of bug behind the VU meter:
  `main.js:349` rebuilt `lv = {a,b,c}` and dropped `stationId`. Under this invariant that reconstruction
  is forbidden — forward `m` as-is.) The CI leak-guard also asserts no relay reconstructs a station frame.
- **Phase gates are Jeff's:** each phase stops for Jeff's verification before the next begins. No phase
  proceeds on script-pass alone.

---

## Invariant the whole plan enforces
Station **UUID** is the only station identity that crosses any boundary (pipe, IPC, query key, contract).
The integer survives only as (i) `stations.id` private DB PK, never above persistence, and (ii) an
opaque, process-private engine handle inside the daemon (1B). The **CI leak-guard** fails the build if an
integer station id appears on any IPC/pipe payload.

## Multi-subscription model (decision 3, refined)
- A **window** owns a **set** of subscribed station UUIDs (single-station view = a 1-element set;
  multi-station monitor = N). API: `ether.audio.setStationSubscriptions(uuids: string[])` (idempotent
  replace), re-called on station switch / opening a monitor.
- **Routing choke point = main.** Main tracks `webContents.id → Set<uuid>`. The daemon keeps emitting
  per-station **UUID-tagged** frames (it already meters every attached station for streaming); main routes
  each frame **only to windows subscribed to that UUID** (`webContents.send` to specific windows, not
  `sendToAllWindows`). Daemon-side per-subscriber filtering is a later optimization if volume warrants;
  routing at main gives the correct semantics now and generalizes to a cross-machine relay in v4.5.
- **Offline frame:** when a subscribed UUID has no engine (absent/not airing), main emits an explicit
  `{stationUuid, offline:true}` frame so the meter reads offline — never blank, never a frozen last value.

---

## Phases (each independently verifiable; commits pushed as they land)

### Phase 0 — foundations (additive, no behavior change)
0.1 **Contract amendment** — add a station-identity clause to `docs/iris-ether-contract.md`: station
identity is the **UUID** on every boundary (local live-wire included); integer ids never cross. (Closes
the census gap where the contract was silent + the local `iris:state` was integer.)
0.2 **CI leak-guard test (scaffold, mandatory gate)** — `scripts/test-station-identity-leak.js` +
a CI step. It scans the emitters (daemon `broadcast(...)`, main `sendToAllWindows/webContents.send`,
preload payloads) and **fails if any station-scoped payload carries an integer station id** instead of
`stationUuid`. Starts allow-listing the not-yet-migrated channels, and the allow-list shrinks to empty by
Phase 3 — so CI stays green per phase and the gate is real at the end.
0.3 **SQLite migration (additive)** — `migrate-station-uuid-key-phase-sync-N.js`: add `station_uuid TEXT`
to every scoped table, backfill `station_uuid = stations.uuid via station_id`, index `(station_uuid)`,
bump `schema_version` (own table). Does NOT switch queries yet. Verified on **copies** of OVEVENTS +
jensj DBs (row counts + backfill completeness).

### Phase 1 — daemon UUID handle + UUID on the pipe (1B)
1.1 Daemon attach registry: `Map<uuid → handle>` (the ONE mapping). Commands arrive by `stationUuid`;
daemon resolves to a process-private handle for Rust (Rust unchanged — 1B). `stations`/`engines`/
`streams` maps re-keyed to UUID; handle used only for the NAPI call.
1.2 All daemon frames (`levels`/`deck`/`queue`/`enginestate`/`stream`) emit `stationUuid` (drop integer).
1.3 `main.js` relays carry `stationUuid` — **fixes the levels drop at `main.js:349`** (carry the tag) and
switches deck/queue/enginestate/stream to UUID.
1.4 Icecast per-station + `stream:status` dest keyed by UUID (`icecast:${uuid}`).
*Verify:* daemon smoke + a two-station pipe capture showing every frame UUID-tagged.

### Phase 2 — multi-subscription transport (3)
2.1 preload: `setStationSubscriptions(uuids)` + `onLevels/onDeck/onQueue` deliver only subscribed,
UUID-tagged frames; keep `off*`.
2.2 main: `webContents.id → Set<uuid>` registry; route frames per subscription; emit offline frames for
absent engines; clean up on window close.
2.3 renderer: meter/deck components bind to their station UUID (or a set); route incoming frames by
`stationUuid`; `engine-rodio` filters/ō routes by UUID. Remove reliance on the global broadcast.
*Verify:* two stations, two subscriptions → independent meters; switch rebinds; absent station → offline.

### Phase 3 — renderer + query re-key to UUID (2A)
3.1 `useActiveStation` surfaces UUID as the audio identity; `AudioEngineContext`/`engine-registry`/
`cmd-routing` keyed by UUID (cmd-routing is already the uuid choke point).
3.2 `stationScoped.ts` + every scoped query switch to `station_uuid`.
3.3 Shrink the leak-guard allow-list to **empty** → the CI gate is now fully armed.
*Verify:* full app smoke; leak-guard green with no allow-list.

### Phase 4 — verification + release
4.1 Automated identity tests (node): frame routes only to the bound UUID; unknown UUID → offline;
`resolveTarget(uuid)`→handle correct + rejects unknown; scoped queries filter by `station_uuid`;
leak-guard.
4.2 **Jeff's walkthrough (packaged build, before tag):** (1) two stations airing → independent correct
meters; (2) live switch rebinds meters; (3) Iris-offline cold boot (no crash); (4) daemon restart →
meters+audio resume for all stations, correctly bound (no station-1 collision).
4.3 Migrate on copies → then jensj in a chosen window (one instance per DB). Tag the release on Jeff's
walkthrough green.

---

## Migration & customer safety
- Client-local, self-applied per install on update (Phase 0.3). Copy-first verification on OVEVENTS +
  jensj DB backups (`sqlite3 .backup`) before any packaged build touches a live box.
- **netgeak + cristianmalliani:** never touched — the re-key is client-local schema (their installs
  self-migrate like any client) and the Postgres backend is already uuid-primary (no platform change).
  Zero migrations/queries-with-side-effects against their data; all test/verify scoped to OVEVENTS+jensj.
- Postgres: no schema change required (already uuid-primary).

## Blast radius (unchanged from proposal, restated)
Touches: daemon (attach map + transport), `main.js` relays + routing, `preload.js`, renderer audio
hooks/components, `stationScoped` + one migration, Iris contract. Does NOT touch: playout/rotation/
selector, **Deck↔Rust deck mapping**, Esc/audio-safety, never-empty floor, Postgres schema, customer
data. Rust untouched (1B). Risks: handle-collision if a UUID→handle miss falls back to station-1 (guarded
by tests 4.1); live jensj migration; offline-frame correctness (walkthrough 4.2 #3/#4).

## Open items for Jeff (in the plan, need a word before/at build)
1. **Release version** for the UUID re-key (standalone before v4.5-ownership) — number?
2. Confirm the **subscription API shape** `setStationSubscriptions(uuids[])` (replace-semantics) is what
   you want vs add/remove pairs.
3. Confirm routing-at-main now (daemon-side per-subscriber filtering deferred) is acceptable for v1.

**No code written. Awaiting your review of this plan.**
