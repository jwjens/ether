# THREE separate axes — none may collapse into another (verified 2026-08-26)

**Status: READ-ONLY VERIFICATION + BINDING CONSTRAINT. No schema written.**

Jeff's screenshot of **Library Columns → CUSTOM METADATA → "+ Add Category"** resolved an ambiguity
that had been sitting in this design: the product uses the word **"category" for two different
things**, and the unified library adds a third classification axis on top. All three are separate,
all three already work, and **none may collapse into another.**

---

## 1. The three axes

| | **① Rotation category** | **② Metadata category (field)** | **③ Asset type** |
|---|---|---|---|
| Table | `categories` | `metadata_definitions` | `library_asset.type` (registry) |
| Answers | *which pool does this station play it from?* | *which fields does this station track?* | *what kind of asset is this?* |
| Examples | Power Gold, Halloween Drop | Title, Artist, BPM, + any custom field | SONG, SPOT, SWEEPER, ANNOUNCEMENT |
| Created by | **the operator, unlimited** | **the operator, unlimited** | developers, in the registry |
| Scope | **per station** | **per station** | install-wide, identical everywhere |
| Live counts | OF 10 · hV 2 · MF 2 · CiJ 1 | 47 built-in × 4 stations = 188 | 8 |
| Where the operator adds one | Song Library toolbar **"+ Category"** | Library Columns → CUSTOM METADATA **"+ Add Category"** | n/a — a code change |

**A single asset carries all three at once**, independently: it *is* a SONG (type), this station tracks
BPM and a custom field on it (metadata), and this station plays it out of Power Gold (rotation
category). Changing one says nothing about the others.

---

## 2. ② verified — custom metadata is unlimited and per station

From the screenshot: *"CUSTOM METADATA — Metadata categories defined for this station"* with
**+ Add Category**, listing Title and Artist as `Text (built-in)`.

`src/components/LibraryColumnsPanel.tsx:201`:

```js
metadataDefinitions.create({
  station_id: stationId,            // ← per station
  name, data_type: formDataType,
  description: …, is_required: 0,
  is_built_in: 0,                   // ← operator-created, distinct from the 47 built-ins
  display_order: maxOrder + 10,     // ← NEXT slot from whatever exists. No ceiling.
})
```

| | |
|---|---|
| Section header (`:385`) | *"Metadata categories defined for this station"* — per station, in the operator's own words |
| Button (`:390`, `:426`) | **"+ Add Category"** |
| Full CRUD | list `:129` · create `:201` · update `:289` · delete `:300` — all carrying `stationId` |
| Cap | **none.** `display_order: maxOrder + 10` computes the next order from the current set. There is no maximum, no fixed slot count, no enum. |
| Storage | `metadata_definitions` (`station_id NOT NULL`, `UNIQUE(station_id, name)`), values in `song_metadata_values`, choice values in `metadata_vocabulary` |
| Data types available | `text · number · single_choice · multi_choice · boolean · date` |
| Live | 188 definitions = 47 built-in × 4 stations. `is_built_in = 0` count is currently 0 — **no custom field created yet, which is a default state, not an unused feature.** |

`UNIQUE(station_id, name)` is worth noting: two stations may each have a field called "Vibe", and they
are **different fields with different values**. That is the per-station guarantee in the schema.

---

## 3. The naming collision, flagged not fixed

**Two buttons in the product are both called "Category" and mean different things:**

- Song Library toolbar → **"+ Category"** → a **rotation** category (`categories`)
- Library Columns → CUSTOM METADATA → **"+ Add Category"** → a **metadata field** (`metadata_definitions`)

Both are visible in the same screenshot. This is a real naming collision and it is exactly the kind of
thing that makes a future change touch the wrong one. **Flagged only — not renaming anything**, since
both are working features the operator knows by those names, and renaming is a product decision.
Noted here so the library work never conflates them.

---

## 4. Binding constraints — added to the build

Extending the list already recorded for rotation categories:

1. **Nothing may cap ② either.** The 1st, 20th and 200th custom metadata field must work exactly as
   they do now. No enum, no fixed slot count, no UI rendering only N.
2. **The type registry is not a metadata field list, and not a category list.** Three axes, three
   stores. A tab per type is not a field, and not a pool.
3. **`metadata_definitions`, `metadata_vocabulary` and `song_metadata_values` are not migrated,
   renamed, merged or replaced** by this arc. `song_metadata_values` is *generalised* from `song_id`
   to `asset_uuid` so overrides work for every asset type — same table, same station scoping, same
   `definition_id` FK, wider reach.
4. **"+ Add Category" stays exactly where it is**, doing exactly what it does, per station.
5. **No built-in field becomes uneditable, and no custom field becomes shared.** The override model
   (§ `docs/per-station-metadata-verified-2026-08-26.md`) applies to all 47 built-ins and to every
   custom field alike.

---

## 5. What the arc actually does to ② — nothing, except widen it

`song_metadata_values.song_id → asset_uuid`. That is the whole change, and it is additive:

- Today an override can only attach to a **song**.
- After, it can attach to **any asset** — so a SPOT can carry a per-station "Advertiser Contact" field,
  a SWEEPER can carry a per-station "Voice Talent", using the same "+ Add Category" the operator
  already uses.

The definitions, the vocabulary, the per-station scoping, the UI and the button are untouched.

---

## 6. Confirmation

**All three axes are preserved.** Unlimited operator-created rotation categories, unlimited
operator-created custom metadata fields per station, and a separate developer-defined asset-type
registry that cannot become either. Recorded as binding constraints above.

Still open and unchanged: (a)/(b) for the 436 categorised songs, and `songs_all` sequencing.
