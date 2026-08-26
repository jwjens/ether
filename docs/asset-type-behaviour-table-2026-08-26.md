# The asset type behaviour table — PROPOSED (2026-08-26)

**Status: SUPERSEDED in part. NOT BUILT.**

Two corrections from Jeff have reshaped this:
1. **The flagged behaviours are OPERATOR settings, not type identity.** The registry carries defaults;
   the operator edits them per station. See `docs/asset-type-fixed-vs-configurable-2026-08-26.md`.
2. **DUCKING IS NOT A TYPE BEHAVIOUR.** *"Beds are USER-CONTROLLED — the jock turns his own bed down
   manually when he talks, like riding a fader on a real board."* The `ducks` / `duckable` columns
   below are **removed from the design entirely** — not kept as advisory flags, because a control that
   does nothing at playout beside a ducker that works is the defect slice 4 already deleted once.
   Ducking stays exactly as built: Preferences → Ducker, DUCK ON per channel, duckable per deck.

Read the duck columns below as history. Everything else stands, now as DEFAULTS rather than rules.

Eight types now — SONG, SPOT, SWEEPER, ANNOUNCEMENT, VOICE_TRACK, BED, PROMO, SFX — with the system
open so a ninth is a one-place definition. Every behaviour below is declared in **one object per
type** in `src/lib/assetTypes.ts`; nothing downstream branches on a type name.

---

## 1. The behaviour table

| Type | Rotation-eligible | Scheduled by | Plays on | Ducks others | Is duckable | Separation | Counts as music | Commercial | Logs as |
|---|---|---|---|---|---|---|---|---|---|
| **SONG** | ✅ yes | rotation clock | rotation deck | no | ✅ **yes** | ✅ artist+title+file | ✅ yes | no | `SONG` |
| **SPOT** | ❌ no | traffic break | rotation deck | no | ❌ **no** | max-plays/day, date window | no | ✅ **yes** | `SPOT` |
| **PROMO** | ❌ no | traffic break | rotation deck | no | ❌ no | max-plays/day, date window | no | ❌ no | `PROMO` |
| **SWEEPER** | ❌ no | cadence (every N) | cart overlay¹ | ✅ **yes** | ❌ no | own cadence | no | no | `SWEEPER` |
| **ANNOUNCEMENT** | ❌ no | date-list | source channel | ✅ **yes** | ❌ no | none² | no | no | `ANNOUNCEMENT` |
| **VOICE_TRACK** | ❌ no | log element | rotation deck | ✅ **yes** | ❌ no | none | no | no | `VOICE_TRACK` |
| **BED** | ❌ no | manual / under | source channel | no | ✅ **yes** | none | no | no | `BED` |
| **SFX** | ❌ no | manual / macro | source channel | no | ❌ **no (immune)** | none | no | no | `SFX` |

¹ SWEEPER stays on the cart overlay in this arc. Moving it to a scheduled deck element is the separate
sweeper redesign and depends on the log-reader flip's Phase 3. This arc gives it the right **name** and
the right **store**, not a new playout path.

² ANNOUNCEMENT has no suppression by design — Jeff's standing ruling: it always fires on its schedule;
whether it airs is the board's fader and ON. Unchanged by this work.

### Reading the two duck columns

They are the two **separate** halves the ducker already has:

- **Ducks others** = it is a duck **SOURCE**. When it plays, everything duckable steps back.
- **Is duckable** = it is a duck **RECEIVER**. It steps back when a source is playing.

So a BED under a VOICE_TRACK works because BED is duckable and VOICE_TRACK ducks. An SFX punches
through because it is neither — nothing pulls it down and it pulls nothing down.

---

## 2. The rows I am least sure of — correct these first

These are judgement calls where standard practice is real but stations differ. Everything else in the
table follows straightforwardly from what already ships.

**a) SPOT `duckable: false`.** I set paid airtime as duck-immune: a commercial must not be attenuated
under anything, because it is what was sold. **But** if you want an emergency announcement to duck a
spot, this flips to `true`. *My read: keep spots immune.*

**b) PROMO — identical to SPOT except `commercial: false`.** A promo is station-owned, so it should
not appear on an advertiser affidavit as sold airtime, but it schedules and plays exactly like a spot.
**If you want promos rotation-eligible** (some stations drop them between songs rather than in breaks)
that is a one-flag change.

**c) VOICE_TRACK `ducks: true`.** A jock segment over a bed should pull the bed down. If your voice
tracks are always dry — no bed under them — this is harmless either way, but `false` is more honest
about what actually happens today.

**d) SWEEPER `ducks: true`.** A sweeper rides over the song's intro, which is what "ducks others"
means. Today it is a cart overlay on the master bus and does not use the ducker at all, so this flag
describes the **target**, not current behaviour. Say if you would rather it stay `false` until the
sweeper redesign actually moves it.

**e) BED `scheduler: 'manual'`.** I have beds as operator-triggered, playing under whatever is on. If
beds should be schedulable as log elements, that changes.

**f) SFX `bus: 'source-channel'`.** A stinger needs to play *over* the programme without stopping it,
which the source channel does. The alternative is the cart overlay, alongside sweepers. *My read:
source channel, because it is duck-immune and the overlay is built around ducking-by-arrangement.*

---

## 3. The full column set

Every column is a **capability** the rest of the product asks about. Nothing asks "is this a spot?"

| Column | Type | Asked by |
|---|---|---|
| `code` | string | stored in `library_asset.type`; also the log class |
| `label` / `labelOne` | string | every panel, tab and filter button |
| `badge`, `color`, `bg`, `border` | string | Play Log, queue, library rows |
| `rotationEligible` | bool | `loggen`, `generate-core` — may fill a music slot |
| `scheduler` | enum | who places it: `rotation` · `traffic-break` · `cadence` · `date-list` · `log-element` · `manual` |
| `bus` | enum | `rotation-deck` · `source-channel` · `cart-overlay` · `aux-deck` |
| `ducks` | bool | ducker source side |
| `duckable` | bool | ducker receiver side |
| `honorsSeparation` | bool | `separation-enforce`, rest maps |
| `countsAsMusic` | bool | analytics, spins, top-artist metrics |
| `commercial` | bool | affidavit / advertiser reporting |
| `metaTable` | string\|null | which side table holds its type-specific fields |
| `showAsTab` | bool | Library tabs are generated from this |
| `sortOrder` | number | display order everywhere |

**Meta tables:** `asset_music_meta` (SONG) · `asset_spot_meta` (SPOT, PROMO — station-scoped traffic
fields) · `asset_sweeper_meta` (SWEEPER) · none for ANNOUNCEMENT, VOICE_TRACK, BED, SFX.

---

## 4. THE OPENNESS TEST — adding a ninth type

Jeff's test. Here is **NEWS** — a scheduled newscast — added after the build is done.

### The whole change: one object.

```ts
// src/lib/assetTypes.ts
NEWS: {
  code: 'NEWS', label: 'News', labelOne: 'Newscast', badge: 'NEWS',
  color: '#38bdf8', bg: 'rgba(56,189,248,0.14)', border: 'rgba(56,189,248,0.45)',
  rotationEligible: false,
  scheduler: 'log-element',     // anchored in the log, like a top-of-hour element
  bus: 'rotation-deck',
  ducks: false, duckable: false,
  honorsSeparation: false,
  countsAsMusic: false,
  commercial: false,
  metaTable: null,
  showAsTab: true, sortOrder: 70,
},
```

### There is no second step. What happens automatically:

| | Mechanically, because… |
|---|---|
| Rotation never picks it | `loggen` filters `type IN (typesWhere(t => t.rotationEligible))` |
| Separation ignores it | rest maps filter on `honorsSeparation` |
| Analytics excludes it | music metrics filter on `countsAsMusic` |
| The affidavit excludes it | advertiser reporting filters on `commercial` |
| It never ducks and is never ducked | the engine reads `ducks` / `duckable` per element |
| Play Log badges it "NEWS" in blue | the badge reads the registry |
| The Play Log filter grows a **News** button with a count | the filter enumerates the registry |
| The Library grows a **News** tab | tabs are `typesWhere(t => t.showAsTab)` |
| It logs as `content_class='NEWS'` | the log class **is** the type code |
| An older build still shows it | `normalizeType()` degrades an unknown code instead of dropping the row |

**No migration.** `library_asset.type` carries **no `CHECK` constraint** — deliberately — so the schema
does not know the set of types and a new code needs no schema change. A transformer is needed **only**
if the type wants its own meta table, and then it adds one table and touches nothing else.

**This is the build's acceptance criterion:** when the work is done, adding a type is a diff of one
object. If it is not, the build is not finished — and there will be a test that asserts exactly this,
by registering a fake type at runtime and checking it appears in the rotation exclusion set, the
filter list and the tab list without any other change.

---

## 5. What I need from you

1. **Correct any row in §1** — especially the six flagged in §2.
2. **Confirm `library_asset` is install-scoped**, with station-specific data in the meta rows
   (`asset_spot_meta` is station-scoped for exactly this). Cheap now, expensive after the backfill.
3. **`songs_all`** — the delete-foundation VIEW work is local/uncommitted and reshapes the same table.
   It lands before this or is abandoned; the two cannot interleave.

Then I build: registry + tests first (step 1), then v50 and the backfill.
