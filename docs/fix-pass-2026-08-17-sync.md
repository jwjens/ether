# Fix pass — sync, 2026-08-17

**Hand this to a fresh session. It is self-contained.**

Three fixes were applied against `docs/sync-systems-map.md`. Two are complete and verified, one is
complete with a stated deviation. **Nothing was runtime-tested and the test suite was not re-run
after the last edit** — the shell session died mid-verification. Read "What to do first" before
touching anything.

Branch `log-reader-flip`, HEAD at the time `e190a63` (4.4.224). **No version bump.**

Related: `docs/sync-systems-map.md` (the systems map) · `docs/freeze-inventory-2026-08-17.md` (the
state that motivated this).

---

## What to do first

1. **`npm run test:sync`.** Last successful run was 41 passed / 1 failed. The failing test was then
   withdrawn, which *should* leave 41/41 — unconfirmed. Do not trust the fixes until this is green.
2. **Delete `electron/sync/tests/zz-probe.test.js`.** Scratch file from a diagnosis. It is neutered
   to `it.skip` so it cannot fail, but it tests nothing and should not be in the tree.
3. **Restart Ether.** It was closed for the database purge and has not been run since. The 41
   mutations that were pending at shutdown are still pending.

---

## 1. The `license_key` loop — no-op writes no longer journal

**Problem.** `stampLicenseEverywhere` re-stamped `license_key` on every station every 20 s from
`App.tsx:993`'s `syncCloud` interval. `station_config_kv` is a synced table, so each write journalled
a CRDT mutation that every peer replays forever. Measured: **2,312 `license_key` mutations, 2,312 of
them with `payload_before.value == payload_after.value`** — 17,280 no-op mutations per machine per
day.

**Fix, two layers.**

`electron/sync/handlers/station_config_kv.js` — the authoritative chokepoint, so every caller is
covered, not just this one:

```js
const _sameValue = (a, b) =>
  (a === b) || (a != null && b != null && String(a) === String(b));

// in stationConfigKvUpsertByKey, after the !existing insert branch:
if (_sameValue(existing.value, value) && existing.deleted_at == null) {
  return stationConfigKvGet(db, existing.uuid);
}
```

`deleted_at` is part of the comparison on purpose — resurrecting a tombstoned row is a real change
and must still journal.

`src/lib/ccData.ts` — read-before-write in `stampLicenseEverywhere`, so the hot path does not even
spend the IPC round trip. Note line 342 already guarded `owner_license_key`; only the
`station_config_kv` write was unguarded.

**Tests.** `electron/sync/tests/t39-t41-noop-guard.test.js`, plus a `station_config_kv` DDL added to
`electron/sync/tests/helpers/create-test-db.js`.

| Test | Asserts | Status |
|---|---|---|
| T-39 | 20 identical writes → 1 mutation, `updated_at` unchanged | passed |
| T-40 | a real change journals exactly one, correct before/after | passed |
| T-41 | same value on a tombstoned row resurrects and journals | passed |
| T-42 | `5` then `'5'` is not a change | **withdrawn — see below** |

### OPEN: T-42, the numeric-coercion arm

Writing the number `5` then the string `'5'` journalled a second mutation — the guard did not fire.
The cause was never established. The test was withdrawn rather than left red or left passing on a
wrong premise; the repro is recorded in a comment at the bottom of the test file.

This does **not** affect the license loop: every real caller (`stampLicenseEverywhere`,
`seed-station-config`, the UI) writes strings, which T-39 covers. It does mean the `String(a) ===
String(b)` arm of `_sameValue` is unproven. To reproduce, write `5` then `'5'` through
`stationConfigKvUpsertByKey` and print `typeof(value)` from the stored row.

---

## 2. Re-key ghost config rows — purged

**Problem.** Sync's apply path re-keyed this install's stations to the sender's integer ids, leaving
`station_config_kv` rows whose `station_id` matches no row in `stations`. Those ghosts are older than
the live rows, and the pre-4.4.224 readers used `WHERE key = ? LIMIT 1` — lowest rowid — so a ghost
`sync_enabled='true'` on a deleted station beat the active station's real value.

**Tool.** `scripts/purge-rekey-ghost-config.js` — dry-run by default, `--write` to commit, `--db` to
target a copy. Scoped to `station_config_kv` **only**; refuses if a ghost id is also a live id.
Deletes with direct SQL and **journals nothing** (a ghost `station_id` is meaningless on any peer, so
a delete mutation would carry nonsense outward).

**Receipt.**

```
station_config_kv rows: 106 -> 27   (deleted 79)
mutations journalled:   2479 -> 2479   (unchanged)
ghost station_ids remaining: (none)
station 1 "Open Format": 10   station 2 "halloVeen": 11
station 3 "Magical Forest": 3  station 4 "Christmas in Jully": 3
OK — ghosts 0, live config intact, no mutations written.
```

**Snapshot of every deleted row (72 KB):**
`%LOCALAPPDATA%\Ether\profiles\ETH-STN-BAA8-E056-6FC8\rekey-ghost-config-2026-08-17T23-20-15-112Z.json`

### Consequence to be aware of

The 79 rows were not just stale flags. They held the **real per-station configuration**:
`theme_custom_vars`, `station_logo`, `eq_master`, `proc_target_lufs`, `audio_output_device`,
`canvas_layout`, `schedule_layout_v1`, `overlay_fallback_category_id`, `designated_generator`.

The live stations hold 10/11/3/3 rows and those are almost entirely license/account keys. **Magical
Forest and Christmas in July now have no theme, no output device and no layout.** This is recoverable
from the snapshot by `station_uuid` — the JSON records the uuid for ghost ids 5, 6 and 7; id 8
("Christmas in Jully") has no uuid stamped and must be matched by `station_name`.

### Still orphaned — NOT touched by this pass

Only `station_config_kv` was purged. Every other child table is still pointing at the dead ids and
still holds the station's actual programming and history:

```
generated_schedule   5:23554  6:47117  7:27615  8:39592     (0 rows on stations 1-4)
play_log             5:6234   6:19829  7:10912  8:11124
clocks · categories · shows · clock_slots · separation_rules · station_programming · spots
```

The active station is 2 (halloVeen); halloVeen's 47,117 schedule rows are under id **6**. The station
is on air with an empty log. Old → new mapping, from `station_uuid` and `station_name`:
**5→1 Open Format, 6→2 halloVeen, 7→3 Magical Forest, 8→4 Christmas in Jully.**

`scripts/repair-station-rekey.js` (from 4.4.220) is the tool for re-pointing them. **Do not run it
until the re-key is prevented, or it is a treadmill** — see the recurrence path below.

### The recurrence path is still open

`merge-engine.js:219-227` preserves the local integer id across `INSERT OR REPLACE` — but only when
`this._uuidIdentity` is true. `_uuidIdentity` is set once at engine construction (`main.js:3023`) and
is not re-read on toggle. 4.4.224 fixed the *read* to be scoped to the active station; it did not
remove the gate. **Any inbound `stations` mutation from a peer whose engine has the flag off re-keys
this machine again.** OV's flag was `false`.

---

## 3. Prefetch no longer materializes into another machine's path

**Problem.** `library-health.js` selected `COALESCE(g.file_path, s.file_path)` and handed it to
`fs.mkdirSync`. `songs.file_path` is typed `blob-ref`, and blob-ref in v0 ships the literal absolute
path (`mutation-writer.js:489`), so a peer's path lands verbatim in this database. Result: 2,443
logged failures between 2026-08-15 and 2026-08-16 —
`EPERM: operation not permitted, mkdir 'C:\Users\projector\Music\ether music library'` — each one a
track that never materialized and was silently missing when due to air.

**Fix.** `electron/library-health.js`:

- `contentHashFor(db, songId)` → `localPathByHash(db, hash)` runs **first**. `local_files` does not
  sync; it is per-machine by construction. A hit means the bytes are already here.
- `localTargetFor(candidate)` keeps only the **basename** and re-roots under `musicDirFn()`, with a
  containment assertion. A filename is machine-neutral; the directory it came from is not.
- A last gate immediately before `fs.mkdirSync` refuses anything outside the library root — the one
  line that used to create another machine's home directory is now unreachable from a stored path.
- Unresolvable rows are skipped with `{ kind:'prefetch', skipped:true, reason }` on the event ledger.
- `g.file_path` is still used (generated_schedule is `syncExcluded`, so it is this machine's), but
  only as a source of a filename, never as a destination.

`musicDirFn` is wired at `main.js:717` from `getMusicDir()`, which reads `music-dir.txt` — a **file,
not the DB** — so it cannot be steered by a synced column.

### DEVIATION from the brief — needs a decision

The brief said: resolve via content_hash + local_files, and *if a song has no hash yet, skip*. That
could not be implemented literally, because the link does not exist on this data:

- `songs` has no `content_hash` column on this install
- `songs.file_key` is a **basename** ("ABC.mp3"), not a hash —
  `SELECT COUNT(*) FROM songs s JOIN songs_v2 v ON v.content_hash = s.file_key` → **0** of 543
- `local_files` → **0 rows**

Skipping everything without a hash would have skipped **100 % of tracks** and turned a working
prefetch into a dead one. So the hash route is wired as the first branch — it activates the moment
the link exists — and the fallback is the machine-safe basename re-root rather than a skip.

**The safety property asked for is fully in place either way: prefetch can no longer mkdir another
machine's path.** What is deferred is making content_hash the *only* route. Flipping to the strict
version is a small change; it costs prefetch entirely until `songs` ↔ `songs_v2` is joined.

---

## Files touched

| File | Change |
|---|---|
| `electron/sync/handlers/station_config_kv.js` | `_sameValue` helper; no-op guard in `stationConfigKvUpsertByKey` |
| `src/lib/ccData.ts` | read-before-write in `stampLicenseEverywhere` |
| `electron/library-health.js` | `musicDirFn` opt; `contentHashFor` / `localPathByHash` / `localTargetFor`; prefetch query and target resolution; mkdir last gate |
| `electron/main.js` | `musicDirFn` wired into `createLibraryHealth` (~line 717) |
| `electron/sync/tests/helpers/create-test-db.js` | `station_config_kv` DDL |
| `electron/sync/tests/t39-t41-noop-guard.test.js` | **new** — T-39/40/41 |
| `scripts/purge-rekey-ghost-config.js` | **new** — the ghost purge |
| `electron/sync/tests/zz-probe.test.js` | **new, scratch — delete it** |

`package.json` untouched. Nothing committed.

---

## How Jeff verifies

**Pending mutations stay at 0 on both machines over an hour, instead of climbing.**

Two caveats on reading that signal:

1. **Restart Ether first.** The 41 mutations pending at shutdown are still pending and will push on
   the next run; the count should then settle at 0 and stay.
2. **OV needs this build too.** The `ccData.ts` half is renderer code and the handler half is
   main-process code, so until OV runs it, OV keeps emitting its own 20 s `license_key` mutation —
   which will keep arriving here as `origin='remote'`. Local `pending` staying flat is the per-machine
   signal; **both flat over an hour is the real pass.**

Query:

```sql
SELECT sync_status, COUNT(*) FROM mutations GROUP BY sync_status;

SELECT COUNT(*) total,
       SUM(CASE WHEN json_extract(payload_before,'$.value')
                   = json_extract(payload_after,'$.value') THEN 1 ELSE 0 END) no_ops
  FROM mutations
 WHERE json_extract(payload_after,'$.key') = 'license_key';
```

`no_ops` must stop growing. Any new `license_key` mutation after the restart is either a genuine key
change or a regression.
