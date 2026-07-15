# JINGLES Overlay v1 — build proposal + discovery receipts (2026-07-14)

**Status: PROPOSAL — awaiting GO on D1–D3 below. No code written. Broadcast untouched.**
Self-contained for a planning chat. Design is locked from `docs/jingles-content-class-design-2026-07-09.md` + Jeff's recovered July spec (separate-path = future; yellow/white per-deck indicators; class-color audit).

---

## Scope (as given)
1. **Overlay orchestration** — at a deck transition where a JIN item is placed, fire it on the existing CART channel (over master, slot 6; separate bus stays future B1–B5). Outgoing song holds full level; jingle starts `lead_in_sec` before the song ends; next song starts `underlap_sec` before the jingle ends. `lead_in_sec`/`underlap_sec` = per-category, defaults **5s / 2s**. Jingles never consume a deck or advance rotation.
2. **State, observed not claimed** — ARMED (scheduled on the upcoming transition) and FIRING (samples actually flowing on CART via `level_cart`/frames, never a claim). Emit both as health events to the JSONL; jingle row/state in the Health Monitor.
3. **Visuals** — (a) per-deck indicator under the deck time: **WHITE = armed, YELLOW = firing** (shades chosen not to collide with the ending/critical countdown colors); (b) the designed teal seam chip between decks + Up-Next connector row (idle → armed glow → firing solid); (c) class-color audit: JIN teal + SPOT amber consistent across decks, queue, up-next, play-log, clock editor, monitor.
4. **Play log** — jingle plays recorded with `content_class`, excluded from music/affidavit math (verify 1b isolation still holds through the new path).

Gates: proposal-first on ambiguity, receipts, one release, commit/push/build installer to `dist-electron`, STOP before install.

---

## Discovery — what's already true (read-only, with receipts)

**Ownership — orchestration MUST live in the daemon.**
- `audiod/engine.js` (`DaemonEngine`) owns queue/advance/scheduler/end-detection/play-logging in the shipped default. Poll = 250ms (`engine.js:137`).
- The renderer engine (`src/audio/engine-rodio.ts`) is fallback-only: advance/preload/end-detection are hard-disabled under `daemonDriven` (`:161, :386, :492, :512, :529`).
- The rotate path already schedules the outgoing stop via `setTimeout(cfMs+500)` (`engine.js:465-471`) — the exact `setTimeout`-off-known-duration pattern the overlay timer reuses.
- Position/duration tracked per tick: `pos = positionSec + elapsed` (`engine.js:165-169`), duration from `getFileDuration` at load. So `durationSec - positionSec` ("N sec before end") is computable every tick at ~250ms; sub-poll precision needs a per-transition `setTimeout` (none exists today).

**CART channel fires over master today (proven plumbing).**
- Slot 6, always summed to program bus: `native/src/audio.rs:196, :353`.
- Reached by direct synchronous addon calls in the daemon: `A.audioLoad("CART",…)` / `A.audioPlay("CART",…)` (`engine.js:128-129`); today via the generic `load`/`play` handlers (`ether-audiod.js:106-107`), bypassing engine queue logic. There is **no cart/overlay method on `DaemonEngine`** yet.
- VU/readout ready: `level_cart` → `lvl.cart` (`ConsoleStrip.tsx:145`), state via `getState().deckCart` (`native/src/lib.rs:145`). Fader shipped (commit `ff5b965`, teal `#14e0c8`, `App.tsx:3822-3831`).

**Data class exists; Phase-1b isolation holds and keys purely on `content_class`.**
- `content_class` on `songs` + `play_log` (v29, `scripts/migrate-content-class-phase-sync-29.js`). UI tag/badge: `App.tsx:4886, 5098` (teal JIN chip).
- Music fill excludes non-MUSIC: `loggen.js:40` (base gate) + `:53` (artist-separation subquery). Main generator: `main.js:5556, 5767`. Analytics: `ListenerAnalytics.tsx:171-223`. Affidavit spot-proof comes from the **spots mirror**, not `play_log.content_class` (`migrate-content-class…29.js:33-34`).
- **Conclusion:** a jingle play is safe against music/affidavit math *iff its play_log row is stamped `content_class='JIN'`*. All filters key on the class; none key on deck/file.

**Play-logging reality.**
- Daemon writer **does** stamp `content_class` (`audiod/playlog.js:27-57`; prefers caller hint → songs lookup → SPOT if in spots → MUSIC). Called on each transition (`engine.js:615`).
- **CART plays are logged nowhere today** (`DeckConfigurator.tsx:525-534` fires CART with no `logPlay`; CART never fans out through `engine.on`).
- **Renderer/IPC logger drops `content_class`** (`sync/handlers/play_log.js:75`, `PATCHABLE :17`; `src/db/client.ts:126` has no `contentClass` arg) → a JIN play logged via the renderer would default to MUSIC and defeat isolation. (Jingles fire daemon-side, so this is belt-and-suspenders — but worth closing.)

**Health ledger.**
- `electron/audio-health.js`: `logJsonl` (`:201`) appends `{ts, stationUuid, stationName, level, prevLevel, reason, metrics}`; snapshot broadcast on `audio:health` (`:230`). Levels today = GREY/GREEN/YELLOW/RED only (`RANK :27`) — **no jingle/ARMED/FIRING state**.
- Health Monitor UI: `src/audio/health.tsx` — per-station rows `:144-162`, event feed `:164-176`; types `HealthStation :9-16`, `HealthSnapshot :18-24`. Add a `noteJingle(...)` intake + snapshot field + a jingle cell.

**Visuals — collision map + audit.**
- OnAirDeck countdown states: `isEnding = remaining<15` → orange, `isCritical = remaining<5` → red (`OnAirDeck.tsx:231-232, 261-270`). Countdown render `:438-452`; overlay numerals `:625-635`. Colors in use: red/orange/blue/green + amber (PAUSED `:277`). **WHITE + a distinctly-saturated YELLOW don't collide.** DOM slot "under the time" = append inside the countdown `div` (after `:451`) or between header (`:454`) and progress bar (`:456`).
  - ⚠️ **Verify:** discovery flagged the live deck view may render `ConsoleStrip`, not `OnAirDeck` (`OnAirDeck` imported `App.tsx:37` but strips rendered via ConsoleStrip `App.tsx:3732-3748`). The indicator will target whichever deck surface is actually on screen (both if both).
- Seam chip / connector insertion points: deck strips flex row `App.tsx:3715-3817`; Up-Next queue map `UpNext.tsx:388-476`; MasterOutput NOW/NEXT `MasterOutput.tsx:869-934` (currently fully neutral).
- **Class-color audit — current inconsistency (the cleanup target):**

| Surface | JIN today | SPOT today |
|---|---|---|
| JINGLES fader (shipped) | `#14e0c8` teal ✅ canonical | — |
| Library JIN badge | `#14e0c8` ✅ | no badge |
| Up-Next (`UpNext.tsx:52-55`) | `#14b8a6` ✗ wrong hex | `#a855f7` ✗ **purple** |
| Spots (`Spots.tsx:27-30`) | `#a78bfa` ✗ **purple (pre-GO)** | `#fbbf24` amber-ish |
| ClockEditor (`:58-70`) | **no jingle slot** ✗ | `#fbbf24` amber ✅ |
| OnAirDeck / MasterOutput / ProgramLog / Logs / BroadcastCalendar / VUMeter | none ✗ | none ✗ |

  Standardize **JIN = `#14e0c8`**, **SPOT = `#fbbf24`**; add class color where missing.

**The gap that forks the build:** *nothing selects/places a JIN item at a transition.* No jingle category, no `lead_in_sec`/`underlap_sec` storage, no `generated_schedule` seam row (its columns are flat `scheduled_at` + song fields; `schema-v0-baseline.js:517-533`), no `slot_type='jingle'` handler (`main.js:5765` silently skips it; the `001_initial.sql` jingle enum is dead/unloaded). JIN is only ever an exclusion.

---

## Decisions needed (proposal-first)

### D1 — How a jingle is chosen for a transition (core fork)
No placement path exists, so v1 must create one. Options:
- **(A) Cadence + jingle-category, daemon-armed — RECOMMENDED.** A jingle category = an LRP pool; the daemon fires one every *N* segues (cadence knob). Fully daemon-contained; no `generated_schedule`/clock-slot rework; real rotation immediately. This is the design doc's **own "primary" mode** (§3, lines 96-98).
- **(B) Explicit clock `slot_type='jingle'`.** Deterministic placement, but needs new `generated_schedule` columns + generator branch + clock-editor UI — materially bigger; the doc defers it to Phase 3 ("secondary").

**Recommendation: A for v1; B deferred to a later phase.**

### D2 — Where `lead_in_sec` / `underlap_sec` (5s/2s) live
"Per-category," but no jingle category store exists. Options:
- **(A) New `jingle_categories` table (schema v30) — RECOMMENDED.** Mirrors `spot_categories`: `name, color, lead_in_sec DEFAULT 5, underlap_sec DEFAULT 2, cadence_every_n`; plus `songs.jingle_category_id`. Minimal management UI: create category, assign JIN songs, set cadence. Matches the locked doc + spot_categories precedent.
- **(B) Single station-wide jingle pool (smallest v1).** No new table; station-level lead/underlap/cadence, columns shaped to graduate to per-category later.

**Recommendation: A (table).** Choose B only if you want the smallest possible first ship.

### D3 — Color audit tokens
Confirm canonical **JIN = `#14e0c8`**, **SPOT = `#fbbf24`**, and that flipping the stray **purple SPOT** (`UpNext.tsx:54 #a855f7`) and **purple JIN** (`Spots.tsx:28 #a78bfa`) to those tokens is wanted, plus adding class color to the surfaces that have none (OnAirDeck/ConsoleStrip, MasterOutput, ProgramLog, Logs, ClockEditor).

---

## The build, once D1–D3 land (daemon-authoritative; broadcast untouched until install)
1. **Schema v30** — `jingle_categories` + `songs.jingle_category_id` (migration + `payloadTransformer`, per the v29 pattern; chain-verifier-safe).
2. **Daemon overlay** in `DaemonEngine` — arm on the approaching segue via `setTimeout` off `durationSec - positionSec`; fire LRP JIN on CART (`A.audioLoad/Play("CART")`); start the incoming deck `underlap_sec` early; never consume a deck/advance. Reuse the `advanceP` serialization + the existing `setTimeout`-off-crossfade pattern.
3. **State (observed, not claimed)** — ARMED = scheduled; FIRING = `level_cart`/frames actually flowing. Emit both to `health-events.jsonl` + a jingle cell/state in the Health Monitor.
4. **Play-log** — log the fire via the daemon writer with `content_class='JIN'`; also close the renderer `content_class` drop (`sync/handlers/play_log.js` + `src/db/client.ts`) so nothing leaks JIN as MUSIC; add a test re-verifying 1b isolation through the new path.
5. **Visuals** — white=armed/yellow=firing per-deck under the time (non-colliding); teal seam chip + Up-Next connector row; JIN/SPOT color standardization across the audited surfaces.
6. **One release** (own version bump + CHANGELOG) → commit/push → build installer to `dist-electron` (`--publish never`) → **STOP before install.**

**Explicitly deferred (not in v1):** the separate CART bus (B1–B5); explicit clock `slot_type='jingle'` placement + clock-editor jingle UI (if D1=A); any spots-table unification.

---

## GO checklist
- **D1 = A** (cadence + jingle-category, daemon-armed)?
- **D2 = A** (`jingle_categories` table, v30)?
- **D3** — JIN `#14e0c8` / SPOT `#fbbf24` standardization confirmed?

Reply with GO or adjustments and the build proceeds.
