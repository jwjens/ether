# Build report — per-station deck configs (migration v35 + code)

**Date:** 2026-07-29 · **Mode:** built and verified **on a COPY of the live DB only**.
**The live database has NOT been migrated.** No version bump, no commit, no build. Awaiting GO.

---

## What was wrong

`deck_configs` was created with `slot TEXT PRIMARY KEY` — globally unique across the whole database — and
`station_id INTEGER NOT NULL DEFAULT 1` was bolted on later. The table could not hold a second station's decks:
inserting slot `A` for station 4 collided with station 1's primary key. Every seeded row landed on station 1 by
column default, so **station 1 had all six slots and stations 2/3/4 had zero**, falling back silently to a default
order on the live console and showing 0/6 in Configure Decks.

Cause traced in `docs/deck-configs-station-identity-trace-2026-07-29.md`; pre-build receipts in
`docs/deck-configs-migration-prep-2026-07-29.md`. Nothing found while building contradicted either document.

---

## 1. Migration — `scripts/migrate-deck-configs-per-station-phase-sync-35.js` (new)

SQLite cannot `ALTER` a PRIMARY KEY, so this is a table rebuild inside one transaction: create with
`PRIMARY KEY (station_id, slot)` → copy every row verbatim → drop → rename → recreate indexes
(`:88-124`).

| Requirement | How | Line |
|---|---|---|
| PK `slot` → `(station_id, slot)` | new table declares the composite PK | `:105-108` |
| Copy verbatim, never re-seed | `INSERT INTO …_new (cols) SELECT cols FROM …` — no defaults, no seeder | `:111` |
| Row-loss guard | copy count compared to pre-count, throws → transaction rolls back | `:113-116` |
| uuids preserved | uuid is one of the copied columns; nothing regenerates it | `:44`, `:111` |
| UNIQUE index on uuid recreated | after the rename (dropping the old table dropped its indexes) | `:123` |
| `station_uuid` index recreated | same | `:124` |
| Idempotent | `isAlreadyMigrated` = PK is exactly `(station_id, slot)` | `:63-66`, `:75-79` |
| Older DBs | any missing column is added before the rebuild so the copy is total | `:83-95` |
| No six-slot assumption | rebuild is slot-agnostic; nothing counts or matches letters | throughout |

It is picked up automatically by the existing runner — `runMigrationChain` (`electron/main.js:1090-1107`) discovers
`^migrate-.+-phase-sync-(\d+)\.js$`, sorts by version and calls `applyMigration(db)`, skipping versions already in
`schema_version`. No wiring needed.

### Verification on a COPY — 8/8 PASS

Copy taken with the app running (`.db`, `-wal`, `-shm`), live files untouched:

```
=== migrate-deck-configs-per-station-phase-sync-35.js ===
current schema_version: 34
deck_configs rows before: 6
PK before: ["slot"]
[migrate-v35] rebuilt deck_configs with PK (station_id, slot); 6 row(s) copied verbatim.

[PASS] schema_version = 35 — got 35
[PASS] PK is (station_id, slot) — ["station_id","slot"]
[PASS] row count unchanged — before 6, after 6
[PASS] every row byte-identical (verbatim copy, uuids preserved)
[PASS] UNIQUE index on uuid recreated — CREATE UNIQUE INDEX "idx_deck_configs_uuid" ON "deck_configs"(uuid)
[PASS] station_uuid index recreated
[PASS] a second station can now hold slot A
[PASS] no leftover scratch table
```

**Idempotency, second run on the same copy:** `PK before: ["station_id","slot"]` → `no-op`, same 8/8 PASS.

The "every row byte-identical" check compares all columns of all rows before and after — that is the proof the copy
was verbatim and uuids survived, which the 204 `mutations` rows keying on them require.

### End-to-end verification on the migrated copy — 13/13 PASS

Seeding every station, using the same SQL as the shipped seeder:

```
BEFORE:  station 1: 6 rows   station 2: 0   station 3: 0   station 4: 0
SEED:    station 1: had 6, seeded 0   stations 2/3/4: had 0, seeded 6 each

[PASS] station 1 (Open Format) has the full default set — 6 rows
[PASS] station 2 (halloVeen) has the full default set — 6 rows
[PASS] station 3 (Magical Forest) has the full default set — 6 rows
[PASS] station 4 (Christmas In July) has the full default set — 6 rows
[PASS] station 1 rows untouched by seeding (drifted layout preserved)
[PASS] station 1 D is still type=mic label=Mic — mic/Mic
[PASS] station 1 E is still type=video custom colour — video/var(--accent-blue)
[PASS] every row has a uuid (UNIQUE index + mutation log key) — 0 null
[PASS] all uuids distinct — 0 duplicated
[PASS] every row has station_uuid (visible to peer sync) — 0 null
[PASS] station_uuid matches its station — 0 mismatched
[PASS] re-seeding is a no-op (idempotent) — 24 → 24
[PASS] a NEW slot (G) is a plain INSERT — no schema or code change

FINAL:
  station 1: A:music* B:music* C:music* D:mic E:video F:guest      ← drift preserved
  station 2: A:music* B:music* C:music* D:music E:music F:guest
  station 3: A:music* B:music* C:music* D:music E:music F:guest
  station 4: A:music* B:music* C:music* D:music E:music F:guest
```

The Deck-G check is the "no assumptions" proof: a slot outside A–F inserts cleanly with no schema or code change.

## 2. Per-station seeding — `electron/main.js`

| Change | Line | What |
|---|---|---|
| `DEFAULT_DECKS` | `:1503-1510` | The single source of the default set. Nothing counts it, nothing matches letters — add an entry (or insert a row) and it flows through |
| `seedDeckConfigsForStation(stationId)` | `:1519-1544` | Seeds one station: `INSERT OR IGNORE` against the `(station_id, slot)` PK, so existing rows are never overwritten. **Mints a uuid per row** and copies the station's uuid into `station_uuid` |
| `seedDeckConfigs()` | `:1551-1568` | Startup guard: iterates **all stations**, seeds only those with zero rows. Logs per-station counts instead of the old global `"c/6 slots present"` |
| `stations:create` | `:6862-6866` | Seeds decks for the new station immediately after `seedStationConfig` — which seeds separation rules, metadata and vocabulary, and never touched decks |
| Removed | `:1379-1383` | The startup `UPDATE deck_configs SET enabled=1 WHERE slot IN ('D','E','F')` — hardcoded a slot set *and* overrode the operator's own enable/disable choices on every launch |
| Removed | old `:1511`, `:1512-1513` | The `slot IN ('D','E','F')` disable and the `"${c}/6 slots present — A B C D E F guaranteed"` guard, whose success criterion was six rows **globally** |

## 3. Write path — upsert, and no more silent false success

**`electron/sync/handlers/deck_configs.js:145-176`** — `deckConfigsUpdateBySlot` was update-only and threw
`slot not found` for any station with no rows. It now creates the row when it is absent, via the existing
`deckConfigsCreate` (which was exported and exposed on the preload bridge but **had no caller**), carrying the
station's uuid so the row is visible to sync and logging an `insert` mutation like any other create.

**`src/components/DeckConfigurator.tsx:70-93`** — `save` now inspects every result. The IPC wrapper returns
`{ok:false, error}` rather than rejecting (`deck_configs.js:203-206`), so the old
`await Promise.all(...)` + unconditional `setConfigs` reported success no matter what. It now collects failures,
logs them, records an error, and **throws** so the caller cannot mistake a failed save for a saved layout.

## 4. Dependency fix

**`src/components/DeckConfigurator.tsx:62`** — `[isReady]` → `[isReady, stationId]`. Switching station now re-reads
that station's deck rows instead of leaving whatever loaded at mount on screen.

## 5. `deckConfigsClearAll` — `deck_configs.js:178-193`

`UPDATE ${TABLE} SET uuid = ? WHERE id = ?` referenced an `id` column that does not exist on this table (columns are
`slot, type, label, color, enabled, purpose, station_id, uuid, created_at, updated_at, deleted_at, station_uuid`). It
threw `no such column: id` whenever reached — only for uuid-less rows, which is exactly what unseeded rows would have
been. Now keys on `(station_id, slot)`.

## No-assumptions audit — every six-slot / A–F site from the prep doc

| Prep doc # | Site | Now |
|---|---|---|
| 1 | seeder `defaults` array | `DEFAULT_DECKS`, single source, extensible |
| 2 | `INSERT … ` without `station_id` | inserts `station_id`, `uuid`, `station_uuid` explicitly |
| 3 | `"${c}/6 slots present"` guard | per-station counts, no fixed total |
| 4 | `slot IN ('D','E','F')` disable | **removed** |
| 5 | `slot IN ('D','E','F')` enable | **removed** |
| 6 | `slot TEXT PRIMARY KEY` schema | migration v35 → `PRIMARY KEY (station_id, slot)` |
| 7 | `type DeckSlot = "A"\|"B"\|"C"\|"mic"` | `type DeckSlot = string` (`App.tsx:3668-3671`) — a new slot was a **compile error** before |
| 8 | `DEFAULT_DECK_ORDER` | left as-is: it is the *zero-row* fallback, and after this build no station has zero rows. Removing it is a separate call |
| 9 | `deckMap = {A,B,C}` | **untouched — out of scope.** It maps slots to the engine's three playout decks |
| 10 | `SLOT_ORDER` in DeckConfigurator | `compareSlots()` — natural sort, any slot id |
| 11 | `SLOT_ORDER` duplicate in StandaloneDecksPanel | imports the shared `compareSlots` |
| 12-14 | `engine-rodio.ts` DeckId / stateA-C | **untouched, per scope.** Item 14 (`else this.stateC = st` files unknown decks as C) remains a live hazard for any future playable deck beyond C |

## Typecheck

```
$ npx tsc --noEmit
src/components/OnboardingFlow.tsx(2039,42): error TS2366: …
src/components/PhoneDesk.tsx(777,21): error TS2345: …
```

**PASS — the 2 standing baseline errors only. Zero new, none in the files touched.**

## Architecture compliance

- **`CLAUDE.md` — "a station is a data binding, not a variant."** Station identity no longer decides whether deck
  data can exist. The storage can now express every station identically; station 1 stops being privileged by the
  `station_id DEFAULT 1`.
- **`CLAUDE.md` — ALTER TABLE pattern / `schema_version` in its own table.** v35 inserts into `schema_version`
  (`:120`) and is auto-discovered by `runMigrationChain` (`main.js:1090-1107`). A PK change is outside the plain
  ALTER pattern, hence the documented rebuild.
- **`CLAUDE.md` — "BUILD THE SENSE."** The seeder logs per-station counts; failed saves now surface instead of
  reporting false success. Two silent failure modes removed (`updateBySlot` throw eaten; `clearAll` `WHERE id`).
- **`CLAUDE.md` — "Correct minimal solution … name what you're NOT building."** Not built: the engine keyed-map
  conversion (`engine-rodio.ts`, explicitly out of scope), `deckMap`, `DEFAULT_DECK_ORDER` removal, and any UI for
  adding slots.
- **Nothing contradicted the prep doc.** Every receipt it cited was found as recorded.

## Not done, deliberately

- **The live DB has not been migrated.** Only the scratchpad copy. Running the app would migrate it automatically via
  `runMigrationChain` — worth knowing before launching.
- No version bump, no commit, no installer.
- Verification scripts live in the session scratchpad, not the repo.

## Files changed

```
NEW  scripts/migrate-deck-configs-per-station-phase-sync-35.js
     electron/main.js                          (seeder, stations:create, removed slot-letter policy)
     electron/sync/handlers/deck_configs.js    (upsert, clearAll key)
     src/components/DeckConfigurator.tsx       (compareSlots, deps, result inspection)
     src/components/StandaloneDecksPanel.tsx   (shared comparator)
     src/App.tsx                               (DeckSlot type)
```
