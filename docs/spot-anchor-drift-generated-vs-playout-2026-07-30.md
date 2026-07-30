# Spot anchor drift — generated right, played without enforcement

**Date:** 2026-07-30 · **Mode:** READ-ONLY. Live DB opened `readOnly: true`, daemon log and source read. Nothing
changed, nothing built.

**Verdict up front: the log was generated CORRECTLY. Playout never looks at the clock.** The spot anchored at
**07:38:53** aired at **07:44:57** — **6 min 04 s late** — and the row that aired was not even that row.

---

## 1. The log as generated — correct on paper

Station 4, today, around the anchor (local time, `generated_schedule`):

```
07:36:00   173s  MUSIC   Please Come Home For Christmas     → ends 07:38:53
07:38:53    18s  SPOT    Spot_Free_Christmas…               ← THE ANCHOR
07:39:11   225s  MUSIC   This Christmas
07:42:56   163s  MUSIC   Kana Kaloka
```

The music row before the spot ends **at exactly 07:38:53**, the second the spot begins. **Generate filled music to
hit the anchor precisely.** The arithmetic is right; this side did its job.

(Yesterday the same clock position generated the spot at 19:40:04 — likewise with music filled to land on it.)

## 2. Playout vs the log — it did not drift off the log, it was never on it

What actually aired 07:25-07:46 has **no overlap** with what was generated for that window:

```
GENERATED                              AIRED
07:27:56  Snow Angel                   07:25:35  Little Saint Nick
07:30:49  Here Comes Santa Claus       07:27:43  Holiday Road - 2024 Remaster
07:33:01  Candy Christmas              07:29:53  Numbah One Day Of Christmas
07:36:00  Please Come Home For Xmas    07:33:50  On Eagle's Wings
07:38:53  SPOT  ← anchor               07:35:37  Christmas In July
07:39:11  This Christmas               07:38:46  Christmas in the City
07:42:56  Kana Kaloka                  07:41:27  What the World Needs Now Is Love
                                       07:44:57  Spot_Free_Christmas…   ← 6m04s late
                                       07:45:15  Santa Claus is on the Way
```

**Not one title matches.** And the row states prove the log is being consumed out of time order:

```
sched 07:20:25  SPOT  state=played
sched 07:38:53  SPOT  state=pending    ← the anchor row. STILL PENDING at 07:46.
sched 08:00:00  SPOT  state=pending
sched 08:19:58  SPOT  state=played     ← a row 34 minutes in the FUTURE, already marked played
```

A row scheduled for **08:19:58 is already `played`** while the 07:38:53 row has not aired. The reader is not walking
the log by time at all.

### Why — the selector is a ROW CURSOR, not a time anchor

`refillIfNeeded` (`audiod/engine.js:739-759`) takes the legacy path and calls `loggen.fillQueue`, whose Tier 0 is
`readGeneratedSchedule` (`audiod/loggen.js:188-205`):

```sql
WHERE gs.id > ?              -- ← _schedCursor: a monotonic ROW-ID cursor
  AND gs.station_id = ?
  AND gs.scheduled_at >= ? - 300      -- only a floor to skip ancient rows
ORDER BY gs.scheduled_at LIMIT ?
```

```js
loggen.js:204   if (rows.length) _schedCursor = rows[rows.length - 1].row_id;
```

**It selects the next 20 rows by id, then the queue plays them back-to-back as fast as each track ends.
`scheduled_at` is never consulted again.** If a song runs long, or a segue adds time, the next row simply starts
later — and every row after it inherits that lateness, compounding. That is exactly the 6-minute gap.

Two further findings in the same function, flagged, not chased:

- **`_schedCursor` is module-level** (`loggen.js:185`), i.e. **shared by all four stations** in the single daemon
  process. Each station's refill advances the other stations' cursor. This is the most plausible source of the
  enormous permanent `missed` backlogs below, and of the future-row-marked-played above.
- **On exhaustion the cursor resets to 0 and re-reads from the beginning** (`loggen.js:414`, *"loop back to start
  once exhausted"*) — the log restarts rather than ending.

### Is there ANY runtime drift correction? — **One, and only one: the top of the hour**

`_checkTopOfHour` → `_hardCutTopOfHour` (`audiod/engine.js:365-395`). **To answer your question directly: yes, at
the top of the hour it replaces the queue with songs.** Specifically it:

1. hard-stops decks A, B and C (no fade),
2. clears the queue,
3. re-queues **20 rows starting at the hour boundary** — `loggen.fillFromHour(db, stationId, hourStartTs, 20)`
   (`loggen.js:209-227`, `WHERE gs.scheduled_at >= hourStartTs`),
4. loads and plays the first one on deck A.

So the log is re-anchored to the clock **once an hour**, by a hard cut, and then runs free again. That is why the
:00 spots land (`07:00:00 state=played`, `08:00:00` next) while the :20 and :39 anchors do not.

**Between hours there is nothing.** No shortening of the fill, no dropping a song, no cut-to-spot at a boundary.
`_segueTick` (`engine.js:1297-1322`) and `handleRotate` (`engine.js:578-...`) never read `scheduled_at` — the segue
decision is purely `remaining <= segueOverlap`. **Stated plainly: outside the top-of-hour hard cut, no runtime
correction toward a time anchor exists.**

## 3. By design, or missing enforcement? — **The enforcement is BUILT, and it is switched OFF**

This is not a gap. It is the **Log-Reader Flip**, already designed and approved, and its Phase 3 activation code is
in the tree:

```js
audiod/engine.js:736-739
// Log-Reader Flip: when ON for this station, playout is a READ-THROUGH of generated_schedule via the
// §2.7 selector — the queue becomes a cache of log rows >= the playhead (§2.3). OFF path below is
// byte-identical to the pre-flip legacy behaviour.
if (this._logReaderOn()) return this._refillFromLog();
```

`_refillFromLog` → `loggen.readLogAnchored` → **`selectRowForNow`** (`loggen.js:242-273`) is precisely the model you
describe — it takes the wall clock and returns the row that *should* be on air now, classifies `behind` /
`on-time` / `ahead`, and stamps the rows whose slots elapsed as `missed`:

```js
const drift = nowTs - playRow.scheduled_at;   // >0 = running behind
return { playRow, missedCount, mode: drift > slackSec ? "behind" : "on-time", driftSec: drift };
```

**It is not running.** The gate is `_logReaderOn()` (`engine.js:722-734`) — env `ETHER_LOG_READER=1` or the
per-station `station_config_kv` key `log_reader_flip`. The live daemon reports, for all four stations:

```
2026-07-30T14:19:10Z [engine s4] log-reader flip: ETHER_LOG_READER=0 (OFF — legacy playout + §2.7 shadow only)
2026-07-30T14:21:25Z [engine s3] log-reader flip: ETHER_LOG_READER=0 (OFF …)
2026-07-30T14:21:29Z [engine s2] log-reader flip: ETHER_LOG_READER=0 (OFF …)
2026-07-30T14:21:33Z [engine s1] log-reader flip: ETHER_LOG_READER=0 (OFF …)
```

So the answer to "generated wrong, or generated right and played without enforcement" is: **generated right, played
without enforcement — and the enforcement exists, fully written, currently observing instead of acting.** Per the
approved arc it stays off until the Phase 3 shadow is judged; the shadow is running right now and is what produces
the numbers in §4.

## 4. Do the other stations drift? — **All of them. This is systemic, not station 4.**

The `[LOGREADER-SHADOW]` line is the flip telling us, every rotation, what it *would* have aired. Latest per
station:

```
s2   drift  31s │  43s │ -59s │  66s        missed 1358 (steady)
s3   drift -27s │ -16s │ -30s │ 64s │ -17s  missed 1434 (steady)
s4   drift -13s │ -56s │  49s │ -23s │ -25s │ 136s   missed 1313 → 1318 (CLIMBING)
```

Every station wanders ±30-60 s and periodically goes `behind`. **Station 4 is not uniquely broken — it is the same
defect, further along.** Two things do set it apart:

- Its aired row is running **~15 rows AHEAD** of the time-anchored row (`aired row 165993 — flip would air row
  165978`), where s2/s3 air a row *at or just behind* theirs.
- Its `missed` count **increases with every track** (1313 → 1314 → 1315 → 1316 → 1318) while s2's and s3's hold
  steady — it is consuming the log faster than the clock, so its anchors keep sliding further out.

Station 1 produces no shadow lines at all (it has no rotation in this log window).

---

## Filed, not chased

The spot that aired at 07:44:57 is written to `play_log` with `content_class = 'MUSIC'`, not `SPOT` — as were the
earlier ones. Whatever the affidavit/reporting layer reads out of `play_log` will not see these as spots. Noted
only; not investigated.

## Scope note

Read-only. Live DB opened `readOnly: true` and closed; daemon log and source read, not modified. No file in
`C:\openair` changed, nothing committed, nothing built. Diagnostic scripts live in the session scratchpad.
