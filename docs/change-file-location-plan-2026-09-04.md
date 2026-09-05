# OPEN / CHANGE FILE LOCATION · PLAN

**Status: CURRENT · last verified 2026-09-04 · PLAN. `CHANGE FILE LOCATION` NOT BUILT.**
`OPEN FILE LOCATION` **is built** (this session) — see §1.
Related: `docs/design-machine-local-paths-2026-09-04.md`, `docs/sync-health-foreign-paths-plan-2026-09-04.md`.

Build order confirmed by Jeff: **2.3 health signal first, then these.**

---

## 1 · OPEN FILE LOCATION — already built, partially wired

| piece | where |
|---|---|
| shared action + presence check | `src/lib/fileLocation.tsx` |
| reveal IPC (`path.resolve` + existence re-check) | `electron/main.js`, `system:revealFile` |
| preload | `system.revealFile` |
| wired: deck + queue | `src/lib/songActions.tsx` (`useSongMenu`) |
| wired: cart wall | `src/components/DeckConfigurator.tsx` |
| help | `docs/help-open-file-location.md` |

Disabled reasons already match the requirement — *"the audio isn't on this machine — this item needs
re-importing"*, so the operator can **see which are missing**.

**What is missing is surfaces, not the action.** The Library, Spots and Announcements panels have
**no right-click menu at all**, so nothing can travel there yet. Adding those menus is the remaining
work, and `CHANGE FILE LOCATION` should land in the same pass so each surface gains both at once.

---

## 2 · Q1 — does CHANGE FILE LOCATION generate an outbound mutation?

**It must not, and here is the mechanism.**

### 2.1 · How mutations are actually produced

There are **no triggers**. Every mutation comes from an explicit `withMutation(...)` call inside a
handler in `electron/sync/handlers/*.js`. **A write that does not go through a handler produces no
mutation** — which is exactly why the OV raw-SQL repair generated none.

### 2.2 · The trap this feature would walk into

Both tables the operator is repointing right now DO have handlers, and both would push the path:

- **`electron/sync/handlers/songs.js:19`** — `PATCHABLE` **includes `file_path`**, and update
  serialises the whole row (`:93-101`). 
- **`electron/sync/handlers/cart_slots.js`** — `persistSlot` in `DeckConfigurator.tsx:805` writes via
  `cartSlots.upsertBySlotNumber`, i.e. through the handler.

**So repointing a cart through the normal save path would push `C:\Users\jensj\...` straight back at
OV — re-creating this morning's incident in the opposite direction.** Jeff's instinct in asking was
correct.

### 2.3 · The decision

**`CHANGE FILE LOCATION` performs a LOCAL-ONLY write: a dedicated IPC that updates `file_path` (and
nothing else) directly, bypassing the handler, so no mutation is logged.**

Justification, not just convenience:

- **A location is local state.** The design doc §3 makes this the central principle, and
  `is_active`, `icecast_password`, `stream_key` and the playhead columns are already `local-only` for
  exactly this reason. This action is the operator asserting a fact about *this machine*.
- **It matches the sanctioned repair.** The OV fix was raw SQL, deliberately mutation-free.
- **It cannot make anything worse.** It only ever narrows what crosses the wire.

The IPC is deliberately narrow — one row, one column, by uuid — so it cannot become a general
mutation-bypass. It logs a health event (`kind:'manual-repoint'`) so a hand repoint is visible in the
ledger rather than being an invisible divergence between machines.

### 2.4 · THE RESIDUAL, STATED PLAINLY

**This does not close the leak.** `file_path` is still in `songs.PATCHABLE`, so the *next ordinary
edit* to that row — a title change, a cue edit, a category move — will serialise the repointed local
path into a mutation and push it. This feature stops **its own** write from leaking; it does not stop
the row from leaking later.

**The leak closes with the protocol amendment**, not here — specifically `[N-23a]`, which makes the
*receiver* take only the basename and discard the directory. Until that ships, the resolver tier
(option C) is what keeps a leaked path harmless.

I am not proposing to remove `file_path` from `PATCHABLE` as part of this feature: that changes what
every song edit transmits, and it belongs with the amendment and its migration, not smuggled in
behind a menu item.

---

## 3 · Q2 — offer the obvious candidate first

When the item's file is missing, the picker does **not** open cold:

1. **Compute the suggestion first.** If `<music_dir>\<basename of stored path>` exists, present it
   before any dialog:

   > **Move this item's file?**
   > `dragon-studio-monster-growl-410553.mp3`
   > Found in your music library.
   > **[ Use this file ]  [ Choose another… ]  [ Cancel ]**

2. **`Use this file`** repoints immediately — one click, no navigation. This is the exact case the
   operator hit: files moved into the library folder, rows still pointing at `Downloads`.
3. **`Choose another…`** opens `dialog.openFile` with the audio filters, **defaulting to the music
   dir** rather than the last-used directory.
4. **No suggestion?** Go straight to the picker — no dead dialog for the sake of symmetry.

**Reuses 2.3's basename index**, which is why these build after it: the same "is this basename in the
music dir" question, answered once, in one place.

### 3.1 · Scope guard — one row, never a sweep

`CHANGE FILE LOCATION` repoints exactly the row that was right-clicked. It is **not** a bulk repair,
and it must not grow into one behind a menu item. A bulk "repoint everything that matches by
basename" is the resolver tier's job — automatic, and already authorised separately.

---

## 4 · Where both actions live

Both belong to any item with a `file_path`, so they go in the shared set (`fileLocation.tsx`) and
travel together. Surfaces, in the order they need doing:

| surface | menu today | work |
|---|---|---|
| deck, queue | `useSongMenu` | add CHANGE only |
| cart wall | own menu | add CHANGE only |
| **Library** | **none** | needs a menu |
| **Spots** | **none** | needs a menu |
| **Announcements** | **none** | needs a menu |
| Sweepers (JINGLES panel) | none | needs a menu |

`CHANGE FILE LOCATION` is disabled with a reason only when the item has **no `file_path` column at
all**. Unlike OPEN, a **missing file is precisely when the operator needs it** — so a missing file
must leave it ENABLED. Getting that backwards would disable the control exactly when it is wanted.

---

## 5 · Tests

| id | assertion |
|---|---|
| **C-1** | a repoint writes `file_path` and logs **no** row in the mutation log |
| **C-2** | the suggestion is offered when `<music_dir>\<basename>` exists, and is not fabricated when it does not |
| **C-3** | repointing one row leaves every other row untouched |
| **C-4** | CHANGE is **enabled** on an item whose file is missing (the inverse of OPEN's rule) |
| **C-5** | a `cart_slots` repoint to a file outside the music dir is allowed and not rebased (design doc T-new-4) |
| **C-6** | after a repoint, 2.3 reclassifies the row from `foreign`/`dead` to `resolves` |

C-1 is the gate. C-6 is what proves the two features are one system.

---

## 6 · OPEN — needs Jeff

1. **Confirm the local-only write** (§2.3) and that you accept the residual in §2.4 — the row can
   still leak its path on a *later* ordinary edit, until the amendment lands.
2. **Do the three missing panels get right-click menus in this pass**, or only Library first? Each is
   a small menu, but it is four surfaces rather than one.
