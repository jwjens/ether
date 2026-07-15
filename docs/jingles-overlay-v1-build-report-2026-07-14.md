# JINGLES Overlay v1 — build report (2026-07-14, v4.4.55)

Ratified D1=A′ / D2=A / D3 + riders 1–4. Built, syntax-checked, migrations verified on a DB COPY, vite
build green, Phase-1b isolation re-verified. **STOP before install** — CI/installer only; Jeff installs.

## Architecture Compliance (rider #4)

| Governing doc | Requirement | Receipt |
|---|---|---|
| **jingles-content-class-design-2026-07-09** | JIN in unified `songs`; excluded from music math; overlay on CART; per-category lead_in/underlap; teal; transition-attached placement (§Data shape) | v29 class + v30 `jingle_categories`; isolation intact (`loggen.js:40,53`); CART slot 6; JIN rows in `generated_schedule` bound to the seam (v31 + `_placeJingles`) |
| **scheduler-rework-status (ONE scheduler)** | Generate selects ahead; **no "smart in-daemon selector"** (`:49`); playout → pure log-reader (#4) | Selection is in Generate (`_placeJingles`, main.js); the daemon only READS placements (`loggen.readJingleForSeam`) and orchestrates the fire — **no in-daemon selection**. Forward-compatible with #4. |
| **ether-v2-data-architecture-spec §26** | "ONE membership … never two systems" | One selection system (Generate). `jingle_category_id` is a category ref like `category_id`, unaffected by the songs→content_hash cutover (`spec:105`). Play-log stamps by `file_path`+class (current model). |
| **phase-a-amendment-4 (bus architecture)** | CART overlay must **not foreclose** B1–B5 buses; jingle carts a *planned future source* (`:121`) | Orchestration is **routing-agnostic** — schedules WHAT/WHEN on the logical **"CART" channel**; never assumes master. Slot-6 routing can move to its own bus later with **zero daemon changes**. Clean seam. |
| **sync-station-identity-uuid-reconciliation** | station-scoped rows carry uuid; integer→uuid rekey pending | `jingle_categories` station-scoped with `uuid`, **identical pattern to `spot_categories`/`clock_breaks`** → inherits the rekey by parity. |

## Rider compliance (with receipts)

- **#1 Bug-A immunity** — `audiod/engine.js`: firing is **poll-driven, no naked timers**; the fire runs
  inside `_advance("jingle-fire", …)` (serialized chain). Supersession mirrors the 4.4.48 `deckGen` guard:
  the arm captures `_airGen` + the deck's `deckGen`; `_jingleSuperseded()` cancels on ANY new go-live
  (`_fireStart` bumps `_airGen`), deck-reload, or the armed deck no longer playing → **silent cancel +
  re-arm next segue**, re-validated again inside the fire closure. Top-of-hour / skip / manual-play-now all
  route through `_fireStart`, so all supersede.
- **#2 Observed end-to-end** — `_logJinglePlay` (content_class='JIN') runs ONLY when `_cartFlowing()`
  confirms samples on `level_cart` (never on arm). Cancel path emits `ARMED_CANCELLED` and writes **no**
  play_log row (`audio-health.js noteJingle` → ledger). A fired-but-unobserved jingle is neither logged nor
  bridged and is never truncated.
- **#3 Migration on a copy** — v30 + v31 run + verified on a byte-for-byte COPY of the live DB (live file
  untouched); idempotent; transformer-chain gate green through v31 (fresh chain v0+v1–v31 clean).
- **#4 Architecture-first** — this section + docs cited before code; the D1 conflict was surfaced and
  resolved to A′ before any daemon code.

## What was built (files)
- **Schema**: `migrate-jingle-categories-phase-sync-30.js`, `migrate-generated-schedule-jingle-placement-phase-sync-31.js`; `synced-tables.js` (jingle_categories + generated_schedule cols + songs.jingle_category_id).
- **Generate (selection)**: `main.js _placeJingles` + `generated_schedule.js` bulk insert cols.
- **Daemon (orchestration)**: `engine.js` (arm/fire/bridge + guard + FIRING observe + JIN log), `loggen.js` (exclude JIN from the deck queue + `readJingleForSeam`).
- **Observability**: `audio-health.js noteJingle` + snapshot/ledger; `main.js` jingle event route; `health.tsx` cell.
- **Play-log**: daemon stamps JIN; renderer gap closed (`play_log.js`, `client.ts`); isolation test green.
- **Visuals**: `ConsoleStrip.tsx` per-deck WHITE=armed/YELLOW=firing; color audit `classColors.ts` + `UpNext.tsx`/`Spots.tsx` (purples→teal/amber).
- **Management**: `JinglesPanel.tsx` + `jingle_categories.js` handler + preload bridge; mounted in Settings → Programming.

## Honest scope notes (unauditioned / deferred)
- **Unauditioned timing.** The real-time overlay timing (lead-in/underlap/bridge) cannot be exercised
  without going on air (broadcast untouched until install). It ships behind heavy guards: with no jingle
  pool / no assigned JIN songs the whole path is a **no-op** (byte-identical prior playout); the seam bridge
  triggers ONLY on observed firing; the stall watchdog remains the dead-air backstop. Tune on air like the
  broadcast-delay DSP precedent.
- **Deferred visual (scope 3b):** the standalone between-decks **seam chip** and the **Up-Next connector
  row** are NOT in v1. The per-deck indicator (live `ConsoleStrip`) + the Health Monitor cell already
  surface ARMED/FIRING; jingles are overlay placements, not deck-queue items, so an Up-Next connector needs
  a separate placement read — a clean fast-follow. The per-deck indicator is on the live deck strip
  (`ConsoleStrip`, the on-air surface); adding it to the standalone `OnAirDeck` view is the same fast-follow.
- **Short jingles:** if a jingle is shorter than lead_in+underlap, the incoming song is clamped to start no
  earlier than the outgoing song's natural end (no double-full-level overlap); underlap is honored when the
  jingle is long enough to bridge. Documented v1 behavior.
