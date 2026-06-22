# Plan: reconcile sync identity by UUID (detailed — build nothing yet)

Status: **DETAILED PLAN. No code. Implementation is a separate, reviewed change.**
Date: 2026-06-22
Companion to: `docs/sync-station-identity-uuid-reconciliation.md` (the design overview)
Proof on record (RED): ether-backend `32987e6` `scripts/prove-member-convergence.js`

---

## 0. The discovery that reshapes the scope

The proof caught the **station** dimension: peer-sync routes/scopes by local integer
`station_id`, so two installs of one station diverge and mis-scope. While planning the fix,
a second instance of the **same class** of defect surfaced and must be decided up front:

- `clock_slots` (and peers) carry **`clock_id` and `category_id` as local integer FKs** in
  their synced payload (`synced-tables.js:154-162` — both `'scalar'`, no UUID). A child row
  references its parent by the *sender's* local integer. On another install that integer is a
  different parent (or none).
- Even a row's own integer `id` only aligns across installs by accident: `clocksCreate`
  inserts without `id` (autoincrement), so the INSERT mutation carries **no** `id` → each
  install autoincrements its own. An *update* mutation later carries `id` and the merge writes
  it (`merge-engine.js:197` keeps `id` in `setCols`), forcibly realigning — order-dependent and
  fragile.

So "reconcile station identity by UUID" is the **first** instance of a general truth: **local
integer ids must never be cross-install identity on the sync path.** The same UUID-resolve the
codebase already uses on the staged/dashboard path is the fix for all of them.

**Prior art in this very system (de-risks the approach):**
- `staged_programming` is *"Keyed by station_uuid (never a local integer id)… Parent refs in
  clock_slots/shows are by UUID; the install resolves uuid → its local id on import."*
  (ether-backend `index.js:653-657`)
- `station_cc_data (station_uuid, table_name, row_uuid, payload)` — same principle
  (`index.js:641-651`).
- `resolveLocalStationId(ether, station_uuid)` already does UUID→local-id on the
  dashboard→install path (`openair/src/lib/ccData.ts`).

The peer-sync path is simply the one place that **didn't** get this treatment. The work is to
bring it in line — not to invent a new model.

## 1. Scope decision (needs Jeff's call before build)

Two tiers. They are additive; Tier 1 alone is **not** sufficient for slot-level convergence.

- **Tier 1 — Station identity by UUID.** Fixes the proven divergence + mis-scoping for the
  `station_id` dimension. Sufficient for top-level station-scoped edits (e.g. a clock's name,
  a category's name). **Not** sufficient where a child references a parent by integer FK.
- **Tier 2 — All cross-install identity by UUID.** Tier 1 **plus** parent FKs
  (`clock_id`, `category_id`, `show_id`, …) carried and resolved by UUID, and the row's own
  `id` removed from cross-install identity. This is what makes two installs editing one
  station's **rotation/slots** converge.

**Recommendation: target Tier 2 as "the real fix."** Shipping Tier 1 only would converge clock
*names* but still mis-link clock *slots* — another latent divergence a future proof would catch.
Tier 1 can be a reviewed *milestone* on the way to Tier 2, but the gate must not re-open until
Tier 2 is green. (The member's "live programming edits" include slots, so Tier 1 does not clear
the bar the proof set.)

## 2. Target architecture (one sentence)

On the sync path, **relationships travel as UUIDs; integers are purely local**. The pusher
translates local integer → UUID at the wire boundary; the receiver resolves UUID → its own
local integer on apply. The backend scopes delivery by **station UUID**, which it can already
map to a license via the `stations` table.

## 3. Concrete changes, layer by layer

### A. Metadata — declare what is identity (`electron/sync/synced-tables.js`)
- Mark, per station-scoped table, that `station_id` is a station reference, and declare FK
  columns with their referenced table (e.g. `clock_slots.clock_id → clocks`,
  `clock_slots.category_id → categories`, `clocks.show_id → shows`). New column category
  (e.g. `'station-ref'` / `'fk:<table>'`) alongside the existing `scalar`/`json-text`/
  `local-only`. This is the single source the writer and merge engine both read — no
  per-table special-casing.

### B. Push side — emit UUIDs (`electron/sync/mutation-writer.js`, `sync-engine.js`)
- When building wire `payload_after` (and the wire mutation's station field), translate each
  declared reference from local integer → UUID by looking up the referenced local row's `uuid`
  (station via `stations`, parent via its table). Carry both is acceptable during transition;
  carry-UUID is the contract.
- `station_id` (batch + per-mutation) becomes/accompanies `station_uuid`.

### C. Backend store + delivery (`ether-backend/src/index.js`, `src/routes/sync.js`)
- Add `station_uuid TEXT REFERENCES stations(uuid)` to the `mutations` table (additive,
  `ADD COLUMN IF NOT EXISTS`; new index `(station_uuid, server_seq)` mirroring
  `idx_mutations_sta_seq`). Store it on push.
- **Pull** (`GET /sync/mutations`) scopes station rows by `station_uuid = $3 OR station_uuid
  IS NULL`, where `$3` is the station UUID the client sends. Keep the library-grant UNION.
- **Pending-count** (`GET /sync/pending-count`) mirrors the new scoping in lockstep (it must
  never diverge from pull).
- The backend already maps `stations.uuid → license_key_id`, so authorization is unchanged;
  this only changes the *scope key*, not the tenant boundary.

### D. Merge apply — resolve UUID → local (`electron/sync/merge-engine.js`)
- Before writing `payload_after` to the live table, for each declared reference resolve the
  incoming UUID to **this install's** local integer (station via local `stations`; parent via
  the parent table) and stamp the local integer onto the row. An unresolved station UUID is a
  hard hold/skip (mirror `ccData.ts`'s loud bail — never write a guessed/foreign id).
- Stop treating the row's own integer `id` as cross-install identity: drop `id` from the
  applied column set (keep `uuid` as the key). This removes the order-dependent id-rewrite.
- Parent-not-yet-present is the existing causal-ordering case (`causal-order.js`) — a slot
  whose parent clock hasn't arrived holds and retries, exactly as today, but keyed by UUID.

### E. Active-station pull param (`electron/main.js:1526`)
- `getStationId` sends the active station's **UUID** (from its local `stations.uuid`) instead
  of `String(getActiveStationId())`.

## 4. Migration / backward-compatibility (the delicate part)

- **No retro-backfill is possible.** A pre-cutover mutation has only the sender's local integer
  `station_id`; the backend cannot recover its UUID. So old rows stay integer-scoped.
- **Cutover strategy:** new mutations carry `station_uuid`; pull delivers by UUID for rows that
  have it and falls back to integer scoping for legacy rows during a transition window, OR each
  install re-baselines (full re-pull) once on upgrade so its live state is rebuilt from
  UUID-scoped delivery. Decide which; re-baseline is simpler to reason about but heavier.
- **Cursor (`server_seq`) is unaffected** — it's a monotonic sequence, independent of scope
  key. Re-baseline = reset the cursor for the affected client and pull from 0 under UUID scope.
- **Mixed-version fleet:** an old client (sends integer, no UUID) and a new client (sends UUID)
  on the same account during rollout must not silently stop seeing each other. This is the
  strongest argument for a **flagged, shadow-first** rollout (§6) and for keeping integer
  scoping working until all installs are new.

## 5. How it gets proven (promote red → green + new proofs)

- **`prove-member-convergence` → green, both halves.** Same harness (real router + real merge,
  owner/member on different local ids). After the fix assert: (a) both converge to the LWW
  winner, **and** (b) the row is scoped to *each install's own* local station id (owner→1,
  member→7) — no foreign id on the row.
- **New: child-FK convergence proof.** Owner and member both edit `clock_slots` of the same
  clock; assert the slot links to the correct *local* clock on each install and converges.
  This is the Tier-2-specific proof; without it Tier 2 isn't demonstrated.
- **Single-account regression.** One account, two machines, same station, **different** local
  ids — assert the *existing* shipping behavior still converges (this is the case most at risk;
  it also tells us whether single-account child-FK sync was ever actually sound).
- **Migration proof.** Seed the store with legacy integer-keyed mutations, run the cutover,
  assert nothing already-synced is dropped, looped, or mis-scoped.

## 6. Rollout (and ordering vs the gate)

1. Land the schema additive changes (backend column/index) — inert until clients use them.
2. Ship clients that **send** `station_uuid`/FK-UUIDs and **shadow-resolve** on apply (compute
   the remap, log divergence, but keep legacy behavior) — a behind-a-flag shadow pass, the same
   discipline as the RBAC `*_SHADOW` flags already in `src/index.js`.
3. Flip the flag to **enforce** UUID scoping + resolve once the fleet is new and shadow logs are
   clean.
4. **Only then** re-evaluate the member-PUSH gate. The gate is value on top of a sync core that
   converges two writers; that core must be green (§5) and enforced (step 3) first. Re-applying
   the gate before this ships the exact divergence the proof caught.

## 7. Risks & unknowns to validate FIRST (before committing to build)

- **It changes the scope key for every station-scoped row (30 tables).** Wrong = break the
  live single-account two-machine sync OV depends on, not a corner case.
- **MEASURED (2026-06-22): single-account child-FK sync is sound ONLY when local ids align;
  it breaks on divergence.** Baseline proof `ether-backend/scripts/prove-single-account-baseline.js`
  (committed `cd67b40`), real handlers + real router + real merge:
  - When the second machine is fresh and the station is created first, both installs autoincrement
    local ids in the same order (station/category/clock → id 1), so `clock_slots.clock_id` /
    `.category_id` / `clock.station_id` all resolve to the receiver's OWN rows, and concurrent edits
    converge. OV's field reality today = this aligned case = clean.
  - The moment a machine already has a station, the synced station lands on a DIFFERENT local id;
    the station-scoped pull (`WHERE station_id = $3 …`) no longer matches and the programming
    **silently never arrives** (clocks=0, slots=0). Same root cause as the cross-account divergence
    (`prove-member-convergence`). One fix closes both.
  - Conclusion: today's "it works" rests on COINCIDENTAL integer-id alignment, not reconciliation.
    The fragility is real and already latent — masked only because OV's machines happen to align.
- **Mixed-version fleet during rollout** (§4) — the window where old+new clients coexist.
- **FK metadata completeness** — every cross-install reference among the 30 station-scoped
  tables must be declared, or an undeclared FK silently keeps diverging. Needs an audit of all
  `*_id` columns in the REGISTRY.
- **Scope creep guard:** install-scope library tables (`songs/artists/albums`) and the grant
  UNION are out of scope — do not touch the isolation boundary proven by
  `prove-library-grant-isolation`.

## 8. Decisions needed from Jeff before any build
1. **Tier 1 only, or Tier 2 (full)?** (Recommendation: Tier 2; Tier 1 alone won't pass the
   slot-level convergence bar.)
2. **Migration: transition-window dual-scoping, or one-time re-baseline on upgrade?**
3. **Confirm flagged shadow-first rollout** (mirrors existing RBAC shadow flags).
4. Approve writing the **single-account baseline regression proof first**, read-only against
   current code, to quantify the real starting point — this is investigation, not the fix.

## 9. Explicitly NOT in this plan
- No code. No schema applied. The gate stash stays stashed and unapplied.
- This document is the plan; implementation is a separate change with its own review and proofs.
