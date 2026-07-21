# Log-Reader Flip — Phase 3 (time-anchored SHADOW) — build report, 2026-07-21 (v4.4.75)

**Design:** `docs/log-reader-single-source-playout-design-2026-07-20.md` §2.7 (time-anchored playhead) +
§7 Phase 3 + the §2.7 auto-fitter RULING. Follows Phase 0 (schema, v4.4.68), Phase 1 (shadow writer,
v4.4.69), Phase 2 (read-path shadow, v4.4.70).

**This release is SHADOW-FIRST and OBSERVATIONAL.** It ships the `ETHER_LOG_READER` flag **OFF**, the
shared §2.7 time-anchored **selector**, and a **daemon-side boundary shadow** that records — at every
go-live — what the flipped reader WOULD air vs what legacy aired. That divergence ledger is the burn-in
that gates the flip. **No playout behavior changes.** The active flip (playout driven by the log,
CLEAR two-verb, emergency-floor refill, operator log-writes) is gated on a clean burn-in AND Jeff's
separate flip GO — per the standing rule and Jeff's own gating language. **STOP before install.**

---

## Blast-radius audit (read-only sweep — receipts)

The playout spine, as it actually stands (not the design's target):

- **The advance funnel is `poll()` → `_maintain()`/`checkEnd` → `handleRotate`/`handleLoadNext`/
  `_hardCutTopOfHour`, all serialized on `advanceP` (`audiod/engine.js:182,476,487,536,273`).** Every
  go-live path funnels through **`_fireStart(deckId)`** (`engine.js:678`) — rotate, load-next, skip,
  play-now, top-of-hour, resume all call it. It already bumps `_airGen`, logs the play, and (Phase 1)
  calls `_shadowStampPlayhead`. **This single funnel is where the boundary shadow hooks** — one seam,
  every boundary.
- **Queue sourcing:** `refillIfNeeded` (`engine.js:595`) pulls from `loggen.fillQueue`
  (`loggen.js:233`) which prefers `readGeneratedSchedule` (`loggen.js:148`) via the ephemeral
  process-local `_schedCursor` (`loggen.js:145`), else falls to clock/on-format tiers. Items carry
  `scheduledAt` + `schedId` (the `generated_schedule.id`, `loggen.js:242`), which `loadToDeck` stamps
  onto `deckSched[id]`/`deckSchedId[id]` (`engine.js:668-669`). **The flip's future active branch will
  replace this sourcing with the selector; the shadow leaves it untouched.**
- **Time drift, confirmed:** the only wall-clock re-anchor today is the top-of-hour hard cut
  (`_checkTopOfHour`/`_hardCutTopOfHour`, `engine.js:263,273` → `loggen.fillFromHour`). Between cuts,
  advance is song-END-driven and `scheduled_at` is a back-link, never a gate — so the playhead creeps
  ahead all hour (the 41-min-ahead symptom). §2.7 is the fix.
- **Flag threading:** the daemon is spawned with `env: { ...process.env, ... }`
  (`electron/audio-daemon-client.js:134-140`), so `ETHER_LOG_READER` inherits from the Electron process
  with **no spawn change** — unset ⇒ OFF.
- **Sync safety:** the lifecycle columns (`state`/`played_at`/`seq`) are local-authoritative
  (§5, Phase 0 payloadTransformer strips them inbound). The shadow only READS them + `scheduled_at`.
  Nothing new is synced.
- **Leak-guard:** the daemon→main `logreader-shadow` event rides the internal pipe keyed by integer
  `stationId` (like `deck`/`queue`/`loadskip`); the UUID is applied at the `logreader-shadow:get` IPC
  boundary. Leak-guard holds at **14**.

---

## What shipped (observational core)

### 1. `ETHER_LOG_READER` gate — `audiod/engine.js`
Module const `LOG_READER_FLIP = process.env.ETHER_LOG_READER === "1"` (ships OFF). Gates the FUTURE
active flip; `start()` logs the gate state so a burn-in run vs a flip run is unambiguous in the daemon
log. This release: OFF everywhere → legacy playout + shadow only.

### 2. The §2.7 time-anchored SELECTOR — `audiod/loggen.js selectRowForNow(db, stationId, nowTs, slack=60)`
Pure, read-only, deterministic (no LLM). The shared decision function the flip will act on and the
shadow observes:
- **BEHIND / ON-TIME:** the latest still-`pending` music row whose slot has arrived
  (`scheduled_at <= now+slack`) — the current slot. `missedCount` = pending rows before it (their slots
  elapsed). `mode` = `behind` if the chosen row's drift exceeds slack, else `on-time` — driven by the
  **chosen row's drift**, NOT the historical backlog (a caught fix — see receipts).
- **AHEAD:** nothing arrived → earliest future pending row is the play-early candidate (never dead-air).
- **EXHAUSTED:** no pending music rows → the emergency-floor condition.
JIN/SWP overlays excluded (seam overlays, never a deck track), matching the daemon reader's guard.

### 3. Daemon boundary SHADOW — `audiod/engine.js _shadowEvalTimeAnchor(deckId, airedSchedId)`
Called from `_fireStart` **before** the Phase 1 stamp (while the aired row is still `pending` and thus
comparable). Emits a `logreader-shadow` record: `{mode, airedSchedId, wouldAirSchedId, driftSec,
missedCount, agrees, ...}`. Read-only; never perturbs playout.

### 4. Ledger + rolling summary + IPC — `electron/main.js`
`logreader-shadow` events append to `userData/logreader-shadow.jsonl` (the greppable burn-in) and fold a
per-station rolling summary (`_logReaderShadow` map: boundaries / agree rate / behind·ahead·on-time /
max drift / max missed / last), exposed via `logreader-shadow:get`.

### 5. Health Monitor surface — `src/components/HealthMonitor.tsx`
A **LOG-READER FLIP — §2.7 SHADOW (burn-in)** section (60s poll, `document.hidden`-gated, low-churn):
per station the would-match rate, boundary count, mode breakdown, max drift, max missed — with an
inline note that low agreement is the drift the flip removes, not an error. The sense is visible in v1.

## What did NOT ship (gated — the flip's active branch)
Per §7 Phase 3 (shadow→canary) and Jeff's gate ("flag OFF until the shadow burn-in is clean and Jeff
gives the flip GO separately"): the active flip — playout driven by `selectRowForNow`, stamping
skipped-past rows `missed`, cued decks = the log's next rows, clock-refill demoted to emergency floor,
CLEAR's two verbs, operator deck-loads writing the log — is the **flip GO** release, built on a clean
burn-in. This release produces the burn-in that gates it.

---

## Read-only proof (receipts) — `scripts/diag-logreader-shadow.js`
Run read-only against Jeff's live DB (WAL concurrent read; **no writes**), 2026-07-21 ~2:20 PM:

| Station | Legacy playhead (state='playing') | §2.7 flip would air | drift | missed |
|---|---|---|---|---|
| **halloVeen** | "The Addams Family" @ 2:01 | **"Be Prepared" @ 2:18** | ~1 min | 336 (backlog) |
| **Magical Forest** | "Santa Claus…" @ 2:00 | **"Underneath the Tree" @ 2:18** | ~1 min | 366 (backlog) |
| **Open Format** | "Titanium" @ 2:09 | "The Greatest" @ **10:11 AM** | **249 min** | 111 |

**Findings the shadow surfaced immediately:**
- **halloVeen + Magical Forest anchor cleanly** — the selector picks the exact now-slot row (~1 min
  drift); the flip would air the right song at the right time. Flip-ready.
- **Open Format's log is gappy near now** — no on-format `pending` row exists between 10:11 AM and now,
  so the time-anchored selector reaches back to a stale 10 AM row (249 min). This is a **real data
  characteristic**, not a selector bug: OF's `generated_schedule` is sparse / exhausted for the day.
  It makes the **emergency floor (§2.6) + Generate density (~60 real-min/hour, §2.7(e))** load-bearing
  for OF before the flip is safe there. Exactly the kind of finding the burn-in must catch pre-flip.
- **`missedCount` spans history** (Phase 1 only stamped aired rows, so skipped rows stay `pending` in
  the past): 336/366 are the accumulated backlog, not this hour. The flip's first boundary would
  reconcile that backlog as a one-time `missed` sweep — OR the flip should bound `missed` to the current
  day. A refinement for the flip-activation design, noted here.

## Gates
- `node --check` loggen.js / engine.js / main.js: OK.
- `npx tsc --noEmit`: zero new errors (3 pre-existing — App.tsx/OnboardingFlow/PhoneDesk).
- Leak-guard: **14** (baseline holds).
- `npm run build` + installer: OK.

## Artifact
`C:\openair\dist-electron\Ether Setup 4.4.75.exe` — `--publish never`. Install + fully close/reopen
(daemon doesn't hot-reload). Flag ships OFF. After a burn-in, read
`%LOCALAPPDATA%\Ether\...\logreader-shadow.jsonl` (or Roaming) and the Health Monitor's §2.7 SHADOW
section for the gating data.

## Files
- `audiod/loggen.js` — `selectRowForNow` (§2.7 selector) + export.
- `audiod/engine.js` — `LOG_READER_FLIP` gate; `_shadowEvalTimeAnchor` + `_fireStart` hook; start() gate log.
- `electron/main.js` — `logreader-shadow` event → ledger + rolling summary; `logreader-shadow:get` IPC.
- `src/components/HealthMonitor.tsx` — §2.7 SHADOW section (60s poll).
- `scripts/diag-logreader-shadow.js` — read-only selector proof (re-runnable receipt).
- `package.json` 4.4.74 → 4.4.75.

## Next
Burn-in on Jeff's box (flag OFF) → review `logreader-shadow.jsonl` + the Health Monitor section. When
the anchor agreement is clean (and OF's gap is addressed via emergency-floor/Generate density), Jeff
gives the flip GO → the active flip release (playout driven by the log). Flag stays OFF until then.
