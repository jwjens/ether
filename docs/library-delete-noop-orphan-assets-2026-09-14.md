# "Delete it anywhere and it returns" — the spot that cannot be deleted

**Reports (verbatim, Jeff, 2026-09-14, OVEVENTS on 4.6.32):**
> "The Opportunity Village spot I deleted on OV synced BACK to OVEVENTS and won't stay deleted.
> Delete it anywhere and it returns."
> "I click delete on the Opportunity Village spot and nothing happens — no error, no message, the
> row stays."
> "the old spot im trying to delete is visible in the library but not in the spots window"

**Verdict: this is NOT a sync defect.** Nothing is being resurrected and nothing is being pushed
back. The row never left, because the Delete button on that row has never been able to delete it.
Two independent defects stacked into one symptom.

---

## Defect 1 — the Library's Delete is a no-op on asset-sourced rows

The Library grid is fed from **two sources**. `App.tsx:5171-5196` adds rows that come from
`library_asset` (spots, announcements — anything with no `songs` row) and stamps them:

    id: -Math.abs(a.id),            // negative, synthetic, to keep React keys unique
    source: "library_asset" as const,

`App.tsx:4802` exists precisely to tell the two apart:

    const isSongRow = (row) => row.source !== "library_asset";

and the comment above it is explicit about why — *"the song machinery: `ether.songs.*` writers,
categories, rotation eligibility and the cue editor all key off a row in `songs`, and a
library_asset-sourced row has no such row to write."*

**`isSongRow` guards the edit paths and not one of the three delete paths.** All three call
`ether.songs.deleteById` with the negative synthetic id:

| line | door | guard | result checked |
|---|---|---|---|
| `App.tsx:5294` | Delete *N* (bulk, selected rows) | none | no |
| `App.tsx:5673` | right-click → Delete | none | no |
| `App.tsx:6121` | the ✕ on the row | none | no |

`songsDeleteById` (`handlers/songs.js`) does `SELECT * FROM songs WHERE id = ?`. A negative id
matches nothing, so it throws `[songs] row not found by id: -5`, the IPC handler turns that into
`{ ok: false, error }` — **and all three call sites discard the result and call `load()`**.

So the click produces: no delete, no error, no message, and the row still there on reload. That is
Jeff's second report, exactly.

It also explains why 4.6.32 said nothing. 4.6.32 added the result check to the **Spots panel's**
delete (`Spots.tsx:355`). Jeff was not clicking that button — he was clicking Delete in the
**Library**, which is a different component and was never touched.

## Defect 2 — why the row is in the Library at all: nobody un-mirrors on delete

**`mirrorAssetDelete` has ZERO callers.** It is defined at `asset-mirror.js:86` and exported at
`:174`, and `grep -rn "mirrorAssetDelete" electron/ scripts/` returns only those two lines.

`handlers/spots.js:13` imports only `{ mirrorAsset }`, and calls it only on create (`:90`).

So a **local** spot delete tombstones the `spots` row and leaves the `library_asset` mirror alive
forever. (The INBOUND path is fine — `mirrorAssetInboundDelete` was added to `merge-engine.js` on
2026-09-14 and does tombstone it. The local path is the one with the hole.)

The two panels then disagree, correctly, about a database that is itself inconsistent:

| surface | join | sees a deleted spot? |
|---|---|---|
| Spots panel (`Spots.tsx:87`) | `library_asset la **JOIN** spots s ON s.uuid = la.uuid` + `s.deleted_at IS NULL` | **no** — inner join drops it |
| Library (`App.tsx:5174-5177`) | `library_asset la **LEFT JOIN** spots sp …` | **yes** — left join tolerates the missing row |

Hence "visible in the library but not in the spots window". Both are behaving as written.

`library_asset` **is** a synced table (`synced-tables.js:32`), so the orphaned asset row replicates
to the other machine and persists on both — which is what made this look like a delete that syncs
back.

## Answers to the three sync questions

1. **Does a delete journal `op='delete'`?** Yes. `spotsDelete` (`handlers/spots.js`) wraps the
   tombstone in `withMutation({ op: 'delete' })`, and `'delete'` is a valid op per `[N-10]`. The
   push query (`sync-engine.js:524-552`) filters only on `sync_status='pending'`, station scope and
   `EXCLUDED_TABLES` — **there is no filter on `op`**, so deletes push like anything else.
   *Whether it actually landed on OVEVENTS is a runtime fact this tree cannot answer* — run
   `scripts/diag-spot-delete-history.js` (below) for that.
2. **Does merge-engine handle an inbound `op='delete'`?** Yes — `merge-engine.js:339-384` is a real
   `else if (op === 'delete')` branch that tombstones by uuid, then neuters songs, un-mirrors the
   asset and retracts spot/voice-track airings. It is **not** insert/update-only. The raw
   `INSERT OR REPLACE` applies only to the insert/update branch.
3. **What stops B pushing the row back alive?** Two things, and both are actually present:
   - **LWW** (`merge-engine.js:162-173`): the incoming mutation's HLC is compared against the latest
     *local* mutation for that `table_name` + `row_id`, across **both** origins
     (`_stmtLatest`, `:75-77`). Lower or tied → `'loser'`, not applied.
   - **`deleted_at` is a synced column** for spots (`synced-tables.js:1019`, `'scalar'`), so it
     travels inside `payload_after`. An update to a tombstoned row carries the tombstone with it,
     and `INSERT OR REPLACE` writes it back. The tombstone is not silently dropped.

   So the resurrection mechanism Jeff reasonably suspected **is not there**. Nothing was resurrected;
   the asset row simply never died.

## The one runtime fact still unproven

Everything above is what the source says. Whether OV's delete mutation actually reached OVEVENTS —
and which mutation is currently winning LWW for that uuid — needs OVEVENTS' database.
`scripts/diag-spot-delete-history.js` prints every mutation for the row, **both origins, in HLC
order**, plus the live row, its mirror, the orphan count and what is still pending in the log. It
opens the database read-only and takes no write lock, so it is safe with Ether open and on air.

## The fix, when approved (NOT BUILT)

1. **Call `mirrorAssetDelete` from every local delete that has a mirror** — `spotsDelete` first, and
   structurally at the handler layer so no table has to remember, matching the create side. This is
   the same "structural, not per-table" ruling Jeff gave for the create path on 2026-09-12.
2. **Guard the Library's three delete doors with `isSongRow`**, and route asset-sourced rows to a
   delete that can actually act on them rather than one that cannot.
3. **Check the result at all three** — the same silence, in a third place.
4. **A one-off repair for the orphans already in both databases** (dry run first, numbers before it
   writes), since fixing the code does not retire rows that are already stranded.

---

# Built 2026-09-14 — and what a Library delete now DOES

## Jeff's question

> "what a Library delete should DO on a spot row. Delete the spot, or refuse and point me at the
> Spots panel? I'd rather it work than refuse, but say if that's wrong."

**It should delete, and the instinct is right — it follows from a ruling already made.**

2026-09-12: *"One library. Import once, then assign where it plays… THE LIBRARY is the only import
door and the only place he says what a file IS."* A place where you say what a file **is** is the
place you can say it is **nothing**. Refusing and pointing at the Spots panel would make the Library
the only import door but not the only delete door, which is the split the ruling exists to remove —
and it would be a second silent-ish dead end in the exact spot that just cost a day.

There is also a plain operational argument: an **orphan has no other door**. The Spots panel cannot
show a row whose `spots` record is gone (it INNER JOINs). If the Library refuses too, the strays are
unreachable from anywhere in the app and only a script can clear them.

## The part that is NOT free, and is the real design content

**A Library delete must never delete the `library_asset` row on its own.** Doing that produces the
mirror-image orphan — a live `spots` row with no asset — which is precisely the defect that made the
Spots panel read 0 while a spot was on air on 2026-09-12. One orphan class traded for another.

So `library:delete-asset` (`electron/main.js`, beside `installAll`) **resolves the owner and calls
that table's real delete handler**:

    for (const { table } of audioBearingTables())      // the registry IS the list
      if (a live row with this uuid exists in `table`)
        -> songsDelete / spotsDelete / announcementsDelete

which is what runs the whole contract — the tombstone, the mutation that carries it to the other
machine, the un-mirror, and the retraction of pending airings. The Library's Delete is therefore a
**routing** decision, not a delete of its own, and it can never invent a half-state.

When no owner is found the asset is a genuine orphan and tombstoning it **is** the whole delete.
That is what lets an operator clear today's strays by hand rather than waiting on the repair script.

## What was built

1. **`App.tsx` — one `deleteLibraryRow(row)`, used by all three doors** (bulk `:5294`, right-click
   `:5673`, the row ✕ `:6121`). It branches on `isSongRow` — the guard that already existed for the
   edit paths and had never been applied to delete — and **checks the result on every path**. A
   failure now names the row and the reason instead of re-rendering as if it had worked. The bulk
   delete counts successes and failures separately, because a half-completed bulk delete used to
   look identical to a complete one.

2. **`mutation-writer.js` — `_unmirrorOnDelete`, structural.** Every journalled local delete passes
   through `withMutation`, so the un-mirror is hooked there and **no handler remembers it**;
   `spots.js` does not mention `mirrorAssetDelete` at all, and the smoke asserts that it doesn't. A
   table that gains an `assetType` tomorrow is covered the day it gains it. Inbound deletes are
   covered separately by `merge-engine.js` (`mirrorAssetInboundDelete`), because pulled rows never
   reach `withMutation`. No recursion: `library_asset` has no `assetType`, so the nested
   `assetDelete` mutation is a no-op on the second pass.

3. **`scripts/repair-orphan-assets.js` — dry run by default.** Read-only unless `--write`, so the
   dry run is safe with Ether open and on air. Orphan definition comes from the registry, not a
   hand-kept list. It writes through `assetDelete`, **not** a raw UPDATE, so each tombstone is
   journalled and the peer retires its copy too — run it once, on one machine.

## The receipts

`npm run test:asset-unmirror` — 7 checks, including "spots.js never mentions mirrorAssetDelete" and
"a table the registry does not mark is untouched", which is what makes it a test of the *structural*
claim rather than of one handler.

The fixture builds `library_asset` **from the registry**. Hand-copying the DDL meant chasing v50,
then v56's `post_ms`, then v57 — and each miss read as "the mirror is broken" when only the fixture
was stale.

Repair script, against a fixture with known orphans (OV's 2026-09-11 snapshot reports 0 — it
predates both the backfill and the deletes, so it proves nothing):

    live library_asset rows : 5
    orphaned                : 3     SPOT 2, SWEEPER 1
    DRY RUN — nothing was written. 3 row(s) would be tombstoned.

    WROTE: 3 asset row(s) tombstoned, 0 failed.
    orphans remaining: 0

    u-done   SPOT     Already Retired        TOMBSTONED   (was already; not double-counted)
    u-ghost  SPOT     Ghost Spot             TOMBSTONED
    u-live   SPOT     GC Sponsorship         live         <- healthy, untouched
    u-orph   SPOT     Opportunity Village    TOMBSTONED
    u-song   SONG     A Song                 live         <- healthy, untouched
    u-swp    SWEEPER  monster growl 01       TOMBSTONED

    delete mutations journalled on library_asset: 3

Re-running the dry run afterwards reports 0 — idempotent.

## Still not done

The **file on disk is never deleted** by any of this; only the library entry is retired. The repair
script reports how many orphans still have audio present so that is visible rather than assumed.
Reclaiming those bytes is the deletion-sweep arc (Phase 3 of the file_key work), which is not to be
started without asking.
