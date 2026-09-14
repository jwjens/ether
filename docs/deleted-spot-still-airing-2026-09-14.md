# A deleted spot keeps airing — diagnosis, 2026-09-14

**Report (verbatim, Jeff, OV):** "I deleted all the old spots. The Spots panel reads 0 rows but
shows 1 sponsor, and the Opportunity Village spot I deleted is STILL BEING SCHEDULED and airing."

**Verdict: question 3.** The delete works. The generator froze a *copy* of the spot into the log
before the delete, nothing retracts that copy, and the log plays the copy — never re-checking the
spots table. Songs got a retraction cascade built for exactly this failure in August. Spots never
got one.

---

## 1. What "delete a spot" actually does

`electron/sync/handlers/spots.js:132-154` — `spotsDelete()`:

    withMutation(db, { table_name: 'spots', row_id: uuid, op: 'delete', ... }, () => {
      db.prepare(`UPDATE spots SET deleted_at = ?, updated_at = ? WHERE uuid = ?`).run(now, now, uuid);
    });

Soft delete, journalled. The panel's trash button is `src/components/Spots.tsx:355` →
`spots:delete-by-id` (`spots.js:213`) → `spotsDeleteById` (`spots.js:167`) → the same `spotsDelete`.

**The UI does not check the result** — `await (window as any).ether.spots.deleteById(id); load();`
— so a throw would be swallowed, the same class of silence as the spot imports. It is *not* the
cause here (the `load()` immediately after would have put the row back on screen), but it is the
same defect and it should be fixed in the same pass.

## 2. Is the OV row actually flagged?

Cannot be answered from this machine — it needs OV's database. **UNVERIFIED.** What *is* settled is
that the flag and the symptom are not in conflict: the generator's only two reads of the spots
table, `electron/generate-core.js:33` (`SPOT_SELECT`) and `:42` (`SPOT_SELECT_BY_CATEGORY`), both
carry `deleted_at IS NULL AND is_active = 1`. A flagged spot cannot be picked by any *future*
Generate. It can still air, because of §3.

Two queries settle it on OV — see §5.

## 3. Already-generated rows — THE CAUSE

The generator writes a **frozen snapshot**, not a reference. `generate-core.js:333` and `:422`:

    generatedRows.push({ scheduled_at: cur, song_id: null,
                         title: sp.title, artist: sp.advertiser || '',
                         file_key: sp.file_path ? path.basename(sp.file_path) : '',
                         file_path: sp.file_path, duration_s: durationS,
                         category_id: null, clock_id: show.clock_id, content_class: 'SPOT' });

- `song_id` is NULL and **there is no `spot_id` column** — `grep -rn "spot_id" electron/` (excluding
  `spot_category_id`) returns nothing. The log row has no back-reference to the spot it came from.
- Playout reads that row and plays `file_path` directly: `src/audio/loggen.ts:591-608` resolves
  `file_path` (or `file_key` from R2) and queues it. **It never consults the spots table.**
- Nothing retracts the row. Songs do have this: `electron/sync/handlers/songs.js:226-265`
  `retractSongReferences()` soft-deletes `generated_schedule WHERE song_id = ? AND state='pending'`,
  built by `docs/deleted-songs-still-air-design-2026-08-06.md` for this exact failure.
  `grep -c generated_schedule electron/sync/handlers/spots.js` = **0**.

So: delete flags the row → future Generates correctly skip it → the log already on disk keeps
airing it, from the frozen path, until those rows age out.

A future cascade cannot copy the song one verbatim: with no `spot_id`, matching has to be on
`content_class='SPOT' AND file_path = ?` (and only `state='pending'` — aired history and the row
on air now stay, per the §9 delete contract).

## 4. Does the delete cross to the other machine?

- **The spots row: yes.** `spotsDelete` goes through `withMutation`, so the delete is journalled and
  the merge engine tombstones the row on the peer.
- **The schedule: no, and it never will.** `generated_schedule` is excluded from sync —
  `electron/sync/synced-tables.js:454-461`, RULING A: the backend has refused the table since
  2026-06-16. Each machine generates its own log.

That is why OVEVENTS is correct and OV is not: OVEVENTS regenerated after the change. OV's log was
generated before the delete and has been airing the snapshot since. (Separately, per Jeff: the new
GC spot has not yet reached OV at all — that is the row-sync half, a different question.)

## 5. What clears it on OV right now, with no build

**Generate for today on OV**, and for any day already generated. `electron/main.js:9013` deletes
non-operator-owned rows from `effStart` — the next top of hour — to the end of day, so it drops the
stale spot rows without touching anything already aired or anything hand-placed.

**It will not clear the current hour.** `effStart` is the next top of hour by design (Generate never
rewrites the past). If the spot is placed in this hour, it can still air once more; removing that
one means deleting the row from the log grid by hand.

Queries that produce the receipt on OV:

    SELECT id, uuid, title, advertiser, is_active, deleted_at FROM spots WHERE station_id = <n>;

    SELECT COUNT(*) n,
           datetime(MIN(scheduled_at),'unixepoch','localtime') first,
           datetime(MAX(scheduled_at),'unixepoch','localtime') last
      FROM generated_schedule
     WHERE content_class = 'SPOT' AND state = 'pending' AND deleted_at IS NULL
       AND file_path = '<the deleted spot''s file_path>';

## 6. The fix, when approved (not built)

1. `retractSpotReferences()` in `spots.js`, called from `spotsDelete`, matching the song contract:
   soft-delete `generated_schedule` rows with `content_class='SPOT'`, `state='pending'`, matching
   `file_path`, for that station. Aired history and `state='playing'` preserved.
2. Same on **deactivate** (`is_active = 0`), not only delete — an inactive spot is just as much an
   advertiser problem as a deleted one.
3. Check the delete result in `Spots.tsx:355` and name the failure.
4. Counts returned from the handler so the delete is observable, exactly as the song cascade does.

---

# The sweep: what else freezes a copy into the log with no back-reference

Jeff, 2026-09-14: *"Songs have a cascade, spots didn't. Sweepers, announcements, carts — check every
one and tell me which can keep airing after I delete them."*

Every writer into `generated_schedule` (`grep -rn "INSERT INTO generated_schedule"` plus the five
`generatedRows.push` sites in `generate-core.js` and the one in `_placeJingles`):

| Content | Reaches the log? | Back-reference | Stops airing when deleted? |
|---|---|---|---|
| **Songs (music)** | yes — `generate-core.js:319` | `song_id` | **YES** |
| **Pinned songs** | yes — `generate-core.js:404` | `song_id` | **YES** |
| **Sweepers (SWP)** | yes — `_placeJingles`, `main.js:8816` | `song_id: pick.id` | **YES** |
| **Spots** | yes — `generate-core.js:333, :423` | **none** | **WAS NO — fixed here** |
| **Voice tracks** | yes — `main.js:8624` | **none** | **NO — still open** |
| Announcements | no | n/a | yes, live-resolved |
| Cart slots | no | n/a | yes, live-fired |
| Published episodes | no | n/a | n/a |
| Daemon hand-load rows | yes, MUSIC only | `song_id` | yes, as songs |

## Why songs and sweepers are safe, and it is not only the cascade

Two mechanisms, and both matter — anyone "simplifying" either will reopen this.

1. **The cascade.** `retractSongReferences` soft-deletes `generated_schedule WHERE song_id = ? AND
   state='pending'`. Sweepers are covered by it *because a sweeper is a `songs` row* (content_class
   `SWP`) and the Sweepers panel has no delete of its own — cuts are deleted from the Library, which
   is `songsDelete`. The placement row carries `song_id: pick.id`, the sweeper's own id, so the
   existing `WHERE song_id = ?` finds it.
2. **The data, which is what covers the INBOUND path.** `merge-engine.js` calls only `neuterSong` on
   an arriving delete, never the cascade. That is survivable *only* because a music/sweeper log row
   carries **no `file_path`** — `generate-core.js:319` and `main.js:8816` write `file_key` and not
   `file_path` — so the air-time resolver `COALESCE(gs.file_path, s.file_path)`
   (`src/audio/loggen.ts:544`) falls through to the song row, which `neuterSong` has just set to
   NULL. The reader's `.filter(r => r.file_path)` then drops it. Songs are stopped by data.

**Spots and voice tracks break that second mechanism** by writing their own `file_path` into the log
row. `COALESCE` takes the frozen path and never reaches the source table, so neutering can never
reach them and only an explicit retraction works — on **both** machines, since the log does not sync.
That is why the spot fix is wired into `merge-engine.js` as well as the handler.

## Announcements and carts — why they were never exposed

- **Announcements** never enter the log. They are resolved live at fire time by uuid
  (`main.js:4844`), and `UpNext.tsx:124` lists only `is_active = 1 AND deleted_at IS NULL`. Delete
  one and it stops immediately.
- **Cart slots** never enter the log either — a cart is fired by the operator pressing a key. The
  daemon's hand-load writer (`audiod/engine.js:1529`) *explicitly refuses* to log anything that is
  not MUSIC, and logs the refusal: *"imaging/commercial never enters the airable music log"*.
- **Published episodes** appear in no schedule path at all.

## Voice tracks — the one still open

`schedule:insertVoiceTrack` (`electron/main.js:8609-8629`) inserts a row with `song_id NULL` and the
voice track's `file_path` copied in. There is no `voice_track_id` column. `voiceTracksDelete`
(`handlers/voice_tracks.js:119`) sets `deleted_at` and nothing else —
`grep -c generated_schedule electron/sync/handlers/voice_tracks.js` = **0**.

It is reachable: `VoiceTracker.tsx:767` inserts, `VoiceTracker.tsx:796` deletes (and, like the spot
panel did, throws the result away).

**A deleted voice track keeps airing, exactly as the spot did.** It is lower-stakes than an
advertiser spot — a jock break, not a paid commercial — which is the only reason it is reported here
rather than fixed in the same commit. The fix is the identical shape and would take one pass. NOT
BUILT, awaiting Jeff's go-ahead.
