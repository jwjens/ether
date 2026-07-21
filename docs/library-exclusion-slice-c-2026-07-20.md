# Library exclusion — Slice C (renderer surfaces) build report, 2026-07-20 (v4.4.73)

The display half of the library-health work. Context: Slice A (senses + IPC, 4.4.71), Slice B (loud
refusals, 4.4.72). **Display + events only — no playout behavior changes anywhere.**

## What shipped

### (1) Health Monitor — LIBRARY & ROTATION section (full page) + mini-panel dot
`src/components/HealthMonitor.tsx`, reading `library-health:get` (30s poll):
- Per-station card (green/yellow/red border + dot) with `HealthRow`s: **Materialization** X/Y
  resolvable (sub: N unresolvable — needs re-import / N cloud-only prefetching / all local), a
  **"show unresolvable list"** toggle (→ `library-health:eligibility` filtered to UNRESOLVABLE);
  **Rotation pool** spun/library (24h) + top-song spins/24h; **Skipped at load** this hour (red when
  >0); **Prefetch lag** (upcoming cloud-only not yet local).
- **Mini dot** (`HealthStatusDot`): library health now rolls into the global dot — any station
  non-green shows a warn/error dot (red station → error, yellow → warn), so the mini panel shows a dot
  only when non-green, as specified.

### (2) Library page — the PLAYS column grows up (fixes the "—")
`src/App.tsx LibraryPanel`, from `library-health:eligibility` (30s refresh so RESTING ticks down):
- Each row's plays cell now shows **play count** (the repaired station-scoped `play_log` join, not the
  stale `songs.play_count`) + **last-played** ("2h ago" / "never") + **rest countdown** ("rest mm:ss")
  + a **status chip**: ELIGIBLE (ready) / RESTING / NEVER_PLAYED (new) / UNRESOLVABLE (no file).
- Backing data added to the sense: `plays` per eligibility row (`electron/library-health.js`).

### (3) Lint — live queue + Generate-time, rules-derived
`electron/library-health.js lintUpcoming(stationId)`: scans the next ~60 pending music rows and, using
the ACTUAL separation rules (`no_repeat_hours` + artist separation) against the plays that PRECEDE each
row's `scheduled_at`, flags any row whose song/artist is still RESTING at its projected air time
(`violatesBySec`, "N minutes early").
- **Live queue (UpNext)** — a **yellow "⚠ separation · Nm early" chip** on any upcoming row that
  violates, matched by `scheduledAt` (`library-health:queue-lint`, 20s). Before it airs.
- **Events** — each violating row is health-evented **once** (`kind:"queue-lint"` →
  `health-events.jsonl`) within ~2 min of placement (the senses/lint tick was tightened from hourly to
  120s). This is the **Generate-time warn** — a violation Generate places is surfaced at the source
  (event) shortly after, without any playout change. (A synchronous post-Generate hook is a possible
  follow-up; the periodic pass catches every placed violation.)

## Verified read-only against live data (post-backfill)
- Eligibility+plays (halloVeen): "A Nightmare On My Street" plays=6 ELIGIBLE, "Anthem" plays=13 RESTING
  (~2.3h), backfilled songs plays=0 NEVER_PLAYED. Summary 30 eligible / 98 never / 44 resting / **0
  unresolvable**. The repaired PLAYS join works.
- Queue lint (halloVeen): **2 real upcoming violations** — "Stranger Things Title Sequence" 9m early,
  "Rest in Peace" 42m early (song separation).

## Gates
- `node --check` library-health.js + main.js: OK.
- `npx tsc --noEmit`: zero new errors (3 pre-existing; HealthMonitor/UpNext/App plays cell clean).
- `npm run build` + installer: OK.

## Artifact
`C:\openair\dist-electron\Ether Setup 4.4.73.exe` — `--publish never`. Install + fully close/reopen.

## Files
- `electron/library-health.js` — eligibility `plays`; `lintUpcoming` + `lintRows`; event emission in
  `computeAll`; senses tick 120s.
- `electron/main.js` — `library-health:queue-lint` IPC.
- `src/components/HealthMonitor.tsx` — LIBRARY section + mini-dot roll-in.
- `src/App.tsx` — `LibraryPanel` eligibility fetch + rich PLAYS cell + `LibStatusChip`.
- `src/components/UpNext.tsx` — queue-lint fetch + yellow chip.
- `package.json` 4.4.72 → 4.4.73.

## Library-exclusion arc — COMPLETE (A + B + C)
- Backfill (165 files) → tonight's air whole.
- Slice A (4.4.71) — prefetch + 5 senses.
- Slice B (4.4.72) — loud refusals (daemon skip events + loadDeck resolve/toast + rotation honesty).
- Slice C (4.4.73) — Health Monitor LIBRARY section, Library PLAYS column, queue + Generate lint.

## Still open (filed follow-ups, Jeff's call)
- 2 unresolvable Open Format songs — need re-import.
- Open Format's ~69 locally-present-but-zero-spin songs — rotation-coverage question (the eligibility
  sense is the instrument).

Nothing committed; nothing pushed. STOP before install.
