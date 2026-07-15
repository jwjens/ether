# JINGLES Overlay v1 — build checkpoint + architecture compliance + D1 conflict (2026-07-14)

**Status: FOUNDATION BUILT + VERIFIED. Daemon code NOT started — blocked on a D1 architecture ratification (below).**
Self-contained for a planning chat. Continues `docs/jingles-overlay-v1-build-proposal-2026-07-14.md`.
GO given (D1=A, D2=A jingle_categories v30, D3 teal/amber) + riders 1–4.

---

## ✅ Foundation built + verified (schema layer — rider #3 satisfied)

- **`scripts/migrate-jingle-categories-phase-sync-30.js`** — `jingle_categories` table (name, color,
  **lead_in_sec DEFAULT 5, underlap_sec DEFAULT 2, cadence_every_n DEFAULT 4**, sort_order, station_id,
  uuid, created/updated/deleted_at) + `songs.jingle_category_id`. Mirrors `spot_categories` (v24) +
  the per-category overlay timing the design puts on the category.
- **Verified on a byte-for-byte COPY of the live DB** (live file NEVER touched — rider #3): 29 → 30,
  all 12 columns present, unique index, defaults 5/2/4 confirmed; **idempotent** (re-run no-ops cleanly).
- **Sync registered** — `jingle_categories` added to `SYNCED_TABLES` + `REGISTRY` in
  `electron/sync/synced-tables.js` (station-scoped, mirrors `spot_categories`); `songs.jingle_category_id`
  registered as a scalar (parity with `category_id`). `node --check` clean.
- **Pre-commit transformer-chain gate passes** (under Electron ABI):
  *"Total migrations discovered: 30 | coverage v2→v30 | Gaps: none | Fresh-install chain v0-baseline +
  v1–v30 clean."*
- **Nothing committed** — holding for ONE release per the gate. CLAUDE.md carries the new hard rules
  (TEMPORARY TOOLING EXPIRES, BUILD THE SENSE, ARCHITECTURE BEFORE CODE).

The `jingle_categories` schema is needed under BOTH D1 options below — nothing built so far is wasted.

---

## 🏛 Architecture Compliance (rider #4)

| Governing doc | What it requires of this feature | How v1 honors it — receipt |
|---|---|---|
| **jingles-content-class-design-2026-07-09** | JIN in unified `songs`; excluded from music math; overlay on CART; per-category lead_in/underlap; teal | v29 class + v30 category pool; isolation untouched (`audiod/loggen.js:40,53`); CART slot 6 (`native/src/audio.rs:196`); timing on the category (v30) ✓ |
| **phase-a-amendment-4** (bus architecture) | CART overlay must **not foreclose** future Program/Cue/Editor/Monitor buses; "jingle carts" = a *planned future source* (`:121`) | Orchestration is **routing-agnostic**: schedules *what* plays *when* on the logical **"CART" channel** via `audio_set_volume("CART")`; never assumes master. When B1–B5 lands, slot-6 routing moves from "summed to program bus" to its own bus **without touching the daemon orchestration**. Clean seam ✓ |
| **ether-v2-data-architecture-spec** | D1 identity = content_hash; D2 snapshot truth; **§26 "ONE membership … never two systems"** | `jingle_category_id` is a category ref (like `category_id`), unaffected by the songs→content_hash cutover (`spec:105`); play-log stamps by `file_path`/class (current model). ⚠️ see conflict |
| **sync-station-identity-uuid-reconciliation** | station-scoped rows carry uuid; integer→uuid rekey pending repo-wide | `jingle_categories` station-scoped with a `uuid` column, **identical pattern to `spot_categories`/`clock_breaks`** → inherits the rekey work by parity ✓ |
| **scheduler-rework-status** | **ONE scheduler**: Generate selects ahead; daemon must NOT be a "smart in-daemon selector" (`:49`); playout → pure log-reader (#4) | ⚠️ **CONFLICT — see below** |

---

## ⛔ Conflict I must surface before writing daemon code (per ARCHITECTURE-BEFORE-CODE)

**D1=A (daemon-side cadence + LRP jingle selection) contradicts the ONE-scheduler architecture.**
- `scheduler-rework-status.md:49` — the approved direction explicitly avoids *"two schedulers"*; a smart
  in-daemon selector is the thing to eliminate, with playout flipping to a **pure log-reader** (#4, not built).
- `ether-v2 §26` — *"ONE membership definition, consumed by BOTH the scheduler and the scoped bootstrap,
  never two systems."*

Adding jingle *selection* to the daemon builds a second selector — the opposite of the target.

### Recommended: D1=A′ (architecturally compliant)
Keep selection in the **ONE scheduler**. **Generate** (main.js schedule generator) applies the cadence and
places JIN rows into `generated_schedule` — the design doc's own **"transition-attached JIN placement row"**
(jingles-content-class-design §Data shape, lines 187-197, confirmed not-yet-built). The **daemon stays a
log-reader**: it reads the JIN placement on the upcoming seam and **orchestrates the real-time overlay fire**
(timing, CART, Bug-A guard). Orchestration is legitimately daemon-side (real-time audio); *selection* is not.
- **Compliant with:** ONE-scheduler; #4 log-reader flip (forward-compatible); the design doc's data shape;
  the B1–B5 bus seam.
- **Cost vs A:** A′ adds `generated_schedule` columns (content_class/channel/lead_in/underlap on a placement
  row) + a Generate placement pass, instead of a daemon counter. `jingle_categories` schema unchanged
  (cadence just applies at Generate-time).

### The decision
D1=A was GO'd **before** rider #4 made architecture-compliance binding. Given the conflict:
- **Ratify D1=A′** (compliant; a bit more work — `generated_schedule` columns + Generate placement), or
- **Keep D1=A** (simpler daemon counter; documented deviation; fights the log-reader roadmap).

No daemon code is written until this is ratified.

---

## Rider #1 (Bug-A immunity) — guard design, with receipts

The overlay firing will be **poll-driven, NOT a naked timer** — strictly stronger than a guarded timer:
- The existing 250ms `poll()` (`audiod/engine.js:137`) checks the armed fire-time and fires **inside
  `this._advance("jingle-fire", …)`** — the serialized advance chain (`engine.js:427-436`). There is **no
  timer to go stale**.
- **Generation-guarded** exactly like the 4.4.48 `deckGen` fix (`engine.js:59, 464-471, 599`): the arm
  captures the on-air generation + the governing deck's `deckGen`; at fire time the chained closure
  re-validates *the same playing deck, same deckGen, no intervening advance / skip / manual / top-of-hour
  cut*. On any mismatch → **cancel silently and re-arm for the next eligible segue**, emitting
  `ARMED_CANCELLED` (rider #2), never a play-log row.
- **FIRING is observed, not claimed** — confirmed by `level_cart`/frames actually flowing
  (`native/src/audio.rs:785`, `native/src/lib.rs:159-163`).
- The stall watchdog (`engine.js:273-306`) treats FIRING as live, so the intentional jingle-bridge across
  the seam is never mistaken for dead air.

## Riders #2 / #3 status
- **#2 (observed end-to-end):** designed in — play_log stamps `content_class='JIN'` on actual fire only;
  an armed-but-cancelled jingle leaves **no** row and emits `ARMED_CANCELLED`. Built with the daemon stage.
- **#3 (migration on a copy):** DONE — v30 verified on a copy, live file untouched (above).

---

## Files currently changed (uncommitted, held for one release)
- NEW `scripts/migrate-jingle-categories-phase-sync-30.js`
- MOD `electron/sync/synced-tables.js` (jingle_categories + songs.jingle_category_id)
- MOD `CLAUDE.md` (3 new hard rules)
- NEW `docs/jingles-overlay-v1-build-proposal-2026-07-14.md`, `docs/jingles-overlay-v1-checkpoint-2026-07-14.md`

## Next, once D1 is ratified
Generate placement (A′) or daemon cadence (A) → daemon overlay orchestration + Bug-A guard → health events
+ Health Monitor cell → play-log stamping + renderer-gap close + isolation test → visuals (white=armed /
yellow=firing per-deck, teal seam chip + Up-Next connector) + JIN/SPOT color audit → ONE release
(commit/push, installer to `dist-electron`, **STOP before install**).

**Decision needed: D1 = A′ (recommended) or A?**
