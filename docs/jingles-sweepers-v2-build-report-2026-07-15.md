# JINGLES/SWEEPERS v2 — build report (2026-07-15, v4.4.57)

Category-assignment model, supersedes v1 cadence. Built on v1's proven rails. Migration verified on a DB
COPY; tsc --noEmit (0 new errors) + vite build green; transformer chain v2→v32 clean. **STOP before install.**

## Architecture Compliance (receipts)

| Governing doc | Requirement | Receipt |
|---|---|---|
| **scheduler-rework-status (ONE scheduler)** | Generate selects; **no in-daemon selector** (`:49`); playout → log-reader (#4) | v2 changes only the SELECTION RULE — `_placeJingles` (main.js) resolves each category's assignment (item / pool-LRP / fallback) + active-hours and writes placement rows. The daemon still only READS (`loggen.readJingleForSeam`). No second selector. |
| **ether-v2-data-architecture-spec §26** | "ONE membership … never two systems" | One selection system (Generate). `categories.overlay_*` + `songs.jingle_category_id` are refs like `category_id`, content-hash-safe (`spec:105`). SWP logged by `file_path`+class (current play_log model). |
| **jingles-content-class-design** | JIN unified in `songs`, excluded from music math; overlay on CART; transition-attached placement | SWP joins JIN as a content_class (unified `songs`); both excluded by the same Phase-1b filters; same v31 placement rows (now `content_class` ∈ {JIN,SWP}). |
| **phase-a-amendment-4 (bus)** | CART overlay must not foreclose B1–B5 | Unchanged from v1 — routing-agnostic "CART" logical channel; SWP rides it identically. Clean seam preserved. |
| **sync-station-identity-uuid** | station-scoped rows carry uuid; integer→uuid rekey pending | `jingle_categories`/`categories` are station-scoped with uuid; overlay assignment columns are plain scalars (parity with `category_id`) → inherit the rekey by parity. |

## Rider parity with v1 (unchanged, now class-aware)
- **Bug-A immunity** — daemon arm/fire/bridge, `_airGen`/`deckGen` generation guard, poll-driven no-naked-
  timers, watchdog-aware seam bridge: **untouched**. The class rides through (`_jingle.contentClass`).
- **Observed, not claimed** — FIRING confirmed by `level_cart`; play-log stamps `content_class` = the resolved
  class (JIN|SWP) ONLY on real fire; `ARMED_CANCELLED` on cancel, no row. SWP excluded from music math
  (same isolation test passes).
- **Migration on a copy** — v32 run + verified on a byte-for-byte COPY (live untouched), idempotent.

## What was built
- **Schema v32** (`migrate-overlay-assignment-phase-sync-32.js`): `jingle_categories.type` (JIN|SWP) +
  `categories.overlay_kind/_song_id/_category_id/_lead_in_sec/_underlap_sec/_active_hours`. Cadence column
  left as a dead no-op. Synced-tables + categories/jingle_categories handlers updated.
- **Library**: "Mark as Sweeper (SWP)" + SWP badge (indigo).
- **Generate**: `_placeJingles` rewritten — per-category assignment resolver (specific item / pool LRP /
  station fallback) + active-hours gate; emits JIN/SWP placements. Cadence path removed.
- **Daemon**: `readJingleForSeam` returns the class; `_logJinglePlay` + health event + indicator carry it.
- **UI**: Jingles panel → overlay-library manager (JINGLES/SWEEPERS tabs, per-category assignment table with
  dropdown + active hours + lead/underlap, station fallback selector); per-deck indicator names the class;
  color audit extended to SWP (`classColors.ts` SWP_INDIGO, UpNext, Spots).
- **Help**: `docs/help/jingles.md` rewritten to the assignment model.

## SWP color — proposed for Jeff's eyes
**`#4F46E5`** (deep indigo) is set as the canonical `SWP_INDIGO` token in `src/lib/classColors.ts` — change
that one constant to retint SWP everywhere. Chosen distinct from JIN teal `#14e0c8`, SPOT amber `#fbbf24`,
brand purple `#8868D8`/`#6040C0` (Iris-reserved), and the category blues (D `#3b82f6`, news `#6366f1`).

## Deferred by design (in the design doc, not built)
- **Trailing links** — v2 is Leading imaging only.
- **Produced / semi / dry variants** — a production practice (one pool, rotation handles variety).

## Honest scope notes
- **Timing unauditioned** — same as v1; ships behind the same guards. **No assignment + no fallback → no
  placement** (byte-identical prior playout). Tune on air.
- **Assignment UI placement**: the per-category dropdown + hours live in the **Jingles & Sweepers panel**
  (the "overlay library manager"), a single coherent surface, rather than inline on the separate Categories
  page. Functionally complete; inline-on-Categories-rows is a cosmetic fast-follow if Jeff prefers it there.
