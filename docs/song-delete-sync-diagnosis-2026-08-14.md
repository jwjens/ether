# Song deletion & sync — diagnosis (2026-08-14)

**Status:** DIAGNOSIS ONLY — **no code changed.** The requested fix would have changed nothing.
**Machine measured:** Jeff's dev box (`jensj`), `%LOCALAPPDATA%\Ether\com.ether.radio\openair.db`.
**Tool:** `scripts/diag-song-delete-sync.js` (read-only, portable, safe while Ether is open).

## Jeff's report, verbatim

> *"The sync is additive only – it backs up new songs but doesn't remove deleted ones. That's why
> 'Perfect Revenge' and 'Rotten to the Core' are still in R2 and OV."*

The symptom is real and recorded as given: both songs are still present where they should not be.
The **cause** below is different from the one proposed, and the proposed fix would not have moved it.

---

## What was asked for, and what is actually true

| # | Brief | Measured |
|---|---|---|
| 1 | Locate the song delete path | `electron/sync/handlers/songs.js` — `songsDelete` / `songsDeleteById` / `songsDeleteByStation`, registered as the `songs:delete*` IPCs. |
| 2 | Ensure a `delete` mutation is written | **Already written.** 32 soft-deleted songs, **32 `op='delete'` mutations**. Both named songs have one, stamped ~80 ms after their `deleted_at`. |
| 3 | Check `sync:push` filters deletes out | **It does not filter by `op` at all.** `sync-engine.js:491 _loadPendingMutations()` selects `sync_status='pending'` and filters only by `station_id` and `EXCLUDED_TABLES`. Deletes were never excluded. |
| 4 | Make `sync:pull` apply deletions | Already implemented: `merge-engine.js:243` applies the tombstone, and `electron/sync/tests/t21-t24-tombstone.test.js` covers it. |
| 5 | Backfill `DELETE` mutations for orphaned soft-deletes | **Population is 0 on this machine.** The script would be a no-op here. |

## The actual cause

```
sync_status spread : pending  473,686   (100%)
origin spread      : local    473,686   (100%)
```

**Nothing has ever been pushed, and nothing has ever been received.** Every mutation this install has
ever written — every insert, every update, and all 32 deletes — is still sitting in the queue, and
not one row has ever arrived from a peer.

So the deletes are not being dropped, filtered, or mishandled. They are queued behind 473,686 others
that have equally never moved. **This is not a deletion defect. It is that sync has never run in
either direction on this machine.** No per-`op` change can alter what a peer sees while that is true.

## A hypothesis that was tested and is FALSE

Both named songs carry `update` mutations dated **2026-08-07**, *after* their 2026-07-20 delete —
the "something wrote to deleted songs on 2026-08-07" item in the handoff. An update applied after a
delete is a classic resurrection bug, so it was worth checking.

It is not happening. All **135** post-delete updates carry `deleted_at` set to the original delete
timestamp — the delete is **preserved**, not cleared:

```
{ 'deleted_at preserved': 135 }
```

Recorded here so nobody re-opens it.

## Two things the brief conflates

**R2 audio is a separate matter.** A `songs` row delete would never remove the `.mp3` from R2 —
R2 audio is not auto-deleted by design (the delete-completeness work, 2026-07-05). Even with sync
fully working, "Perfect Revenge" would still be an object in the bucket. Removing the audio is a
different, deliberate decision about a shared account library.

**OV and ovevents are separate installs with their own databases and were NOT measured.** Everything
above describes the dev box. The orphan population there is unknown. `scripts/diag-song-delete-sync.js`
is portable and answers it in one run:

```
ELECTRON_RUN_AS_NODE=1 node_modules\.bin\electron scripts\diag-song-delete-sync.js
```

## Why no code was written

The requested change would be a no-op three times over: the mutation already exists, push already
carries it, pull already applies it, and the backfill has zero rows to backfill. Shipping it would
add code that does nothing and imply a fix that had not happened.

## What actually stands in the way — a decision, not a patch

Turning sync on is the real fix, and it is blocked on two known items that need Jeff, not code:

1. **The 473,686-mutation backlog.** Enabling sync starts draining every mutation this install has
   ever written to a live backend, at once.
2. **`sync_uuid_identity` is OFF while peer-sync routes station rows by LOCAL INTEGER id.** Two
   installs whose station ids differ will **mix stations up rather than merge them**. This must be
   settled *before* two machines ever sync — the failure mode is corruption on both sides, and it
   would be far worse than two songs that will not go away.

Item 2 is the reason this should not be "just switched on" to make the two songs disappear.

## Suggested order

1. Run the diagnostic **on OV and on ovevents** — confirm whether their delete mutations exist too,
   and whether either has ever synced. That converts "still in OV" from an inference into a reading.
2. Settle `sync_uuid_identity` / station-UUID routing (the peer-sync identity defect).
3. Decide what happens to the backlog — drain, or mark historical mutations as already-applied.
4. Only then enable sync. The 32 deletes will travel with everything else, no deletion-specific
   code required.
5. Separately, decide whether deleting a song should also remove its R2 object. Today it does not,
   by design.
