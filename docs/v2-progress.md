# Ether v2 Data Architecture — Progress

Contract: `docs/ether-v2-data-architecture-spec.md`. Workflow: OVEVENTS dev + backend only until week 3; read-only before destructive; `.js` scripts never inline; migrations proven on a copy; Jeff approves each destructive step with explicit "go".

---

## Session 2026-07-01 — Step zero (spec §7.3 / §10 blocking risk)

**Done:** Read-only backend query mapping licenses + library_grants + where the library lives. Ran against production Postgres via `railway run -s Postgres` (Railway injects `DATABASE_PUBLIC_URL` through the `ballast.proxy.rlwy.net` public proxy — no secret handled locally).

**Proven (confidence ~95%, direct DB read):**
- License ids: **DJ = 2** (Dj Deniro, djdeniro@gmail.com, ETHER-OWNER-2026), **OV = 19** (jensj@opportunityvillage.org, ETH-STN-1D73-7E88), **testaccount = 20** (testaccount@yahoo.com). Extra unlisted account: netgeak = 21.
- **The library is owned by license_key_id = 19 (OV)** — 2525 songs mutations (365 insert / 415 delete) under 19 vs only 4 (all no-op) under 2. **Genesis snapshot (§7.3) publishes to license 19.**
- library_grants: grant id=1 DJ(2)→OV(19) is REVOKED (2026-06-23); grant id=2 **OV(19)→DJ(2) is ACTIVE** — OV shares its library to DJ, so DJ reads OV's catalog via the grant UNION. Reseeding 19 is therefore visible to 2 (expected per grant; Jeff to consciously accept before publish).

**Flags raised (awaiting Jeff):**
- No license is named "US Phenomenon" — DJ/OV/testaccount/netgeak only. USPH is likely a *station* under an account (probably DJ/2), not its own license. Confirm before any week-3 multi-account step. Not a blocker for the OV/19 genesis publish.
  - RESOLVED (Jeff): USPH is an empty station under license 2, disposable — delete/recreate fresh at week 3 cutover.
- Active OV→DJ grant = cross-visibility; needs a conscious "yes" before genesis publish.

**Backend facts confirmed en route (from earlier read-only map):** mutations table is the only library store (no materialized `songs` table on backend yet — v2 adds `library_songs`); pull is `WHERE server_seq > since AND license_key_id = ?`; push dedups `ON CONFLICT (license_key_id, id)`; per-license `DELETE FROM mutations WHERE license_key_id=$1` primitive exists (in the account-delete route). Railway project `brave-simplicity` / production; Postgres service name `Postgres`.

**Next:** await Jeff's "go" on **Week 1** (spec §2 schemas + §3 endpoint contracts — build `library_songs` / `library_snapshot_version` / `library_tombstones` tables and the snapshot/changes/upsert/delete endpoints; client `songs_v2` / `local_files` tables). Nothing built yet.

---

## Session 2026-07-01 (cont.) — Week 1, steps 1–2 (schemas)

**Spec change (Jeff-approved, Option 1):** added `snapshot_version BIGINT NOT NULL` to `library_songs` (§2.2) — resolves the §2.2-vs-§3.2 conflict (upserts now filter by `snapshot_version > N` exactly like tombstones). Spec doc updated. openair commit `c81ba3f`.

**Step 1 — client SQLite (done, proven, NOT applied to live):** migration v27 `scripts/migrate-songs-v2-phase-sync-27.js` creates `songs_v2` (content-hash PK, install-scoped, REST-populated → deliberately NOT in synced-tables) + `local_files` (machine-local, never synced). Old `songs` untouched. Proven on a dev DB copy 26→27 (all cols + PK, idempotent, old songs intact); verify:schema PASS; fresh-install chain clean v0→v27. openair commit `c0a612c`. **Not applied to live dev DB — happens on next dev restart (separate go).**

**Step 2 — backend Postgres (done, proven on scratch, NOT applied to prod):** `ether-backend/src/lib/library-schema.js` (`LIBRARY_V2_DDL`) = `library_songs` / `library_snapshot_version` / `library_tombstones` + 2 change-stream indexes; wired into `initDB()` schema-init (additive `CREATE ... IF NOT EXISTS`). Proven on pg-mem scratch with a stub `licenses` FK: all 25 checks pass (columns incl. snapshot_version, composite PKs, changes-by-version query on both tables, dup rejection; idempotency guaranteed by IF NOT EXISTS — pg-mem can't re-run the no-op, noted). ether-backend commit `d919e82`. **NOT deployed — lands on next Railway deploy (separate go).** Tooling note: no docker/psql on OVEVENTS; pg-mem is the scratch Postgres.

**Next:** Step 3 — backend endpoints §3.1–3.4 (`GET /library/snapshot`, `GET /library/changes`, `POST /library/songs`, `DELETE /library/songs/:content_hash`), written + proven on pg-mem, stop before deploy. Then the two pending applies (dev restart for v27; Railway deploy for backend schema+endpoints) on Jeff's go.
