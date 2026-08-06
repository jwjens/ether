# Migration safety — a customer machine went down, and the software must fix itself

**Date:** 2026-08-06 · **Status: DESIGN OF RECORD — build follows this doc.**
**Priority: customer machine down.** Every fix here ships **in the software** and runs **on launch**.
No scripts, no manual steps, no operator intervention. Users cannot close Ether, run a script, or
verify a copy — the software must handle this by itself, for every user.

---

## 0. What the customer sees

```
Ether — Database Error
Ether could not open its database and has to close.
C:\Users\projector\AppData\Local\Ether\com.ether.radio\openair.db
Cannot add a column to a view
```

A dead end with one button: **Quit**.

## 1. The kill path (receipts)

1. **4.4.151 migrated their database.** `songs` was renamed to `songs_all` and `songs` became a VIEW of
   the live rows (`electron/main.js` runMigrations). Irreversible from the app's side.
2. **The build they actually run is 4.4.135.** CI has published nothing since 2026-08-04; every
   4.4.151–4.4.156 artifact exists only as a local installer. Auto-update keeps customers on 4.4.135.
3. **4.4.135 runs `runMigrationChain(db)` at boot** (`main.js:1414` in that tag), which scans
   `scripts/migrate-*-phase-sync-N.js` and executes them. Several contain **raw, unguarded**
   `db.prepare('ALTER TABLE songs ADD COLUMN …').run()` — e.g. `migrate-cart-id-phase-sync-20.js:26`,
   `migrate-content-class-phase-sync-29.js:27`, `migrate-jingle-categories-phase-sync-30.js:59`.
4. On a migrated DB, `songs` is a view → SQLite: **"Cannot add a column to a view"** → the exception
   escapes `initDb()` → the fatal dialog → Quit.

The 11 `alterSafe(...)` ALTERs in `runMigrations` are try/caught and survive. **The migration chain is
not.** That asymmetry is what turned a schema difference into a dead machine.

## 2. The three failures, and the rule each one breaks

| # | failure | rule it breaks |
|---|---|---|
| 1 | The delete-foundation migration strands older builds | A migration that reaches customers must leave the DB **openable by the previous build** |
| 2 | An unhandled schema state is a fatal dead end | The boot path must **never** dead-end a user who cannot intervene |
| 3 | Customers auto-update to 4.4.135 while their DB may be 4.4.151+ | The build a customer is **entitled to** and the schema on their disk must be **reconciled**, not assumed |

---

## 3. Fix 1 — a schema shape that cannot strand anyone

**The mistake:** the zero-edit trick required the name `songs` to *be* the filtered view. That is
precisely what makes the DB unreadable to any build that expects `songs` to be a table. Elegance for us,
a brick for the customer.

**The new shape — `songs` stays a TABLE, deleted rows leave it.**

- `songs` — the physical table, holding **live rows only**. Old builds open it and see exactly what they
  expect: a table of songs. Nothing strands.
- `songs_deleted` — a graveyard table with the identical column set. A delete **moves** the row here in
  one transaction; a sync re-insert ([N-112]) moves it back.
- Deleted songs are unreachable to every selector **because they are not in the table** — the same
  guarantee the view gave, with no filter to remember and no rename.

This is option D from `docs/deleted-songs-still-air-design-2026-08-06.md` §7.2, which I passed over for
sync risk. Customer safety outranks that trade, and the sync work is bounded (§3.1).

### 3.1 Sync handling (the reason D was deferred — now in scope)
- `merge-engine` delete apply → move the row to `songs_deleted` instead of stamping `deleted_at` in place.
- The update path's `changes === 0 → INSERT OR REPLACE` fallback (`[N-107]`) must **check the graveyard
  first**, or a peer update would resurrect a deleted song into `songs`.
- `[N-112]` re-insert after tombstone → move back from the graveyard, clearing `deleted_at`.
- Identity resolution (id↔uuid) reads **both** tables, so preserved history rows keep their references.

### 3.2 Repair-on-boot (this is what un-bricks the customer)
On launch, the app inspects the actual schema and repairs it — silently, automatically, no prompt:

| state found | action |
|---|---|
| `songs` is a TABLE, no `songs_deleted` | create `songs_deleted`; move any `deleted_at IS NOT NULL` rows into it |
| `songs` is a **VIEW** + `songs_all` TABLE (a 4.4.151–4.4.156 DB) | **repair**: drop the view, rename `songs_all` → `songs`, move tombstoned rows to `songs_deleted`, repoint the FTS triggers. DB is back to a shape every build can open |
| anything else unrecognised | do not migrate; §4 |

The repair is idempotent, runs inside one transaction, and is verified on a copy before it ships.

## 4. Fix 2 — the boot path must never dead-end

`initDb()`'s catch currently renders one message and a **Quit** button for *every* failure. That is the
wrong shape for a user who cannot intervene. Replace with **classify, then act**:

1. **Repairable schema drift** (§3.2) → repair silently and continue booting. The user sees nothing.
2. **Schema NEWER than this build understands** (a real downgrade) → **refuse to migrate, do not
   crash.** A clear screen: *"This station's data was created by a newer version of Ether. Update to
   continue."* with an **Update Ether** button that runs the updater, and a **Contact support** link.
   The database is left untouched — refusing is safe, crashing is not.
3. **Genuinely unopenable** (corrupt file, missing folder, locked by another process) → keep the
   existing message, but add **Retry**, **Open data folder**, and **Contact support** — never a
   single-button dead end.

**Invariant:** no boot-path exception may reach the user as a bare error with only Quit.

## 5. Fix 3 — reconcile entitlement with schema

- **Stamp compatibility in the DB.** A `min_app_version` marker written by any migration that changes
  shape. On boot, a build older than the marker takes §4 case 2 (clear refusal) instead of crashing.
- **The two-phase rule — this is the durable protection.** A migration that older builds cannot read is
  only allowed to ship **after** every customer is on a build that understands the marker. Phase 1 ships
  the guard (harmless, backward compatible). Phase 2 ships the shape change. Never both at once.
- **Publish what customers are entitled to.** CI must actually publish; a fleet sitting on 4.4.135 while
  development runs 21 versions ahead is how a local-only build reached a customer's data. Releases are
  the contract — if CI does not publish, no schema change may ship.
- **Guard, in CI:** a check that fails the build if a migration is not backward compatible without a
  `min_app_version` bump — the same shape as the station-isolation guard that caught the global static.

## 6. What this does NOT do

- It does **not** ask the operator to run anything. No scripts on customer machines, ever.
- It does **not** touch `netgeak` (lic 21) or `cristianmalliani` (lic 23) data or accounts.
- It does **not** keep the view. The view shape is abandoned because it cannot be made safe for builds
  already in the field.

## 7. Recovery for the machine that is down right now

The installed build (4.4.135) crashes before the updater can run, so no software on that machine can
heal it. The only path is a build that contains §3.2 repair-on-boot. Therefore:

1. Ship the repair build.
2. The customer **installs it like any normal update** — download, double-click. No scripts, no data
   surgery, no operator steps.
3. On first launch it repairs the schema automatically and the station comes back with its data intact.

Their data is safe throughout: every row, including tombstones, is present in `songs_all` on their disk.

## 8. Order of work

1. **Repair-on-boot + never-dead-end boot path** (§3.2, §4) — this is what un-bricks the customer.
2. **`songs_deleted` shape + sync handling** (§3, §3.1) — restores the delete guarantee safely.
3. **`min_app_version` marker + CI guard + two-phase rule** (§5) — makes recurrence structurally
   impossible.
4. Publish through CI so entitlement and schema line up again.

Verification is on a **copy of a real migrated database** before any of it ships, and the packaged
artifact is smoke-tested, exactly as the previous builds were.
