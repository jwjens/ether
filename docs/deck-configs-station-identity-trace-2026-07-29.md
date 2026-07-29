# Decks complete on Open Format, incomplete everywhere else — traced

**Date:** 2026-07-29 · **Mode:** READ-ONLY. No edits, no commits. The live DB was opened **read-only**
(`node:sqlite`, `readOnly: true`) for the data receipts; nothing was written.

**Related:** `docs/deck-fill-sweep-station-identity-trace-2026-07-28.md` — same class (station identity changing
behaviour), **different hop**. That trace found the *engine instance* per station; this one is the *deck config
rows*. They are independent defects that compound.

---

## Headline — it is a DATA gap, and the schema makes it unfixable as data

**`deck_configs` has `slot` as its PRIMARY KEY.** One row per slot **for the entire database**, not per station.
`station_id` was bolted on afterwards as a plain column. So the table **cannot physically hold a second station's
decks** — and it doesn't:

```
=== deck_configs table info ===          (live DB, read-only)
  slot        TEXT     pk=1   ← PRIMARY KEY, globally unique
  station_id  INTEGER  notnull=1  default=1

=== ALL deck_configs rows ===
  total rows: 6
  station_id=1  slot=A  type=music   enabled=1  Deck A
  station_id=1  slot=B  type=music   enabled=1  Deck B
  station_id=1  slot=C  type=music   enabled=1  Deck C
  station_id=1  slot=D  type=mic     enabled=0  Mic
  station_id=1  slot=E  type=video   enabled=0  Deck E
  station_id=1  slot=F  type=guest   enabled=0  Guest 2

=== rows per station ===
  station 1 (Open Format):     6 rows, 3 enabled
  station 2 (halloVeen):       0 rows, 0 enabled
  station 3 (Magical Forest):  0 rows, 0 enabled
  station 4 (Christmas In July): 0 rows, 0 enabled   ← currently the ACTIVE station
```

Open Format is station 1. `station_id INTEGER NOT NULL DEFAULT 1` means every seeded row landed on it by default.
**Every other station owns zero deck rows and always has.**

---

## 1. Where decks are rendered, and what sets the count

`src/App.tsx:3866-3868` — the console strip row:

```jsx
{activeDeckOrder.map((slot) => {
  const config = deckConfigs?.find(d => d.slot === slot);
  const deckType = config?.type || (slot === "mic" ? "mic" : "music");
```

The count is `activeDeckOrder.length`, derived at `App.tsx:3669-3680`:

```js
const DEFAULT_DECK_ORDER: DeckSlot[] = ["A", "B", "C", "mic"];
const rawDeckOrder = deckConfigs && deckConfigs.length > 0
  ? deckConfigs.filter(c => c.enabled).map(c => c.slot)
  : DEFAULT_DECK_ORDER;                                    // ← silent fallback
const hasGuestDeck = !!deckConfigs?.some(c => c.enabled && c.type === "guest");
const activeDeckOrder = (lpViewport.narrow && !hasGuestDeck)
  ? rawDeckOrder.filter(s => s !== "mic")
  : rawDeckOrder;
```

`deckConfigs` here is LivePanel's prop, passed at `App.tsx:2508` as `visibleEnabledDecks`, which is
`enabledDecks` (`App.tsx:809`) — the `enabled` list from `useDeckConfig` (`DeckConfigurator.tsx:74`).

## 2. Yes — the deck set is station-scoped, at one hop

`src/components/DeckConfigurator.tsx:46-62`:

```js
const { stationId, isReady } = useActiveStation();
…
queryScoped("SELECT slot, type, label, color, enabled, COALESCE(purpose,'') as purpose FROM deck_configs ORDER BY slot",
            [], stationId)
```

`queryScoped` (`src/db/stationScoped.ts:58-78`) rewrites that into `… WHERE station_id = ?` and splices the station
id in. So the deck set **is** a per-station query against a table that holds rows for exactly one station.

**A second, separate defect in the same hook:** the effect's dependency array is `[isReady]`
(`DeckConfigurator.tsx:62`) — **not `[stationId]`**. The deck list is never re-read on a station switch. Whatever was
loaded at mount persists across switches. That is its own station-identity bug, independent of the missing rows.

## 3. Open Format has rows no other station ever got

`electron/main.js:1494-1514`, `seedDeckConfigs()` — the only writer of default deck rows:

```js
const insert = db.prepare(
  "INSERT OR IGNORE INTO deck_configs (slot, type, label, color, enabled) VALUES (?, ?, ?, ?, ?)"
);                                       // ← no station_id in the column list
…
const { c } = db.prepare("SELECT COUNT(*) as c FROM deck_configs").get();
console.log(`[DeckGuard] ✓ deck_configs: ${c}/6 slots present — A B C D E F guaranteed in database`);
```

Three things follow, all provable from that one function:

1. **No `station_id` is supplied**, so the column default applies — `station_id = 1`
   (`electron/main.js:1279-1280`: `ALTER TABLE ${tbl} ADD COLUMN station_id INTEGER NOT NULL DEFAULT 1`, with
   `deck_configs` in the list at `:1276`).
2. **`INSERT OR IGNORE` with `slot` as PRIMARY KEY** means that once A–F exist, every later insert for any station
   collides on the PK and is silently ignored. **Re-running the seeder can never create rows for station 2.**
3. **The guard counts 6 rows globally** (`:1512-1513`, "6/6 slots present") — the seeder's own success criterion is
   "six rows in the table", which is satisfied forever by station 1's rows. It reports healthy while three stations
   have none.

**Station creation does not seed decks either.** `stations:create` (`electron/main.js:6798-6826`) calls
`seedStationConfig(db, row.id)` (`:6823`), and that function seeds separation rules, metadata definitions and
vocabulary only — `grep deck electron/seed-station-config.js` returns **nothing**. A new station is born with zero
deck rows by design-omission.

## 4. What happens with no rows: silent fallback, no throw

`App.tsx:3671-3673` — `deckConfigs.length > 0 ? … : DEFAULT_DECK_ORDER`. Zero rows takes the `:` branch. **No error,
no warning, no console line.** `useDeckConfig` only logs on a query *failure* (`DeckConfigurator.tsx:60`), and a
zero-row result is a success. So a station with no deck config is indistinguishable in the logs from one that is
configured — the same honest-state gap as `MicChannel`'s empty catch.

**Where static analysis stops — UNKNOWN.** The fallback is `["A","B","C","mic"]`, so a zero-row station should render
**four** strips, not one. The observed "one deck" is therefore **not fully explained** by this path alone. Candidates
that would decide it, none resolvable from the tree:

- `lpViewport.narrow` drops `mic` (`App.tsx:3678-3680`) → three, still not one.
- The strips may render but be **empty/dead** because that station's `AudioEngine` was never `init()`-ed — the
  primary defect in `docs/deck-fill-sweep-station-identity-trace-2026-07-28.md` (HOP 4). Blank strips read as
  "missing decks".
- The `[isReady]`-only dependency (§2) means what is on screen may belong to whichever station was active at mount.

**The check that settles it:** on a non-Open-Format station, F12 → console → count rendered `ConsoleStrip`s, and run
`(await window.ether.deckConfigs.list(<stationId>))` to see what that station's UI actually received.

## 5. DATA gap or CODE gap — both, and the code gap is the one that matters

**The proximate cause is a DATA gap:** stations 2-4 have zero `deck_configs` rows (§ headline).

**But it cannot be repaired as data**, and that is the real finding. `slot TEXT PRIMARY KEY` means the table can hold
at most six deck rows in total. Inserting `('A', …)` for station 2 violates the primary key. **A per-station deck
configuration is not representable in the current schema.** The decisive receipt is the two lines together:

```
scripts/verify-main-schema.js:383   slot    TEXT PRIMARY KEY,
electron/main.js:1280               ALTER TABLE deck_configs ADD COLUMN station_id INTEGER NOT NULL DEFAULT 1
```

A globally-unique key plus a station column bolted on beside it. The query layer then reads it as if it were
per-station (`queryScoped`), so the read model and the storage model disagree — and station 1 is the only station the
disagreement is invisible for, because it is the default.

So: **CODE gap (schema + seeder), presenting as a DATA gap.** Backfilling rows would fail on the PK; the fix has to
make the key `(station_id, slot)` and give the seeder a station to seed *for*, at station-create time as well as at
startup. Not designed here.

---

## Why Open Format looks "complete" and the others "incomplete"

Nothing about Open Format is special in the rendering code. It is special in exactly one way: **it is station 1, and
`station_id` defaults to 1.** Every default row the seeder has ever written landed on it. The deck feature is not
more finished there — it is the only station the storage model can describe.

That is the general shape the requirement rejects: *a station is a data binding, not a variant.* Here station identity
does not change what the deck component renders; it changes **whether the data the component reads exists at all**,
and only one station's data can exist.

## Related, not the same

`docs/deck-fill-sweep-station-identity-trace-2026-07-28.md` HOP 4 — a per-station `AudioEngine` that never ran
`init()` fires no events, so its strips never sweep. That defect is about **whether a rendered deck is alive**; this
one is about **whether the deck is rendered at all**. On a non-station-1 station both are in play at once, which is
likely why the symptom reads as "the feature is unfinished here".

## Scope note

Read-only. No file in `C:\openair` modified, nothing committed, nothing built. The live DB was opened with
`readOnly: true` and closed; no writes, no schema changes. The diagnostic script lives in the session scratchpad, not
in the repo, and is not needed again.
