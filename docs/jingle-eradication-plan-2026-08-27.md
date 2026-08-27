# Retiring "jingle" — the deep rename to Sweepers

**READ-ONLY PLAN. No code written, no migration created, nothing applied.**
Source of truth for the library arc: `docs/library-current-state.md`.

Date: 2026-08-27 · Branch `log-reader-flip` · Ruling: one imaging concept, "jingle" removed entirely.

---

## 0. The decision — Option A confirmed (JIN → SWP)

**Recommend Option A.** The deciding fact, measured on the live DB:

```
songs               JIN=64      SWP=0
generated_schedule  JIN=46,349  SWP=0
play_log            JIN=16,357  SWP=0
jingle_categories   JIN=4       SWP=0
```

**`SWP` is entirely unused.** So JIN→SWP is a pure relabel of one value with no collision and no
merge — nothing has to be reconciled, because there is nothing on the SWP side to reconcile with.

Option B (`SWEEPER`) costs strictly more for no gain:

- it rewrites the same 62,774 rows **and** invalidates every existing `'SWP'` literal, roughly
  doubling the code churn;
- the alignment it promises is illusory. `content_class` and `library_asset.type` are already
  deliberately different vocabularies — `MUSIC`↔`SONG`, `ANN`↔`ANNOUNCEMENT` — and only `SPOT`
  happens to match. Aligning the sweeper alone makes the system no more consistent than it is now.

Where the two vocabularies meet, the mapping is made explicit in one place rather than by coincidence
(§5). **Proceeding on Option A unless overruled.**

---

## 1. Migration v52 — the data

### What makes this safe

Verified on the live database before writing anything:

| check | result |
|---|---|
| `CHECK` constraint on `content_class` (songs / generated_schedule / play_log) | **none** |
| `CHECK` constraint on `jingle_categories.type` | **none** |
| Foreign keys referencing `jingle_categories` | **none declared** (`jingle_category_id` is an undeclared reference) |
| `PRAGMA foreign_keys` | ON — but with no FK to violate |

No constraints means a plain `UPDATE`. **No table rebuild, no column drop, no reshape** — so the
database stays openable by the previous build, which is the 4.4.151 rule
(`docs/migration-safety-and-customer-recovery-2026-08-06.md`).

### The SQL

```sql
-- 1. The pools and the songs move TOGETHER. This is the one atomic pairing in the whole change:
--    the overlay scheduler selects imaging with
--        WHERE s.jingle_category_id = ? AND s.content_class = ?   (electron/main.js:7887)
--    and supplies that second parameter from the POOL'S TYPE (main.js:7914). If the songs become
--    SWP while the pools stay JIN, resolvePool() matches nothing, returns an empty candidate list,
--    and imaging silently stops airing — the catch swallows it and the caller just continues.
UPDATE jingle_categories SET type = 'SWP', updated_at = @now WHERE type = 'JIN';
UPDATE songs             SET content_class = 'SWP', updated_at = @now WHERE content_class = 'JIN';

-- 2. The log. 46,349 rows, of which 44,098 are still PENDING — this is mostly the FUTURE log, not
--    history, so it is migrated rather than left alone.
UPDATE generated_schedule SET content_class = 'SWP' WHERE content_class = 'JIN';

-- 3. The as-run record. 16,357 rows. Migrated per the ruling that the name is gone entirely.
UPDATE play_log SET content_class = 'SWP' WHERE content_class = 'JIN';
```

### Idempotency

By outcome, not by a flag: every statement is `WHERE … = 'JIN'`, so a second run matches zero rows.
`isAlreadyMigrated(db)` returns true when no `'JIN'` remains in any of the four tables, matching the
shape v51 uses.

### It must NOT journal

Raw `UPDATE`s inside one `db.transaction()`, **not** `withMutation`. Three reasons, in order of
severity:

1. **Double application.** Migrations run on every install. A journalled backfill arrives twice on a
   peer — once from its own v52, once from the incoming mutation. v50 and v51 journal zero for the
   same reason.
2. **Journal flood.** 62,774 mutations in one go. `generated_schedule` already holds **27,886**
   journal rows and `play_log` **6,538**; `docs/backlog.md` records `generated_schedule` as the
   largest single contributor to sync backlog. This would roughly triple it in one migration.
3. **Convergence does not need it.** The transformation is deterministic — every install computes
   the identical result from data it already has.

### What v52 does NOT touch

`library_asset` (already `SWEEPER=64`, correct and untouched), `songs.jingle_category_id` values,
`station_programming`, `song_metadata_values`, and the `jingle_categories` **table name** (§4).

---

## 2. ⚠ THE ONE THING THAT CHANGES WHAT AIRS — needs your ruling

`electron/main.js:7943`:

```js
const DEFAULTS = { JIN: { lead: 5, under: 2 }, SWP: { lead: 2, under: 1 } };
…
lead_in_sec:   leadOverride  != null ? leadOverride  : def.lead,
underlap_sec:  underOverride != null ? underOverride : def.under,
```

`def` is chosen by the picked item's class. **Today everything is JIN, so every generated overlay
gets a 5s lead-in and 2s underlap. After v52 everything is SWP, so new overlays get 2s / 1s.**

The overrides do not save you: `leadOverride` comes from `categories.overlay_lead_in_sec`, and
**0 of 15 categories set one**. So the default is what has been airing, and it would change.

Imaging would sit noticeably tighter against the music. Not a break — an audible change.

**Recommendation: collapse `DEFAULTS` to a single sweeper default of `{ lead: 5, under: 2 }`** —
preserving exactly what airs today. There is only one type after this change, so there should be
only one default. Adopting SWP's 2/1 would be changing the sound as a side effect of a rename, which
is not what a rename should do.

**Incidental, not fixed here:** `main.js` reads `jingle_categories` exactly once — `SELECT type`.
The pools' own `lead_in_sec`/`underlap_sec` are never read at generation, so pool 2's tuned
`10/13.5` is being ignored today. Pre-existing; flagging only.

---

## 3. UI consolidation

### `JinglesPanel.tsx` → `SweepersPanel.tsx`

The two-tab structure collapses cleanly — nothing in the code requires two classes to exist.

| now | after |
|---|---|
| `const [tab, setTab] = useState<"JIN"\|"SWP">` | removed |
| `tabPools = pools.filter(p => (p.type \|\| "JIN") === tab)` | `pools` (all are SWP) |
| `tabSongs = songs.filter(s => s.content_class === tab)` | `songs` |
| `{t === "SWP" ? "SWEEPERS" : "JINGLES"}` tab buttons (line 193) | deleted — the panel *is* Sweepers |
| `{tab === "SWP" ? "Sweepers" : "Jingles"} ({tabSongs.length})` (218) | `Sweepers ({songs.length})` |
| `Mark as {tab === "SWP" ? "Sweeper (SWP)" : "Jingle (JIN)"}` (220) | `Mark as Sweeper` |
| `accent = tab === "SWP" ? SWP_INDIGO : JIN_TEAL` | one accent |
| `createPool` — `type: tab`, `lead_in_sec: tab === "SWP" ? 2 : 5` | `type: 'SWP'`, single default |
| `optgroup label="Jingle pool (rotates)"` (147) | `Sweeper pool (rotates)` |

`ClassPoolSelect.tsx` loses its `["JIN","SWP"]` two-button toggle entirely (the pool dropdown stays).

### Other user-facing sites

- `src/App.tsx` context menu (5614-5615): "Mark as Jingle (JIN)" / "Unmark Jingle" — **delete**;
  keep only the Sweeper pair.
- `src/App.tsx` 5866/5869: two class badges collapse to one.
- `BroadcastCalendar.tsx:75`: the `JIN → "Jingle"` label — delete, SWP→"Sweeper" already exists.
- `MidiEngine.tsx`, bottom-bar button — **already renamed** on 2026-08-27.
- `docs/help-jingles.md` → `docs/help-sweepers.md`, plus 12 other help docs mentioning jingles.

### File rename

`JinglesPanel.tsx` → `SweepersPanel.tsx`. One import site (`src/App.tsx:52`). Low risk. Note the
internal panel key `progPanel === "jingles"` is **state, not a label** — renaming it touches every
call site for no operator-visible gain, so it stays unless you want it.

---

## 4. Renaming the `jingle_categories` TABLE — recommend NOT now

This is the one genuine blocker in the whole plan.

`jingle_categories` is a **synced table** (`electron/sync/synced-tables.js:31, 281`). The receiver
dispatches on the table name:

```js
const entry = REGISTRY[m.table_name];      // merge-engine.js:111 and :330
```

and `mutation-writer.js:234` rejects any write to a table not in the registry. So an install with the
table renamed would receive a peer's mutation carrying `table_name: 'jingle_categories'`, find no
registry entry, and **drop it silently** — two installs diverging with nothing on screen to say so.
That is the same class of defect as the peer-sync station-identity bug already on file.

Blast radius if done anyway: 68 `jingle_categories` refs + 40 `jingle_category_id` refs in source, an
`ALTER TABLE … RENAME`, five already-shipped migrations that reference it by name (v29-v32, v50) and
which the transformer chain replays on every fresh install, plus a registry alias shim so peer
mutations under the old name still apply.

**Recommendation: keep the table name.** It is invisible to the operator, and the ruling is about the
name users see. If you want it renamed, it should be its own migration (v53) with the alias shim
designed first — not folded into v52.

---

## 5. Code refactoring — the real surface

Source only; build artifacts (`dist/`, `dist-electron/`) excluded, which is why these numbers are
lower than the 600 estimated.

| category | count | disposition |
|---|---|---|
| (a) user-facing strings | 47 | **change** — §3 |
| (b) code identifiers (`jingleCategories`, `jinPools`, `JIN_TEAL`, `readJingleForSeam`, `onJingle`) | 90 | **mostly leave.** Renaming identifiers is churn with no operator-visible effect and a real merge-conflict cost. Rename only where a name would now mislead a reader — e.g. `JIN_TEAL` → `SWEEPER_TEAL`. |
| (c) DB identifiers (`jingle_categories`, `jingle_category_id`) | 108 | **leave** — §4 |
| (d) `'JIN'` literals | 97 across 40 files | **remove from live code paths**, keep in history — below |
| (e) help docs | 13 files | **change** |

### Removing the `'JIN'` literal

Live code paths where `'JIN'` must go (~14 source files):
`audiod/autofit.js`, `audiod/engine.js`, `audiod/loggen.js`, `electron/main.js`,
`electron/audio-health.js`, `electron/library-health.js`,
`electron/sync/handlers/{generated_schedule,jingle_categories}.js`, `electron/sync/synced-tables.js`,
`src/App.tsx`, `src/audio/{health.tsx,imagingCommit.ts}`,
`src/components/{BroadcastCalendar,ClassPoolSelect,ConsoleStrip,JinglesPanel,ReelSplitter,StudioSendBar,UpNext}.tsx`,
`src/lib/{albumArt.ts,classColors.ts,contentClass.tsx}`.

Most are the harmless pass-through form `x === 'SWP' ? 'SWP' : 'JIN'`, which simply becomes `'SWP'`.

**Must NOT change** — these are history, and rewriting them breaks chain replay on fresh installs:
`scripts/migrate-content-class-phase-sync-29.js`, `migrate-jingle-categories-phase-sync-30.js`,
`migrate-generated-schedule-jingle-placement-phase-sync-31.js`,
`migrate-overlay-assignment-phase-sync-32.js`, `migrate-library-asset-phase-sync-50.js`.
Their `typeFromContentClass` must keep mapping `JIN → SWEEPER` so a pre-v52 database still migrates
correctly.

**The one place `'JIN'` should remain in live code** is a documented back-compat read: any row that
predates v52 arriving from an un-migrated peer. Proposal — one constant in `src/lib/contentClass.tsx`:

```ts
export const SWEEPER: ContentClass = "SWP";
/** Pre-v52 rows and peers still say JIN. Read it, never write it. */
export const LEGACY_SWEEPER = "JIN";
export const isSweeper = (v?: string|null) => v === SWEEPER || v === LEGACY_SWEEPER;
```

Every branch then uses `isSweeper()`, and `'JIN'` appears exactly once in the codebase.

---

## 6. Play Log filter + engine

- `src/lib/contentClass.tsx`: `ContentClass` drops `"JIN"`; `CLASS_ORDER` becomes
  `["MUSIC","SPOT","SWP","ANN"]`; `normalizeClass` maps a legacy `"JIN"` → `"SWP"` so historical rows
  from an un-migrated peer still render under the single Sweepers chip. One chip, correct count.
- Engine/rotation already treats them identically — `autofit.js:27` excludes both from `isMusic`,
  `loggen.js` selects `IN ('JIN','SWP')`, `engine.js` passes the class through. **Nothing in the
  scheduler branches on the distinction**, so there is no rotation risk in this change. That was
  verified before this plan was written.

---

## 7. Risks

| risk | severity | mitigation |
|---|---|---|
| Pools retyped without songs (or vice-versa) → **imaging silently stops airing** | **high** | one transaction; assert both counts post-update; the proof harness re-runs `resolvePool` |
| Lead-in/underlap default changes 5/2 → 2/1 | **medium, audible** | §2 ruling before v52 lands |
| 62,774 journalled mutations flooding sync | **high** | raw UPDATEs, no `withMutation` |
| Table rename orphaning peer mutations | **high** | not doing it (§4) |
| Editing shipped migrations breaks fresh-install replay | **high** | v29-32/v50 are frozen |
| An un-migrated peer sends `JIN` rows | low | `isSweeper()` / `normalizeClass` read both |

**No foreign-key blocker exists** — `jingle_category_id` has no declared FK.

---

## 8. Proposed sequence

1. **You rule** on §2 (the timing default) — this gates everything.
2. **v52 migration** + a proof harness: before/after class counts per table, `resolvePool` still
   returns candidates for all 4 pools, rotation pools unchanged on all four stations.
3. **UI consolidation** — one tab, file rename, context menu, badges, calendar label.
4. **Code sweep** — `isSweeper()` constant, `'JIN'` removed from live paths.
5. **Help docs** — `help-jingles.md` → `help-sweepers.md` + 12 others.
6. Verify on the running app, then commit.

Steps 2-3 are the ones that touch air and want their own verification pass. Nothing is pushed until
you have seen sweepers still firing.
