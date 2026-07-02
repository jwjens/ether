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

**Step 3 — backend endpoints (done, proven on scratch, NOT deployed):** `ether-backend/src/routes/library.js` — `GET /library/snapshot`, `GET /library/changes?since_version=N`, `POST /library/songs`, `DELETE /library/songs/:content_hash`. Core logic exported as plain fns (snapshotFor/changesFor/upsertSong/deleteSong); mounted at `/library` behind `requireLicenseOrMember` in index.js (same auth as /sync). Reads honor `library_grants` via the shared `grantedOwnerLicenseIds` (own UNION granted owners); writes touch only the caller's license; upsert/delete bump `library_snapshot_version` + stamp `snapshot_version`; delete writes a tombstone; re-add clears it. ether-backend commit `4581111`.
  - Proven on pg-mem with the REAL grant state (19→2 active, 2→19 revoked): **license 2's snapshot returns license 19's songs (the grant case Jeff required)**; license 20 (no grant) is empty; changes filter by snapshot_version; delete tombstone visible + re-add clears it. All 12 checks pass. pg-mem limitation noted: `MAX() over = ANY(array)` returns 0 in the emulator; combinedVersion uses standard `= ANY($1::int[])` (same as sync.js), verified correct via the IN form (=2/=3) — prod-correct.
  - **Confidence endpoints work on prod Postgres: ~85%** (pg-mem is an emulator; ON CONFLICT/EXCLUDED, transactions, ANY-array all exercised; only real-Postgres run remains).

**Open design note (flagged, not blocking the OV/DJ reality):** `combinedVersion` returns MAX across [own, granted-owners]. Correct when a grantee is a pure reader of one grantor (license 2 has an empty own library, reads only 19). A grantee with its OWN non-empty library + a grant would have two independent per-license counters under one cursor — the tail could miss own-library changes. Not a problem for OV/DJ; revisit before any multi-source-library grantee ships.

**Next (Week 1 close-out — both HELD for one combined apply, on Jeff's go):**
1. **Railway deploy** of ether-backend (schema §2.2 + endpoints §3) together — creates the tables on prod + serves the endpoints.
2. **Dev restart** on OVEVENTS to apply client migration v27 to the live dev DB.

---

## Session 2026-07-02 — SCOPE CHANGE: full clean slate + fresh account

**Decision (Jeff):** abandon ALL old data — old backend (every license/mutation/station + station-scoped history) and all local DBs. Go-live target = a BRAND-NEW account via the normal signup flow. Spec updated to match (header banner + §7 rewritten to "Fresh account + library import", §7.1 to "New-customer experience", §10 clean-slate). openair commit pending this note.

**What this changes:**
- **Week 2** = fresh signup → importer (scan 4 folders, hash, dedup) → publish snapshot to the NEW license (no reseed, no truncate, no grant scoping). Step-zero OV/19 map is now historical only.
- **Week 3** = full new-customer path signup→on-air; stations/clocks/programming AUTHORED FRESH (not migrated/regenerated). Kills the tombstone-referencing-schedule + never-seeded-separation_rules bug classes by construction.
- **Simplifications dropped from the plan:** per-license reseed (§3.4 truncate), library_grants entanglement, schedule regeneration from old data, careful license juggling. Week 1 v2 schema/endpoints still stand and still need the one Railway deploy.

**OPEN DECISION (in spec §10):** old prod rows (licenses 2/19/20/21 + mutations/stations) — leave **dormant** (recommended, zero-risk, license-scoped so they don't touch the fresh account; deletable later via platform delete-account route) vs **actively wipe** now. Awaiting Jeff.

**Unchanged pending applies:** the Week 1 Railway deploy (schema+endpoints) and the v27 client migration still happen — they're account-agnostic foundation. The fresh account is created against them.

**Next:** Jeff's calls on (a) old-data disposal (dormant vs wipe), (b) go on the Week-1 combined apply (Railway deploy + dev restart). Then Week 2 = fresh signup + import.

---

## Session 2026-07-02 (cont.) — WEEK 1 COMPLETE (applied + proven)

**Decision:** old data stays DORMANT (spec §10 updated). No prod wipe.

**Railway deploy (prod):** `railway up` (2nd attempt; 1st timed out on upload) deployed ether-backend commit `4581111`. Deployment `d3d9fc49`, `● Online`, logs `[Ether] API live → port 8080` + `[DB] Schema ready` (initDB ran → v2 tables created on prod). Backend URL https://ether-backend-production.up.railway.app. Auth header = `x-license-key`.
  - Smoke tests PASS: `GET /library/snapshot` valid license → 200 `{version:0, songs:[]}`; no header → 401 "Missing x-license-key header"; invalid key → 401 "invalid_license_key".

**Dev restart (OVEVENTS):** electron:dev restarted → boot log `[migrate-v27] Transaction committed.`. Live dev DB now schema_version=27; `songs_v2` (11 cols) + `local_files` (3 cols) EXIST, both empty. Confirmed read-only.

**State:** Week 1 (v2 schemas + endpoints) is deployed to prod and applied to dev, all proven. Old data untouched/dormant. ether-backend commits `d919e82`,`4581111` still local-only in git (deployed via `railway up`, NOT pushed to GitHub — push later for repo/GitHub-Railway consistency if desired).

**Next: WEEK 2 — fresh account + library import (spec §7):**
1. Create the go-live account via the normal signup flow (fresh license).
2. Importer (OVEVENTS dev): scan the 4 folders, SHA-256, dedup, extract metadata, copy to content store, upsert songs_v2. Report scanned/unique/dup-collapsed/unreadable.
3. Review gate (Jeff) → go/no-go.
4. Publish snapshot to the fresh license via POST /library/songs.
5. R2 upload by hash. 6. Verify: wipe dev DB, bootstrap, one row per song, resolvable.

Note: ether-backend deployed state == local commit `4581111`; GitHub remote NOT yet updated (deploy was via `railway up`, not git push).
