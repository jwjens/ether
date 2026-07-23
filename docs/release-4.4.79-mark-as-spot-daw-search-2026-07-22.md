# v4.4.79 — Mark as Spot + Show+ DAW library search import, 2026-07-22

Two small additions to existing surfaces (no restructuring), plus the discoverability rule and the
missing Spots help entry. Follows the "doors before rooms" principle (now in CLAUDE.md).

## (1) Library right-click → "Mark as Spot"
Joins **Mark as Jingle / Mark as Sweeper** in the library context menu (`src/App.tsx` LibraryPanel):
- **Mark as Spot (SPOT)** opens a small dialog — pick a spot **category** (existing list, or type a new
  one inline) and a **type** (Commercial default / Promo / PSA / Sponsorship).
- On confirm: the track's `content_class` becomes `SPOT` (leaves music rotation — same discipline as
  JIN/SWP), a new category is created if named, and `ether.spots.create({title, file_path, spot_type,
  spot_category_id})` links the spots record carrying the title + file.
- **Amber `SPOT` badge** on the row (JIN teal / SWP indigo / SPOT amber `#f59e0b`).
- **Unmark Spot (→ Music)** returns it to rotation.
- The Spots & Promos panel stays the full traffic manager (dates, max-plays, advertiser) — this is the
  fast path into it.
- **SPOTS added to the bottom bar / hamburger** (`viewTabs`, after JINGLES) — it was native-top-menu only.

## (2) Show+ DAW — library search import
A **search bar** in the StudioPro toolbar (next to ＋ Import) — same title/artist search the Library uses
(`SELECT … FROM songs … WHERE title/artist LIKE`). Results render in a dropdown, each **draggable**. Drop
onto any track/timeline (`onLaneDrop`) → the file resolves via the **standard path**
(`audio:resolve-local-path`, local-first → R2-by-file_key, like a deck load) → loaded onto the track at
the drop position via a `file:///` URL (the same renderer path ClipEditor uses). Complements ＋ Import;
nothing else changes.

## Discoverability rule + Spots help entry
- **CLAUDE.md** gains **"DOORS BEFORE ROOMS"** — every user-facing panel must be reachable from the
  canonical navigation (hamburger), have a help entry, and explain itself in its empty state.
- **`docs/help-spots.md`** written (Spots shipped with no help entry — the release rule was violated).
  Plain-language, step-by-step, both entry paths (Mark-as-Spot fast path + the full panel) + break
  scheduling on clocks.

## Door audit (context)
The full door audit stands: the hamburger currently renders only the 9 `viewTabs`; ~14 feature panels are
native-menu-only (settings, spots, studio, voicetrack, analytics, streaming, smartschedule, etc.), and
several have no door at all (help/HelpPanel, macros, midi, gselector…). This release closes the two Jeff
named (Spots door + a fast path; DAW library import) and adds the governing rule; the full hamburger-as-
canonical-nav rebuild is the larger follow-on.

## Gates
- `npx tsc --noEmit`: **zero new** errors in the changed code. 3 pre-existing (App.tsx bulk-category
  `cat?.name`, OnboardingFlow, PhoneDesk — all listed as known-pre-existing in CLAUDE.md; the App.tsx one
  was hidden by a prior `tail` truncation, not new here).
- `npm run build` + installer: OK. Leak-guard unaffected (renderer-only).

## Artifact — STOP before install
`C:\openair\dist-electron\Ether Setup 4.4.79.exe` — `--publish never`.

## Files
`src/App.tsx` (Mark-as-Spot menu item + dialog + SPOT badge + SPOTS viewTab), `src/components/StudioPro.tsx`
(library search + draggable results + onLaneDrop resolve/load), `docs/help-spots.md`, `CLAUDE.md`
(DOORS BEFORE ROOMS), `package.json` 4.4.78 → 4.4.79.
