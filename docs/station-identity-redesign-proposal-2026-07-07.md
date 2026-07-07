# Station identity redesign — UUID-first (proposal, 2026-07-07)

Design + decisions. **Nothing approved, nothing built until Jeff replies GO** with his calls on the three
flagged questions (NAPI approach, transport model, v4.5 folding). Facts + receipts in
`station-id-census-2026-07-07.md`.

**Target invariant:** the station **UUID is the only station identity that crosses any boundary** —
process (renderer↔main↔daemon), persistence (query keys), machine (sync/backend), and API/contract. The
per-machine integer may survive *only* as a private, never-exposed DB auto-increment PK and/or a
process-private engine handle — see decisions 1 & 2.

---

## Decision 1 (FLAGGED) — the NAPI boundary

Rust keys engines by `HashMap<u32, …>` and every `#[napi]` fn takes `Option<u32>` (census §1). Two paths:

**(A) Pure UUID in Rust.** `HashMap<String, SharedAudioState>`; every NAPI fn takes `station_id: String`.
No mapping anywhere; UUID is the key end-to-end.
- *Pro:* zero mapping, the invariant holds literally into Rust.
- *Con:* pervasive Rust change + a native rebuild shipped to clients; string hashing on the 10 Hz path
  (negligible, but real); touches every call site.

**(B) UUID everywhere above the daemon; a process-private handle at ONE choke point.** *(recommended)*
The daemon, at station-attach, allocates an opaque per-process handle for a UUID and keeps the *only*
`Map<uuid → handle>` that exists. Rust stays integer-keyed but the integer is now a **process-private
handle allocated at attach — never the DB id, never persisted, never crossing above the daemon.** Every
boundary above the daemon (pipe, IPC, renderer, DB) is UUID.
- *The single place a mapping is allowed to live:* `audiod/ether-audiod.js` station-attach registry.
  Justified because it's in-process, ephemeral (rebuilt on daemon restart), and the handle is opaque —
  it is not "the per-machine integer station id" the standing rule forbids (which is the DB id leaking as
  identity). Nothing outside the daemon can observe or persist it.
- *Pro:* no Rust rewrite/rebuild; smaller blast radius; the invariant holds at every real boundary.
- *Con:* a mapping still exists (contained + defensible); requires discipline that the handle never leaks.

**Recommendation: (B).** It satisfies the invariant at every boundary with far less churn, and the
rule's intent (no per-machine identity crossing boundaries) is met — the handle is process-private and
opaque. Ship (A) only if you want literally no integer in Rust and accept the rebuild. **Jeff decides.**

## Decision 2 (FLAGGED) — does the integer PK survive?

Scoped tables today carry `station_id INTEGER` + a per-**row** `uuid` (NOT a station_uuid); scoping
queries filter by integer `station_id` (census §6). Two paths:

**(A) Keep `stations.id` as a private auto-increment PK; re-key scoping to `station_uuid`.** Add a
`station_uuid` column to each scoped table (backfilled `station_id → stations.uuid`), switch every scoped
query to `station_uuid`, and forbid `stations.id` above the persistence layer.
- *Pro:* far smaller migration; `stations.id` is a fine internal join key; existing FKs/rows untouched.
- *Con:* the integer still exists → future-leak risk (mitigate with a convention + a guard test that no
  IPC/pipe payload carries an integer station id).

**(B) Remove the integer entirely; `uuid` becomes the sole PK.** Re-key every FK + scoped table.
- *Pro:* no integer anywhere; zero leak risk.
- *Con:* large, low-value migration; uuid PKs are wider join keys; more risk on live data.

**Recommendation: (A)** — keep `stations.id` as a *DB-internal* PK, re-key all *scoping* to
`station_uuid`, and add the guard test. Honest tradeoff: (B) is purer but the integer as a private join
key is harmless; the value is in removing it as an *identity that crosses boundaries*, which (A) achieves.
**Jeff decides.**

## Decision 3 (FLAGGED) — transport model

**Broadcast-and-filter (current):** daemon broadcasts every station's frames; every window filters
(deck/queue filter at `engine-rodio.ts:173,191`; levels don't — the bug). 
**Per-station subscription (recommended):** a window tells the daemon "I'm bound to station UUID X"; the
daemon streams only X's frames to that window; on unbind/switch it resubscribes.

| Dimension | Broadcast-and-filter | Per-station subscription |
|---|---|---|
| VU bug | recurs if any consumer forgets to filter | **impossible** — you only receive your station |
| Volume | 10·N frames/s × every window | only bound frames |
| Multi-window future | every window sees all, filters | each window binds independently |
| Cross-machine (v4.5) | local daemon lacks a remote station's frames | generalizes to "subscribe to UUID wherever it lives" |
| Failure mode | bound station engine absent → blank | daemon emits an explicit **offline** frame → UI shows offline, never blank/stale (the never-empty lesson) |

**Recommendation: per-station subscription keyed by UUID**, with an explicit `offline` frame when the
bound station has no engine (so a bound-but-absent station reads "offline," never a frozen meter). It
fixes the VU bug *structurally*, scales, and is the only model that extends to v4.5 cross-machine
visibility. **Jeff decides.**

## Decision 4 (FLAGGED) — folding with v4.5 (license→account ownership)

**(a) Unified milestone (UUID re-key + ownership together).** *Scope:* very large. *Risk:* high — two
deep refactors entangled; failures hard to bisect; ownership work rides an unstable identity base
mid-flight. *Ordering:* none forced, but they interfere.
**(b) UUID re-key first (own release), ownership after on the clean base.** *(recommended)* *Scope:* two
sequential milestones. *Risk:* lower — each independently verifiable + bisectable. *Ordering constraint:*
v4.5 ownership's core feature is **cross-machine station visibility**, which is **impossible** while
station identity is a per-machine integer — so the UUID re-key is a **hard prerequisite** of v4.5, not
merely adjacent. Doing it first *is* laying v4.5's foundation.

**Recommendation: (b).** UUID re-key is the prerequisite v4.5 already needs; sequencing keeps each
release small, verifiable, and shippable. **Jeff decides.**

---

## Migration plan (on a COPY first; schema_version in its own table)
1. **SQLite (client-local, self-applied per install on update):**
   - New migration `migrate-station-uuid-key-phase-sync-N.js`: add `station_uuid TEXT` to each scoped
     table; backfill `UPDATE t SET station_uuid = (SELECT uuid FROM stations WHERE id = t.station_id)`;
     index `(station_uuid)`. Keep `station_id` transitionally (Decision 2A).
   - Bump `schema_version` (its own table).
   - Switch `stationScoped.ts` + all scoped queries to `station_uuid`.
2. **Rust/daemon:** per Decision 1 (recommended B — daemon UUID→handle map; no Rust change).
3. **Order of verification:** run the migration on **copies** of the OVEVENTS and jensj DBs first
   (`sqlite3 .backup`), verify row counts + backfill completeness + a generate/air smoke, before any
   packaged build touches a real box. jensj is live — one instance at a time; migrate in a chosen window.
4. **Customer accounts netgeak + cristianmalliani — untouchable.** The re-key is **client-local schema**
   (their installs self-migrate on update, same as any client) and the **backend is already uuid-primary**
   (census §6) so **no platform-side change touches their data**. We never run migrations against their
   DBs, never query-with-side-effects, never test on them. All test/migration verification is scoped to
   OVEVENTS + jensj copies only.
5. **Postgres:** already uuid-primary (`stations.uuid UNIQUE`, `station_now_playing`/`station_metadata`
   uuid-PK) — no backend schema change required.

## Verification plan (Jeff's walkthrough on a packaged build, before any tag)
Must pass all:
1. **Two stations airing simultaneously → independent, correct meters** (the original bug — each VU shows
   its own station only).
2. **Station switching rebinds meters live** — switch A→B, meters follow within a beat, zero cross-talk.
3. **Iris-offline cold boot** — app boots with Iris down: badge offline, no crash, audio + meters fine.
4. **Daemon restart recovery** — kill the daemon; on respawn, meters + audio resume for **all** stations,
   each bound correctly (no station-1 fallback collision).

Automated identity-layer tests (node, like the selector invariant test):
- Frame routing: a subscriber bound to UUID-X receives only X's frames; unknown UUID → no frames + an
  offline frame.
- `resolveTarget(uuid)` maps to the right handle and rejects unknown UUIDs.
- **Guard test:** no IPC/pipe payload shape carries an integer station id (scan the emitters) — prevents
  regression of the leak.
- Scoped-query test: `stationScoped` filters by `station_uuid`.

## Blast radius
**Touches:** daemon (attach map + per-subscription transport), `main.js` relays (levels/deck/queue →
per-subscription, carry UUID), `preload.js` (subscribe/unsubscribe API), renderer audio hooks/components
(`useActiveStation` already has uuid; bind by uuid), `engine-rodio`/`engine-registry` (key by uuid or
route via daemon), `cmd-routing` (already the uuid choke point), SQLite scoped queries + one migration.
Optionally Rust (only under Decision 1A).
**Deliberately does NOT touch:** playout/rotation/selector logic; **Deck X ↔ Rust deck mapping (sacred)**;
Esc/audio-safety; the never-empty floor; Postgres backend schema (already uuid); **customer platform
data**. One-instance-per-DB and copy-first migration rules hold throughout.
**Known risks:** (1) the NAPI/handle mapping (Decision 1) is the delicate seam — station-1 fallback
collisions if a handle is missed; (2) migrating live jensj; (3) per-station subscription offline-frame
correctness (a bound-but-absent station must read offline, never blank) — covered by walkthrough #3/#4.

---

**Awaiting GO + your three decisions (NAPI 1A/1B, PK 2A/2B, transport 3, folding 4a/4b).** No code until then.
