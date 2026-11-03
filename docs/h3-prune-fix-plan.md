# H3 fix plan — scope the daily mutation-log prune per license

**Date:** 2026-10-05 · **Source finding:** `docs/multitenancy-audit.md` §H3 · **Status:** PLAN ONLY. No code, schema or data changed. No commits.
**Defect, as recorded:** the daily mutation-log prune groups by `(table_name, row_id)` across **all licenses** (`ether-backend/src/index.js:1314-1328`, scheduled `:1378-1382`). One account's newer write can make the prune delete another account's latest history for that row.

---

## Step 1 result — has the prune already removed another account's history?

**Short answer: no damage is visible, and none is possible against today's data. The pre-August history can't be audited because it no longer exists.**

Script: scratchpad `h3-prune-damage.js`, run with `railway run --service Postgres node …`. It ran inside `BEGIN READ ONLY` with a 180s statement timeout and printed aggregates only (no row contents, no license ids, no per-account breakdown). Output, verbatim:

```
=== A0 mutation log ===
rows=214933 licenses_with_rows=1 (table,row_id)_groups=213594 oldest_received=2026-08-14T18:45:33.003Z

=== A1 cross-license (table,row_id) groups surviving today ===
  TOTAL groups=0 rows=0 licenses_involved=0

=== A2 PENDING: license-histories the NEXT prune would wipe entirely ===
  TOTAL (license,row)_pairs=0 rows=0

=== A3 checkpoint rows ===
  rows=0 licenses=0

=== B1 mirror rows (station_cc_data) vs the owning license's log ===
  table	in_own_log	in_no_log	only_other_license	strict(lic syncs that table)	licenses_strict
  announcement_schedule	4	0	0	0	0
  cart_slots	0	12	0	0	0
  categories	16	0	0	0	0
  clocks	5	0	0	0	0
  clock_slots	85	0	0	0	0
  shows	4	0	0	0	0
  spots	4	0	0	0	0
  TOTAL in_own_log=118 in_no_log=12 only_other_license=0 strict=0

=== B2 imported staged rows (clone uuid-passthrough) ===
  imported=0 in_own_log=0 same_uuid_in_another_license_log=0

=== C active library grants: 0
```

**What each line proves:**
- **A0 / A1 / A2.** The whole log currently belongs to **one license**. A cross-license collapse needs at least two licenses sharing a `(table_name,row_id)`, so the global prune is currently doing exactly what a per-license prune would. The next run will wipe nothing (A2 = 0).
- **A3.** No checkpoint rows exist, so the shared `('__checkpoint__','')` group has never been populated in today's log.
- **B1.** This is the only trace a past cross-license deletion could leave: a row a license demonstrably has in its own mirror, missing from its own log but present under another license. **0 rows.** The 12 `cart_slots` rows in no log at all are cart slots that never ride peer-sync. That's unrelated to the prune.
- **B2 / C.** The two non-malicious paths that put one row UUID under two licenses (clone uuid-passthrough, library grants) are both unused today: 0 imported clone rows, 0 active grants.

**What it cannot prove, and why.** The prune has been global since it first shipped (`f2662c6`, 2026-06-16, then `a2f46b7` the same day). Nothing older than **2026-08-14** survives in the log. That isn't the prune at work, because the prune keeps the latest row per group forever. The earlier licenses' logs were removed on purpose with the platform account-delete route: `docs/v2-progress.md:191-192` ("Deletes of 2/19 were clean … their mutations gone") and `:343` ("`mutations` table is 0 across all licenses"). That window carried one cross-license sharing setup: the 2↔19 library grant (`docs/v2-progress.md:112`). Whether the prune collapsed rows between those two licenses before they were deleted is **UNVERIFIABLE**, because deleted rows leave no trace and both accounts are gone. **No current account is affected.**

**Severity therefore changes from "may have destroyed data" to "latent: arms the moment a second license syncs, a grant is issued, or a clone is imported".** The fix should land before the first outside customer turns on sync, because exposure starts at the second syncing license.

---

## 1. The corrected prune (exact SQL)

**Rule:** keep the newest mutation per **(license_key_id, table_name, row_id)** forever. Delete superseded rows of the **same license** older than the buffer. A license's history can then only be thinned by that license's own newer writes, never by another account's. `license_key_id` is `NOT NULL` with an FK (catalog: `mutations_license_key_id_not_null`, `mutations_license_key_id_fkey`), so the equality join can't drop rows through NULLs.

### 1a. The prune (replaces `index.js:1317-1326`)

```sql
DELETE FROM mutations
 WHERE server_seq IN (
   SELECT m.server_seq
     FROM mutations m
     JOIN (SELECT license_key_id, table_name, row_id, MAX(server_seq) AS keep
             FROM mutations
            GROUP BY license_key_id, table_name, row_id) g
       ON  g.license_key_id = m.license_key_id
      AND  g.table_name     = m.table_name
      AND  g.row_id         = m.row_id
    WHERE m.server_seq  < g.keep
      AND m.received_at < $1::timestamptz)
```
`$1` = `new Date(Date.now() - bufferDays * 86400000)`, computed in JS. `bufferDays` stays at 2, and `server_seq` is the table's primary key (catalog: `mutations_pkey PRIMARY KEY (server_seq)`).

**Why this form and not a one-word edit of the current `DELETE … USING`.** The obvious minimal change is to add `license_key_id` to the GROUP BY and the join of the existing statement. That is equally correct SQL. But the repo's test database (pg-mem, `ether-backend` devDependency) **cannot parse `DELETE … USING`**, and it **rejects `int * INTERVAL`**. Both were probed in the scratchpad (`h3-pgmem-probe.js`: "Your query failed to parse"; `h3-pgmem-probe2.js`: "operator does not exist: integer * interval"). The repo rule is that the test runs the exact SQL production runs (`src/lib/link-pairing.js:66-67`). The form above passes on pg-mem with the correct result (`h3-pgmem-probe3.js`, §4).

On real Postgres the `IN (subquery)` form plans as a semi-join on the primary key. At today's ~215k rows that's comparable to the current hash join. **UNVERIFIED** until `EXPLAIN` runs in step V4.

### 1b. The dry-run count (replaces `index.js:1359-1366`; it must match 1a exactly)

```sql
SELECT COUNT(*)::bigint AS would_delete
  FROM mutations m
  JOIN (SELECT license_key_id, table_name, row_id, MAX(server_seq) AS keep
          FROM mutations
         GROUP BY license_key_id, table_name, row_id) g
    ON  g.license_key_id = m.license_key_id
   AND  g.table_name     = m.table_name
   AND  g.row_id         = m.row_id
 WHERE m.server_seq  < g.keep
   AND m.received_at < $1::timestamptz
```

### 1c. The "superseded" figure in `/api/platform/db-stats` (replaces `index.js:1345-1348`)

```sql
SELECT COUNT(*)::bigint AS total,
       (COUNT(*) - COUNT(DISTINCT (license_key_id, table_name, row_id)))::bigint AS superseded
  FROM mutations
```

### 1d. Code shape (describes the change, nothing applied)
- Move the three statements into one new module, `src/lib/mutation-retention.js`, exporting `pruneSupersededMutations(pool, bufferDays)`, `countPrunable(pool, bufferDays)` and `supersededStats(pool)`, plus the shared `cutoff(bufferDays)`. `index.js` calls them from the daily timer (`:1378-1382`), `/api/platform/prune-mutations` (`:1355-1375`) and `/api/platform/db-stats` (`:1331-1351`). This gives one definition, so the dry run can't drift from the real prune, and the module can be tested without HTTP. That mirrors how `libraryGrants.js` and `cmd-bus.js` are factored.
- Rewrite the comment at `:1307-1313`. It currently says "row_id is a UUID, so (table,row) is globally unique and this never crosses accounts". The replacement should say: retention is per license, because row ids are client-supplied and are legitimately shared across licenses by clone uuid-passthrough and grants.
- **No schema change is needed.** An index on `(license_key_id, table_name, row_id, server_seq)` would speed up the GROUP BY, but at 215k rows it isn't required and isn't proposed. Revisit if V4 shows a slow plan.
- `VACUUM` handling (`:1371-1372`) is unchanged.

**Deliberately NOT in this change:** rejecting pushes whose `row_id` exists under another license. With per-license retention, a foreign `row_id` push can only ever affect the pusher's own log (pull is already scoped by `license_key_id`, `src/routes/sync.js:213`, `:225`, `:237`), so the attack in H3 no longer has a victim.

---

## 2. Blast radius — every reader and writer of the server mutation log

| # | Caller | File:line | Reads/writes | Change? | Effect of per-license prune |
|---|---|---|---|---|---|
| 1 | Daily auto-prune | `index.js:1378-1382` | DELETE | **Yes**: calls 1a | Keeps the newest row per row **per license**. With one license (today) the result is identical to now. |
| 2 | `POST /api/platform/prune-mutations` (dry run + run) | `index.js:1355-1375` | COUNT / DELETE / VACUUM | **Yes**: 1b and 1a | The dry-run number equals what the run deletes. No caller found in the dashboard, admin or health repos, so it's platform-token, manual use only. |
| 3 | `GET /api/platform/db-stats` | `index.js:1331-1351` | COUNT | **Yes**: 1c | "superseded" now means superseded within the license. Identical today. |
| 4 | Desktop push `POST /sync/mutations` | `src/routes/sync.js:81-170` | INSERT under `req.license.id` | No | None. |
| 5 | Desktop pull `GET /sync/mutations` (uuid / legacy / install branches + grant UNION) | `sync.js:174-281` | SELECT `license_key_id = own` ∪ granted owners' songs/artists/albums | No | **Fixes** the guarantee pull depends on: a fresh device always finds its own license's latest row per row. Grantees still get each owner's latest library row, because the owner's newest row is now kept per owner. Gaps in `server_seq` were already normal and the client cursor handles them (`openair/electron/sync/sync-engine.js:261`, `:318-320`). |
| 6 | `GET /sync/pending-count` | `sync.js:302-351` | COUNT per license | No | None. |
| 7 | Cloud-first station create | `index.js:2619-2626` | INSERT (`row_id` = new station uuid) | No | None. |
| 8 | `clone-categories` / `clone-programming` / `borrowed-library` | `index.js:3291-3294`, `:3333-3336`, `:3404-3406` | `SELECT DISTINCT ON (row_id) … WHERE license_key_id = owner ORDER BY row_id, server_seq DESC` | No | These read the owner's latest row per row, which the new prune now guarantees is the owner's own. Today a grantee's newer write to a shared uuid could prune the owner's row out from under these readers. |
| 9 | Platform account delete | `index.js:1454` | `DELETE … WHERE license_key_id = $1` | No | Already license-scoped. |
| 10 | Station deletes (platform / dashboard / desktop) | `index.js:1645`, `:2651`, `:4411` | `DELETE … WHERE station_id = $1 OR (table_name='stations' AND row_id = $1)` | **No (see note)** | Unaffected by this fix. |
| 11 | Backend proof / diag scripts | `ether-backend/scripts/prove-*.js`, `diag-*.js`, `clone-ov-programming-now.js` etc. | SELECT (some seed pg-mem) | No | None of them call the prune. |
| 12 | Desktop **local** SQLite `mutations` retention (90-day `compactMutations`) | `openair/electron/sync/mutation-writer.js:738-755`; `sync-engine.js:363` | Local DELETE | No | A separate table on each install (single tenant). Untouched. |

**Adjacent, same class, NOT in this fix (your call):** the three station-delete statements in row 10 aren't scoped by license. When an account deletes its own station, they also delete **any other license's** mutations whose `station_id` equals that uuid, or whose `stations` `row_id` equals it. Station UUIDs are globally unique (`stations_uuid_key`), so the only foreign rows that can match are ones another license pushed with this station's uuid. That's junk, not a victim's history, so the risk is low. Adding `AND license_key_id = <owner>` would close it. I'm flagging it rather than folding it in.

**Out of scope (one line):** the prune doesn't distinguish legacy station-scoped rows (`station_id` set, `station_uuid` NULL) from uuid-identity rows of the same row. That's intra-license only, and unchanged by this fix.

---

## 3. Recovery plan

**Not needed.** Step 1 found no cross-license damage in any surviving data (A1 = A2 = B1-strict = B2-shared = 0), and the only window that can't be audited belonged to accounts that have since been deleted (§Step 1).

If damage were ever found after a second license starts syncing (V5 below would catch it), these are the recovery sources, in order of authority:
1. **The affected account's installs.** Every desktop keeps its own local `mutations` table for 90 days (`mutation-writer.js:738`) and the full row state in `openair.db`. Re-pushing the missing rows (the existing re-baseline / checkpoint path) rebuilds the server log from the account's own truth.
2. **The account's R2 DB backups**, at `${license.id}/backups/<ts>.db.gz` (`index.js:4817`), for an install that's gone.
3. **`station_cc_data`** for the programming tables only. It's display-grade, and it's not a source of mutations.

All of these are license-scoped, so recovery never needs another tenant's data.

---

## 4. Verification

### V1. Unit test (new `src/lib/mutation-retention.test.js`, node:test + pg-mem, same style as `src/lib/link-pairing.test.js`)
Run with `node --test src/lib/mutation-retention.test.js`. The repo has no `npm test` script and no CI workflow. These cases have already been dry-run against the candidate SQL in `h3-pgmem-probe3.js`, which returned `rowCount = 2` and the expected survivors:
1. **Cross-license, same row id, both old.** L1 and L2 each keep 1 row. *Today's SQL would leave only L2's.*
2. **Same-license supersession, both old.** 1 of 2 survives (the newest `server_seq`).
3. **Newer row inside the buffer.** The older row is deleted and the newer one kept.
4. **Two rows both inside the buffer.** Both kept.
5. **Checkpoints `('__checkpoint__','')` across two licenses.** One per license survives.
6. **`countPrunable` before = `pruneSupersededMutations` rowCount** for the same cutoff, and `supersededStats.superseded` drops by that amount.
7. **Regression guard.** Seed L2 with a newer row for L1's uuid and run the prune. L1's `SELECT DISTINCT ON (row_id) … WHERE license_key_id = L1` (the clone/borrowed reader shape) still returns its row.

### V2. Full backend suite
`node --test src/**/*.test.js` (cmd-bus, station-commands, link-pairing, slug, park-ops, station-source and the new test) must stay green.

### V3. Pre-deploy prod baseline (read-only)
- Rerun `h3-pgmem-probe3.js`. Rerun `h3-prune-damage.js` (A0–A2) and record the numbers.
- Call `POST /api/platform/prune-mutations {"dry_run":true}` on the **current** backend and record `would_delete`.

### V4. Post-deploy prod check (read-only)
1. `POST /api/platform/prune-mutations {"dry_run":true}` again. With one license in the log, **`would_delete` must equal the V3 value** (per-license grouping is identical to global grouping when there's only one license). A different number means the new SQL isn't equivalent and the deploy should roll back.
2. `GET /api/platform/db-stats`: the `superseded` figure is unchanged vs V3 for the same reason.
3. `EXPLAIN` (no `ANALYZE`, so nothing executes) of the 1b count, run from a read-only scratch script. Confirm it's a hash join on the GROUP BY with no nested-loop explosion.
4. After the next daily run, check Railway logs for `[retention] pruned N` (`index.js:1380`) and confirm N is about V3's `would_delete` plus the day's growth.

### V5. Cross-license behaviour on a disposable license (needs your GO; this is a WRITE)
Using a throwaway test license (not 21/23, and not a customer), push one `categories` `update` with a `row_id` equal to a row uuid from the existing synced license. Then take the dry-run count, and run the A1/A2 sections of `h3-prune-damage.js`. **Expected:** A1 shows 1 cross-license group, A2 shows 0 pending (per-license retention protects both), and the original license's row is still returned by its own pull. Afterwards, delete the test license with the platform account-delete route, which is license-scoped (`index.js:1454`). V1 already proves this logic in-memory. V5 only adds a receipt from production.

### Done =
V1 and V2 green, V4.1/V4.2 equal to baseline, V4.3 plan acceptable, and the first daily prune logged. Per CLAUDE.md, the runtime claim "the prune no longer crosses accounts" needs the V4/V5 receipts, not just this plan.

---

---

## Implementation record (GO 2026-10-05)

**Commit:** `ether-backend` `a01339a` on branch `fix/h3-prune-per-license` (based on `d160f2c` = `origin/main`). **LOCAL ONLY: not pushed, not deployed.**

- **Files:** `src/index.js` (+20/−41), new `src/lib/mutation-retention.js`, new `src/lib/mutation-retention.test.js`. Pre-existing uncommitted script changes in that repo were left untouched and are not in the commit.
- **Station-delete scoping (approved adjacent item):** platform `DELETE /api/platform/stations/:uuid` (owning license read from `stations.license_key_id`), dashboard `DELETE /api/account/stations/:uuid` (`req.auth.lk`), and desktop `POST /account/delete-station` (`license.id`) now call `deleteStationMutations(db, licenseId, uuid)`.
- **Tests:** `node --test src/*.test.js src/lib/*.test.js` → **58 pass / 0 fail**. That's 45 existing tests plus 13 new ones: the 7 planned cases, 4 station-delete scoping cases, a source wiring check, and a cutoff test.

### V3 pre-deploy baseline (recorded 2026-10-05 22:19–22:20 UTC)
| Source | would_delete (buffer 2d) | total | superseded |
|---|---|---|---|
| **Deployed** `POST /api/platform/prune-mutations {dry_run:true}` + `GET /api/platform/db-stats` | **239** | **214,937** | **1,343** |
| Direct SQL, current global grouping (read-only) | 239 | 214,937 | 1,343 |
| Direct SQL, new per-license grouping (read-only) | 239 | 214,937 | 1,343 |

**For V4 after deploy:** the numbers drift as new mutations arrive and old ones age past the buffer, so don't compare against the figures above. Compare the **deployed dry run against the direct global-SQL count taken at the same moment.** With one license in the log, the two must be equal. Script: scratchpad `h3-baseline.js`. Raw output: scratchpad `h3-baseline-out.txt`.

### H5 exposure count (read-only, totals only, 2026-10-05)
`active_licenses=8 no_linked_user=0 exposed_email_unclaimed=0 exposed_with_active_seats=0 exposed_active_seats_total=0 exposed_published_link_keys=0`. **No active license is exposed today.** Every active license's email already has a `users` row, so it can't be claimed by signup. H5 stays latent: any future license issued without a web login (Stripe key-only, platform-minted) becomes exposed. Script: scratchpad `h5-exposure.js`.

### Deployed 2026-10-05 (GO for push/deploy)
- **Merge:** `main` was fast-forwarded to `a01339a` (`--ff-only`) and pushed as `d160f2c..a01339a`, one commit. The repo's other uncommitted scripts were not included.
- **Railway:** deployment `c5d7fd0a` built commit `a01339ab07c9…`. It started 22:30:56 UTC and was **SUCCESS** at about 22:31:29 UTC. The previous deployment, `6badb8d8`, was removed. `GET /health` returned 200 (`{"ok":true,…,"version":"1.5.2"}`). The deploy logs show `[DB] Schema ready` and `[Ether] API live → port 8080`, with no errors.
- **V4 paired check** (scratchpad `h3-postdeploy.js`): the deployed endpoints and the direct SQL were fired concurrently, with the direct query pinned to the same cutoff instant and run as one REPEATABLE READ snapshot. Two pairs, verbatim:
  ```
  pair 1 @ 2026-10-05T22:31:54.086Z — DEPLOYED would_delete=243 total=214937 superseded=1343 | DIRECT global=243 per_license=243 total=214937 superseded global=1343 per_license=1343 | licenses_in_log=1 rows_since_baseline=0 | MATCH would_delete YES, superseded YES, total YES
  pair 2 @ 2026-10-05T22:31:58.009Z — identical, all MATCH YES
  ```
  **The deployed per-license dry run equals the old global SQL. No rollback.**
- **Versus the V3 baseline** (239 / 1,343 / 214,937): total and superseded are unchanged, and **no rows arrived** between readings (the newest row was received at 22:18:57Z, before the baseline). `would_delete` rose by **+4**, which is entirely explained by the 2-day cutoff advancing about 12 minutes. A read-only count of superseded rows received between the two cutoffs (2026-10-03 22:19:48.834Z to 22:31:54.086Z) returned exactly **4** (scratchpad `h3-window.js`).
- **Note:** the daily prune is a `setInterval(24h)` from process start, so the restart reset it. The first automatic per-license prune runs about 24h after 22:31 UTC on 2026-10-05; check for `[retention] pruned N` in the logs then (V4.4). V4.3 (EXPLAIN) and V5 (throwaway-license test) are **not run**, and V5 needs its own GO.

**Temporary tooling:** four read-only diagnostics in the session scratchpad: `h3-prune-damage.js`, and the in-memory probes `h3-pgmem-probe.js`, `h3-pgmem-probe2.js` and `h3-pgmem-probe3.js`. Each ran once. Nothing is scheduled or persistent, so there's nothing to log in `docs/backlog.md` and nothing to tear down.

**Stop.** Awaiting Jeff's GO before any code change.
