# Deleting a category does nothing — routing trace (2026-09-24)

**Read-only.** Nothing edited, committed, built or deployed. The live DB was never opened: every DB
receipt below comes from a copy of `%LOCALAPPDATA%\Ether\profiles\ETH-STN-BAA8-E056-6FC8\openair.db`
(+ `-wal`, `-shm`) taken while Ether was not running. Line numbers are the working tree at
`C:\openair` HEAD `ff5d11f` (v4.6.47).

Jeff's report, recorded as given: *"deleting a category — in the dashboard Categories push-up AND the
Schedule Manager's Categories tab — shows the confirm dialog; after OK, nothing happens. No error,
category stays."*

---

## VERDICT — one cause

**The delete works. The list that re-reads after it does not filter out deleted rows, so the category
never leaves the screen.**

`CategoriesTab.load()` — `src/components/scheduler/CategoriesTab.tsx:35-38`:

```sql
SELECT c.*, (SELECT COUNT(*) FROM songs WHERE category_id = c.id) as song_count
FROM categories c WHERE c.station_id = ? ORDER BY c.code
```

There is **no `deleted_at IS NULL`**. `categoriesDelete` is a SOFT delete — it sets `deleted_at` and
leaves the row in place (`electron/sync/handlers/categories.js:156-159`). So after OK the row is
deleted, `load()` re-reads, the query returns the row it just deleted, and the screen is unchanged.
No error is possible because nothing failed.

Every sibling list in the same folder filters; this one is the outlier:

| file:line | query | filters `deleted_at`? |
|---|---|---|
| `scheduler/CategoriesTab.tsx:36` | `FROM categories c WHERE c.station_id = ?` | **NO** |
| `scheduler/ShowsTab.tsx:43` | `FROM shows s … WHERE s.station_id = ? AND s.deleted_at IS NULL` | yes |
| `scheduler/ShowsTab.tsx:46` | `FROM clocks WHERE deleted_at IS NULL` | yes |
| `scheduler/ClocksTab.tsx:234` | `FROM clocks WHERE deleted_at IS NULL` | yes |
| `scheduler/ClocksTab.tsx:235` | `FROM categories ORDER BY priority, code` | **NO** |
| `ImagingPanel.tsx:119,121` | `FROM categories … AND deleted_at IS NULL` | yes |
| `ProgramLog.tsx:154` | `FROM categories WHERE deleted_at IS NULL` | yes |

`queryScoped` cannot save it: it injects `station_id` only and never touches `deleted_at`
(`src/db/stationScoped.ts:41-43` — `STATION_ID_RE` is the whole of its rewriting).

`ClocksTab.tsx:235` is the same defect in the clock editor's category picker: a deleted category is
still offered as a slot target.

### The receipt that proves it — a category that IS deleted and IS still listed

From the DB copy, `categories` row id=15:

```
id=15  uuid=571d6471-c77c-41bb-87bf-01d6fbf3151c  code="ff"  name="tt test categoyr"
station_id=2  created_at=2026-08-10T22:03:26.323Z
deleted_at=2026-09-15T01:37:50.125Z          ← deleted
songs=0  clock_slots=0  programming=0
```

and the matching mutation, written by the same call:

```
#c387d286-5937-4b25-b04a-8fa0f8b81c3e  op=delete  row=571d6471-c77c-41bb-87bf-01d6fbf3151c
station=2  at=2026-09-15T01:37:50.125Z
```

The delete ran, committed, and was logged for sync — nine days ago. `station_id=2` is the active
station (`halloVeen`), so `WHERE c.station_id = ?` matches it and the tab renders it to this day.
**That row is on Jeff's screen right now, and pressing Delete on it again will "do nothing" again** —
the second delete also succeeds, rewrites `deleted_at`, and changes nothing visible.

---

## 1. Both Delete buttons — one path, not two

Both doors render the **same component**. There is exactly one `categories.delete` call site in the
entire renderer.

```
Dashboard CATEGORIES push-up   App.tsx:2673 (bottom-bar tab)
                             → App.tsx:4369  <Scheduler defaultTab={progPanel} embedded />
Pop-out "Categories"           PopoutRenderer.tsx:280  <Scheduler defaultTab="categories" embedded />
Schedule Manager               App.tsx:3086  <Scheduler defaultTab={schedulerTab} />
                             → Scheduler.tsx:67,105   {tab === "categories" && <CategoriesTab />}
```

`<CategoriesTab />` is mounted with **no props** in all three, so `hosted` is false and it uses its own
`load()` (`CategoriesTab.tsx:32-39`) — the unfiltered query above.

The delete itself, `CategoriesTab.tsx:98-110`:

```ts
const del = async () => {
  if (!editing?.id || !editing.uuid) return;              // :99  silent, but BEFORE the confirm
  if (!confirm(`Delete category "${label}"?…`)) return;   // :101 the dialog Jeff sees
  setSaveError("");
  try {
    await (window as any).ether.categories.delete(editing.uuid, stationId);   // :104
    load();                                                // :105 re-read — the unfiltered query
    setEditing(null);
  } catch (e: any) { setSaveError(e?.message || "Delete failed"); }
};
```

IPC chain:

```
ether.categories.delete(uuid, stationId)
  → electron/preload-handlers.js:67   ipcRenderer.invoke('categories:delete', uuid, stationId)
  → electron/sync/handlers/categories.js:190   ipcMain.handle('categories:delete', …)
  → categoriesDelete(db, uuid, stationId)      categories.js:140-162
```

`categoriesDelete` (`categories.js:140-162`):

1. `validateScope()` — registry check only (`categories.js:21-27`)
2. `SELECT * FROM categories WHERE uuid = ?`; throws `[categories] row not found` if absent (`:142-143`)
3. `withMutation(...)` → `UPDATE categories SET deleted_at = ?, updated_at = ? WHERE uuid = ?` (`:156-159`)

**No guard for songs, clock slots, station_programming, imaging assignments, or protected/default
categories exists.** There is nothing to refuse the delete. That is why the confirm's warning
("songs… will lose this category assignment") is accurate: the delete is unconditional.

---

## 2. How a failure *would* hide — the latent second defect

The cause above is a display bug, not a refusal. But if a refusal ever did fire, it would be equally
invisible, and this is worth fixing in the same change:

**`categories:delete` never rejects.** `categories.js:190-193` wraps the call in try/catch and
**returns** `{ ok: false, error }` — a *resolved* promise. `await` at `CategoriesTab.tsx:104` therefore
never throws, the `catch` at `:107` never runs, and `setSaveError` never fires. The return value is
assigned to nothing and read by nobody; `load()` at `:105` runs unconditionally, success or failure.

So every one of these would look identical on screen — dialog, OK, nothing:

| failure | where | reaches the screen? |
|---|---|---|
| row not found (uuid absent/NULL) | `categories.js:143` | **no** — `{ok:false}` discarded |
| `validateScope()` registry mismatch | `categories.js:21-27` | **no** — same |
| `logMutation` validation throw (rolls back the whole txn) | `mutation-writer.js:220-274` | **no** — same |
| `withMutation` library-borrowed guard | `mutation-writer.js:422-427` | **no** — same |
| any SQLITE error inside the transaction | `mutation-writer.js:442-462` | **no** — same |

Two of Jeff's listed candidates are **ruled out** by code, not assumption:

- **library-borrowed read-only guard** — `LIBRARY_CATALOG_TABLES = new Set(['songs','artists','albums'])`
  (`mutation-writer.js:66`). `categories` is not in it, so the guard at `:422` cannot fire for this table.
  (`install_config_kv` has no `library_borrowed` row on this install either.)
- **station_uuid NULL on newly created rows** — `mutation-writer.js` contains no `station_uuid` at all;
  `logMutation` keys on `station_id` and only rejects `undefined` (`:255-257`). The 2026-09-23 gap does
  not reach this path. In the DB, **0 categories have a NULL or empty uuid** (query returned `[]`).

The `!editing.uuid` early return at `:99` is also ruled out as Jeff's symptom: it returns *before* the
confirm, and Jeff sees the confirm.

---

## 3. The categories, from the DB copy

Active station is **id=2 `halloVeen`** (`uuid 43889edc-203d-4743-9e4f-6ea311d6e035`, `is_active=1`).
16 category rows total, none with a NULL uuid.

What the Categories tab renders for the active station (`WHERE c.station_id = 2`, unfiltered):

| id | uuid | code | name | created_at | deleted_at | songs | clock_slots | programming |
|---|---|---|---|---|---|---|---|---|
| 7 | ea2cc1d5-… | HV | HalloVeen | 2026-07-06T18:55:13Z | — | 153 | 20 | 0 |
| **15** | 571d6471-… | ff | **tt test categoyr** | 2026-08-10T22:03:26Z | **2026-09-15T01:37:50Z** | 0 | 0 | 0 |
| 17 | cb078567-… | H1&2 | Early tracks (Not as scary) | 2026-08-13T19:36:22Z | — | 0 | 0 | 0 |

The other empty, never-deleted rows (other stations, so not on this tab): id=10 `DA/Dance`, id=11
`CW/Crowd `, id=12 `CH/Chill Hits` (all station 1, 0/0/0), id=13 `JG/Jingles` (station 3, 0/0/0).

**Which failure is firing: none.** Every candidate refusal is absent from the code path. Row 15 is the
proof — it was deleted successfully and is still displayed. Any category Jeff deletes joins it.

> **Caveat on recency.** This copy's newest write is `2026-09-23T22:04` and its `-wal` is 57 KB. If
> Jeff created the mistaken categories after that, they are not in these tables. That does not weaken
> the verdict — the defect is in the query, not in any particular row — but the specific rows he is
> looking at may be ones I cannot name.

---

## 4. ether-startup.log — no delete attempts recorded

`%APPDATA%\Ether\ether-startup.log` (1.6 GB, last write `2026-09-23 15:04:09` local).

Scanning the last 8 MB (87,041 lines), every `SESSION START` present:

```
2026-09-21T02:37:30Z  version: 43.5.1  packaged: false     (dev)
2026-09-21T02:55:18Z  version: 43.5.1  packaged: false     (dev)
2026-09-21T03:19:19Z  version: 4.6.46  packaged: true
2026-09-21T22:28:15Z  version: 4.6.46  packaged: true
2026-09-21T22:31:26Z  version: 4.6.46  packaged: true      ← last real user session
2026-09-23T22:04:05Z  version: 4.6.47  packaged: true      ← the packaged smoke, 65 s, ended in [SMOKE] PASS
```

Matches for `[categories]`, `categories:delete`, `mutation-writer`, `row not found`: **none.**

Two things follow, both flagged rather than smoothed over:

1. **The only 4.6.47 session on this box is my own packaged smoke.** The newest session a person drove
   is **4.6.46**, on 2026-09-21. If Jeff's attempts happened on this machine they are not in this log;
   if they happened elsewhere, this log is the wrong witness. Either way the version in the report and
   the version in the log do not agree, and that is worth settling before anything is built.
2. **A refused delete would leave no trace anyway.** Nothing on this path logs — not the handler, not
   `categoriesDelete`, not the renderer. `console.log('[categories] handlers installed')`
   (`categories.js:200`) is the only `[categories]` line in the file, emitted once at boot. Absence of
   log lines is therefore not evidence that nothing was attempted.

---

## Proposed fix — not built

**One-line cause, three-part fix. The third part is the one that matters for next time.**

1. **Filter the list.** `CategoriesTab.tsx:36` — add `AND c.deleted_at IS NULL`. This alone makes
   Delete appear to work, because it already does. Same for `ClocksTab.tsx:235`, so a deleted category
   stops being offered as a clock-slot target.

2. **Make the refusal reachable.** `CategoriesTab.tsx:104` — read the result and show it:

   ```ts
   const res = await (window as any).ether.categories.delete(editing.uuid, stationId);
   if (!res?.ok) { setSaveError(res?.error || "Delete failed"); return; }   // leave the editor OPEN
   load(); setEditing(null);
   ```

   `saveError` is already rendered in this component, so this costs nothing new. Without it, the next
   genuine refusal on this path is another silent no-op — the same class of bug, a second time.

3. **Decide what a non-empty category should do.** Today the delete is unconditional and the confirm
   says songs "lose this category assignment" — but nothing detaches them: `songs.category_id` keeps
   pointing at a soft-deleted row. Deleting `HV` (153 songs, 20 clock slots) would silently strip a
   live station's rotation. That is a separate decision for Jeff, not a fix to slip into this one, but
   it is the reason the missing `deleted_at` filter has been survivable so far: nobody could tell the
   deletes were landing.

**Not proposed:** any guard that refuses the delete. Jeff's categories are empty and he wants them
gone; adding a refusal would trade a silent no-op for a louder one.

**Regression cover this needs:** a check that a soft-deleted category is absent from what
`CategoriesTab.load()` reads, and one that a `{ok:false}` from the handler puts its `error` on screen.
Neither exists today — `smoke-categories-handlers.js` exercises the handler, not the list query.

---

## Appendix — provenance

- The query has been unfiltered since the Phase A split, which was explicit that it copied the code
  as-is: *"Extracted verbatim from Scheduler.tsx (Phase A, 2026-08-10) — lines 311-462 of the
  pre-split file. NO LOGIC CHANGED."* (`CategoriesTab.tsx:2-3`). The defect predates the split.
- DB copy: `openair.db` 748,408,832 B + `-wal` 57,712 B + `-shm` 32,768 B, taken 2026-09-24 with no
  Ether or ether-engine process running (`Get-Process` returned nothing).
- Diagnostic script: read-only `better-sqlite3` open with `{ readonly: true }`, run against the copy
  only. Held in the session scratchpad; nothing persistent was installed on this machine.
