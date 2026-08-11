# Generate Worker + Auto-Generation — design

**Date:** 2026-08-11 · **Status:** DESIGN ONLY — no code written, nothing changed.
**Builds on:** `docs/goal-driven-scheduler-redesign-2026-08-10.md` (scheduler-core, Phase 2.5/3),
`docs/log-reader-single-source-playout-design-2026-07-20.md` (generated_schedule is playout),
backlog *"Auto-generation — rolling-horizon top-up (filed 2026-07-22)"*.

---

## 0. What the code already does — three premises in the brief need adjusting

Written before designing, because two of them change the shape of the work.

### 0.1 Generate does NOT block the main thread outright. It blocks it one hour at a time.

`_generateDayChunked` (`electron/main.js:7284`) already yields:

```js
for (let h = 0; h < 24; h++) {
  if (_genCancel) return { cancelled: true };
  await _generateDayRows(dayBase, ctx, effStart, h);   // one hour, synchronous
  _genEmit({ phase: "hour", hour: h, hourMs: Date.now() - t0, ... });
  await new Promise(r => setImmediate(r));             // ← the yield that keeps main alive
}
```

So the unit of blocking is **one hour's pick**, not the run. "Generate freezes the UI" is therefore
imprecise: the UI stutters for the length of each hour slice, 24 times a day generated, and the event
loop is starved in bursts rather than continuously.

**This matters because it decides whether the project is worth doing** — and the number that decides
it is already being emitted. `hourMs` rides in every `schedule:generate-progress` payload. Nobody has
read it.

> **GATE 0 — RESULT (2026-08-11): worker DROPPED - but read the correction; the first reasoning was
> wrong. See `docs/generate-phase0-measurement-2026-08-11.md` section 0.**
>
> **CORRECTED:** an hour of picking is **~4 s of solid CPU**, not the 2-6 ms my benchmark claimed -
> measured in-tree on Jeff's install (TIME-SLICED YIELD comment, 2026-08-06). The benchmark timed the
> candidate query, which turns out to be the cheap part. The 2026-07-21 freeze WAS Generate.
>
> The worker is still dropped, because that freeze was **already fixed in 4.4.156** (`9f8c752`) by
> yielding every ~60 ms inside the hour: 120 ms and 500 ms slices measured 100% responsive. A worker
> would re-solve a solved problem. What remains true is that main burns ~0.96 cores during a generate
> - real, but not worth a thread today.
>
> ORIGINAL (WRONG) RESULT TEXT FOLLOWS.
>
> Measured p95 hour slice: **5–24 ms** across all four stations; a full 7-day generate is ~1 s of
> candidate SQL. That is an order of magnitude below this gate's own 300 ms bar. **§1 (the worker) is
> dropped from the arc**; §2 (fuel gauge), §3 (auto-generation) and the §1.3 extraction proceed.
>
> Two corrections to this document, found by running it:
> 1. **`hourMs` is not retrievable.** It is emitted and consumed by nothing — not the renderer, not
>    the ledger, not any log. Phase 0 had to be run as a read-only proxy benchmark instead. The claim
>    below that it merely went "unread" was too generous.
> 2. **The 2026-07-21 17 s freeze is NOT explained by Generate's pick loop**, which cannot produce
>    17 s at these library sizes. This document used that incident as motivation. Its real cause is
>    still unknown, and the worker would not have fixed it.
>
> The worker becomes correct at scale — ~404 ms/hour at a 5,000-song category — but the cheaper and
> better first move there is to fix `ORDER BY RANDOM()`, which sorts the whole category to pick one
> song. Revisit at ~2,000 songs in a single category, or a measured `hourMs` p95 over 300 ms.
>
> ---
>
> **ORIGINAL GATE TEXT — MEASURE FIRST (half a day, no product code).** Capture `hourMs` across a 7-day generate
> on OV's library. If the p95 hour slice is ~50 ms, the worker buys very little and this arc should be
> re-scoped to auto-generation alone. If it is 300 ms+, every hour boundary is a visible stall and the
> worker is justified on its own. **Do not build §1 before this number exists.** The 17 s freeze on
> 2026-07-21 is suggestive, not proof — it was attributed to a 7-day run without a per-slice profile.

### 0.2 Cancellation and progress already exist and must be preserved, not invented

- `ipcMain.handle('schedule:generateCancel')` sets `_genCancel` (`main.js:7307`).
- Cancel is honoured **at every hour boundary**, and an in-flight day is discarded, never written.
- Each day commits atomically (`_commitDayRows`, `main.js:7300`): `DELETE` + bulk insert in ONE
  transaction, because a split commit once left `generated_schedule` — the single playout source —
  empty for the duration of a pick.

The worker must reproduce this contract exactly. It is not a new feature surface.

### 0.3 A worker precedent already ships — follow it rather than inventing a second pattern

`electron/db-verify-worker.js` (40 lines) + its host (`main.js:1266-1281`) establish the house style:

| Element | Existing pattern |
|---|---|
| Spawn | `new Worker(path, { workerData })` |
| Messages | `{ progress }` … then one `{ result }` |
| `worker.on("error")` | **fall back to the in-process implementation** |
| `worker.on("exit")` | settle with an explicit failure — never hang |
| better-sqlite3 | `require`d INSIDE the worker, in a try/catch, because the ABI can be wrong |
| Mutation | none — that worker only reads |

§5's rollback story is this pattern, already proven in the restore path.

---

## 1. The worker

### 1.1 Recommendation: worker READS and PICKS; main WRITES

Three shapes were considered.

| | A. Everything in the worker | B. Pure compute only | **C. Read+pick in worker, commit on main** |
|---|---|---|---|
| Heavy SQL off main | yes | **no** | yes |
| CPU pick off main | yes | yes | yes |
| Worker needs a WRITE connection | yes | no | **no** |
| Write path stays single-owner | no | yes | **yes** |
| Atomicity of a day | in worker | on main | **on main, unchanged** |

**B is rejected on measurement grounds**: the expensive part is not arithmetic, it is
`stmtCandidates` — a per-slot query with `ORDER BY RANDOM()` over the category's songs, plus
separation lookups against `play_log`. Moving only the arithmetic leaves the SQL on main and buys
almost nothing.

**A is rejected on blast radius**: a second read-write connection introduces writer contention with
main and with the daemon (a third process that already writes `generated_schedule.state`). WAL
tolerates it, but the failure mode — a `SQLITE_BUSY` inside the one transaction that owns playout —
is exactly the class this codebase has been burned by.

**C is the recommendation.** The worker opens its own **read-only** connection, does the candidate
reads and the picking, and posts back plain row objects. Main performs the existing
`_placeJingles` + `_commitDayRows` unchanged. The worker keeps db-verify-worker's strongest property:
**it cannot corrupt anything, because it never writes.**

Volume is not a concern: a 7-day generate is ~2,000 rows of small plain objects; structured clone
cost is negligible beside the pick itself.

### 1.2 Message protocol

Deliberately close to the existing progress payload so the renderer needs no changes.

```
main → worker   { type: "generate", stationId, days: [dayTs…], effStartByDay, config }
worker → main   { type: "progress", phase: "hour", day, dayIdx, dayTotal, hour, hoursDone, hourMs, rows }
worker → main   { type: "day",      dayIdx, dayTs, effStart, dayEnd, rows: [...], diag, relaxed, coreParity }
worker → main   { type: "result",   daysGenerated, cancelled }
worker → main   { type: "error",    message, stack, dayIdx }
main → worker   { type: "cancel" }
```

**A `day` message per day, not one payload at the end.** It preserves today's "each finished day is
committed atomically; a cancel leaves whole days, never a half day" behaviour, and it bounds memory
for a long range.

**Cancellation stays cooperative.** The worker checks a flag set by the `cancel` message at each hour
boundary — the same granularity as today. `worker.terminate()` is NOT the cancel path: it would kill
the thread mid-pick with no chance to report which days completed. Terminate is reserved for §5's
watchdog.

### 1.3 The context problem — the one real piece of engineering

`_buildScheduleCtx(stationId)` (`main.js:6706`) returns **prepared statements bound to main's
connection**. Prepared statements cannot cross a thread boundary; neither can the `db` handle.

So the worker must build its own context against its own connection. That means `_buildScheduleCtx`
and `_generateDayRows` have to become **connection-parameterised** — they take a `db` rather than
closing over the module-level one.

This is the bulk of the work and the main regression risk, because those functions are the picker.
Mitigation:

1. Extract them into `electron/generate-core.js`, taking `db` as an argument, with **no behaviour
   change** — a pure move, diffed for byte-identity the way Phase A's tab extraction was.
2. Main requires it and calls it exactly as before. Ship that alone and verify: same rows, same
   order, same diagnostics.
3. Only then does the worker require the same module.

**One module, two callers.** If the worker ever gets its own copy of the picker, the arc has failed:
that is two schedulers, and the goal-driven redesign exists specifically to avoid that.

### 1.4 Error handling

| Failure | Behaviour |
|---|---|
| Worker fails to spawn (ABI, path, OOM) | Log, fall back to the in-process path, generate normally |
| Worker `error` event mid-run | Days already committed stand; remaining days fall back in-process |
| Worker exits with no `result` | Treated as failure; same fallback; health event |
| A single day throws inside the worker | `{type:"error", dayIdx}` — that day is skipped, the rest continue, and the failure is reported per-day rather than losing the run |
| Worker hangs (no message for N seconds) | Watchdog terminates it, falls back (see §5.3) |

**The fallback is not a nicety, it is the rollback plan.** Generate must work on a machine where the
worker cannot run at all.

---

## 2. Horizon / fuel gauge

### 2.1 The metric: runway to the FIRST GAP, not the last row

The obvious calculation — `MAX(scheduled_at) - now` — is wrong, and wrong in the dangerous direction.
A station with rows through Friday but a hole tomorrow at 03:00 has **one** day of runway, not four.
A gap is dead air on a flipped station.

```
horizonHours = (first uncovered hour at or after the current hour) - now
```

Concretely, per station:

1. Take the set of hours that have at least one non-deleted `generated_schedule` row, from the
   current hour forward.
2. Walk forward from the current hour; stop at the first hour with no rows.
3. That boundary minus now, in hours, is the runway. Days = runway / 24.

**Hours a show does not cover are not gaps.** A station that runs 06:00–00:00 has no 03:00 rows by
design, and the gauge must not report a nightly cliff. The covered-hours set comes from the same
show/clock read Generate uses (`stmtShows` + `deleted_at`-filtered slots), so the gauge and the
generator agree on what "should exist" by construction rather than by a second opinion.

> **Open question 1 for Jeff:** for a station with no active show at all, is the correct runway `0`
> ("nothing will air") or `n/a` ("nothing is meant to air")? Recommendation: **n/a, level grey** —
> a station with no shows is unconfigured, not starving, and a red gauge there is the false alarm
> that teaches people to ignore the gauge.

### 2.2 Levels

Per the backlog: **green ≥5 days · yellow <3 days · red <1 day.** Between 3 and 5 is green;
thresholds are the operator-visible contract and belong in one constant, not three call sites.

### 2.3 Where it surfaces

- **Health Monitor** — a per-station row, beside the existing depth/materialisation senses. This is
  the canonical home: it is where "is my station healthy" already lives.
- **Schedule Manager header** — one line: `SCHEDULE: 6 days` / `SCHEDULE: 14 hours — generating…`.
  The workspace is where an operator is already thinking about the log.
- **Calendar** — already shows generated days; the gauge adds the number, not a new surface.

No new panel. (`DOORS BEFORE ROOMS` cuts both ways: a fourth place to look is not a door.)

### 2.4 How it updates

It is a **derived read, not stored state** — so it cannot go stale or disagree with the log:

| Trigger | Why |
|---|---|
| The existing `library-health` sweep | It already runs per station and owns the Health Monitor snapshot |
| After any Generate commit | The number changed; do not make the operator wait for a sweep |
| On demand when the Schedule Manager mounts | A pane opening should not show a stale figure |

Cost is one indexed query per station over future rows — cheap next to the sweep already running.
**No new timer, no new poller.** (Standing rule: temporary tooling expires; permanent senses ride
existing sweeps.)

---

## 3. Auto-generation

> **CORRECTION 2026-08-11 — THIS SECTION DESIGNED SOMETHING THAT ALREADY EXISTED.**
>
> `_autoExtendTick()` has shipped in `electron/main.js` for months: a 30-minute timer, per station,
> calling `_generateRange()` when runway falls below a threshold, with sparse-schedule healing. I
> wrote §3 without finding it — the same failure as §1's premise, in the same file.
>
> Everything below therefore reads as a design for a REPLACEMENT. It should be read as a
> specification for what the existing engine was MISSING, which is what the arc actually built:
> ledger events (done), the Health Monitor row (done), the corrected first-gap metric (done),
> thresholds 4d/10d (done), and per-station on/off plus the deferral policy (open).
>
> The parts of §3 that survive unchanged are §3.2b (deferral) and §3.3's safety rails — neither
> existed. The parts about "where it is decided" and "no new timer" were describing a timer that was
> already there.



### 3.1 The rule

> When a station's runway falls below its threshold, generate forward to its target — in the worker,
> unattended, and say so afterwards.

- **Threshold** (default **2 days**) and **target** (default **7 days**) are per station.
- **Off is a first-class setting**, not an absence of configuration. `auto_generate = off` must be
  honoured forever with no nagging: a station that is hand-programmed is a legitimate choice.
- Runs are **serialised** — one auto-generate at a time across all stations, and never concurrent
  with a manual Generate. The lock is main-side and in-memory; a second request is dropped, not
  queued, and logged as dropped.

### 3.2 Where it is decided

In main, on the back of the horizon read that already happens in the `library-health` sweep. The
sweep computes the runway; if it is under threshold and auto is on and no run is in flight, it posts
a job to the worker. **No new scheduler, no new interval.**

### 3.2b RULED 2026-08-11 — auto-generation DEFERS while in-process audio fallback is active

The retraction (Phase 0 §0) left one honest argument standing: a generate burns ~0.96 cores on main
for its duration. Responsiveness is fine — the 60 ms yield handles that — but when the audio daemon
is NOT running and the app is in **in-process audio fallback**, the audio path shares that thread.
An unattended background generate competing with playout is a risk taken on the operator's behalf,
without them asking.

**The answer is policy, not a thread:**

- Before starting an auto-run, check the playout mode (`AUDIO_DAEMON` / the mode the Health Monitor
  already reports as "in-process").
- If in-process fallback is active, **do not start**. Emit a health event
  `auto-generate-deferred { stationId, reason: "in-process-audio", horizonHours }` and try again on
  the next sweep.
- When the daemon is healthy again, the deferred run proceeds normally.
- **Manual Generate is unaffected.** An operator pressing Generate has decided; the app does not
  second-guess that. This rule governs only the unattended path.

**The deferral must be visible, and it must not be silent forever.** If the horizon reaches the RED
band while auto-generation is still deferred, that is no longer a deferral — it is a station heading
for a dry log, and the Health Monitor says so in RED regardless of the reason. A quiet deferral that
outlives the runway would be the same class of failure as a sense that stops writing.

### 3.3 Safety rails

These exist because an automatic writer to the playout source is the highest-consequence thing in
this design.

1. **Never touch the in-progress hour.** The existing `effStart = max(dayStart, next top of hour)`
   rule is not optional; auto-generation uses the same code path.
2. **Only ever generate FORWARD, into hours that have no rows.** Auto-generation must never
   regenerate a day that already has a schedule — that is a manual, operator-initiated act, because
   it discards a log the operator may have hand-edited.
3. **Cap the work per run** (default 7 days) and **rate-limit** (no more than one auto run per
   station per hour) so a misconfiguration cannot spin.
4. **Back off on failure**: two consecutive failures for a station disable auto for that station
   until the next app start, with a RED health event. Retrying a failing generator every sweep is how
   a small bug becomes a log full of noise and a hot CPU.
5. **A global kill switch** (`auto_generate_enabled`, install-scoped) so the behaviour can be turned
   off fleet-wide without a release.

### 3.4 What the operator sees

Silence is not acceptable for something that writes the log unattended:

- A health event per run: `auto-generate` with station, days generated, rows, duration, outcome.
- The fuel gauge moving, with a transient "generating…" state.
- Failures surface as RED in the Health Monitor, with the same named reasons Generate already
  produces (`emptyCats`, `noClock`, `noShowHours`) — the diagnostics exist; auto-generation reuses
  them rather than inventing a second vocabulary.

> **Open question 2 for Jeff:** should auto-generation run when the station is **off air**? It costs
> nothing and keeps the runway healthy. Recommendation: **yes** — the alternative is a station that
> starts up with an empty log precisely because it was quiet.

---

## 4. Integration with the existing rules

The worker inherits every rule by **calling the same code**, not by reimplementing it. This section
is the checklist for the extraction in §1.3.

| Rule | Where it lives today | In the worker |
|---|---|---|
| **Clock is law** — only live (`deleted_at IS NULL`) slots | `stmtSlots` (`main.js:6705`) | Same statement, worker's connection |
| **Goals / scheduler_mode** | `scheduler-core.js` via `_generateDayRows`; `stations.scheduler_mode` | Unchanged — scheduler-core is already pure and thread-safe by construction (no I/O, no `Date.now`, no `Math.random`) |
| **NULL-category exclusion** | `stmtCandidates` filters `s.category_id = ?`, so NULL can never match | Unchanged. **Note:** the 4.4.181 guard was in the DAEMON fill (`loggen.baseConditions`), a different path — Generate was never the leak |
| **Jingles / SWP placement** | `_placeJingles` | **Stays on main** — it runs at commit time, beside the write |
| **Timed spot breaks** | clock_breaks read inside the pick | Same statement, worker's connection |
| **Separation + dayparting** | `ctx` maps from `play_log` / `separation_rules` | Rebuilt in the worker against its own connection |
| **pick_reason / explainability** | written into the row objects | Carried across in the `day` message unchanged |
| **scheduler-core parity ledger** | `_noteSchedulerCore(stationId, ctx)` | Ledger data rides in the `day` message; **main writes it**, so observation stays where the file handles are |
| **Health events** | `_libHealth.noteGenerate(...)` | Same — main-side, from the returned diag |

**Verification for the extraction (§1.3 step 2):** generate the same 7 days twice — once through the
old path, once through the extracted-but-still-in-process path — with a fixed seed, and diff the
committed rows. Same rows, same order, same `pick_reason`. This is the parity discipline that
Phase 3's differential ledger already established; reuse it rather than trusting a read-through.

---

## 5. Risks and rollback

### 5.1 The ranked risks

| # | Risk | Likelihood | Consequence | Mitigation |
|---|---|---|---|---|
| 1 | **The picker extraction changes what airs** | medium | high — silently different rotation | Pure move first, byte-diffed; parity run before the worker exists |
| 2 | better-sqlite3 unavailable/ABI-mismatched in the worker | medium | none if handled | `require` in try/catch → fall back in-process (db-verify precedent) |
| 3 | Auto-generation regenerates a day an operator hand-edited | low | high — lost work | Forward-only into EMPTY hours; never overwrite |
| 4 | Worker hangs; runway silently stops growing | low | high — eventual dead air | Watchdog (§5.3) + the gauge itself is the alarm |
| 5 | Read-only worker connection sees a mid-write state | low | medium | WAL gives the worker a consistent snapshot; the commit is one transaction on main |
| 6 | Auto-generation storms after a failure | medium | medium | Rate limit + two-strike back-off + kill switch |
| 7 | Worker + daemon + main all open the DB | certain | low | Already true today (daemon is a separate process); worker adds a READER only |

### 5.2 Rollback, in order of cost

1. **`auto_generate_enabled = false`** — install-scoped kill switch. Auto stops; manual Generate is
   untouched. No release needed.
2. **`generate_worker_enabled = false`** — the worker is bypassed and Generate runs exactly as it
   does today. This flag must exist from the first commit, default OFF, and the in-process path must
   remain a first-class code path, not a decayed fallback.
3. **Revert the release.** The extraction in §1.3 is the only change that touches picking, which is
   why it ships as its own commit ahead of everything else.

### 5.3 If the worker fails

- **Fails to start** → in-process, with one health event. The operator sees nothing different.
- **Errors mid-run** → committed days stand (they are atomic); the rest run in-process.
- **Hangs** → no message for 60 s while a run is active ⇒ terminate, health event, in-process retry
  once. If that also fails, auto-generation backs off for the station.
- **Produces bad rows** → the parity ledger already in place is what would catch it; a generate whose
  divergence rate jumps is a RED health event, not a silent success.

**A generate that did not happen must never look like one that did.** Every failure path ends in
either a completed generate or a visible RED — never a quiet no-op.

---

## 6. Phasing

| Phase | Work | Gate |
|---|---|---|
| **0** | Measure `hourMs` over a 7-day run | **DECIDES §1.** Under ~50 ms p95, re-scope to auto-generation only |
| **1** | Extract picker into `generate-core.js`, connection-parameterised. Still in-process | Byte-diff the move; parity run of 7 days |
| **2** | Fuel gauge — read-only, no generation changes | Gauge matches a hand count on OV; no gap false-positives on a part-day station |
| **3** | The worker, behind `generate_worker_enabled`, default OFF | Same rows as Phase 1; cancel still works at hour boundaries; kill the worker mid-run and confirm fallback |
| **4** | Auto-generation, behind `auto_generate_enabled`, default OFF | Runs unattended on jensj for a week; never overwrites; health events present |
| **5** | Defaults ON, OV last | A full week of green |

Phases 1 and 2 are independently useful and carry no worker risk. If the arc stops after Phase 2,
the operator still gains the fuel gauge — which is the part that turns "the log ran dry" from a
surprise into a number that was visible for days.

---

## 7. What this design deliberately does NOT do

- **No new scheduler.** One picker, called from two places.
- **No second timer or poller.** The gauge and the auto-trigger ride the existing `library-health`
  sweep.
- **No generation in the daemon.** The daemon reads the log and fills gaps live; it does not author
  days. Auto-generation is a main-process concern, which also sidesteps the standing caveat that the
  daemon does not reload on auto-update.
- **No backfill.** Auto-generation never writes into the past or the current hour.
- **No horizon state in the database.** The gauge is derived; a stored copy is a thing that can lie.

---

## 8. Open questions for Jeff

1. **Runway for a station with no active show** — `0` (red) or `n/a` (grey)? Recommendation: grey.
2. **Auto-generate while off air?** Recommendation: yes.
3. **Default threshold / target** — 2 days / 7 days proposed. OV's tolerance may differ.
4. **Does auto-generation need an operator-visible log of its runs**, beyond health events — e.g. a
   line in the Calendar for "auto-generated"? Recommendation: yes, eventually; not in Phase 4.
5. **Phase 0's outcome could cancel §1.** Is that acceptable, or is the worker wanted regardless of
   what `hourMs` says? The honest answer changes how much is built.
