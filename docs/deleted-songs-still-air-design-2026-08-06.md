# A delete is a delete — foundation-up (2026-08-06)

**Status: BUILT locally, 2026-08-06 — AWAITING JEFF'S RUNTIME VERIFICATION (§14). Not committed.**
All four §11 decisions approved by Jeff (C, preserve history, all 215, verify-first). The safety check
on the risky sync line passed before any code was written.
**This supersedes the filtering-patch design of earlier today, which Jeff rejected.** That design would
have added `deleted_at IS NULL` to 9 query sites. It is not being built. The receipts below show it
would also not have been enough on its own — and, more importantly, that the *cascade* Jeff asked for
**already exists and is already defeated**.

Sibling to `docs/generate-clock-law-deleted-slots-2026-07-21.md` (the same law at the *slot* level).
Version at time of writing: 4.4.150, branch `log-reader-flip`.

---

## (0) Jeff's ruling — verbatim

> "NO filtering-patch approach. A delete should be a delete from the foundation up. He does not want
> `deleted_at IS NULL` sprinkled across a dozen queries as bandages — miss one and it airs again, which
> is exactly how this happened."
>
> "The song and its schedule entries go together. Nothing downstream needs to 'filter deleted' because
> nothing deleted is left to encounter."

## (1) The operator report — verbatim

> "the Library shows '529 tracks · 0 shown' and 'No music yet' when searching 'rotten' — but 'Rotten to
> the Core' is scheduled and in the queue right now. A scheduled song isn't appearing in library search."

> "This is why Jeff's deletes don't stick: deleted songs leave the library but keep airing."

The operator deleted a song and it kept playing for sixteen days. That is the defect. Everything below
adds diagnosis; none of it replaces the report.

---

## (2) What the delete path does TODAY — cascade already exists

`songsDelete` (`electron/sync/handlers/songs.js:109-136`) **already cascades**, shipped 2026-07-13 in
commit `58aa880`, with this comment:

```js
// Clean cascade (2026-07-11): a deleted song must leave NO residual the scheduler can grab as a
// ghost. Purge its generated_schedule rows, play_log history, and station_programming entries.
try { db.prepare(`DELETE FROM generated_schedule WHERE song_id = ?`).run(existing.id); } catch {}
try { if (existing.file_path) db.prepare(`DELETE FROM play_log WHERE file_path = ?`).run(existing.file_path); } catch {}
try { db.prepare(`DELETE FROM station_programming WHERE song_id = ?`).run(existing.id); } catch {}
```

The same block is in `songsDeleteByStation` (`:191-221`). It runs inside `withMutation`, so it is
atomic with the tombstone. **Design item #1 of the redesign brief is already built.**

## (3) Why it didn't hold — the decisive receipt

Every phantom row was created **after** its song was deleted:

```
pending phantom rows, created BEFORE the delete (cascade missed them):     0
pending phantom rows, created AFTER  the delete (RE-CREATED by Generate): 215
all states, created after the delete:                                     812
```

Per song — `Rotten to the Core` deleted `2026-07-20T20:32:31Z`, its surviving pending rows created
`2026-07-20T21:14:54Z → 2026-08-05T20:07:36Z`. Same shape for all twelve.

**The cascade ran, purged correctly, and Generate re-created the rows on the next run — repeatedly, for
weeks.** A point-in-time purge cannot beat a selector that re-picks the song every generation. Running
the cascade again over the existing 215 (brief item #2) clears them for exactly one Generate cycle.

> **Consequence for the brief:** cascade-on-delete is necessary and already present; it is **not
> sufficient**, and it is not what's missing. What's missing is that the deleted song is still
> *selectable*.

## (4) The cascade has the same "miss one" problem as filters

The reason to reject sprinkled filters — *an enumerated list a human must keep complete* — applies
equally to an enumerated cascade list. The current list is already incomplete. Every table carrying a
song reference:

| table.column | rows → deleted songs | cascaded today |
|---|---|---|
| `generated_schedule.song_id` | 879 | ✅ |
| `station_programming.song_id` | 0 | ✅ |
| `play_log.file_path` | 363 | ✅ (and it shouldn't — §5) |
| `pinned_songs.song_id` | 0 | ❌ |
| `clock_slots.song_id` | 0 | ❌ |
| `scheduled_log.song_id` | 0 | ❌ |
| `scheduler_reasons.song_id` | 0 | ❌ |
| `song_metadata_values.song_id` | 0 | ❌ |
| `categories.overlay_song_id` | 0 | ❌ |

Six uncascaded reference sites. All read 0 today — no live damage — but a pinned song or a clock-slot
pinned `song_id` is exactly the next "it aired again." **Filter-everywhere and cascade-everywhere are
the same class of fix: correctness maintained by hand.** Only a *structural* change removes the class.

## (5) The cascade also destroys history — it touches too much

Two hard deletes in that block go too far:

1. **`DELETE FROM generated_schedule WHERE song_id = ?` has no `state` filter** — it removes `played`
   and `missed` rows too. That is the record of what actually aired, deleted along with the future.
2. **`DELETE FROM play_log WHERE file_path = ?` erases airplay history.** `play_log` is the evidence
   base for the advertiser affidavit (a record stations produce for paying clients) and the input to
   separation/LRP. Songs 6, 11 and 22 now have **0** `play_log` rows — their airplay history is gone.
   The 363 rows still pointing at deleted songs exist only because those songs *kept airing after
   deletion* and re-created their own history.

Both are **hard** deletes inside a **soft**-delete handler, and neither emits a mutation — so peers
keep their copies and the installs diverge. Deleting a song should retract its future, never rewrite
the past.

## (6) Is soft-delete the right foundation? — No. The architecture already says so.

**Jeff's instinct is the ratified direction, not a new one.** `docs/ether-v2-data-architecture-spec.md`
§1 already decided this on 2026-07-02:

> **D3 — Delete means removed from the snapshot.** A delete removes the row from backend state and
> emits a tombstone that exists only long enough for online clients to hear about it… **No immortal
> tombstones, no LWW resurrection.**

and §7.1 names this exact bug class as one v2 structurally eliminates:

> the old bug classes — **schedule rows referencing tombstoned songs**, never-seeded `separation_rules`,
> ghost/duplicate library — cannot appear

**But the live v0 protocol blocks a hard local delete today.** `docs/sync-protocol-v0.md` §20 is the
current source of truth and it is explicit:

- `[N-109]` "Ether uses soft-deletes throughout… **No row in a synced table is physically removed in
  normal operation.**"
- `[N-110]` "Application code that reads synced tables **MUST filter `WHERE deleted_at IS NULL`**;
  tombstone propagation is transparent to the UI."
- `[N-112]` re-insert after tombstone clears `deleted_at` via `INSERT OR REPLACE`.

And the resurrection is not theoretical — it is in the merge engine. `merge-engine.js:227` applies a
remote delete as `UPDATE … SET deleted_at`, and the *update* path above it (`changes === 0` →
`INSERT OR REPLACE`, `[N-107]`) means **a physically-absent row is re-inserted by the next peer
mutation carrying its uuid.** Hard-delete locally and the song comes back on the next sync.

Two things follow, and they must both be said:

- **Soft-delete is the source of this defect.** The tombstone row is the ghost; it stays selectable,
  and every layer is expected to remember to look away.
- **`[N-110]` mandates precisely the convention Jeff just rejected** — "every reader MUST filter." The
  protocol asks for discipline across 254 read sites. That discipline failed at 9 of them, silently,
  for weeks. Jeff is right about the foundation; the protocol is what has to give, and D3 already says
  it will.

Per ARCHITECTURE BEFORE CODE this conflict is surfaced, not built over: **we cannot hard-delete under
v0 sync, and we should not keep filtering. The available move is to make deleted rows structurally
unreachable while the tombstone survives for sync.**

## (7) The options, on receipts

| | approach | verdict |
|---|---|---|
| **A** | Hard-delete the songs row locally | **Rejected.** Violates `[N-109]`; resurrects via `[N-107]`/`merge-engine.js:227`. |
| **B** | Cascade + `deleted_at IS NULL` at every reader | **Rejected by Jeff**, and receipts agree: 9 missed readers, 6 missed cascade targets. Correctness by hand. |
| **C** | **Physical/logical split — `songs_all` table + `songs` VIEW** | **Recommended.** |
| **D** | Graveyard table — move the row to `songs_deleted` on delete | Most literal "delete is a delete"; heavier sync risk (§7.2). |

### 7.1 Option C — the view split (recommended)

```sql
ALTER TABLE songs RENAME TO songs_all;
CREATE VIEW songs AS SELECT * FROM songs_all WHERE deleted_at IS NULL;
```

- **Every one of the 254 existing `FROM songs` / `JOIN songs` sites becomes correct with zero edits** —
  including the 4 selection sites and the 5 resolution joins from the rejected design, and every query
  anyone writes in the future. There is no list to keep complete. This is "nothing deleted is left to
  encounter," implemented where it cannot be forgotten.
- **The tombstone survives** in `songs_all`, so `[N-109]`–`[N-112]` and the merge engine keep working
  unchanged. No protocol change, no resurrection risk, no divergence.
- **The work is the 25 write sites + 3 FTS triggers**, which must target `songs_all` (SQLite views are
  not writable). That is a bounded, greppable, verifiable list — unlike the read side.

**Blast-radius pass — RESULTS (2026-08-06, run on a throwaway copy; live DB never opened).**
Every line below is an executed statement, not a prediction.

*The guarantee holds, with zero query edits:*

| check | result |
|---|---|
| `SELECT COUNT(*) FROM songs` | **529** (was 543) — deleted rows invisible to all 254 readers |
| `stmtCandidates` shape asked for deleted song 342 | **0 rows** — Generate cannot pick it |
| reader shape (`loggen.js:199`) on phantom row 190155 | **`file_path = null`** → skipped by the *existing* `.filter(r => r.file_path)` |
| any pending row that still resolves a deleted song to audio | **0** |
| `CREATE TABLE IF NOT EXISTS songs` (runs every boot) | **no-op — no shadow table**; view + `songs_all` intact, 529 rows still visible |
| `ALTER TABLE songs_all ADD COLUMN` | **view exposes the new column automatically** (`SELECT *` re-resolves) — future `alterSafe` columns need no view rebuild |

*Breakage found — the exact work list:*

| statement | SQLite says | site(s) |
|---|---|---|
| `UPDATE songs SET …` | `cannot modify songs because it is a view` | `merge-engine.js:215/231`, **`main.js:1152` (NOT try-wrapped → startup crash)**, `main.js:7345/7393/7596`, handlers |
| `INSERT OR REPLACE INTO songs` | `cannot modify songs because it is a view` | `merge-engine.js:204/221`, `site-replication.js:185` |
| `DELETE FROM songs` | `cannot modify songs because it is a view` | handlers |
| `ALTER TABLE songs ADD COLUMN` | `Cannot add a column to a view` | `runMigrations` `alterSafe` ×8 (silently swallowed today — columns would never land) |
| `CREATE TRIGGER … AFTER INSERT ON songs` | `cannot create AFTER trigger on view: songs` | the 3 `songs_fts` triggers (`main.js:1350-1380`) |
| `SELECT … ORDER BY rowid` | `no such column: rowid` | **`handlers/songs.js:33` (`songsList`)** — a *read* casualty |
| `SELECT rowid AS id FROM songs` | `no such column: rowid` | **`src/audio/imagingCommit.ts:48`** — a *read* casualty |

*Verified working when repointed:* the 3 FTS triggers on `songs_all`, including the soft-delete
trigger — `songs_fts` went **462 → 461** on an `UPDATE OF deleted_at`, i.e. it still fires.

*New decision the pass surfaced (§11.5):* `merge-engine.js:243` `_resolveLocalId` and
`sync-engine.js:479` `_uuidStmt` resolve id↔uuid by dynamic table name. Through the **view** they would
be blind to deleted songs, so a preserved `played` history row referencing a deleted song would
serialize its reference as null. **Recommend pointing identity resolution at `songs_all`** — product
reads use the view; identity must never be blinded by deletion.

**Original checklist (now answered by the pass above):**
1. `REGISTRY['songs'].tableName` drives the merge engine's `UPDATE ${table_name}` — it must point at
   `songs_all` **while the wire `table_name` stays `'songs'`**, or peers diverge. This is the single
   highest-risk line in the change.
2. The 3 `songs_fts` triggers (`main.js:1363-1397`) are external-content FTS triggers on `songs` — they
   must move to `songs_all`, and the FTS rebuild path checked.
3. Any dynamic/generic SQL that builds table names from the registry or from `PRAGMA table_info`.
4. `INSERT OR REPLACE INTO songs` in the merge apply path — fails against a view.
5. Backup/restore, R2 library sync, station-delete, and the importer's `SELECT *`/write paths.
6. Schema migration under the standing ALTER pattern + `verify:schema` gate.

### 7.2 Option D — graveyard table

Delete = `INSERT INTO songs_deleted SELECT * FROM songs WHERE id=?` + `DELETE FROM songs` + cascade, in
one transaction. Literally satisfies "the row leaves the table." Costs more: the merge engine's delete
*and* update paths must both consult the graveyard (or `[N-107]` re-inserts the song into `songs` on the
next peer update), and `[N-112]` re-insert becomes a move-back. It changes sync behavior; C does not.
Available if Jeff prefers the row physically gone from `songs`.

## (8) The recommended design

1. **Foundation — Option C.** `songs_all` + `songs` view. Deleted songs become unreachable by
   construction for all 254 readers. No filters added anywhere.
2. **Keep the cascade, and correct it** (§9): it should retract *future air and programming
   references*, and must stop deleting *history*.
3. **Complete the cascade list** — the six uncascaded reference tables from §4, in the same transaction.
4. **One-time cleanup** of the 215 existing phantom rows (they exist regardless of the foundation):
   soft-delete via the guarded, survey-first script pattern of
   `scripts/fix-phantom-operator-log-row.js`. With C in place they cannot re-appear.
5. **The sense (BUILD THE SENSE, NOT THE SCAFFOLD):** deletes emit a health event carrying what was
   retracted (`n` pending rows, `n` programming references). A delete that silently retracts 24 log
   rows should be visible in the Health Monitor, in v1.

## (9) The delete contract — what a complete delete touches

| | today | should be |
|---|---|---|
| `songs` row | soft-delete (tombstone) | unchanged — tombstone stays, sync depends on it |
| visibility to readers | by convention (`[N-110]`) | **by construction** (view) |
| `generated_schedule` **pending** | hard DELETE | **retracted** (soft-delete, so the log keeps its shape) |
| `generated_schedule` **played/missed** | hard DELETE ❌ | **preserved** — what aired, aired |
| `play_log` | hard DELETE ❌ | **preserved** — affidavit evidence, separation input |
| `station_programming` | hard DELETE | retracted (correct) |
| `pinned_songs`, `clock_slots.song_id`, `categories.overlay_song_id`, `song_metadata_values`, `scheduled_log`, `scheduler_reasons` | untouched ❌ | retracted with the song |
| audio file / R2 object | untouched | untouched (unchanged policy) |

**One sentence:** a delete retracts the song's *future* — everywhere, atomically — and never edits its
*past*.

## (10) Defects #2 and #3 — unchanged, still sequenced after this

**#2 — 29 songs unreachable in the Library panel.** `App.tsx:5007` loads `ORDER BY s.title LIMIT 500`
against a header `COUNT(*)` of 529 (`App.tsx:5009`); search filters client-side over the loaded 500
(`App.tsx:5130`). Wolves ×2, Wonderful Christmastime, Wonderwall - Remastered, Wrapped Up for
Christmas, Wrapped up in Joy, You And I - deadmau5 Remix, You Make It Feel Like Christmas, You Make My
Dreams (Come True), You Should Be Dancing, You're A Mean One Mr. Grinch, Zombie, Zombie - 2025
Remastered, 12× audiocoffee-halloween-impact, one bare UUID (id 493), no tears left to cry ×2, test
track. Fix: paginate or remove the limit — the count and the list must come from one universe.

**#3 — zero search results renders the empty-library state.** `App.tsx:5558` shows "No music yet /
Import a folder" whenever `filtered.length === 0`, so *no matches* is indistinguishable from *no
library*. It is what made a correct search look like a failed load. Fix: a distinct
"No matches for '<term>'" state.

## (11) Open decisions — Jeff

1. **Option C (view split) or Option D (graveyard)?** Recommend **C** — same guarantee, no sync-protocol
   risk, and it fixes 254 read sites without editing them.
2. **History preservation (§9):** confirm the cascade should stop deleting `play_log` and
   `played`/`missed` log rows. Recommend **yes** — deleting a song should not erase the affidavit.
3. **Scope of the one-time cleanup:** all 215 pending, or only the 101 future-dated? Recommend **all
   215**.
4. **Do the blast-radius verification in §7.1 first, as its own read-only pass, before any code?**
   Recommend **yes** — item 1 (the registry `tableName`) can diverge two installs if it is wrong, and
   that is worse than the bug being fixed.

## (12) Verification plan

- **Runtime receipt required** (the only valid test): after install + full close/reopen, delete a song
  → it disappears from the library **and** from the queue/calendar, and never returns after a Generate.
  A DB query is not proof.
- On a **copy**: apply the migration, run Generate for a full day, assert **zero** rows referencing any
  `deleted_at IS NOT NULL` song. Re-run twice — the previous fix passed once and failed on re-generation.
- Sync regression on a copy: T-21…T-24 (tombstone tests, `sync-protocol-v0.md` §E) must stay green with
  the view in place.
- Cleanup script prints before (215) / after (0) with a PASS assertion.
- `node --check`; `npx tsc --noEmit` zero new errors (baseline: 2 — OnboardingFlow, PhoneDesk);
  leak-guard baseline **14**; `verify:schema` gate for the migration.

## (13) Files this touches (when approved)

- **Migration** — `songs` → `songs_all` + `songs` view; `songs_fts` triggers repointed.
- `electron/sync/synced-tables.js` — `REGISTRY.songs.tableName` → `songs_all`, wire name unchanged.
- `electron/sync/handlers/songs.js` — writes to `songs_all`; corrected + completed cascade in
  `songsDelete` / `songsDeleteByStation`; health event.
- `electron/sync/merge-engine.js` — apply path writes `songs_all` (verify `INSERT OR REPLACE`).
- `electron/main.js` — importer/FTS write paths; **no filter edits** (the view does it).
- `electron/library-health.js` + `src/components/HealthMonitor.tsx` — the retraction sense.
- `scripts/` — one-shot guarded phantom cleanup (survey / `--apply`).
- `src/App.tsx` — #2 and #3, separate builds after #1 is verified.
- **Not touched:** the 4 selection sites and 5 resolution joins from the rejected design.

---

## (14) BUILD RECORD — 2026-08-06

### Safety check ran BEFORE any code (Jeff's gate)
Simulated the merge-engine apply path and identity resolution against the split schema on a throwaway
copy. **All passed:** remote insert/update apply; **T-21** delete tombstones (row invisible via the
view, tombstone physically retained); **T-24** delete of an absent row is a no-op; **T-23/[N-112]**
re-insert after tombstone clears `deleted_at` and the row returns; **[N-107]** update-of-unknown-uuid
still reports `changes = 0` so the engine's INSERT fallback is unchanged. Identity resolution proved the
§11.5 point empirically: through the **view** a deleted song resolves to **null**; through `songs_all`
it resolves to **342**. Product reads use the view, identity resolution does not.

### What was built
1. **Migration** (`main.js` `runMigrations`, idempotent, only converts while `songs` is a real table):
   drops the 3 FTS triggers → `ALTER TABLE songs RENAME TO songs_all` → `CREATE VIEW songs AS SELECT *
   FROM songs_all WHERE deleted_at IS NULL`; logs live-vs-tombstoned counts. FTS triggers recreated on
   `songs_all`; the 11 `alterSafe` ALTERs and the boot `daypart_mask` UPDATE repointed to `songs_all`
   (that UPDATE was **not** try-wrapped — it would have been a startup crash).
2. **Wire vs physical name.** `REGISTRY.songs.tableName` → `'songs_all'`; the registry **key** stays
   `'songs'` (the wire name on every mutation — changing it would diverge peers). `merge-engine`
   resolves through a new `_physical()` on every apply; `deserializePayload` deliberately keeps the wire
   name. `site-replication` gained `writeName` (reads still go through the view, so replication can
   never ship a deleted song).
3. **Identity resolution** (`merge-engine._resolveLocalId`, `sync-engine._uuidStmt`) → physical table,
   per §11.5.
4. **`EXCLUDED_TABLES` fixed** (`sync-engine.js:23`): it is matched against `mutations.table_name`, the
   wire name, but was built from `e.tableName`. Identical for every table until today — a latent trap
   the moment a physical name diverges. Now built from registry keys.
5. **The delete contract** (`retractSongReferences`, `handlers/songs.js`) — retracts `pending` log rows,
   `station_programming`, `pinned_songs`, `song_metadata_values`, un-aired `scheduled_log`, and
   `scheduler_reasons`; **nulls** `clock_slots.song_id` and `categories.overlay_song_id` (structures
   outlive the song). **Preserves** `play_log`, `played`/`missed` rows, and **`playing`** — audio on air
   right now is never yanked. Used by both `songsDelete` and `songsDeleteByStation`.
6. **The sense** — `library-health.noteEvent` bridge + a `song-retracted` health event and console line
   carrying per-table counts, so a delete that retracts 24 log rows is never silent again.
7. **Read casualties fixed** (views have no rowid): `handlers/songs.js` `ORDER BY rowid` → `id`,
   `src/audio/imagingCommit.ts`, and **`src/components/ImportDialog.tsx` ×2** — the last two were not in
   the original blast-radius list and would have been runtime errors, not compile errors.
8. **`scripts/retract-deleted-song-phantoms.js`** — survey-by-default, `--apply` guarded, works before
   or after the migration, prints before/after plus what it preserved, and self-verifies.

### Proof on a throwaway copy (live DB never opened)
```
1. MIGRATION            library shows 529 of 543 (14 tombstoned, unreachable)
2. RETRACT PHANTOMS     before 215 → retracted 215 → after 0
                        aired history preserved 664 === 664 · play_log 363 untouched
3. DELETE A SONG        [1] "...Baby One More Time" — 18 pending, 53 aired, 33 play_log
                        gone from library · gone from FTS index · gone from airable log
                        aired history preserved (53) · play_log preserved (33)
4. REGENERATE TWICE     run #1: 79 rows placed, 0 from deleted songs
                        run #2: 79 rows placed, 0 from deleted songs
                        the deleted song did NOT come back
5. THE READER           0 pending rows can resolve a deleted song to a playable path
```
Run #2 is the step that matters: the previous fix passed once and failed on re-generation.

### Gates
- `node --check` on all 8 edited JS files: OK.
- `npx tsc --noEmit`: **zero new errors** (accepted baseline: 2 — OnboardingFlow, PhoneDesk).
- Not committed, not versioned, no installer built — Jeff's runtime receipt gates all of that.

### Jeff's verification (the real gate)
Delete a song → it is gone from the library **and** the queue **and** the calendar, and it **stays**
gone after a Generate. Regenerate twice.

### Known follow-up (not touched — out of scope)
`scripts/migrate-cart-id-phase-sync-20.js` and `migrate-content-class-phase-sync-29.js` do
`CREATE INDEX … ON songs(…)`. They are standalone one-shots, **not** run at boot, so they are not in
any live path — but re-running one against a migrated DB would fail ("views may not be indexed"). They
want `songs_all` if they are ever run again.

---

## (15) OUTCOME — 2026-08-06, live

**Installed 4.4.151, migration ran, app started normally (no view crash).** Live DB confirmed:
`songs` = VIEW, `songs_all` = TABLE, 511 live of 543.

**Live cleanup applied** (Ether + daemon confirmed not running, backup
`openair.db.bak-prephantomretract-20260806_070908` taken first):

```
BEFORE: 200 airable rows belonging to deleted songs      ← 200, not 215; see below
rows retracted: 200
AFTER:  0
[PASS] every phantom retracted   [PASS] count matches survey   [PASS] aired history preserved (1866 === 1866)
post-write: integrity_check ok · foreign_key_check 0 problems · play_log 36,859 rows intact
```

**Why 200 and not 215:** between the first measurement (Aug 5, 18:27) and the fix landing, **13 more
phantom rows actually aired** and 2 were missed. Deleted songs kept going to air right up until 4.4.151
was installed.

**The delete contract, verified on Jeff's real library.** He deleted 18 songs at 06:27–06:30 local
(Anthem, Arabian Nights, Banana Boat, Be Prepared, Black Magic, the Halloween set…). Every one:
`pending = 0` (future retracted immediately), `history = 27..98` rows preserved, `play_log = 12..48`
preserved.

**The regenerate test PASSED.** A Generate ran at 07:15:31 local producing zero deleted-song rows;
rows created for any deleted song since the cleanup: **0**; airable rows whose song is deleted: **0**.

**A false alarm followed, and it was caused by a wrong statement of mine** — "Rotten to the Core" appeared
at 04:10 AM in the calendar and looked like a re-creation. It was a `state='played'` history row from an
airing that happened ~2 hours before 4.4.151 existed. Full receipts and the two defects it exposed:
`docs/generate-freeze-and-calendar-history-2026-08-06.md` §0.
