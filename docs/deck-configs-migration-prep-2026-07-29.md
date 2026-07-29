# deck_configs — pre-build confirmations for the (station_id, slot) migration

**Date:** 2026-07-29 · **Mode:** READ-ONLY. No edits, no commits. Live DB opened `readOnly: true`; nothing written.
**Companion:** `docs/deck-configs-station-identity-trace-2026-07-29.md` (the cause).

---

## 1. "Apply Layout" on a zero-row station — it neither inserts nor collides. It **throws, and the throw is eaten.**

The write path, end to end:

```
DeckConfigurator "Apply Layout" → onApply → useDeckConfig.save   src/components/DeckConfigurator.tsx:64-71
  → window.ether.deckConfigs.updateBySlot(stationId, slot, patch)
  → electron/preload-handlers.js:108   ipcRenderer.invoke('deck_configs:update-by-slot', stationId, slot, patch)
  → electron/sync/handlers/deck_configs.js:203   ipcMain.handle(...)
  → deckConfigsUpdateBySlot(db, stationId, slot, patch)   :145
```

The handler is **update-only**:

```js
// electron/sync/handlers/deck_configs.js:147-150
let existing = db.prepare(
  `SELECT * FROM ${TABLE} WHERE station_id = ? AND slot = ? AND deleted_at IS NULL`
).get(stationId, slot);
if (!existing) throw new Error(`[deck_configs] slot not found: ${slot} for station ${stationId}`);
```

For station 4 there is no such row, so **every slot throws `slot not found: A for station 4`**. So, precisely:

- **No INSERT is attempted** — the PRIMARY KEY is never reached, so there is no collision and no `INSERT OR IGNORE`
  in this path. Your two candidate outcomes are both wrong; it fails earlier than either.
- **The throw never reaches the user.** The IPC wrapper catches it and returns a value:
  ```js
  // :203-206
  try { return { ok: true, row: deckConfigsUpdateBySlot(...) }; }
  catch (e) { return { ok: false, error: e.message }; }
  ```
  `invoke` therefore **resolves** with `{ok:false}` — it does not reject.
- **The caller ignores the result.** `DeckConfigurator.tsx:64-70` does
  `await Promise.all(next.map(c => …updateBySlot(…)))` and never inspects the returned objects, then
  unconditionally runs `setConfigs([...next])` at `:70`. **The UI updates to the new layout while the database
  received nothing.** Apply Layout reports success it did not have.

**Nothing anywhere creates rows for a new station.** `deckConfigsCreate` is exported (`:216`) and exposed on the
preload bridge (`preload-handlers.js:106`), but **no caller exists** — `grep` across `src/` and `electron/` finds
only the bridge line itself. So today there is no code path, UI or otherwise, by which station 2/3/4 can obtain deck
rows.

**Consequence for the build:** the fix needs an **upsert**, not just a PK change. With `(station_id, slot)` as PK and
`deckConfigsUpdateBySlot` still update-only, Apply Layout on an unseeded station would keep failing silently. Either
seed before the panel can be used, or make this path `INSERT … ON CONFLICT(station_id, slot) DO UPDATE`. And the
swallowed `{ok:false}` at `DeckConfigurator.tsx:64-70` should be checked regardless — it is why this went unnoticed.

## 2. Everywhere that bakes in six slots / a fixed deck count

Ordered by how badly each blocks "more decks is just an insert".

### Hard blockers — these define the set

| # | Site | What it hardcodes |
|---|---|---|
| 1 | `electron/main.js:1495-1502` | The seeder's `defaults` array — literally A,B,C,D,E,F with fixed types/colours |
| 2 | `electron/main.js:1503-1505` | `INSERT OR IGNORE … (slot, type, label, color, enabled)` — **no `station_id` column**, so every seeded row defaults to station 1 |
| 3 | `electron/main.js:1512-1513` | `SELECT COUNT(*) … ` + `"${c}/6 slots present — A B C D E F guaranteed"` — the seeder's health check asserts **six rows globally**. With per-station rows this becomes 6 × N and the guard reports nonsense |
| 4 | `electron/main.js:1511` | `UPDATE deck_configs SET enabled=0 WHERE slot IN ('D','E','F') AND enabled=1` — slot-letter policy baked into startup |
| 5 | `electron/main.js:1380` | `UPDATE deck_configs SET enabled=1 WHERE slot IN ('D','E','F')` — the same letters, opposite direction, in a migration |
| 6 | `scripts/verify-main-schema.js:382-388` | `CREATE TABLE … slot TEXT PRIMARY KEY` — the schema-of-record that must change to `PRIMARY KEY (station_id, slot)` |

### Renderer-side fixed sets

| # | Site | What it hardcodes |
|---|---|---|
| 7 | `src/App.tsx:3668` | `type DeckSlot = "A" \| "B" \| "C" \| "mic"` — a **union type**; a slot "G" is a compile error, and note it does not even include D/E/F |
| 8 | `src/App.tsx:3670` | `DEFAULT_DECK_ORDER = ["A","B","C","mic"]` — the silent zero-row fallback |
| 9 | `src/App.tsx:3870-3871` | `const deckMap = { A: deckA, B: deckB, C: deckC }` — only three slots can resolve to a deck object; D/E/F/G get `undefined` |
| 10 | `src/components/DeckConfigurator.tsx:30` | `SLOT_ORDER = ["A","B","C","D","E","F"]` — drives sort order; an unknown slot sorts to `-1` |
| 11 | `src/components/StandaloneDecksPanel.tsx:75` | A **second copy** of the same `SLOT_ORDER` array |

### Engine-side fixed sets (the deepest)

| # | Site | What it hardcodes |
|---|---|---|
| 12 | `src/audio/engine-rodio.ts:30` | `export type DeckId = "A" \| "B" \| "C"` |
| 13 | `src/audio/engine-rodio.ts:79-81` | `stateA` / `stateB` / `stateC` as three named fields, not a map |
| 14 | `src/audio/engine-rodio.ts:207` | `if (id === "A") this.stateA = st; else if (id === "B") … else this.stateC = st` — an else-branch that silently files **every** unknown deck id as C |

**#14 is the one to watch.** It is not merely a limit — it mis-routes. Any slot beyond A/B/C that reaches the engine
lands in deck C's state. Adding a seventh deck without touching this would corrupt C.

**Honest scope note:** items 12-14 mean "more decks by insert" is achievable for the *config and layout* layers with
the migration you described, but a genuinely playable Deck G also needs the engine's three named states turned into a
keyed map. Worth deciding explicitly whether this build stops at config-level extensibility or goes all the way.

## 3. Migration target — confirmed, with the exact obstacles

**Target is correct:** `PRIMARY KEY (station_id, slot)`, per-station seeding at startup **and** at
`stations:create` (`electron/main.js:6798`, which today calls only `seedStationConfig` at `:6823` — and that function
seeds separation rules, metadata definitions and vocabulary, never decks), plus `useDeckConfig`'s dependency
`[isReady]` → `[stationId, isReady]` (`DeckConfigurator.tsx:62`).

### The stored schema, verbatim from the live DB

```sql
CREATE TABLE deck_configs (
      slot       TEXT PRIMARY KEY,
      type       TEXT NOT NULL DEFAULT 'music',
      label      TEXT NOT NULL,
      color      TEXT NOT NULL DEFAULT '#34d399',
      enabled    INTEGER NOT NULL DEFAULT 0,
      purpose    TEXT DEFAULT '',
      station_id INTEGER NOT NULL DEFAULT 1,
      uuid       TEXT,
      created_at TEXT,
      updated_at TEXT,
      deleted_at TEXT
    , station_uuid TEXT)
```

**SQLite cannot ALTER a PRIMARY KEY** — this is a table rebuild: create `deck_configs_new` with the composite PK,
`INSERT INTO … SELECT *`, drop, rename, recreate indexes. The standard `ALTER TABLE` pattern in `CLAUDE.md` does not
cover PK changes.

### Does station 1's data survive? **Yes — cleanly, with three things to carry across.**

Station 1's six rows are complete and internally consistent (all six have a `uuid`, all share
`station_uuid = 75532b61-fa0c-4bc5-a5f0-0298b94c0123`, none soft-deleted). Under a composite PK they remain unique,
so the copy is lossless. Note the live rows have **drifted from the seeder defaults** — `D` is `mic`/"Mic" and `E` is
`video` with `color: var(--accent-blue)`, not the seeder's `music`/"Deck D" and `#ef4444`. **The migration must copy
existing rows, never re-seed over them**, or the operator's real layout is lost.

Three carry-across obligations:

1. **`idx_deck_configs_uuid` — a UNIQUE index on `uuid`** (`CREATE UNIQUE INDEX "idx_deck_configs_uuid" ON "deck_configs"(uuid)`).
   It must be recreated on the new table. **And per-station seeding must mint a fresh `uuid` per row** — seeding six
   slots for station 4 with station 1's uuids would violate this index. The current seeder writes no uuid at all
   (`main.js:1504`), leaving it NULL; note SQLite allows multiple NULLs in a UNIQUE index, so today's NULL-uuid rows
   do not collide, but any new seeder that copies a uuid would.
2. **`idx_deck_configs_station_uuid`** — non-unique, also needs recreating.
3. **`station_uuid` must be populated for new stations' rows.** It is the sync layer's station identity; leaving it
   NULL on seeded rows would make them invisible/unroutable to peer sync.

**No triggers, no foreign keys, no other table references `deck_configs`** — verified against `sqlite_master`. The
rebuild has no cascade surface.

**Sync queue:** `mutations` currently holds **204 rows** with `table_name = 'deck_configs'`. Those reference rows by
`uuid`, not by rowid or slot, so a PK rebuild that preserves `uuid` leaves them valid. Worth confirming the sync
handlers' assumptions before the copy, since the same 204 rows will replay against whatever comes out.

### One latent bug the migration will expose

`deckConfigsClearAll` (`electron/sync/handlers/deck_configs.js:159-172`) does
`db.prepare("UPDATE ... WHERE id = ?").run(uuid, row.id)` at `:167` — **there is no `id` column** on this table
(confirmed: `slot, type, label, color, enabled, purpose, station_id, uuid, created_at, updated_at, deleted_at,
station_uuid`). That statement throws `no such column: id` whenever it is reached, which is only when a row has a
NULL uuid. Today all six rows have uuids so it never fires. **Freshly seeded per-station rows written without uuids
would walk straight into it.** Either seed with uuids (which #1 above requires anyway) or fix that line.

---

## Summary of what must be true before the build is safe

1. Upsert, not update-only, or seed-before-use — otherwise Apply Layout keeps silently failing (§1).
2. Check the `{ok:false}` return in `useDeckConfig.save` (`DeckConfigurator.tsx:64-70`) — the silence is why this hid.
3. Six-slot literals at the 11 renderer/seeder sites in §2 become data-driven; the engine's three named deck states
   (§2 items 12-14) are a deliberate scope decision, and item 14 mis-files unknown decks as C.
4. Table rebuild for the composite PK; **copy** station 1's rows rather than re-seeding (they have drifted).
5. Recreate both indexes; mint fresh `uuid` and set `station_uuid` on every seeded row.
6. `deckConfigsClearAll`'s `WHERE id = ?` is broken and will be reached by uuid-less seeded rows.

## Scope note

Read-only. No file in `C:\openair` modified, nothing committed, nothing built. The live DB was opened `readOnly: true`
and closed. Diagnostic scripts live in the session scratchpad, not the repo. Migration verification on a DB copy, as
you said — nothing here has touched the live database.
