# v4.4.78 — Log-Reader Flip ACTIVATION (Phase 3 → live, per-station canary), 2026-07-22

The flip goes live behind a **per-station** flag — playout can now consume `generated_schedule` via the
§2.7 selector. **Flag OFF for every station on install → zero change until you flip one.** Design:
`docs/log-reader-single-source-playout-design-2026-07-20.md`; readiness: the FLIP-READY burn-in verdict
(`docs/log-reader-phase-3-burnin-verdict-2026-07-22.md`). Both confirmed riders enforced (below).

## What ships
### (1) §2.3 queue-as-cache read-through — `audiod/engine.js` + `audiod/loggen.js`
`_logReaderOn(stationId)` (per-station flag ∪ dev env override) gates `refillIfNeeded`. When ON, the
queue is re-sourced by **`loggen.readLogAnchored`** (the §2.7 selector): the pending region becomes a
cache of log rows from the playhead forward; the cued/bound HEAD (the decks) is never dropped (§2.4a).
**The proven preload / rotate / loadToDeck path is untouched.** Behind → skip-past rows stamped `missed`
(day-bounded); exhausted → the emergency floor (below).

### (2) Operator deck-loads write the log — `source='operator'` (§2.5)
`noteManualCue` / `intentCueDeck` call `_writeOperatorLogRow` when the flip is ON: a jock hand-load writes
a `generated_schedule` row at the playhead (`source='operator'`), so it airs **as a log row** — the
acceptance ("every air is a log row, machine OR operator; zero off-log airs"). Carried by **migration
v34** (`source TEXT`, local-only), verified on a live-DB copy (foundation commit `dbd714c`).

### (3) CLEAR — two honest verbs (§3.2) — `src/App.tsx`
The CLEAR button opens a two-verb popover: **Reset to schedule** (re-sync playout + re-cue idle decks
from the log — `queueClearPending`) / **Clear & regenerate** (`schedule:generateDay` rewrites forward
rows; the in-progress hour is spared). **Never a silent clock-refill.**

### Emergency floor — loud (§2.6)
On true selector exhaustion the flip screams `logreader-floor` (→ health ledger) and falls to the
clock/on-format tiers so a flipped station **never dead-airs**. Off-log, and never silent.

### Canary control + agreement monitor
Health Monitor gains a per-station **Log-Reader Flip — Canary** toggle (LOG-READER ON / LEGACY), writing
the flag via the local-only setter. The §2.7 shadow keeps writing — post-flip it is the **agreement
monitor** (aired == the flip's pick → ~100% once the flip is the source).

## Rider A — AHEAD = never wait, never dead air (compliance stated explicitly)
`readLogAnchored` NEVER returns empty while any pending music row exists. On `ahead` (the next row's slot
is still future) it returns that **earliest future row as the item to air**, so playout airs it the
moment the current song ends — it does not wait. Within `FLIP_AHEAD_SLACK_SEC` (120s) this is silent;
beyond it a `logreader-ahead` health event fires. Music floats forward. "Never far-future early" governs
only the selector's anchor *choice* (it won't jump to a distant future row as the anchor); it is not
permission for silence between rows. **Harness proves it:** AHEAD case returns 2 items, earliest first,
zero missed.

## Rider B — the flag NEVER syncs (receipts)
`log_reader_flip` lives in `station_config_kv` and is LOCAL-AUTHORITATIVE both directions:
- **Outbound:** written only by `stationConfigKvSetLocal` — a **mutation-less** writer (no `withMutation`)
  → nothing ever enters the outbound sync stream. `Create`/`UpsertByKey`/`Update` **reject** the key.
- **Inbound:** those same handler guards skip the key on apply; and the peer-sync engine is off by
  default, so a flag mutation cannot even exist. A remote machine's sync can never flip a station's
  playout engine. (The `is_active` lesson.) **Harness proves** per-station OFF-default / ON / other-station-OFF.

## OFF-path byte-identical
`refillIfNeeded` gates at the very top: `_logReaderOn()` false → the legacy branch runs unchanged.
Two unflipped stations on the same install are wholly unaffected. **Harness proves** the flag gate.

## Off-air harness — `audiod/smoke-logreader-anchor.js` (in-memory SQLite; real code)
**18/18 PASS:** BEHIND (anchor to now-slot, missed = earlier-**today** only, yesterday excluded — day-
bounded), AHEAD (rider A — non-empty, earliest-early, no missed), ON-TIME, EXHAUSTED (empty → floor), and
the per-station flag gate. Plus `smoke-seam-stop` 5/5 and `smoke-enginestate` 19/19 unaffected.

## Gates
- `node --check` engine/loggen/main: OK. Harnesses 18/18, 5/5, 19/19.
- `npx tsc --noEmit`: zero new (2 pre-existing — OnboardingFlow, PhoneDesk). Leak-guard **14**.
- Migration v34 verified on a live-DB copy (33,543 rows, additive, idempotent, transformer strips).
- `npm run build` + installer: OK.

## Artifact — STOP before install (Magical Forest canary)
`C:\openair\dist-electron\Ether Setup 4.4.78.exe` — `--publish never`. **Flag OFF everywhere on install
→ nothing changes.** Full close/reopen (daemon doesn't hot-reload). Then:
1. Health Monitor → **Log-Reader Flip — Canary → flip Magical Forest ON**.
2. Verify on air: queue == calendar, ▶ == decks, anchor holding; the §2.7 shadow agreement climbs to
   ~100% for MF. **STOP for your word before halloVeen.**
3. halloVeen next. **Open Format LAST, after a fresh Generate on it** (its 90-min gaps).

## Files
`audiod/loggen.js` (readLogAnchored), `audiod/engine.js` (_logReaderOn / _refillFromLog / operator-write /
gate), `electron/main.js` (flip-event ledger routing), `src/components/HealthMonitor.tsx` (canary toggle),
`src/App.tsx` (CLEAR two-verb), `audiod/smoke-logreader-anchor.js` (harness), `package.json` 4.4.77→4.4.78.
Foundation (migration v34 + rider-B flag) in `dbd714c`.
