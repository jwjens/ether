# Design: safe, schedulable re-baseline on upgrade (build nothing)

Status: **DESIGN ONLY. No code.** Companion to:
- `docs/sync-station-identity-uuid-reconciliation.md` (the defect)
- `docs/sync-station-identity-uuid-reconciliation-plan.md` (the Tier-2 fix plan)

This document covers *one* piece of that plan: §4 "re-baseline on upgrade," made safe for a LIVE
on-air station. It is written against the three constraints the read-only investigation surfaced:

- **(a) on-air gating** — never run heavy sync work mid-broadcast; defer to a quiet window on the
  machine's terms.
- **(b) no write-storm** — don't hold WAL write locks long enough to stall the daemon's live
  `songs`/`clocks` reads (busy_timeout=5000 → a stall caps at ~5s, enough to cause a late
  transition / dead air at a song boundary).
- **(c) resolve-to-existing-local-ids** — never renumber this install's local integer ids, so the
  non-synced `generated_schedule` (which references local `song_id`/clock ids) stays valid.

And it answers the two questions you asked:
1. How on-air awareness gets wired from the marker file into the sync layer (§2).
2. Whether it should run at all on an already-aligned install, or detect alignment and skip (§1).

---

## 1. WHEN it runs — and the self-skip (answers question 2)

**Decision: the re-baseline is conditional and self-skipping. An already-aligned install (OV today)
does NOT do the heavy re-pull — it detects alignment, verifies clean, and just flips to enforce.**

Rationale (from the baseline proof): on an aligned install every station-scoped row already resolves
to the same local id it has, so a full re-pull re-applies thousands of mutations that all land on
identical state — pure churn, pure risk, zero benefit. The real work (and the only place stale
references can appear) is a *divergent* install.

So the gate is a cheap **read-only divergence scan**, not a re-pull:

- For each station-scoped local row, check that `station_id` equals the local id resolved from the
  station's UUID, and that each parent FK (`clock_id`, `category_id`, `show_id`, …) resolves to a
  live local row of the referenced table. Count mis-scoped / dangling rows.
- **Zero divergence → `not_needed`.** No heavy work. Flip enforce. (Expected OV path.)
- **Nonzero → `scheduled`.** Only these installs do the corrective re-pull (§3).

This dovetails with the shadow-first rollout (plan §6): the shadow pass already computes "what the
UUID-resolved result would be" and logs divergence. The divergence scan *is* that shadow report read
once over a full cycle — if shadow logs are clean, the install is aligned and skips. One mechanism
serves both "is it safe to enforce yet" and "does this install need a re-baseline."

## 2. HOW on-air awareness reaches the sync layer (answers question 1 — the new connection)

The blocker today: on-air lives as a **marker file** in the HA/main layer
(`_persistOnAir(anyLive)` writes/removes it, driven by the daemon's Icecast `liveCount`; `_wasOnAir()`
reads it — main.js:1703), and the sync layer has no view of it.

**Decision: inject an `isOnAir` predicate into the scheduler — the same dependency-injection seam
already used for `getStationId`.** Sync stays ignorant of *how* on-air is determined.

- In `main.js`, where the scheduler is built (`app._syncScheduler = new SyncScheduler(...)`, ~1532),
  pass `{ isOnAir: () => _wasOnAir() }`. The marker file, its path, and the Icecast wiring all stay
  in main.js. The sync layer receives a `() => boolean`, nothing more — mirroring
  `getStationId: () => String(getActiveStationId())` (main.js:1526).
- **Only the re-baseline path consults it.** The normal incremental tick (push + small pull) is tiny
  and must keep flowing on air — it is NOT gated. The predicate gates *only* the heavy corrective
  re-pull.
- Re-checked at start and **between every page** (the pull already paginates 500 rows). If on-air
  flips true mid-run, the runner finishes the current short page transaction, persists the cursor,
  and **suspends** until off-air — then resumes from the cursor. That is what makes it "on the
  machine's terms," interruptible without losing progress (re-apply is idempotent — merge Step 1).

Why a predicate and not "sync reads the marker file": reading the file directly would couple sync to
HA's file layout and main.js paths and break the existing rule that the sync engine is importable
from non-Electron contexts (test/verify scripts). The predicate keeps that boundary intact.

## 3. HOW it runs without a write-storm (constraint b)

When `scheduled` AND `isOnAir() === false`:

- **Off-air is the primary mitigation.** Off air, the daemon isn't doing song-boundary `songs`/clock
  reads for a live stream, so a stalled read can't become dead air for listeners.
- **Chunked + cooperative.** Re-pull in the existing 500-row pages, each applied in its **own short
  transaction** (never one giant transaction), with a yield/delay between pages so the WAL write lock
  is released frequently and the daemon's `busy_timeout` is never exhausted.
- **Re-check on-air between pages** (§2). Going live suspends the run.
- **Prefer a scoped re-pull over a full cursor-0 reset.** Only station-scoped tables for the
  station UUIDs that the divergence scan flagged need re-delivery; install-scope and library tables
  are unaffected. This bounds the volume to the actually-divergent data instead of the whole history.
  (Full cursor reset stays available as the simplest-correct fallback, but the scan makes it rarely
  necessary.)

## 4. HOW it avoids renumbering (constraint c)

Under the Tier-2 fix, apply already resolves each incoming station/parent UUID to the install's
**existing** local id and keeps matching rows by **uuid** (`row_id`), with the row's own integer `id`
dropped from the applied column set (plan §3D). The re-baseline uses that same apply path, so:

- A divergent row gets its `station_id`/FKs **corrected to this install's existing local ids** — it
  is re-homed, not renumbered.
- This install's own local ids never change, so `generated_schedule`'s local `song_id`/clock
  references stay valid across the re-baseline. No regeneration is forced; the next operator-driven
  `schedule:generate`/`generateDay` (guarded to never touch already-aired hours) picks up corrections
  when the operator chooses.

## 5. End-to-end state machine (`rebaseline_state` in system_state)

1. **Upgrade to the UUID-enforce build** → `pending`.
2. **Divergence scan** (read-only, §1):
   - 0 divergence → `not_needed` → enable UUID enforce. (OV path — no heavy work.)
   - \>0 → `scheduled` (record the flagged station UUIDs).
3. **`scheduled` + off-air** (+ optional operator window, §6) → corrective re-pull (§3/§4),
   chunked, on-air-gated, resolve-to-existing.
4. **Re-scan returns 0** → `done` → enable UUID enforce.
5. Idempotent throughout: interrupt (on-air, quit, crash) → resume from the persisted cursor; the
   merge's idempotency + LWW make re-apply safe.

## 6. Operator visibility & scheduling (constraint a, "schedulable")

- A non-modal indicator: "Programming re-sync pending — will run while off air" / "in progress N%".
- Operator controls: **Run now (only enabled while off air)** and **Defer to tonight / quiet
  window**. Default behavior with no operator action = run automatically the next time the station
  is off air. Nothing ever starts the heavy work while the marker says live.

## 7. Open questions / risks to settle before building

- **What counts as "on air" for deferral?** The marker is Icecast `liveCount > 0` (streaming). A
  station playing to local monitors without streaming would read as off-air. Decide whether the
  predicate must broaden to "any playout," or whether streaming is the right line.
- **Multi-station installs share one WAL DB.** On-air is per-station, but a re-baseline touching
  station X contends with station Y's live reads. "Off air" for the re-baseline should likely mean
  **all local stations off air** (or hard-throttle if any is live). Decide.
- **HA interplay.** The watchdog/auto-resume path (main.js ~386) and "Keep My Station On Air" must
  not race the re-baseline — gate it out during crash-recovery resume, not just steady-state on-air.
- **Marker latency.** The marker updates on the daemon→main Icecast status push, so there's a small
  window where a just-started broadcast isn't yet reflected. Per-page transactions are short and
  busy_timeout absorbs one overlap; we only *start* when off-air. Acceptable, but named.

## 8. How it would be proven

- **Divergence scan correctness:** seed an aligned install (scan → 0 → skip) and a divergent install
  (scan → N flagged) and assert the gate routes each correctly.
- **Resolve-to-existing:** after a corrective re-pull on a divergent install, assert local ids are
  unchanged and `generated_schedule` references still resolve (constraint c).
- **On-air gating:** drive the runner with `isOnAir` toggling mid-run; assert it suspends between
  pages and resumes from the cursor with no double-apply (constraint a + idempotency).
- **No-write-storm:** assert pages are independent short transactions with yields (constraint b) —
  measurable as max single-transaction duration under a simulated concurrent reader.

## 9. Not in scope
- No code. The gate change stays stashed and unapplied. This is the design for one slice (re-baseline)
  of the Tier-2 plan; it does not implement the UUID resolve itself (plan §3) — it consumes it.
