# The unified library build — full session record

**Purpose:** a complete, honest record of what was built, why, and where the approach may be wrong,
so the design can be researched and judged independently. Written at Jeff's request after he
identified that the work had drifted wider than his ask.

Dates: 2026-08-26 → 2026-08-27 · Branch: `log-reader-flip` · Nothing pushed.

---

## 1. What was asked for

Jeff's stated goal, in his words across the arc:

> "spots, sweepers, and announcements become entries in the ONE library, tagged by type, instead of
> living in their own separate panels/tables. The panels become filtered views of the library. That's
> the RCS model — one library, everything typed, filter to see each type."

And on how to build it:

> "NEW library_asset table — the clean version, built right the first time, not growing songs and
> renaming later. I've been burned all week by the easier way leaving cruft; we do it properly now."

> "this is all dev, nothing's on air, so don't stage it around broadcast safety or hide things behind
> canary flags."

> "the TYPE system must be EXTENSIBLE… Show me how a new type gets added under your design before you
> build — that's the test of whether it's actually extensible."

**Binding constraints Jeff stated, all of which came from him correcting me:**

| constraint | how it arose |
|---|---|
| The library is INSTALL-scoped — an asset is a file, shared by all stations | Jeff: "the audio files are ONE shared library all stations draw from" |
| But per-station treatment is real and live | Jeff: "it does exist each song is treated differently to each station"; "it is live 4 stations are working independently right now" |
| ALL metadata is per-station overridable — every field | Jeff: "ALL metadata is changeable per station in the library — every field (title, artist, category, all of it)" |
| Custom metadata categories are user-created and UNLIMITED, per station | Jeff: "categories are UNLIMITED. There is no set number… I create as many as I want" |
| Ducking is a CHANNEL/DECK function, never a property of content type | Jeff: "available to ANYTHING on that deck — mic, announcement, any source" |
| Beds are user-controlled — no automatic ducking | Jeff: "the jock turns his own bed down manually… like riding a fader on a real board" |

---

## 2. What was actually built

Four commits, all local, all on `log-reader-flip`:

| commit | step | contents |
|---|---|---|
| `6c74910` | 1 — type registry | `shared/asset-types.json` (8 types), `src/lib/assetTypes.ts`, `electron/asset-types.js`, parity smoke, unit tests — 716 lines |
| `f725792` | 2 — the table | `scripts/migrate-library-asset-phase-sync-50.js` + smoke — 476 lines |
| `cb9f8c9` | 3 — sync | `library_asset.js` + `asset_meta.js` handlers, registry entries, preload — 611 lines |
| `93ba3f8` | 4a — reader flip | asset-field reads in both loggens + 3 proof harnesses + plan doc — 717 lines |

Preceded by six docs-only commits recording constraints Jeff supplied (`5ab306a`, `533904d`,
`5881eeb`, `b603e15`, `144284d`, `56aaa3b`).

### 2.1 The type registry (step 1)

One JSON file defines eight types. Structural fields sit at top level; operator-configurable defaults
sit under `defaults`:

```
SONG · SPOT · PROMO · SWEEPER · ANNOUNCEMENT · VOICE_TRACK · BED · SFX
```

The extensibility test Jeff demanded — adding a ninth type — is: append one object to
`shared/asset-types.json`. No code edit. Queries derive their type lists from the registry
(`typesWhere`, `placeholders`), so a new type is included the moment it is declared. `normalizeType`
degrades an unknown code to SONG for display rather than dropping the row.

**Design decision:** behaviours Jeff flagged as operator decisions (`rotationEligible`, `scheduler`,
`bus`, `honorsSeparation`, `countsAsMusic`, `showAsTab`, `sortOrder`, labels) are *defaults*, not
hardcoded type properties. No duck flags exist anywhere in the registry — per Jeff's correction that
ducking belongs to the channel.

### 2.2 The table (step 2, schema v50)

```
library_asset        INSTALL-scoped. No station_id. No category_id. No CHECK on `type`.
asset_spot_meta      STATION-scoped — the same file can be sold to two stations on different terms.
asset_sweeper_meta   install-scoped.
station_programming  WIDENED with asset_uuid (not replaced).
song_metadata_values WIDENED with asset_uuid (not replaced).
```

Three deliberate choices worth challenging:

- **No `CHECK` on `type`.** A newer peer may sync an asset of a type this build has never seen.
  A CHECK would reject the row and the asset would vanish from this install. Unknown types are
  STORED as given and only *displayed* through `normalizeType`.
- **The overlays are widened, not replaced.** `station_programming` and `song_metadata_values` keep
  `song_id` and gain `asset_uuid`. This preserves the per-station treatment that Jeff confirmed is
  live on four stations.
- **`library_asset` carries defaults, never truths.** Title/artist there are what a station sees
  *until* it overrides them in `song_metadata_values`. Any writer treating a column there as
  authoritative for a station is wrong.

### 2.3 Sync registration (step 3)

Both new tables write through `withMutation` with a no-op guard (a write that changes nothing must
never journal a mutation, because every peer pushes, pulls, applies and retains it forever).

This step also **fixed a defect I had shipped in v4.4.231**: I had put `announcement_uuid` in a
`refs` map. `refs` is uuid-identity *remapping* for columns holding local integer ids; a uuid needs
none of that, and listing one made every row look dangling to `rebaselineScan`.

### 2.4 The reader flip (step 4a)

Asset fields (`file_path`, `file_key`, `title`, `duration_ms`, `artist_id`, `intro_end`,
`outro_start`, `bpm`, `energy`, `is_explicit`, `last_played_at`, `content_class`→`type`) now resolve
from `library_asset` in `audiod/loggen.js` and `src/audio/loggen.ts`.

Two fallbacks, both about never producing dead air:

- **The table may be absent.** Migrations are fail-soft, so an install where v50 failed has no
  `library_asset`. A hard reference would make every rotation query throw — and `pickTier` swallows
  SQL errors into an empty pool, so the station would go silent with nothing in the log saying why.
  The table is probed once per DB handle; the pre-flip SQL is kept verbatim as fallback.
- **The row may be absent.** No importer writes `library_asset` yet, so a song imported after v50 has
  no asset row. Hence `LEFT JOIN` + `COALESCE`, not `INNER JOIN`.

---

## 3. Evidence produced

Three harnesses ship with the work. All read-only.

| script | what it proves |
|---|---|
| `scripts/prove-rotation-pool.js` | the eligible POOL under three predicates (today / asset-flip / per-station), per station per hour |
| `scripts/prove-asset-field-parity.js` | every field the flip moves, compared row by row across all 436 rotation-reachable songs |
| `scripts/prove-flip-4a-live.js` | the REAL flipped loggen SQL, via its exported internals, against the pre-flip baseline |

Result on the live 4-station DB:

```
Open Format 163/hr · halloVeen 151/hr · Magical Forest 76/hr · Christmas in Jully 46/hr
4 stations × 24 hours · 10,464 rows compared · 0 drift · 0 swallowed SQL errors
field parity: 0 mismatches across 10 fields × 436 songs
```

Jeff verified rotation on all four stations on the running app before the commit.

**Why the pool and not the sequence:** rotation picks with `ORDER BY … RANDOM()`, so comparing the
log it produces proves nothing — two identical systems produce different logs. The invariant is the
set rotation is allowed to draw from.

### Two false greens caught

Both are worth recording because they are the failure mode this kind of work is most prone to:

1. `prove-rotation-pool` printed `VERDICT: A ≡ B on every station and hour` while comparison B had
   been **skipped** for a missing table. Fixed to print `NOT EVALUATED`.
2. A ten-zero parity result is indistinguishable from a broken comparator. A negative control was
   added — comparing `title` against `file_path`, which must mismatch on every row. It reported
   436/436, proving the comparator can fail.

A third check confirmed the live DB resolved to the asset path (`ASSET_ON`) — otherwise "identical"
would have been true for the trivial reason that the pre-flip SQL ran.

---

## 4. Where the approach went wrong

**Scope drift, identified by Jeff on 2026-08-27.**

I framed step 4 as "the reader flip" — flipping *all* readers off `songs`. Inventorying those readers
swept in rotation's programming columns (`category_id`, `rotation_status`, `daypart_mask`,
`no_repeat_hours`), which are per-station concerns. That produced:

- a proposed split into 4a (asset fields) and 4b (programming fields);
- a measured blocker for 4b — `station_programming` holds 12 rows against 436 categorised songs, so
  flipping it would yield a **zero-song pool on all four stations**;
- a proposed v51 backfill to create the missing per-station rows.

**None of that is required for the stated goal.** Jeff's challenge:

> "The 4b rotation-scoping flip and the 436-row-per-station backfill are NOT part of 'add
> spots/sweepers/announcements to the library' — that's re-architecting rotation's per-station
> scoping, which I did not ask for."

He is right. Rotation's per-station scoping governs *how music is picked for a station*. It touches
`station_programming`, which has 12 rows, **zero of them for JIN/SWP/SPOT**. Spots, sweepers and
announcements never touch that table. Typing them and filtering panels by type does not read or write
it.

The cause was mine: I read "unified library" as "unify everything `songs` does," which is a larger
claim than "put every asset in one typed table." v51 was stopped at the read-only probe; nothing was
written.

**Open question for research:** was step 4a itself necessary? It is committed, proven pool-identical,
and does move readers onto the library — but it was not required for the stated goal either. It is
the tip commit and reverts cleanly.

---

## 5. What the goal actually needs

Measured on the live DB, 2026-08-27:

```
library_asset (already typed)      the separate homes they still live in
   SONG      444                      spots table           3  → 0 missing asset rows
   SWEEPER    64                      announcements         5  → 5 MISSING
   SPOT        3                      songs JIN            64  → 0 missing (typed SWEEPER)
   TOTAL     511                      songs SPOT            2

station_programming: 12 rows — 0 of them for JIN/SWP/SPOT
```

**Spots and sweepers are already in the one library with the right type.** v50 did that. The only
data gap is announcements.

Minimal remaining path:

1. **Announcements into the library** — 5 rows, `type='ANNOUNCEMENT'`, plus the writer in the
   announcement create path.
2. **Panels become filtered views** — `src/components/Spots.tsx` and `src/components/Announcements.tsx`
   read `ether.spots` / `ether.announcements`; `JinglesPanel` reads sweepers via `content_class='JIN'`.
   Point all three at `library_asset:list({types:[…]})`, which already exists and is registered.
3. **Writers** — creating a spot/sweeper/announcement writes a `library_asset` row, plus
   `asset_spot_meta` for traffic terms (already built, already station-scoped).

Old tables can remain as type-specific meta side-tables. That is what `asset_spot_meta` is for.

---

## 6. Questions worth researching before continuing

1. **Is a separate `library_asset` table right, or should `songs` have been renamed/widened?** The
   clean-table choice was Jeff's explicit ruling ("not growing songs and renaming later"). The cost
   is a transition period where two tables describe the same files and writers must keep both — which
   is exactly the state the tree is in now.
2. **Is `type` on the asset the right axis?** RCS separates *category* (rotation) from *media type*.
   The design keeps three orthogonal axes — TYPE (registry, install-wide), CATEGORY (unlimited,
   per-station), METADATA (unlimited custom fields, per-station). Confirm that matches how Zetta
   actually models it.
3. **Should the per-station overlay be `station_programming` at all?** It was designed for music
   rotation. If spots/announcements ever need per-station treatment, does that belong there, in
   `asset_spot_meta`, or somewhere new?
4. **Does `asset_spot_meta` being station-scoped while `asset_sweeper_meta` is install-scoped hold
   up?** The rationale was that the same audio can be sold to two stations on different terms, while
   a sweeper is the same sweeper everywhere. Worth challenging.
5. **The writer flip has no plan yet.** No importer writes `library_asset`. Until it does, every new
   file rides the `songs` fallback, and the two tables drift apart.

---

## 7. State as of this record

- Four library commits local on `log-reader-flip`, unpushed: `6c74910`, `f725792`, `cb9f8c9`, `93ba3f8`
  (plus `6c74910`'s predecessor docs commits).
- v50 applied to the live DB; schema_version = 50; transformer chain verified v2→v50, no gaps.
- Rotation verified by Jeff on all four stations after 4a.
- v51 backfill: **stopped**, read-only probe only, nothing written.
- 4b: **not flipped**, and not required for the stated goal.
- Gates green: `tsc --noEmit` exit 0; `loggen-category-gate` 9/9 unmodified; content-class exclusion
  passing; all three proof harnesses passing.

## Related documents

- `docs/unified-library-architecture-2026-08-26.md` — the architecture design
- `docs/library-asset-build-plan-2026-08-26.md` — the build plan Jeff ruled on
- `docs/three-axes-preserved-2026-08-26.md` — TYPE / CATEGORY / METADATA must not collapse
- `docs/station-switch-contract-2026-08-26.md` — the station-switch contract mapped before schema work
- `docs/reader-flip-plan-2026-08-27.md` — the step-4 plan and proof design
