# Sync core: reconcile station identity by UUID (design — not built)

Status: **DESIGN ONLY. Build nothing on this yet.**
Date: 2026-06-22
Origin: the `prove-member-convergence` failure (ether-backend `32987e6`). That proof caught,
before shipping, that enabling member writes would make two installs of one station diverge.

---

## 1. The problem in one paragraph

The peer-sync path routes and merges station-scoped programming by each **machine's local
integer `station_id`**, not by the station's stable **UUID**. The same OV station is local id
`1` on one install and id `7` on another (the integer is per-install autoincrement; it is not
guaranteed to match across machines). Because the integer is the routing key, two installs
editing the *same* station never see each other's edits, and on the rare occasion an edit is
delivered it gets stamped with the *sender's* local id — so the row detaches from the
receiver's own station. The result is divergence and mis-scoping.

This is latent today because only **one** writer per account is live (single-account, and in
practice usually one machine at a time). The moment a second writer with a different local id
edits the same station — which is exactly what the member-PUSH gate would unlock — the defect
becomes real. That is why the gate is stashed and not applied.

## 2. Root cause, concretely (where it lives)

Two places, both keyed on the local integer:

- **Backend pull scoping** — `ether-backend/src/routes/sync.js` (GET `/sync/mutations`):
  `WHERE station_id = $3 OR station_id IS NULL`, where `$3` is the *receiver's* local
  station id. A mutation tagged with a different local id is filtered out and never delivered.
  The client supplies that id from `getActiveStationId()` (`openair/electron/main.js:1526`,
  `getStationId: () => String(getActiveStationId())`).

- **Local merge apply** — `openair/electron/sync/merge-engine.js` (`_applyToLiveTable`):
  applies `payload_after` verbatim by **uuid** (`row_id`). The row converges in content, but
  `payload_after.station_id` is the sender's local integer, so the receiver's row column is
  overwritten with a foreign id. There is no remap.

Note the asymmetry that makes this easy to miss: the **dashboard → install** path
(`openair/src/lib/ccData.ts`, `resolveLocalStationId`) *already* reconciles `station_uuid →
this install's local id`. That fix does **not** touch the peer-sync (install ↔ install) path,
which is the one member edits travel on. The two paths look similar and are easily conflated.

## 3. What the fix is

Make the station's **UUID** the unit of station identity on the sync path, so routing and
scoping no longer depend on a number that differs per machine. The local integer stays as the
in-DB foreign key; it is just never used as a *cross-machine* key again.

Conceptually:
- A mutation should be associated with the **station UUID**, not (only) a local integer.
- The backend should deliver a station's mutations to anyone scoped to that station **by
  UUID**, regardless of what local integer each install happens to use.
- On apply, the receiver should resolve the incoming station UUID to **its own** local id and
  stamp that onto the row — the same resolve-by-UUID that `ccData.ts` already does, but moved
  onto the merge/apply path.

## 4. What it touches (the surface area — this is a live-sync-core change)

This is not a leaf edit; it reaches the parts of the system that move every station-scoped
row. Expect to touch, roughly:

1. **Wire format / mutation shape** — carry `station_uuid` on station-scoped mutations (today
   only the local integer travels). Either add a field, or derive/translate at the boundary.
2. **Backend store + pull** (`src/routes/sync.js`, and the mutations table / its indexes) —
   scope station-scoped pulls by station UUID. The pending-count query mirrors the pull and
   must move in lockstep. Likely needs the station UUID stored/queryable on the backend
   `mutations` row (or a station-uuid ↔ license mapping the pull can join).
3. **Push side** (`openair/electron/sync/sync-engine.js`, `mutation-writer.js`,
   `synced-tables.js`) — emit the station UUID alongside (or instead of) the integer.
4. **Pull param** — `getStationId()` wiring (`main.js`) sends the active station's UUID, not
   its integer.
5. **Merge apply** (`merge-engine.js`) — resolve incoming `station_uuid → local id` and stamp
   the **receiver's** id onto the row; do not write the sender's integer. Reuse the
   resolve-by-UUID logic already proven for `ccData.ts`.
6. **Migration / back-compat** — existing stored mutations and in-flight cursors are keyed by
   the integer. A transition that doesn't strand already-synced data is part of the design,
   not an afterthought (see risk below).

## 5. How it would be proven

- **Promote `prove-member-convergence` from red to green.** Same harness (real router + real
  merge engine, owner and member on *different* local ids). After the fix it must assert:
  (a) both installs converge to the LWW winner, **and** (b) the row stays scoped to *each
  install's own* local station id (owner's row → id 1, member's row → id 7) — i.e. no foreign
  id leaks onto the row. Both halves matter; today both fail.
- **Single-account regression.** A second proof (or extension) that the *existing* shipping
  case still works: one account, two machines, same station — including when the two machines
  legitimately hold different local ids. This is the case most at risk of regressing.
- **Migration proof.** Drive the integer→UUID transition over a store seeded with
  pre-existing integer-keyed mutations and assert nothing already-synced is dropped,
  re-delivered in a loop, or mis-scoped.

## 6. Risk to existing single-account sync (the thing to respect)

The reason to plan this separately rather than patch it now:

- **It changes the routing key for every station-scoped row.** Get it wrong and you don't
  break a corner case — you break the working single-account two-machine sync that OV relies
  on. This is the live sync core, not a feature flag boundary.
- **Stored/in-flight data is keyed the old way.** Backend mutations, client cursors, and
  pending pushes all reference the integer. The change needs a migration story that keeps
  already-synced installs converged through the cutover.
- **Two code paths must stay consistent.** Pull and pending-count mirror each other; push and
  merge mirror each other. A half-applied change (e.g. backend scopes by UUID but clients
  still send integers) is its own divergence bug.
- **Sequencing.** This must land and be proven green **before** the member-PUSH gate is
  re-applied. The gate is value on top of a sync core that can converge two writers; that core
  doesn't exist yet. Re-applying the gate first just ships the divergence the proof caught.

## 7. Explicitly out of scope right now

- Re-applying the stashed gate change (`ether-backend stash@{0}`). It stays stashed, and its
  "convergence proven" comment is false and must not go back as-is.
- Any code change to the sync path. This document is the design step; implementation is a
  separate, planned change with its own review.
