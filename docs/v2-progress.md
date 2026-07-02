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

---

## Session 2026-07-02 (cont.) — clean-slate executed + verified; HalloVeen diagnostic

**Jeff actions (outside this session):** deleted old accounts on prod — licenses **2 (DJ) and 19 (OV) are gone**; signed up a **fresh djdeniro** → **license 22** (plan=station, one empty station "djdeniro" id 32). jensj/OV **not yet re-signed-up** (no license on prod).

**Diagnostic — fresh djdeniro showed a HalloVeen station he never created (audio dead):**
- **Root cause = LOCAL residue.** The dev machine's `openair.db` (283 MB, schema v27) was **never wiped before sign-in** — it still held all old stations (HalloVeen id 10 on OV's key, Magical Forest, OV, +1186 old songs, 37,535 generated_schedule rows). The app displayed old local stations under the new login (station identity is local-first).
- **License 22 is CLEAN on the server** (read-only prod check): 0 mutations (whole table empty), 0 library_songs/snapshot_version/tombstones, 0 staged_programming; only its own empty station. Not down-flowed, not up-polluted.
- **Deletes of 2/19 were clean:** no orphans in station_cc_data/now_playing/metadata/play_history/listener_samples; staged_programming empty; their mutations gone. Route covers the server; it does NOT touch local DBs.

**Delete/re-signup mechanism verified (read-only):** the only re-signup blocker is `users.email UNIQUE`; `users` has no soft-delete column; `licenses.email` is not unique. The delete route frees an email **iff** the email's `users` row has `license_key_id = <deleted license>`. Platform auth is a Railway-secret JWT (independent of any license) → deleting license 2 can't lock the route.

**Local wipe (executed, proven):** killed all Ether/electron/engine/dev procs (0 remaining), then deleted `%LOCALAPPDATA%\Ether` + `Roaming\Ether` + `Roaming\openair` (`Roaming\com.ether.radio` absent). All targets gone. **`Music\ether music library` preserved — 1430 files intact.**

**Fresh boot verified:** new DB created clean, migrated **v1→v27** (schema_version max=27/count=27), `songs_v2`(11 cols)+`local_files`(3) present, **zero old data** (1 default Station + 5 separation_rules + 8 config = first-run seeds). Jeff confirmed the app opened fully clean.

**Lesson:** wipe local app data BEFORE the first sign-in to a fresh account.

**Still pending:** push ether-backend to origin (requested but preempted by this diagnostic — origin still behind `d919e82`,`4581111`); jensj/OV fresh re-signup.

**Next:** Week 2 importer — write it, prove on scratch, stop at the review gate.

---

## Session 2026-07-02 (cont.) — Week 2 importer written + proven; AT REVIEW GATE

**Importer:** `scripts/import-library-v2.js` (uses `music-metadata`, the app's existing tag path). Scans ONLY the 4 folders, SHA-256 = content_hash (identity, D1), dedups by hash (source_folder keeps first), extracts title/artist/album/duration. `--dry-run` = scan+report only (no writes); write mode copies to `<store>/<hash>.<ext>` + upserts `songs_v2`/`local_files` (Phase 2, post-go, app CLOSED or scratch `--db`).

**Proven on scratch (14/14 checks, `scratchpad/prove-importer.js`):** dedup collapses byte-identical cross-folder copies to one row + keeps first source_folder + hash-is-identity; write path (songs_v2+local_files+`<hash>.<ext>` store copy); idempotent re-run (row count stable, copied=0); real tags read (Britney "…Baby One More Time" dur=211096 artist=Britney Spears). Fixed one bug (scanLibrary musicDir default).

**REVIEW-GATE REPORT (dry-run over real library, 23.9s):**
- per-folder: Daytime 215, Halloween 58, Christmas 36, CS - Coffee Shop 43 = **352 scanned**
- **350 unique content hashes**; **2 duplicate groups** collapsed (2 extra copies), **0 unreadable/tagless**
- dup 1: `Halloween/Somebody's Watching Me.mp3` == `Halloween/Somebody’s Watching Me.mp3` (straight vs curly apostrophe, byte-identical)
- dup 2: `Daytime/White Christmas …` == `Christmas/White Christmas … Spotify Singles …` (same recording, cross-folder)
- full deduped list (350) written to scratchpad `v2-import-report.json`
- Count lands exactly on the real library size → healthy. **STOPPED — awaiting Jeff go/no-go on the deduped list.**

**Post-go (Phase 2, not done):** copy uniques to content store; publish to djdeniro/license-22 via `POST /library/songs` (server-side, safe) OR write local songs_v2 with app CLOSED; R2 upload by hash; verify (wipe dev, bootstrap, one row per song, resolvable).

---

## Session 2026-07-02 (cont.) — Week 2 Phase 2 COMPLETE + verified

**source_folder question (Jeff):** confirmed **display-only** — zero references in `electron/`+`src/`; song→category is `songs.category_id` (explicit FK), never derived from folder. Collapsing White Christmas does not affect what the Christmas station pulls.

**ether-backend pushed to origin:** `24620e7..4581111 main` (origin now matches deployed; 0 unpushed). (GitHub dependabot flags 10 pre-existing vulns — unrelated, later.)

**Publish:** `scripts/import-library-v2.js` scan → 350 POSTs to `/library/songs` for license 22 (key ETH-STN-4462…, read in-process, never printed; key_hash NULL so lookupLicense matches plaintext). **350/350 ok, 0 fail**; snapshot version=350, songs=350.

**R2 upload by hash:** bucket **`ether-backups`** (R2_BUCKET env; code default "ether-audio" is overridden), key scheme `22/<content_hash>.<ext>`, via `railway run` (backend R2 creds), WHEN_REQUIRED checksum. **uploaded=350, failed=0.**

**Mid-pipeline disk change (Jeff):** deleted the Daytime White Christmas copy (folders now FROZEN). Re-verify vs frozen disk:
- per-folder Daytime **214** / Halloween 58 / Christmas 36 / CS 43 = **351 scanned, 350 unique, 1 dup group** (only "Somebody's Watching Me", straight-vs-curly apostrophe), 0 unreadable.
- **No drift:** disk's 350 hashes == snapshot's 350 hashes (0 only-disk, 0 only-snapshot).
- White Christmas (`a4e576842aad…`) now Christmas on disk **and** already Christmas on server (metadata matched — fix was a no-op). Snapshot still 350/version 350.

**API/cloud verify PASS:** `GET /library/snapshot` license 22 = **350 songs**; R2 HeadObject **350/350 resolvable, 0 missing**, White Christmas resolves YES.

**Limitation noted:** this is an API/cloud-level verify. The literal wipe-and-app-bootstrap can't run yet — the client does not consume `/library/snapshot` on sign-in (that's §4, not built). Server + cloud are correct and a bootstrap *would* succeed once wired.

**Next build: spec §4 — client bootstrap** (app pulls snapshot into `songs_v2` on sign-in, then tails `/library/changes`). Scope only, stop before code.
