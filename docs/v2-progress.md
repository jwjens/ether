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

---

## Session 2026-07-02 (cont.) — §4 client bootstrap SHIPPED + proven

**Build:** `electron/sync/library-client.js` — `bootstrapLibrary` (GET /library/snapshot → songs_v2 + store version in system_state `library_snapshot_version` + populate local_files from content store) and `tailChanges` (GET /library/changes, apply upserts/deletes by content_hash, 410 → re-bootstrap). Wired in `main.js` as an **ALWAYS-ON timer** gated on `account_jwt` + resolvable license key.

**Key correction (why v1 failed):** first attempt hooked `sync:set-active`, but that handler lives inside the `sync_enabled === 'true'` block (opt-in Multi-Device Sync, OFF by default) → never registered on a fresh install. Fixed by making the library bootstrap independent of that toggle (always-on). Library bootstrap ≠ mutation sync.

**PROOF (real, wiped machine + djdeniro sign-in):** `songs_v2 = 350` from snapshot v350; distinct hashes 350; `library_snapshot_version = 350`; per source_folder Daytime 214 / Halloween 57 / Christmas 36 / CS 43; White Christmas = Christmas. `local_files = 0` (no local store on this machine → playback via §6/R2). openair commit `b6cfd29`. Metadata read-path only — nothing reads songs_v2 into the UI yet (read-cutover, later).

**Follow-up flagged:** account-switch should reset `library_snapshot_version` / re-bootstrap for the new license (single-value cursor). Fine for single-account go-live.

---

## Session 2026-07-02 (cont.) — Station 1 seed investigation (READ-ONLY)

**Trigger:** on a wiped machine + djdeniro sign-in, the app showed a local **"Station 1"** the user never created, and the user's real **"djdeniro"** station (server, license 22, id 32) was NOT in the station switcher.

**Provenance — CONFIRMED old, Jeff-authored, NOT session-added:** the Station 1 seed in `initDB()` is foundational fresh-install code Jeff wrote in May–June 2026:
- `INSERT INTO stations (id=1 …)` + `"[DB] Seeded station 1"` → `501fb29` *refactor(fresh-install): extract seedFreshInstall()* **2026-05-16**.
- pre-chain `INSERT INTO stations (name) VALUES ('Station 1')` → `8072176` *feat(schema): Option B — schema-v0-baseline* **2026-05-17**.
- icecast/generate defaults → `4696740` *fresh-install stations generate/stream by default (v4.3.83)* **2026-06-18**. Lineage to `fb9277e` (Electron migration, 2026-03-29). Nothing this session created or modified it.

**Why "djdeniro" isn't in the badge:** the switcher lists LOCAL stations; "djdeniro" exists only on the SERVER (signup auto-created it). The desktop seeds its own local "Station 1" on fresh install and never pulls the account's server stations down (station rows move only over the opt-in mutation sync; there is no "adopt account stations on sign-in"). §4 is library-only and does not touch stations.

**What actually breaks if no station exists pre-onboarding:**
- "40 callsites" header at top of main.js is AUDIT HISTORY (resolved, `08f75da`) — not a live blocker.
- Real: `getActiveStationId()` returns `row?.id ?? 1` → phantom station 1. FKs to `stations(id)` DO exist in migrations (`pinned_songs` + v4 lib table in `migrate-library-phase-sync-4`, metadata in `migrate-metadata-tables-phase-sync-6`) → phantom-1 writes to those FK-violate (baseline alone has no FK; migrations add them).
- Migration chain does NOT crash on 0 stations (station-loops iterate empty), but per-station seeds produce 0 rows (migration-6: 47 metadata_definitions + 35 vocabulary × 0; separation_rules etc. = 0). The seed exists so these bind to station 1.
- RUST engine boots "Station 1" at startup; onboarding CONFIGURES station 1 (`OnboardingFlow.tsx:240` hardcodes `upsertByKey(1,…)`), it does not create one.

---

## PLAN (not built): station-provisioning + seed-removal + spec §8 bundle

**This is the fix for the missing djdeniro station.** Build AFTER §6 resolver, BEFORE the read-cutover.

**ACCEPTANCE TEST (verbatim customer sentence — the ONLY definition of done, demonstrated on a WIPED machine):**
> "Sign up on the web, create a station, install the app, sign in: your station, with your name on it, is on screen."
No jargon, no toggles, no second step.

**REQUIRED BEFORE THE BUILD STARTS (read-only proof, not a during-build check):** the renderer pre-onboarding-write audit (plan step 7) — prove that no renderer screen issues a station-scoped write before a station exists (the FK-violation path). Runs as its own read-only proof first.

**Plan steps:**
1. Delete the Station 1 seed (main.js ~993–1034). Fresh DB → 0 stations. Existing installs keep their stations (fresh-install-only).
2. `getActiveStationId()` → `?? null` (not 1); callers treat null as pre-onboarding.
3. Move per-station seeding from migration-time → station-creation time (spec §8): `seedStationConfig(stationId)` in `stations:create` inserts the 5 default separation_rules (30/30/30 STRICT, gender 3 SOFT, category 1000 SOFT), 47 metadata_definitions, 35 metadata_vocabulary, icecast defaults — one transaction. Also fixes never-seeded-separation_rules gap.
4. Onboarding becomes the creator: "create" path calls `stations:create` (→ seeds config); drop hardcoded station-1 assumption.
5. Sign-in station provisioning: on sign-in, GET /account/connect → materialize each account station locally (uuid = server uuid, owner_license_key = account license) → set active. Returning djdeniro gets "djdeniro"; brand-new account → onboarding-create makes the first. No default seeds anywhere.
6. Reconcile signup "djdeniro" (id 32): provisioning-pull adopts it → no duplicate.
7. Guards: RUST engine inits lazily on station-active (not at boot); generator/scheduler/playout gate on `getActiveStationId() != null`; renderer never writes station-scoped rows before a station exists (the read-only proof above).

---

## Next build: spec §6 — resolveByHash resolver (local store → R2 → cache into store). Prove on scratch, stop at gate.

---

## Session 2026-07-02 (cont.) — §6 resolveByHash resolver BUILT + proven (at gate)

**Build:** `electron/audio-resolver.js` — `resolveByHash(db, content_hash, {store, r2GetToFile})`: (1) local_files hit + file exists → local; (2) file already in store → repair local_files + return; (3) R2 GET `<hash>.<ext>` → write into `<musicDir>/store` → upsert local_files → return; (4) miss → `{ok:false,'not local, not in R2'}`. ext is authoritative from songs_v2. R2 fetch is INJECTED (prod passes the backend-signed flow / fetchR2Track; tests pass a direct S3 client). License-agnostic — hands r2GetToFile the bare `<hash>.<ext>`; the injected fn applies the license prefix. Replaces resolveLocalAudioPath.

**Proven on scratch (8/8, `scratchpad/prove-resolver.js`, real license-22 hash + backend R2 creds via `railway run` + electron-as-node):** R2 fetch → source=r2, 14.5 MB mp3 landed in store, local_files inserted; 2nd call → source=local, R2 NOT hit, stored path returned; unknown hash → ok:false (not in songs_v2); in-songs_v2-but-not-in-R2 → ok:false (not local, not in R2). openair commit pending.

**NOT wired into playback yet** — audio:load/cue still use resolveLocalAudioPath; swapping them to resolveByHash is part of the read-cutover (needs songs_v2 to be the read source + prod r2GetToFile bound to fetchR2Track). §6 is the resolver + gate only.

**Next build:** station-provisioning + seed-removal + §8 bundle (see plan above). Its acceptance test is the verbatim customer sentence; the renderer pre-onboarding-write audit runs as a read-only proof FIRST.

---

## Session 2026-07-02 (cont.) — pre-onboarding-write audit (READ-ONLY proof, PASSED)

**Scope:** prove no renderer screen writes a station-scoped row before a station exists (the FK-violation path), so removing the Station 1 seed won't crash a fresh install.

**Hard-fail FK set** (write with station_id + no matching stations row → FK violation): `station_programming`, `pinned_songs` (migrate-library-phase-sync-4), `metadata_definitions`, `metadata_vocabulary` (migrate-metadata-tables-phase-sync-6). Everything else with station_id (`station_config_kv`, `songs`, `categories`, `clocks`, `clock_slots`, `shows`, `generated_schedule`, `play_log`, `scheduled_log`) is a plain column → orphan, not crash.

**Render gate (App.tsx 1925–1934):** Splash → OnboardingFlow (if not signed in) → UserLogin → OnShiftScreen → main app. All ~40 station-scoped write callsites live in the main app → unreachable until after sign-in + login + shift.

**Only pre-station screen = OnboardingFlow.** Writes EXCLUSIVELY `station_config_kv` (`kv.upsertByKey(stationId,…)`, `stationId` from `useActiveStation()`) + `install_config_kv` (account_jwt/email) — both NON-FK. Writes to NONE of the four FK tables.

**VERDICT: renderer pre-onboarding path is SAFE** — seed removal won't FK-crash. Three grounds: write screens gated behind sign-in; only pre-station screen writes non-FK config; no FK-table write before a station exists.

**Build-time follow-ups (not crashes):** (1) OnboardingFlow config writes under phantom station_id=1 → orphan config; onboarding must create the station first then write config under its real id. (2) `getActiveStationId() ?? 1` → `?? null` + `useActiveStation()` null-tolerant. (3) Engine/main-process boot writes non-FK tables with phantom 1 → orphan; migration chain with 0 stations seeds 0 rows (loops empty) → no FK writes; engine still needs a no-station boot guard.

**ADDED PROOF REQUIREMENT (Jeff):** the Rust engine's zero-station boot must be DEMONSTRATED with an actual boot against an empty-station DB — not reasoned about. Finish line stays the verbatim customer sentence on a wiped machine.

---

## Session 2026-07-02 (cont.) — station-provisioning build: steps 1–2 DONE + engine zero-station boot PROVEN

**Step 1 (seed removal):** deleted both Station 1 seed spots in `initDB`/`seedFreshInstall` (pre-chain bare seed + the id=1 INSERT); guarded the `separation_rules` seed to skip when `getActiveStationId()` is null (per-station config moves to §8 station-create). **Step 2:** `getActiveStationId()` now returns `null` (was `?? 1`) when no active station. Renderer `useActiveStation()` already tolerates this (falls back to id=1 + ready → routes to sign-in), so no renderer change needed.

**ENGINE ZERO-STATION BOOT — DEMONSTRATED (actual boot on empty-station DB, not reasoned):** wiped → booted with seedless code → `stations=0, separation_rules=0, metadata_definitions=0, schema_version=27`; migration chain clean; **0** FK/constraint/migration-fail errors in the log; RUST engine opened its default Station-1 audio slot (by integer id, DB-independent), mixer + Program Bus running, 7 electron procs healthy — no crash. openair commit pending.

**⚠️ FINDING (blocks the "wiped machine" acceptance test — needs its own fix before the acceptance run):** on the wiped machine the fresh DB came back with `account_jwt` + `license_key` + `account_email=djdeniro`, the app AUTO-signed-in, and §4 re-bootstrapped `songs_v2=350` with NO manual sign-in. So my wipe (`%LOCALAPPDATA%\Ether` + `Roaming\Ether` + `Roaming\openair`) is NOT a true factory reset — the session persists. `userData` = `Roaming\Ether` (renderer Local/Session Storage + Cookies); un-wiped `Roaming\Electron` + `Local\Electron` also hold a `Local Storage`. Renderer does NOT cache the JWT in localStorage, so the session is surviving in a store the wipe isn't reliably clearing. §4's auto-bootstrap made this newly visible. **A valid factory reset / acceptance test must reliably clear userData (Roaming\Ether: Cookies, Local/Session Storage, IndexedDB) — pin down the exact persistence location first.** (Note: packaged app sets its own userData; may differ from dev — confirm.)

**LEAK IS ACTIVE, NOT PASSIVE:** the leaked session didn't just pull the library down — it **wrote a station identity to the server**. License 22 acquired a second station id=33 "Station 1" (uuid `32e62ffc…` = the local seeded phantom's uuid, created 09:38) via the **station-registration endpoint** (license_key + machine_id + station_uuid), NOT the mutation stream — `mutations` table is 0 across all licenses. The phantom (id 33) is empty (cc/staged/now_playing/play_history all 0). Signup station id=32 "djdeniro" (uuid `766cdcce…`, 01:07) is the keeper. → This is the station-provisioning duplicate trap firing live; being cleaned now (delete id 33 from server on Jeff's go) BEFORE steps 3–7. Confirms the leak/wipe defect is a bidirectional (read+write) integrity problem, raising its priority.

---

## Session 2026-07-02 (cont.) — Fixes A/B, step 5, cleanup, sync dead-end trace, + SUBSCRIPTION-MODEL rework (spec updated)

**Phantom station cleaned:** deleted server station id=33 "Station 1" via `DELETE /api/platform/stations/:uuid` (platform token from ETHER_PLATFORM_SECRET). License 22 back to exactly 1 station "djdeniro" (id 32). Deleted-license (2/19) rejection re-verified: mutations empty, 0 activations for old keys, `/account/connect` only under valid license 22.

**Session-leak resolution:** pinned `sessionData == userData == Roaming\Ether` (Chromium session lives in the same dir the wipe clears; DB in `LocalAppData\Ether`, also cleared). No out-of-band store, no auto-restore code path → the "session returning" was a manual sign-in on boot, not a passive leak. **Fix A** (openair `7ff2c06`): `system:factoryReset` now async, `session.defaultSession.clearStorageData()+clearCache()` + `rm(app.getPath('sessionData'))` before the file wipe — path-independent. **Fix B** (openair `6323d84`): `scripts/dev-factory-wipe.ps1` — complete verified wipe of both stores (kills lockers, retry, preserves music). Primary proof = the app's own reset button (now the proven wipe).

**Step 5 (openair `1c6ba32`):** `reconcileAccountStations` first-station adoption — materialize account stations by uuid already existed (no-dup, step 6), but it was add-only and never set one active; added: when NO station is active, activate the account's (cloud) station → "your station on screen." **Seats:** freed license 22's 5/5 test-junk activations (→0) so a fresh sign-in can activate.

**DEMO DEAD-END (the sync screen) — traced read-only:**
- **Call:** onboarding `'pulling'` screen → `runCloudInstall()` → `ether.invoke('station:install-from-cloud')` (OnboardingFlow.tsx:499–500) → main.js:3047 handler → `POST /backup/download-url`. Months-old restore-from-backup era.
- **Runtime:** license 22 has **0 backups** → `/backup/download-url` → **404** → `{ok:false,"No cloud backup found"}` → `syncPhase='error'` → "Sync failed"; Retry re-calls the same 404. Local state at dead-end: **stations=(none)**, onboarding flags=(none), session present (license 22 + jwt), songs_v2=350 (§4 bootstrap ran).
- **Bypass:** YES — the restore step dead-ends BEFORE `first_run_complete`, so the new provisioning (`reconcileAccountStations`, App.tsx:868) never materializes djdeniro (`stations=(none)` proves it). The obsolete restore step preempts steps 3–7. It also can't distinguish "404 = no backup yet (normal for a new account)" from "sync failed (error)".

**Part 1 — spec updated:** added the **CORE ARCHITECTURAL VISION** north-star to the top of `ether-v2-data-architecture-spec.md` (stations are cloud-defined; surfaces SUBSCRIBE; playout is a CLAIM not a binding; playout fully local, cloud never in the playback path; claims degrade safely offline; transfers server-mediated with human confirmation / dead-air disclosure).

---

## PLAN (Part 3 — subscription model, not built; stop for Jeff's go)

**Schema — `station_attachments` (backend, license-scoped):** `(license_key_id, surface_id, station_id, role TEXT DEFAULT 'playout' CHECK role IN ('playout','monitor'), created_at, updated_at)`. **Playout claim is EXCLUSIVE per station** (one playout surface at a time; claimable + releasable). Future rail for studio handoff + cloud playout; **only desktop-playout attachment is built now**; roles beyond playout/monitor deferred. `surface_id` MUST be a STABLE machine id across wipes (hardware-derived) — NOT the per-DB `client_id` (which regenerates on wipe) — or the persistence sentence fails. **[design item: introduce/confirm a stable surface id.]**

**Onboarding decision table (replaces the sync step entirely):**
- **0 stations** → no sync question (empty account is normal, not an error) → straight to **create-your-station** → `stations:create` → §8 seed → attach as playout → done.
- **1 station** → **attach as playout automatically + silently**, materialize by uuid, set active → done. **Zero questions (the customer sentence).**
- **≥2 stations** → **"Which stations does this machine run?"** by name, checkboxes, **min one** → write playout attachments for the chosen → materialize each + §8 seed, set first active → done.
- No "sync" jargon, no dead-end screens. **Backup/Restore moves to Settings** (out of the sign-in path).

**Sign-in reads attachments:** a known surface with existing attachments auto-gets its stations — even after a full wipe + reinstall it becomes itself again (requires the stable surface_id). A new surface on a multi-station account gets the placement question ONCE; the answer persists server-side.

**Station creation** (onboarding or later) seeds §8 per-station config in ONE transaction (5 separation_rules, metadata definitions, everything).

**Remove from onboarding:** `'pulling'` / `install-from-cloud` / `pickAudioLocation` (restore + audio-source steps). Library arrives via §4 snapshot bootstrap (already automatic).

**Acceptance tests:** (1) **customer sentence** — sign up → create station → install → sign in: your station, your name, on screen, no questions. (2) **placement sentence** — multi-station account, new machine, pick stations by name, only those appear. (3) **persistence sentence** — a machine with attachments, fully wiped + reinstalled, signs in and becomes itself again, no questions.

---

## Session 2026-07-02 (cont.) — Part 3 build APPROVED (D1/D2/D3) + Phase 1 DONE

**Decisions (Jeff):** D1 provisioning-first, D2 reuse machine_id as surface_id, D3 enforce UNIQUE playout now. D3 addendum: attach against a station whose playout is held by ANOTHER machine fails gracefully (show holder, clean message, no transfer flow yet).

**D2 honesty note:** `machine_id == client_identity.client_id` (main.js:5970) is PER-DB and regenerates on a full wipe (why 3 ids appeared across test wipes). Consequence: 1-station persistence passes regardless (count-branch asks nothing — covers dev box + go-live); MULTI-station persistence (test #3) would re-ask after a wipe until client_id is stabilized (cheapest: preserve client_id across factory-reset, reusing the install-from-cloud pattern). Flagged as a follow-up; does NOT block the dev-box finish line or 1-station go-live.

**Naming corrections (the plan uses REAL names):** backup subsystem = `electron/cloud-backup.js` (not backup-service.js); restore step = `'pulling'` state in OnboardingFlow (not CloudSyncStep); provisioning = `reconcileAccountStations` in `src/lib/ccData.ts` (not provisionStationsOnSignIn); account stations from `POST /account/connect` (not /stations/mine). Provisioning is PARTIAL (materialize-by-uuid old; step-5 adoption added-unproven; not yet attachment-aware) → rework EXTENDS it.

**PHASE 1 DONE (backend subscription model) — built, proven, deployed, verified:**
- `ether-backend/src/lib/attachments-schema.js` (`ATTACHMENTS_DDL`) + `src/routes/attachments.js` (attachSurface/detachSurface/attachmentsForSurface + router) + index.js wiring (initDB, mount `/account/attach`+`/account/detach`, `/account/connect` now returns this surface's `attachments`). ether-backend commit `5fab4e2`, deployed `99fe35c1` (Online).
- `station_attachments (license_key_id, surface_id, machine_name, station_uuid, role playout|monitor)` + partial UNIQUE `one_playout` per (license, station) = D3. Proven pg-mem 9/9 (attach, idempotent, D3 hold-by-another 409+holder, detach+reclaim, monitor non-exclusive). Prod-verified: table + 4 indexes present; `/account/connect` returns `attachments`.

**Remaining phases (in order):** Phase 2 = §8 `seedStationConfig` in `stations:create` (main.js). Phase 3 = provisioning attachment-aware (ccData `reconcileAccountStations` reads/writes attachments; App.tsx D1 provisioning-first). Phase 4 = onboarding decision table (OnboardingFlow: remove `'pulling'`/`'pickAudioLocation'`, replace `'pickStation'` with 0/1/≥2 branches writing attachments; `'addStation'` = create). Phase 5 = Backup/Restore → Settings. Then regression checklist (backup/restore from settings; plain sign-in bootstraps library; factory reset lands clean) + the 3 sentences + dev-box demo (next sign-in shows djdeniro, zero questions).

---

## Session 2026-07-02 (cont.) — MAJOR requirement: STATION LIBRARY SCOPING (launch-blocking) + build-order change

**PART 1 (spec updated):** station library scoping is launch-blocking correctness, not roadmap. Replaces the "install-scoped / shared pool" note. Stations subscribe to SLICES; a machine bootstraps ONLY the union of slices for its attached stations; `/library/snapshot` filters **server-side** (unsubscribed songs never leave the server — filtered, not delivered-but-hidden); slices seed from `source_folder` first, graduate to category/programming; **fail CLOSED** (ambiguous/missing scope → empty, never everything). Spec: new "LAUNCH-BLOCKING REQUIREMENT — Station library scoping" section + amended §2.1 songs_v2 comment + §3.1 snapshot semantics.
- **Two equally-binding acceptance tests (both must pass, one mechanism):** (1) **Portland** — 1,000-song station's machine gets those 1,000 and nothing else from other markets. (2) **OV** — machines attached to OV stations are STRUCTURALLY incapable of receiving explicit content from personal stations' slices.
- **Week-3 grants flag:** cross-account grants (personal↔OV) either don't exist or become slice-scoped — decided at jensj/OV setup, OV test as the lens.

**PART 2 (build order updated, in spec):** (1) finish read-cutover; (2) **station library scoping BEFORE the jensj cutover** (jensj bootstraps scoped); (3) week 3.

**PART 3 (deliverable, gated):** sign-in/onboarding **STATE TABLE** — every reachable state, what the user sees, ≥1 path forward; no undefined branches / generic failure screens / dead-ends. "Nothing to sync yet" is a normal state with a normal screen. The old "Sync failed" dead-end was an unenumerated state → the cure is enumeration, not error copy. Reviewed at a gate.

**PART 4 (week-4 punch-list — LOGGED, NOT BUILT):** with Backup/Restore moved to Settings, a returning user has no signpost that authored content (clocks/programming) is restorable there. Until programming/clocks are server-truth, add a one-time discoverability cue: if the account's R2 backup namespace has archives AND the local DB has no programming → "You have a cloud backup — restore from Settings?" notice.

**Gate-readiness note:** the provisioning gate (customer/placement/persistence sentences + dev-box demo) is NOT walkable yet — only Phase 1 (backend attachments) is built; Phases 2–4 (esp. the Phase 4 onboarding decision table that removes the `'pulling'`/install-from-cloud dead-end) are not. A sign-in now still hits the old "Sync failed" dead-end. The dev-box walkthrough requires Phases 2–4 first.

---

## Session 2026-07-02 (cont.) — FORMATS design extension (spec only; build order UNCHANGED)

Added "FORMATS — station DNA, portable across markets" to the spec. Formats = first-class cloud objects; a station's initial import + programming crystallizes into a reusable format (library slice, categories, eventually clocks/rules). Multi-market launch = a privileged engineer signs in and syncs a format to the first machine. **Templates (formats) vs instances (stations):** syncing a format SEEDS a new station's categories, never clones the source station's identity; each station's categories remain its living library membership after seeding. **Composes with — never replaces —** station library scoping + fail-closed bootstrap (a format that can't resolve its slice seeds EMPTY). **Deferred:** whether format updates propagate (auto / on-approval / snapshot-at-birth). No build; still awaiting go on Phases 2–4 for the provisioning gate.

---

## Session 2026-07-02 (cont.) — MONDAY 2026-07-06 = OV live day; decisions locked (flat library, slice=categories, OV pool); honest schedule call

**Verifications (asked not to assume):**
- **PART 4 — nothing in the running system reads the four folders (CONFIRMED).** `electron/`+`src/` have zero folder reads; playback is content-store-by-hash (`<musicDir>/store/<hash>.<ext>`) → R2 via `resolveByHash`; `source_folder` is a metadata column; `getMusicDir()` = the store root, not the four folders. Only `scripts/import-library-v2.js` (dev tool) scans folders. → **No physical reorg of the four folders needed; they're archival with zero runtime dependency.**
- **PART 5c — R2 same-hash across licenses is STORED TWICE (CONFIRMED).** Audio R2 keys are license-namespaced (`<license_id>/<hash>.<ext>`; resolver hands bare `<hash>.<ext>`, injected fetch adds the license prefix; publish used `22/<hash>.<ext>`). Dedup only WITHIN a license → OV's pool and djdeniro's pool are physically separate objects in R2. Answer to "dedupe or store twice": **store twice** (isolation over storage cost).

**Decisions locked (spec updated):**
- **PART 5a — slice = category membership.** A station's category/programming assignments ARE its library slice; ONE membership definition for scheduler + scoped bootstrap. Audio follows category membership strictly (fail-closed); metadata may scope wider (operator picker). source_folder may seed initial categories, then it's categories.
- **PART 4 — FLAT LIBRARY going forward.** One source folder; categories are the ONLY membership. source_folder = historical metadata, never live scope. No reorg before Monday.
- **PART 5c — OV its own pool, NO cross-account grants.** OV categories authored this week ARE its import/scoping; OV structural-isolation satisfied by account/license separation (independent of intra-account slicing).
- **PART 5b — FORMATS** (logged prior; deferred build).

**MONDAY SCHEDULE — HONEST CALL (Monday = 2026-07-06, ~4 days incl. weekend):**
- **Monday's OV go-live CAN hold.** Its critical path is Phases 2–4 (provisioning + onboarding placement question offering the 3 stations) + read-cutover (play from songs_v2/resolver) + OV library published under OV's OWN license + account separation (no grants). All feasible in 4 days — tight, with Phase 4 (onboarding rework) and read-cutover as the effort centers.
- **KEY INSIGHT — intra-account station scoping is NOT on Monday's critical path.** The Monday machine runs ALL 3 OV stations → it receives the UNION of their slices = OV's entire pool; the scoped and unscoped-within-OV results are IDENTICAL for an all-3 machine. And OV's no-explicit-content guarantee comes from account/license separation (own pool, no grants, R2 store-twice), NOT from intra-account slicing. So full station library scoping (the Portland/subset-machine case) is launch-blocking but **can ship in the days after Monday without blocking the OV go-live**; it's provable this week against OV's real categories, and if it isn't green by ~Sun it does not threaten Monday.
- **Realistic dates:** Phases 2–4 + read-cutover + OV publish → by Monday (contingent: onboarding rework + read-cutover go smoothly; account-switching bugs during the week don't eat the runway; OV categories authored by ~Fri so the OV pool can be published). Full intra-account scoping (Portland test green) → realistically Mon–Wed of the following week, not gating Monday.
- **Risks that could actually slip Monday:** read-cutover touches playback (audio-regression risk — real device test needed); Phase 4 is the biggest single piece; account-switch state bleed if found late.

**PART 2/3 — STATE TABLE is the Monday gate.** Every state this week touches gets a row + a demonstration on this box where possible (djdeniro↔OV switching, authoring-under-OV-while-holding-djdeniro-claim, 3-station placement, flaky-net sign-in, sign-in mid-deploy). jensj-only rows flagged "Monday-verified." Account switching = first-class demonstrated (no session bleed, per-account claims/attachments, clean scoped-library swap, truthful badge). Undefined this week = fixable bug; undefined Monday = failure. Produced as Phase 4 lands.

**BUILD SEQUENCE (to protect Monday):** Phases 2 → 3 → 4 (provisioning + onboarding placement — unblocks the djdeniro walkthrough AND OV authoring/switching this week) → read-cutover → intra-account scoping (prove vs OV's real categories; non-gating for Monday) → state table filled+demonstrated through the week. NOTE: the djdeniro walkthrough needs Phase 4 in — "dev up" alone still hits the old dead-end until then.

---

## Session 2026-07-02 (cont.) — Phase 2 (§8) + Phase 3 (attachment-aware provisioning) DONE + proven

**PHASE 2 (openair `a8e60b3`):** `electron/seed-station-config.js` — `seedStationConfig(db, stationId)` seeds a station's config in ONE transaction the moment it exists: 5 separation rules + 47 metadata definitions + 35 vocabulary (verbatim from migrate-v6 so a new station matches a migrated one). Idempotent per station → safe for onboarding-created AND reconcile-materialized stations. Wired into the `stations:create` handler; never blocks creation. Proven 11/11 on scratch (counts, idempotency, per-station isolation).

**PHASE 3 (attachment-aware provisioning) — checkpointed alone before Phase 4:**
- `src/lib/provisioning.js` (+ `.d.ts`) — PURE, unit-testable decisions: `selectAttachedStationsToMaterialize` (materialize ONLY stations this surface is attached to; fail-closed on no attachments; skip already-local + tombstoned) and `chooseActiveStation` (prefer attached; never change an on-air station; legacy fallback to first local).
- `src/lib/ccData.ts` `reconcileAccountStations` now reads `/account/connect.attachments`, materializes only attached stations, adopts active via the pure fn. **No App.tsx render-gate change** (reconcile already fires on the signed-in effect) — deliberately minimal touch to the sign-in routing layer where the prior two gates failed.
- **Proven 10/10 (script-level, pure):** provisioning-first (attached [A,B] of {A,B,C} → materialize A,B only, NOT C); fail-closed (no attachments → nothing, never all); no-dup (already-local → skip); tombstone (locally-deleted → no resurrection); **interrupted mid-sign-in** (connect failed → attachments [] → materialize nothing, no bad state; resume after partial is idempotent add-only); adoption (prefer attached / never switch on-air / legacy fallback).
- **Preservation re-run GREEN:** Phase 1 attachments 9/9, Phase 2 §8 11/11 — both unchanged. Factory-reset (Fix A) untouched.
- **Transition note:** with the seed gone + fail-closed, a surface with NO attachments materializes nothing (correct) — so the dev box stays station-less until Phase 4 writes an attachment via the placement answer. Phase 4 completes the walkable path. Existing installs with local stations are unaffected (add-only never removes; adoption falls back to first local).

**Next: Phase 4** — onboarding decision table (0/1/≥2 → 3-station placement question, writes attachments) removing the install-from-cloud dead-end; produces the state table. Bring dev up when the placement flow is walkable for the djdeniro walkthrough.
