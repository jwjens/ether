# Cart wall persistence — trace before the build

**Date:** 2026-07-31 · **Mode:** READ-ONLY. Live DB opened `readOnly: true`, source read. Nothing changed.
**Question:** do cart assignments survive an app restart today?

---

## Verdict

**No. The cart wall a jock actually uses keeps its assignments in React state and writes nothing.**

But the picture is better than "no persistence exists" — **the whole persistence layer is already built and
registered. It is simply not connected to the wall.** This is a wiring job, not a from-scratch design.

| Layer | State |
|---|---|
| `cart_slots` **table** | ✅ **Exists**, full synced shape: `id, slot_number, title, file_path, color, hotkey, station_id, uuid, created_at, updated_at, deleted_at, station_uuid` |
| Sync registration | ✅ **Registered** — `electron/sync/synced-tables.js:18` and `:113-114` |
| IPC surface | ✅ **Complete** — `cartSlots.list / getById / create / update / upsertBySlotNumber` (`electron/preload-handlers.js:42-46`) |
| Backup / restore | ✅ Included — `electron/main.js:1257, 1273` |
| **Rows in the live DB** | ❌ **0** |
| **`BoutiqueCartWall` (the wall)** | ❌ **Never calls any of it** |
| Intended consumer | ❌ `main.js:55` names `src/components/CartWall.tsx` — **that file does not exist** |

## Receipts

**The table is real and correctly shaped** — `uuid`, `station_uuid`, soft delete: the same contract as
`deck_configs`, ready to sync:

```
cart_slots cols: id, slot_number, title, file_path, color, hotkey,
                 station_id, uuid, created_at, updated_at, deleted_at, station_uuid
rows: 0
```

**The wall writes nothing.** Grepping the entire `BoutiqueCartWall` component
(`src/components/DeckConfigurator.tsx:493-700`) for any persistence call — `cartSlots`, `upsert`,
`localStorage`, `stationConfigKv`, `query(` — returns **one** hit, and it is a file-picker dialog:

```
:576  ether.dialog.openFile({ … })      ← assigning audio, not saving the assignment
```

State is seeded from a hardcoded constant on every mount:

```ts
DeckConfigurator.tsx:484   const DEFAULT_CART_KEYS = ["1","2","3","4","5","6","7","8","9","0","Q","W","E","R","T","Y","U","I"];
DeckConfigurator.tsx:500   const [carts, setCarts] = useState<CartSlot[]>(DEFAULT_CART_KEYS.map(…))
```

**Every assignment dies with the component.** Not merely on restart — on any unmount.

**`songs.cart_id` (migration v20) is orphaned.** The column and its index exist; **0 rows use it**, and no
code reads or writes it. A different, earlier approach to the same problem, abandoned. It is not the
foundation to build on — `cart_slots` is.

**One real consumer exists**, and it is not the wall: `ProducerDesk.pushToCart`
(`src/components/ProducerDesk.tsx:274-284`) reads `cart_slots` and calls `upsertBySlotNumber` to push a
producer note into a free slot. So the write path is **proven to work** — it just has no reader on the
wall side. A note pushed from the Producer Desk today lands in the DB and **never appears on the cart
wall.**

Note it also hardcodes `18` (`for (let i = 0; i < 18; i++)`) and says *"All 18 cart slots are full."* —
one of the counts to derive.

## What this means for the build

**Jeff's instinct is right and the sequencing follows from the trace: persistence first.** A 64-slot park
wall that forgets itself is worse than an 8-slot one that remembers. And because the table, sync
registration and IPC already exist, **persistence is the smallest of the three layers, not the largest.**

**Release 1 — persistence (shippable and valuable on its own).**
Load `cart_slots` on mount (station-scoped, `slot_number`-ordered), write on assign / label edit / clear
via `upsertBySlotNumber`, seed defaults only when the station has no rows. **Fixes a second bug for free:**
the Producer Desk's `pushToCart` becomes visible on the wall, which today is a silent write to nowhere.
No visual change, no count change — the wall people have now, remembering itself.

**Release 2 — the wall.** 64 slots, square tiles, rows of 8 flexing to 4, window opens at 4 rows + scroll;
bottom strip 24 (3×8). Counts derived, not hardcoded — the sites are `DEFAULT_CART_KEYS` (18),
`slice(0, 8)` in the strip render (`:589`), and `ProducerDesk`'s `18`.

**Release 3 — MIDI.** Scoped below.

### The key strategy is a real design question, not a detail

`DEFAULT_CART_KEYS` is 18 keys (`1-0`, `QWERTYUI`). **64 slots cannot each have a single keystroke.** The
honest options: keys for the first N only (the strip's 24, say) with the rest click/MIDI-only; or a
bank/shift modifier. **I am not deciding that alone** — it changes how a jock's hands work during a shift.
Flagging it now because it shapes the schema (`hotkey` is already a column, so the DB is ready either way).

## MIDI scope (release 3)

**Confirmed available:** `midir` is active with device profiles for RØDECaster Pro II, X-Touch and
DDJ-1000SRT. **The mapping UI is the unbuilt half** — that matches your description.

Scoped as: **pad → cart slot, per device, persisted with the cart config.** Note-on fires the cart through
the same path as click and key, so there is one fire path with three triggers rather than three
implementations. `cart_slots` already has `hotkey`; a MIDI binding wants its own column or a small
companion table keyed by device profile — **I have not yet read the profile format**, so I will not
specify the shape until I have.

**Velocity and pad-light feedback: v2**, explicitly. Feedback requires MIDI *output* per device, and what
each profile supports I have not verified. **Not promising lights until I have read the profiles.**

---

## Scope note

Read-only. Live DB opened `readOnly: true` and closed; source read, not modified. No file in `C:\openair`
changed, nothing committed, nothing built.
