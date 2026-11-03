# H2 fix plan — scope the legacy backup routes to the authenticated license

**Date:** 2026-10-05 · **Source finding:** `docs/multitenancy-audit.md` §H2 · **Status:** PLAN ONLY. No code, schema, data or R2 change. No commits.
**Defect, as recorded:** `/backup/list` and `/backup/upload` filter on a client-supplied `station_id` instead of the caller's license.
**Backend baseline:** `ether-backend` `main` = `a01339a` (the H3 fix, deployed). Line numbers below are at that commit.

---

## 0. What exists today (receipts)

**Two backup systems live side by side:**

| System | Routes | Storage | Scoping today |
|---|---|---|---|
| **Legacy** (Postgres BYTEA, gzipped JSON of play_log etc.) | `POST /backup/upload` `index.js:6659`, `GET /backup/list` `:6696`, `GET /backup/download/:id` `:6713`, `DELETE /backup/:id` `:6727` | `backups` table (`id, station_id TEXT, license_key TEXT, filename, size_bytes, checksum, data BYTEA, …`; catalog: `backups_license_key_not_null`, `backups_station_id_not_null`) | **upload + list: by `station_id` only (H2).** download + delete: `id AND license_key` |
| **Current** (R2, whole `openair.db` gzipped) | `POST /backup/upload-url` `:4770`, `POST /backup/download-url` `:4835` | R2 `${license.id}/backups/<ts>.db.gz` + `.meta.json` | **Already correct.** The prefix comes from the server-resolved license (`:4796-4797`, `:4847`). The timestamp is regex-sanitized, so the caller can't name another prefix |

**The defect, line by line:**
- `/backup/list`: `stationId = req.query.station_id || req.license.email` and `… FROM backups WHERE station_id=$1` (`:6698-6705`). There's no license filter in either the list or the size total.
- `/backup/upload` (Studio = `plan === "pro"`): `SELECT COUNT(*) FROM backups WHERE station_id=$1`, then `DELETE FROM backups WHERE id=(SELECT id FROM backups WHERE station_id=$1 ORDER BY created_at ASC LIMIT 1)` (`:6676-6680`). The count and the rotation delete span every license's rows under that `station_id`.
- `/backup/download/:id` and `DELETE /backup/:id` are already license-scoped: `id=$1 AND license_key=$2` (`:6715`, `:6729`).

**What `station_id` actually is.** It is **not a station.**
- The desktop fills it from `station_config_kv.license_email` (`openair/src/components/CloudBackup.tsx:136`).
- It shows it as an editable text box labelled **"Station ID (your email)"** (`:494-500`).
- The server falls back to `req.license.email` (`:6670`, `:6698`).

It's a free-text label that is normally an email address.

**Read-only aggregate** (scratchpad `h2-backup-scope.js`). It ran in `BEGIN READ ONLY`, never selected the `data` column, and printed totals only. Output, verbatim:
```
backups=0
bytes=0
uploader_licenses=0
uploader_unresolvable=0
under_own_station_id=0
under_foreign_station_id=0
under_unrecognised_station_id=0
ident_shared_by_two_licenses=0
oldest=null
newest=null
station_ids_with_multiple_uploaders=0
active_licenses=8 active_without_plaintext_key=0
```
The script classifies each backup's `station_id` against the uploader's identifiers (the license email, its users' emails, its station uuids) and against every other license's.

**Answer: no stored backup sits under another license's station_id. The `backups` table is empty**, so the defect has exposed or deleted nothing, and nothing needs migrating or recovering. All 8 active licenses carry a plaintext `license_key`, which matters for the design in §1.

---

## 1. The fix (exact changes, described only)

**Principle:** the tenant boundary is the **license**, taken from the verified `x-license-key` (`requireLicense`, `index.js:1078-1087`). `station_id` stays a **label within** that license. It's never a lookup key across licenses.

**Why not "station_id must be one of the license's stations".** The brief asked to scope to stations owned by the license, so this is a deliberate deviation. Every desktop in the field sends an **email** here (`CloudBackup.tsx:136`), never a station uuid. Requiring an owned station uuid would make every existing caller fail with no security gain: once every query is scoped by license, a label can only ever name the caller's own rows. If you still want validation, the compatible form is to accept a `station_id` only if it equals the license email, one of its `users` emails, or one of its station uuids, and reject anything else with 400. That costs any user who typed free text into that box (unknown count, and none stored today). Not recommended, but it's one `EXISTS` check if you want it.

**Tenant key.** The existing `backups.license_key` (NOT NULL), matched against `req.license.license_key`. **No schema change.** All active licenses have a plaintext key today (aggregate above). A license with no plaintext key (bcrypt-only) gets an explicit refusal instead of today's accidental behaviour, which is an insert 500 on upload and silent empty matches elsewhere.

*Deliberately not built:* a `backups.license_key_id` column and backfill. That belongs with audit M6 (removing plaintext keys at rest), which would have to re-key this table anyway. The table is empty, so that migration will be trivial whenever M6 lands.

### 1a. New module `src/lib/legacy-backups.js` (same pattern as `mutation-retention.js`)
One home for all legacy-backup SQL, so routes and tests run identical statements:

```js
// listBackups(pool, licenseKey, stationId|null) -> { rows, total }
SELECT id, filename, size_bytes, checksum, created_at, description
  FROM backups
 WHERE license_key = $1 AND ($2::text IS NULL OR station_id = $2)
 ORDER BY created_at DESC
SELECT COALESCE(SUM(size_bytes),0) AS total
  FROM backups
 WHERE license_key = $1 AND ($2::text IS NULL OR station_id = $2)

// rotateStudioBackups(pool, licenseKey, stationId, keep = 30) -> deleted count
// Counts and deletes ONLY the caller's rows. Deletes as many as needed to make room for one more
// (>= keep), so a backlog left over from the old unscoped behaviour can't block the cap.
SELECT COUNT(*) FROM backups WHERE license_key = $1 AND station_id = $2
DELETE FROM backups
 WHERE license_key = $1
   AND id IN (SELECT id FROM backups
               WHERE license_key = $1 AND station_id = $2
               ORDER BY created_at ASC
               LIMIT $3)          -- $3 = count - keep + 1, only when count >= keep

// insertBackup(pool, { licenseKey, stationId, filename, sizeBytes, checksum, data, description }) -> { id, created_at }
INSERT INTO backups (station_id, license_key, filename, size_bytes, checksum, data, description)
VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, created_at          -- unchanged statement

// getBackup(pool, licenseKey, id) -> row|null        (unchanged predicate)
SELECT * FROM backups WHERE id = $1 AND license_key = $2

// deleteBackup(pool, licenseKey, id) -> boolean      (unchanged predicate)
DELETE FROM backups WHERE id = $1 AND license_key = $2 RETURNING id
```

### 1b. Route changes in `index.js`
- **A shared guard** at the top of all four handlers: `if (!req.license.license_key) return res.status(409).json({ error: "legacy_backup_unavailable", detail: "This license has no legacy backup storage; cloud backups use /backup/upload-url." })`. That turns today's insert 500 and silent no-match into an honest answer. It affects 0 active licenses today.
- **`POST /backup/upload` (`:6659-6693`):**
  - `stationId = req.body.station_id || req.license.email`. This is unchanged and is only a label now.
  - Replace the rotation block (`:6676-6681`) with `if (req.license.plan === "pro") await legacyBackups.rotateStudioBackups(pool, req.license.license_key, stationId, 30)`.
  - Replace the insert with `insertBackup(...)`, using the same statement.
- **`GET /backup/list` (`:6696-6711`):**
  - `stationId = req.query.station_id ? String(req.query.station_id) : null`.
  - Call `listBackups(pool, req.license.license_key, stationId)`. The response shape `{ backups, total_size_bytes, plan, limit }` is unchanged.
  - **Behaviour change:** with no `station_id`, it lists *all* of the caller's legacy backups, instead of filtering on the license email.
- **`GET /backup/download/:id` and `DELETE /backup/:id` (`:6713-6736`):** switch to `getBackup` / `deleteBackup`. The predicate is unchanged; only the guard is added.
- **R2 routes (`:4770`, `:4835`) and the platform account delete (`:1437`, `DELETE FROM backups WHERE license_key = $1`): no change.** They're already license-scoped.

---

## 2. Blast radius — every caller

| Caller | Version range | Calls | After the fix | Desktop change needed? |
|---|---|---|---|---|
| `CloudBackup.tsx` list, `:237` | all | `GET /backup/list?station_id=<license_email>` | Returns the caller's own rows under that label: the same rows an honest caller saw before, minus any foreign rows (none exist) | **No** |
| `CloudBackup.tsx` restore, `:292` | all | `GET /backup/download/:id` | Unchanged predicate | No |
| `CloudBackup.tsx` delete, `:341` | all | `DELETE /backup/:id` | Unchanged predicate | No |
| `CloudBackup.tsx` create, **old** | **≤ v4.4.26** (`ae18187^:CloudBackup.tsx:278-294`) | `POST /backup/upload` with `station_id = <email field>` | Stored under the caller's own `license_key`. Studio rotation now counts and evicts only the caller's rows | **No.** Old builds keep working unchanged |
| `CloudBackup.tsx` create, **current** | **≥ v4.4.27** (`ae18187`, 2026-06-27) | `cloud-backup:run-now`, R2 path (`CloudBackup.tsx:281`; `electron/cloud-backup.js:90`) | Untouched | No |
| Desktop install-from-cloud | current | `POST /backup/download-url` (`electron/main.js:6730`, `:6880`) | Untouched (already license-prefixed) | No |
| Platform account delete | — | `DELETE FROM backups WHERE license_key=$1` (`index.js:1437`) | Untouched | — |
| Other repos (dashboard, admin, health, signup, cast, listener, iris, backend `public/` and `scripts/`) | — | none (grep found no `/backup/upload\|list\|download` callers) | — | — |

**No desktop change is required.** The fix is server-side and accepts every call shape that every shipped desktop sends, so old installs in the field need nothing.

**Optional desktop follow-up, NOT part of this fix:** the legacy panel's "Station ID (your email)" box and its legacy backup list can never show anything in production (the table is empty, and no build since v4.4.27 writes to it). Retiring that UI, and later the four routes, is a cleanup for the open-question 7 / doors pass, not a security need.

**Alternative you may prefer: retire instead of scope.** The table is empty and no current desktop uploads, so deleting the four legacy routes would remove the surface entirely. The cost is old ≤ v4.4.26 installs: their manual "Backup Now" would get a 404 instead of a stored backup, and every version's legacy list would show an error instead of an empty list. I'm recommending **scope now** (what you asked for, zero field breakage) and **retire with the desktop UI cleanup later**.

---

## 3. The Studio 30-backup rotation after the fix
- **The count** is `WHERE license_key = $caller AND station_id = $label`, so only the caller's rows are counted.
- **The delete** is `WHERE license_key = $caller AND id IN (SELECT id … WHERE license_key = $caller AND station_id = $label …)`. The license filter appears in both the outer DELETE and the subquery, so the statement **cannot** match another license's row even if the subquery were ever changed.
- `$caller` is `req.license.license_key` from `requireLicense`, never from the request body. `station_id` can only narrow within the caller's rows.
- **Conclusion: after the fix the rotation can only ever delete the caller's own oldest backups.** Test R1–R3 (§4) pins this down.

Side note, not tenancy: the cap is per `(license, station_id)`, so a Studio user can sidestep the 30 limit by varying the label. Counting per license instead is a one-word change, but it's a product decision, so it's left as is.

---

## 4. Test plan — new `src/lib/legacy-backups.test.js` (node:test + pg-mem, real module SQL)
Run with `node --test src/*.test.js src/lib/*.test.js` (the full suite, currently 58).

**List**
- **L1.** Licenses A and B both store rows under `station_id = "shared@x.com"`. `listBackups(A, "shared@x.com")` returns only A's rows, and the `total` only A's bytes. *(The H2 defect today.)*
- **L2.** `listBackups(A, null)` returns all of A's rows across labels, and none of B's.
- **L3.** Old-desktop shape: A's rows under A's email, then `listBackups(A, A.email)` returns them all.

**Rotation**
- **R1.** B holds 30 rows under label X, all older than A's. A uploads under X, so A's count is A's own (< 30) and **0 rows are deleted**. B still has 30.
- **R2.** A holds 30 rows under X, B holds older rows under X. Rotation deletes exactly **A's oldest**, and B is untouched.
- **R3.** A holds 32 rows under X (a pre-fix backlog). Rotation leaves A at 29, so after the insert A has 30. B is untouched.

**Download and delete**
- **D1.** `getBackup(B, idOfA)` returns null, and `deleteBackup(B, idOfA)` returns false. A's row survives.
- **D2.** The owner's `getBackup` and `deleteBackup` succeed.

**Guard and wiring**
- **G1.** In a route-level test with a stubbed `req.license` that has a null `license_key`, every handler answers 409 `legacy_backup_unavailable`. This can be done by testing a small `requireLegacyKey` helper exported from the module.
- **W1.** A source wiring check on `index.js`: no `FROM backups WHERE station_id` remains, there is no inline `INSERT INTO backups` / `DELETE FROM backups WHERE id` outside the module, and all four routes call `legacyBackups.*`.

**pg-mem risk:** BYTEA and `IN (… LIMIT $n)` haven't been probed yet. The first step of implementation is a scratch probe, as was done for H3. If pg-mem rejects either, the fix is to keep the production SQL and adjust only the test fixture (e.g. a TEXT stand-in column for `data` in the test table), never to fork the SQL.

---

## 5. Post-deploy verification
Backend-only deploy on GO (fast-forward `main`, push; Railway auto-deploys). No desktop release.

1. **Deploy health:** Railway deployment SUCCESS for the new commit hash; `GET /health` returns 200; logs show `Schema ready` and `API live`.
2. **Read-only, unauthenticated:** `GET /backup/list` with no key returns 401 (unchanged).
3. **Read-only aggregate:** rerun `h2-backup-scope.js`. It should still show `under_foreign_station_id=0` and `station_ids_with_multiple_uploaders=0` (the table is expected to stay at 0).
4. **Functional isolation in production (a WRITE, needs its own GO):** with two throwaway paid licenses (never 21/23, never a customer):
   - each uploads a tiny valid gzipped-JSON backup under the **same** `station_id`
   - each `GET /backup/list?station_id=<that>` returns only its own row
   - cross `download/:id` and `DELETE /:id` return 404
   - then delete both throwaway licenses with the platform account-delete route, which also deletes their backups (`index.js:1437`)
   - rerun step 3: 0 rows left

   Unit tests L1–D2 already prove this in memory. Step 4 only adds a production receipt.
5. **Desktop smoke (optional, Jeff):** open Cloud Backup on a current build. The legacy list shows "no backups" exactly as before, and R2 "Backup Now" is unaffected.

**Done =** the suite is green with the new tests, steps 1–3 pass, and step 4 runs if you GO it.

---

---

## Implementation & deploy record (GO 2026-10-05)
- **Decisions per GO:** license-scoped, no stricter station_id check, routes kept.
- **Commit:** `ether-backend` `2081013`, on branch `fix/h2-backup-scope` from `origin/main` `a01339a`. It changes `src/index.js` (+27/−28) and adds `src/lib/legacy-backups.js` and `src/lib/legacy-backups.test.js`. The repo's pre-existing uncommitted scripts were left untouched and are not in the commit.
- **One change from §1a:** rotation runs as **two statements** (select the caller's oldest N ids, then `DELETE … WHERE license_key = $1 AND id IN (<those ids>)`), not a single `DELETE … IN (SELECT … LIMIT n)`.
  - Why: pg-mem re-evaluates that subquery while deleting from the same table. A scratch probe deleted 10 of 10 rows where Postgres deletes 2, and the first test run failed R2/R3 the same way (19 and 20 deleted).
  - Effect: the behaviour is the same, the license filter sits on both statements, and tests and production run identical SQL.
  - The deployed H3 prune isn't affected: its subquery selects only rows below each group's max, and the max is never deleted. Its exact-count tests pass.
- **Tests:** `node --test src/*.test.js src/lib/*.test.js` → **70 pass / 0 fail**. That's 58 existing plus 12 new: L1–L3, R1–R4, I1, D1–D2, G1, W1.
- **Deploy:**
  - `main` fast-forwarded and pushed as `a01339a..2081013`.
  - Railway deployment `366576af` (commit `2081013`) reached **SUCCESS** at 22:44 UTC, and `c5d7fd0a` was removed.
  - `GET /health` returned 200. Startup logged `[DB] Schema ready` and `[Ether] API live → port 8080`, with no errors.
  - An unauthenticated `GET /backup/list` returned 401.
- **Post-deploy aggregate** (read-only, totals only): `backups=0 … under_foreign_station_id=0 … station_ids_with_multiple_uploaders=0`, `active_licenses=8 active_without_plaintext_key=0`. That's unchanged from the pre-fix reading.
- **Not run:** the production two-license write test (§5 step 4) needs its own GO.
- **Rollback point:** `a01339a`.

**Temporary tooling:** one read-only aggregate script in the session scratchpad (`h2-backup-scope.js`), run once. Nothing is scheduled or persistent.

**Stop.** Awaiting Jeff's GO before any change.
