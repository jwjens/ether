# JINGLES / SWEEPERS v2 — category-assignment model (design, 2026-07-15)

**Status: DESIGN — locked by Jeff (this doc), pending two confirmations (SWP hex + a truncated item 8).
No code yet.** Supersedes JINGLES Overlay v1's **cadence** model. Builds on v1's proven rails:
transition-attached placement rows + daemon log-reader orchestration (Bug-A guards, observed FIRING).
Governing docs: `jingles-content-class-design-2026-07-09`, `ether-v2-data-architecture-spec §26`,
`scheduler-rework-status` (ONE scheduler), `phase-a-amendment-4` (bus seam), `jingles-overlay-v1-*`.

## The shift (v1 → v2)
v1 fired jingles on a **cadence** ("every N transitions") from a pool. v2 replaces that with **per-music-
category assignment**: each music category can name **THIS exact jingle/sweeper** or **a rotating pool**,
with its own timing and active hours. **Cadence is retired** (`jingle_categories.cadence_every_n` stays as a
dead column — additive philosophy, no drops; Generate stops reading it).

---

## (1) DATA

- **`SWP` content_class** — sweepers become a first-class overlay class parallel to `JIN`. No schema change
  for the value (content_class is TEXT); Library gets **"Mark as Sweeper (SWP)"** next to the existing
  "Mark as Jingle (JIN)" (`App.tsx:4937`). SWP is excluded from music math exactly like JIN (§5).
- **Overlay categories are typed** — the v30 `jingle_categories` table gains **`type TEXT DEFAULT 'JIN'`**
  (`JIN` | `SWP`). It now organizes the whole overlay library (jingles AND sweepers) and each row is a
  **rotating pool** (LRP within it — burnout protection). Managed in the panel (§6). `songs.jingle_category_id`
  (v30) already links an overlay song to its pool — unchanged, now typed by the pool's `type`.
- **Migration v32** (additive; **verified on a DB COPY per the rules, never the live file**): `ALTER TABLE
  jingle_categories ADD COLUMN type TEXT DEFAULT 'JIN'` + the assignment columns below + payloadTransformer +
  synced-table registration. `generated_schedule` needs **no new columns** — v1's
  content_class/channel/lead_in_sec/underlap_sec/jingle_category_id (v31) carry SWP placements too
  (content_class='SWP').

## (2) ASSIGNMENT — the core

Each **music category** row gets an **overlay assignment** (columns added to `categories`, v32):

| column | meaning |
|---|---|
| `overlay_kind` | `NULL` (none) · `'item'` (a specific jingle/sweeper) · `'pool'` (rotate within a category) |
| `overlay_song_id` | the SPECIFIC JIN/SWP song (when kind='item') — "THIS exact jingle for THIS category, period" |
| `overlay_category_id` | the overlay pool to rotate within (when kind='pool') → `jingle_categories.id` |
| `overlay_lead_in_sec` | per-assignment; default **jingle 5 / sweeper 2** (from the resolved item's class) |
| `overlay_underlap_sec` | per-assignment; default **jingle 2 / sweeper 1** |
| `overlay_active_hours` | 24-bit daypart mask, default **16777215 (always)** — keep imaging out of hours where it doesn't belong |

Some categories get a jingle, some a sweeper, some nothing — it's per-category. The **item vs. category**
choice is the heart: *item* = deterministic ("always THIS sting on the Power Gold"), *category* = rotation
with burnout protection.

## (3) FALLBACK

An **optional station-level generic pool** for categories with no assignment. Stored in `station_config_kv`
(`overlay_fallback_category_id`, per-station, no schema churn). **If none is set, an unassigned category is a
clean dead segue** — silence between songs is a deliberate programming choice, **never an error** (no
warning, no health event, no placement).

## (4) GENERATE (ONE-scheduler compliant — selection rule only)

When Generate places a music song of category **C** at a seam:
1. Resolve C's assignment (or the station fallback). No assignment + no fallback → place nothing.
2. If the seam's **hour ∉ `overlay_active_hours`** → place nothing (daypart gate).
3. Resolve the **item**: kind='item' → that song; kind='pool' (or fallback) → **LRP within the pool**
   (station-scoped play_log, same selector as v1 `_placeJingles`, filtered by the pool + its `type`).
4. Attach a **transition-attached placement row** to the seam — **identical shape to v1** (v31 columns):
   `content_class` = the resolved item's class (`JIN`|`SWP`), `channel='CART'`, `lead_in_sec`/`underlap_sec`
   from the assignment, `jingle_category_id` = the pool (or null for a specific item), `song_id` = the item.

This is a **selection-rule change only** — placement rows, the daemon log-reader, and the CART overlay are
unchanged. Still ONE scheduler (`scheduler-rework #4` / `ether-v2 §26`): Generate selects, the daemon reads.

## (5) DAEMON — unchanged, class-aware

Orchestration, Bug-A generation guards, poll-driven-no-naked-timers firing, seam bridge, and **observed
FIRING** (`level_cart`) are **exactly v1**. Only the class travels: a `SWP` placement fires the same way and
is **logged non-music like JIN** (`playlog.logPlay(..., contentClass: 'SWP')`) → excluded from music/
affidavit math by the same Phase-1b filters. Health events (ARMED/FIRING/ARMED_CANCELLED) carry the class.

## (6) UI

- **Categories page** — each music-category row gets the **overlay dropdown** (None / a specific jingle or
  sweeper / a pool) + **active-hours** control. This is where assignment happens, inline where the operator
  already thinks about a category.
- **Panel = overlay library manager** — the Jingles panel becomes **JIN + SWP tabs**: create/manage typed
  pools, assign overlay songs to pools, set the station fallback. (Cadence UI removed.)
- **Per-deck indicator** — WHITE = armed / YELLOW = firing, now **class-aware** (shows JIN vs SWP).
- **Color audit extended to SWP** everywhere the JIN/SPOT audit reached (queue, up-next, spots, clock editor,
  play-log, health cell) via the `classColors.ts` token.

### SWP color — PROPOSAL for Jeff's eyes
Needs blue-violet/indigo, **distinct from**: brand purple `#8868D8` / deeper `#6040C0` (Iris-reserved),
JIN teal `#14e0c8`, SPOT amber `#fbbf24`, and the existing category blues (D `#3b82f6`, news `#6366f1`).

- **Recommended: `#4F46E5`** (deep indigo) — clearly its own: bluer/deeper than the brand lavender-purple,
  not teal, not amber, and darker/more saturated than news `#6366f1` so it doesn't read as "news".
- Alternates: `#5865F2` (brighter "blurple" — but sits close to news `#6366f1`); `#7C3AED` (more violet —
  but nearer the Iris purple family, so I'd avoid it).

**Pick one (or name your own) and I'll set it as the canonical SWP token in `classColors.ts`.**

## (7) DEFERRED by design (noted, not built)
- **Trailing links** — v2 is **Leading** imaging only (introducing what's *next*, over the intro of the
  incoming song). Trailing (over the *outgoing* song's tail as an outro) is a later pass.
- **Produced / semi-produced / dry variants** — a **production practice**, not code: drop the different cuts
  into one pool and rotation handles variety. No variant modeling in v2.

## (8) HELP — rewrite `docs/help/jingles.md` to this model
Per the release rule (every feature ships its help entry), rewrite the help doc to the assignment workflow:
tag JIN/SWP in the Library → build typed pools → **assign per music category (item vs. pool) + active hours**
→ optional station fallback → Generate. Same plain-language template.

> ⚠️ **Item (8) in the instruction was truncated mid-sentence** ("…assignment workflow, item-vs-category
> choice, fallback,"). I've captured the evident intent above; **confirm nothing after "fallback," was lost**
> (e.g. a specific help section or an additional item 9).

---

## Migration / build plan (once the two confirmations land)
1. **v32 migration on a COPY** — `jingle_categories.type`; `categories` overlay columns; payloadTransformer;
   synced-tables registration (type + the 6 overlay columns + fallback kv). Verify + idempotent.
2. **Library** — "Mark as Sweeper (SWP)" parallel to JIN; SWP badge (indigo).
3. **Generate** — replace `_placeJingles` cadence with the assignment resolver (item/pool/fallback + active-
   hours gate); emit JIN/SWP placement rows.
4. **Daemon** — thread the class through the fire/log/health (SWP = non-music); indicator class-aware.
5. **UI** — Categories overlay dropdown + hours; panel JIN/SWP tabs + fallback; SWP color audit.
6. **Help** — rewrite `docs/help/jingles.md`.
7. **Release** — tsc --noEmit + vite build gates, migration-on-copy, ONE release, commit/push, installer to
   `dist-electron`, **STOP before install**.

**Confirm: (a) SWP hex = `#4F46E5` or your pick; (b) nothing lost after the truncated item (8).** Then I build.
