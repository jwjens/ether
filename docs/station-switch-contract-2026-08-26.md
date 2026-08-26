# The station-switch contract — what it touches, and how new work rides it (2026-08-26)

**Status: READ-ONLY MAP. Written before any `library_asset` schema, at Jeff's instruction.**

> *"When I switch stations, a LOT changes: all preferences, everything under the native menu, the
> station badge, the theme, and more — every one of those is per-station and working. This is the
> 5-months-of-work system."*

The requirement: the new library must **plug into this**, not create a second way stations are scoped.

---

## 1. What a station switch actually is

It is smaller than it looks, and that is why it works everywhere. **Three moving parts, one of each.**

### (a) ONE authority — `stations.is_active`

`ipcMain.handle('stations:switch')` (`electron/main.js:9695`) does exactly one thing:

```js
for (const s of others) stationsUpdateById(db, s.id, { is_active: 0 });
stationsUpdateById(db, id,  { is_active: 1 });
```

`stations:get-active` reads `WHERE is_active=1`. That row is the answer to "which station am I on",
and there is no second answer anywhere.

**`is_active` is `'local-only'` in the sync registry**, with the reason written on the line:
*"which station THIS machine operates is per-install local state — syncing it clobbers each…"*. So a
switch on this machine never moves another machine. That is load-bearing and the new work must not
disturb it.

### (b) ONE broadcast — the `station-switched` DOM event

Dispatched from `App.tsx:867` and `:2259`. Everything that needs to re-read listens for it:

| Listener | What it re-reads |
|---|---|
| `useActiveStation` (`:111`) | **the hook every component uses** — `{stationId, stationUuid, isReady}` |
| `ActiveStationBadge` (`:43`) | the badge |
| `SettingsPanel` (`:240`, `:2520`, `:3963`) | preferences, station-scoped KV |
| `SkinPicker` (`:832`, `:1075`) | theme, station logo, font |
| `usePlan` (`:118`) | tier / plan |
| native menu | `menu:rebuild` IPC → `buildMenu()` (`main.js:2725, 2898`) |

Anything that caches station data listens; anything that reads through the hook re-renders for free.

### (c) ONE scoping helper — `queryScoped`

`src/db/stationScoped.ts` injects `WHERE station_id = ?` into a query, splicing the param into the
right position. Its precondition is simple and absolute:

> **a per-station table has a `station_id` column.** If the SQL already mentions `station_id`,
> `queryScoped` passes through untouched and warns once.

**That is the entire contract.** A table is per-station because it has `station_id`; a component is
station-aware because it uses `useActiveStation()`; a cache is correct because it listens for
`station-switched`.

---

## 2. Everything Jeff listed, and which part carries it

| What changes on switch | Carried by |
|---|---|
| Preferences | `station_config_kv` (has `station_id`) + `SettingsPanel`'s `station-switched` listeners |
| Native menu | `menu:rebuild` → `buildMenu()` |
| Station badge | `ActiveStationBadge`'s listener |
| Theme / logo / font | `station_config_kv` + `SkinPicker`'s listeners |
| Categories | `categories.station_id` + `queryScoped` |
| Clocks, shows, clock slots, breaks | `station_id` + `queryScoped` |
| Rotation | reads the active `stationId` from the hook, then station-scoped queries |
| Log / play history | `generated_schedule.station_id`, `play_log.station_id` |
| Output / stream / decks | `deck_configs.station_id`, per-station Icecast fields on `stations` |
| Plan / tier | `usePlan`'s listener |
| Announcements + their schedule | `announcements.station_id`, `announcement_schedule.station_id` — **today's arc already rides this path** |

---

## 3. Does the library design plug in? — YES, and it adds nothing

### `library_asset` — install-scoped, and therefore **must not** be re-scoped

It has **no `station_id`**, deliberately: the file library is shared, and a switch must not change
which files exist. That is not a gap in the contract — it is the contract saying "this is not
per-station".

**Concrete implementation rule that falls out of this:** **never call `queryScoped` on
`library_asset`.** It would inject `WHERE station_id = ?` and fail on a column that does not exist.
Plain `query()` only. This is the one place the new work could accidentally invent a second mechanism,
so it is written down here and belongs in a test.

### Per-station treatment rows — carry `station_id`, ride the existing path exactly

Generalising `station_programming` (which already has `station_id`) to every asset type means those
rows are per-station **by the existing definition**: `station_id` column → `queryScoped` works →
`useActiveStation` supplies the id → `station-switched` re-reads. **Nothing new.**

### Type-behaviour settings — already on the path

`station_config_kv` under `asset_type.<CODE>.<behaviour>` is the same store the theme, the closing
times and every other per-station preference use. `SettingsPanel` already re-reads station KV on
`station-switched` (`:2520`), so the settings surface inherits switching without adding a listener.

### The Library UI

Tabs come from the registry (install-level, identical on every station). The **contents** of each tab
are per-station treatment, read with `useActiveStation()` + `queryScoped`. Switch stations and the
same tabs show that station's treatment — which is the behaviour Jeff described.

---

## 4. What the new work must NOT do

Stated as prohibitions, because each is a plausible shortcut that would fork the mechanism:

1. **No second "current station" notion.** No module-level `currentStationId`, no separate
   `library_active_station` KV key. `is_active` is the only authority.
2. **No new switch event.** If something must re-read on switch, it listens for `station-switched`.
   No `library-switched`.
3. **No `station_id` on `library_asset`.** The moment it has one, the library stops being shared and
   the ruling is broken.
4. **No `queryScoped` on install-scoped tables.**
5. **Nothing may make `is_active` synced.** A synced switch clobbers other machines, which the
   registry comment already warns about.

---

## 5. The one risk this map surfaced

Rotation currently filters on `songs.category_id` / `rotation_status` / `daypart_mask`
(`audiod/loggen.js:70`) — **columns on the install-scoped row, not per-station rows.** When rotation
moves onto per-station treatment, it moves from "a column that is the same everywhere" to "a row
selected by `station_id`". That is the correct direction and it is what makes per-station treatment
real — but it is the step where rotation's scoping actually changes, so it is the one that needs its
output compared before and after, per station.

Everything else in the arc is additive to a contract that already works.

---

## 6. Confirmation

**The design reuses all three parts of the switch mechanism and introduces none of its own.**
`library_asset` sits deliberately outside per-station scoping because it is the shared file library;
everything station-specific hangs off `station_id` rows and `station_config_kv`, both of which the
existing switch already drives.

No schema written. Awaiting Jeff on the one open item: whether the 436 categorised songs migrate as
**(a)** one treatment row each on their current station, or **(b)** the same plus availability to
every station.
