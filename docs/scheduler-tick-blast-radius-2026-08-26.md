# The 15s tick — what actually runs on it, and what second-accuracy really costs (2026-08-26)

**Status: INVESTIGATION COMPLETE, AND THE PROPOSED SCOPE IS BUILT (2026-08-26).**

Jeff chose 250ms. Gates green: `node --check`, `tsc --noEmit` (0 errors), `verify:schema` PASS,
`test:sync` 46/46. This is the authoritative doc for the change;
`docs/announcement-second-precision-design-2026-08-26.md` is superseded.

Jeff's concern: "a 15s check interval can throw off the whole clock — every event drifts." This
answers his four questions with receipts, and the headline correction is in Q1.

---

## Q1 — What runs on the 15s tick? ANNOUNCEMENTS ONLY.

`ANNOUNCE_TICK_MS` has exactly one consumer: `_announceTimer` → `announceTick()`
(`electron/main.js:4421`). Nothing else reads it. No spot, no traffic element, no clock event, no
top-of-hour is on this timer.

**The real playout clock is in the DAEMON, and it is already sub-second:**

```
audiod/engine.js:375
  if (!this.pollTimer) { ...; this.pollTimer = setInterval(() => this.poll(), 250); }
```

**250 ms, per station.** `_checkTopOfHour()` is called from inside `poll()` (`engine.js:526`), so the
top-of-hour hard cut is evaluated **four times a second** and fires within 250 ms of :00.

More important than the cadence is the MODEL, which `engine.js:569-570` states outright:

> Radio needs the top of each hour to hit at :00 … even mid-song. **Nothing else here watches the
> wall clock; rotation only advances at song-end.**

Spots and clock elements **do not fire on a wall-clock tick at all.** They play back-to-back by
preload + segue — the next element is already loaded on a standby deck and is triggered by the
outgoing deck's *audio position*, not by any timer. A polling interval, at any speed, is not in that
path and cannot drift it.

**Conclusion: second-accuracy is an ANNOUNCEMENT fix, not a scheduler-wide fix.** There is no
scheduler-wide 15s tick to make second-accurate — the traffic path is 250 ms and position-driven.

The premise "every event drifts off the 15s tick" does not hold. The 15s tick was introduced
yesterday and only ever governed announcements.

## Q2 — Who set 15s, and was it deliberate?

```
$ git log -S "ANNOUNCE_TICK_MS" --oneline -- electron/main.js
4e7425e feat(announce) slice 5: scheduled announcements fire from MAIN, and closing time is per weekday
```

**One commit — slice 5, 2026-08-25. Yesterday. This arc.** It is not an old load-driven decision and
it was never "not revisited"; it is one day old.

The reason it is 15s is visible in the guard it was written alongside:

> `// Fired already this minute-or-two? The tick is 15s, so without this the same minute fires four times.`

15s was picked as "comfortably inside a one-minute match window" — enough to not miss a `HH:MM`
match, coarse enough not to fire constantly. **There was no load analysis behind it.** Nothing is
being protected by keeping it.

## Q3 — What does second-accuracy cost, and how do you keep it cheap?

The tick currently runs, **per tick**:
- `SELECT id FROM stations WHERE deleted_at IS NULL`
- one announcements SELECT **per station**
- one `station_config_kv` SELECT **per close_offset row**

…and it called `db.prepare()` on all of them **every single tick** — i.e. it recompiled the SQL each
time. Affordable at 1 tick / 15s; wasteful at 1/s or faster, on the process that also carries the
audio command path.

Two mitigations, in order of value:

1. **Hoist the prepares to module scope.** Compile once, reuse. Same statements, same results, only
   the compilation moves. This alone takes the per-tick cost down to a few indexed reads on tiny
   tables — microseconds.
2. **Cache the plan in memory.** Read announcements + closing times on a slow refresh; the fast tick
   then does pure integer comparison over a small array. **Zero DB in the hot path.**

For scale: the daemon already runs a 250 ms poll **per station** — 16 evaluations/second across four
stations — doing far more work than this, and has been fine. A 1/s (or even 4/s) arithmetic-only
tick in main is not the expensive thing it sounds like. The expensive thing was `db.prepare` in a
loop, and that is fixable independently of cadence.

## Q4 — How RCS-grade timing is actually achieved here

Not by polling the wall clock quickly. Three mechanisms already in the build:

1. **Preload + segue.** The next element is loaded onto a standby deck ahead of time and triggered
   off the outgoing deck's audio position (`engine.js` — `segueTriggered`, `preload`). Back-to-back
   accuracy is a property of the audio engine, not of any timer.
2. **The log is built to time.** `audiod/loggen.js` + `audiod/autofit.js` compute anchors and fit
   content into the window ahead of the moment. Precision is baked into the log, then played out.
3. **The :00 hard cut.** One wall-clock anchor per hour, evaluated at 250 ms — deliberately the only
   thing in the engine that watches the clock.

And the designed, approved, not-yet-flipped fourth:

4. **§2.7 time-anchored playhead** — the Log-Reader Flip
   (`docs/aux-channel-ducker-announcements-design-2026-08-21.md` is the announce arc;
   the flip's own design carries §2.7). Phases 0–2 shipped (v4.4.68/69/70); the flag stays off until
   Phase 3 shadow burn-in. **This is the architectural home for "back-to-back elements land in the
   right order at the right time."** If element-level anchor accuracy is the real requirement, that
   arc is where it belongs — not in a polling interval.

---

## Proposed scope — SMALL, and it is what Jeff already asked for

**In scope (announcements only):**
- `trigger_time` and closing time match to `HH:MM:SS`. No migration — `trigger_time` is TEXT
  (`scripts/schema-v0-baseline.js:260`) and closing time is a TEXT KV. `'HH:MM'` reads as
  `'HH:MM:00'`, so every existing row keeps the exact instant it has today.
- `ANNOUNCE_TICK_MS` drops so the tick VISITS every second — the match is an equality test, so an
  interval that does not visit a second can never fire on it. **This is the forced change and the
  only reason the tick moves.**
- `db.prepare` hoisted out of the tick.
- `step={1}` on both pickers, seed `17:30:00`, `fmtTime` renders seconds only when non-zero.

**Explicitly NOT in scope, per Jeff:** no grace window, no missed-fire/catch-up logic, no change to
how a manual ▶AIR press interacts with a scheduled fire, no midnight-wrap rework, and **no change to
the daemon's 250 ms poll or anything on the traffic path.**

### The one open choice: 1000 ms or 250 ms

With an exact-second equality match and no grace window (Jeff's constraint), a tick that lands late
enough to skip a second means that second is never seen and the row does not fire.

- **1000 ms** — the largest interval that visits every second. Smallest possible change to the
  number. A single late tick can skip a second.
- **250 ms** — visits every second about four times, so one late tick cannot skip it. The
  **existing** 120 s `last_played_at` guard already absorbs the repeat hits within the matched
  second — this needs **no new firing rule whatsoever**, which is exactly Jeff's constraint. It is
  also the cadence the daemon has run at, per station, for the life of the product.

**DECIDED: 250 ms** (Jeff, 2026-08-26) — built.

**Recommendation was 250 ms.** It buys robustness using only the knob Jeff authorised (the tick rate)
and the guard that is already there, and it costs nothing once the plan is cached and the prepares
are hoisted. It is the one place where a slightly larger tick change is the *more* conservative
choice.
