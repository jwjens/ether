# Processing meters — display + records

**Date:** 2026-08-19 · **Instrumentation only.** The processing itself works (Jeff's ears). **No bump —
rides into 4.4.229.** Runtime UNVERIFIED; acceptance is Jeff's screen.

---

## 1 · Why the meters sat on "waiting for audio"

Two gates, both asking the wrong question.

### 1.1 · The frames were never emitted for a jukebox-only station

`audiod/engine.js` created the meter timer in `DaemonEngine.init()`:

```js
if (!this._procMeterTimer) this._procMeterTimer = setInterval(() => this._emitProcMeters(), 66);
```

A `DaemonEngine` exists only for a station that has an **automation engine**. A station playing only
the jukebox never creates one — `jukebox:play` talks to the addon directly, by design
(`docs/jukebox-deck-source-design-2026-08-17.md`). So with AUTO off and the jukebox audibly running,
**no procmeters frame was ever produced**, and the panel truthfully reported that it had nothing.

**Fixed:** the emit moved to the daemon's station loop (`audiod/ether-audiod.js`, the 100 ms
`eventTimer`), which runs for every station the daemon knows about, engine or not. It reuses the
`audioGetLevels` call already made there — no extra native call, ~10 Hz.

**The gate is now the processor's own state and nothing else:** `lv.proc_local || lv.proc_stream`. The
processor is the **last stage on the master sum**, so whatever reaches it is measured — rotation, a
hand-loaded deck, or the jukebox on an aux deck. Deck, engine and automation state are not consulted.

**Single writer:** the engine's timer is gone, so exactly one thing emits this frame.
`_emitProcMeters()` itself is retained because `audiod/smoke-manual-mode.js:110` calls it directly to
assert it is not gated on automation.

### 1.2 · The panel's "waiting" keyed off frame arrival, not signal

`HealthMonitor.tsx` chose its text on `m ? … : "waiting for audio"` — i.e. on whether a frame had
arrived. Now:

```js
const hasSignal = !!m && ((m.outLufs ?? -70) > -69 || (m.inLufs ?? -70) > -69);
```

Bars render when the processor is on **and has signal**; otherwise the panel says "on, waiting for
audio" honestly. Silence and no-data are both handled, and neither is confused with a broken meter.

### 1.3 · Also fixed earlier in this arc (context for the same panel)

- The whole panel was `{procOn && (…)}` — it **disappeared** until the flags were read, which is why
  the meters could not be found at all. Now always rendered.
- `HealthMeters` (the dashboard's "Audio levels") took procmeters **unscoped** — with four stations it
  showed whichever frame arrived last. `main.js` now tags the frame with `stationUuid` (the treatment
  the levels frame already had) and the component filters on it.

## 2 · The visual

`src/components/ProcessingMeters.tsx` — `Meter`, `RideMeter`, `ProcessingTrio` — is the **one**
implementation, moved out of `SettingsPanel` (not copied). Preferences imports it, so Preferences and
the Health Monitor render the same three bars on the same scales with the same labels:

**IN LOUDNESS · OUT LOUDNESS · RIDE GAIN**, each with a moving bar, and the limiter's state stated
under the ride ("clamping −X dB" / "idle") because it sits at 0 at steady state by design and a bar
bound to it reads as broken.

The Health Monitor's own **"Audio Processing"** panel keeps its `PanelMeter` geometry (in / out / ride /
limiter) and now carries a **"Decks · aux D–F"** row underneath in the same geometry, fed by the aux
bus's own instance of the same processor via `aux: {…}` on the same frame.

**Acceptance:** jukebox playing alone, no station AUTO → three bars dancing.

## 3 · The records

One line per minute, per station that is processing audio, appended to the **existing**
`health-events.jsonl` — no second store, no new IPC, no new timer. Written from `noteLevels()` in
`electron/audio-health.js`, which already receives the full levels object containing every `proc_*`
field.

```json
{"ts":"2026-08-19T05:41:00.312Z","type":"processing","stationUuid":"43889edc-…","stationName":"halloVeen",
 "windowSec":60,"samples":593,"target":-14,"inLufs":-19.4,"outLufs":-14.1,
 "rideMaxDb":5.6,"limiterMaxGrDb":1.2,"outPeakMaxDbfs":-1.0,"paths":"local+stream",
 "aux":{"outLufs":-14.3,"rideMaxDb":6.1,"limiterMaxGrDb":0.8,"samples":540}}
```

**Accumulated, not sampled.** An instantaneous reading once a minute can land in a quiet bar and
misreport the hour, so each line carries the **mean** IN/OUT LUFS across the window and the **worst**
ride and limiter figures seen in it — which is what a loudness question is actually asking.
`outPeakMaxDbfs` is the true-peak high-water mark, so limiter activity is answerable after the fact.

**The aux (deck) chain is recorded alongside**, because the park hears that bus, not the programme bus.
A loudness history that omitted it would answer the wrong question.

**Silence is not recorded.** A line is written only if the processor saw programme in the window
(out > −69 LUFS). The absence of lines is itself the answer for a period when nothing aired.

### 3.1 · Size and retention — stated honestly

One line is **~250–320 bytes** with the aux block, ~200 without.

| Scenario | Lines/day | Bytes/day | Per year |
|---|---|---|---|
| 1 station, 12 h on air | 720 | ~0.2 MB | ~75 MB |
| 4 stations, 12 h on air | 2,880 | ~0.8 MB | ~300 MB |
| 4 stations, 24 h (park season) | 5,760 | ~1.7 MB | ~600 MB |

**`health-events.jsonl` has NO rotation or pruning today** — I checked; there is no `rotate`, `prune`,
`maxBytes` or `unlink` anywhere in `electron/audio-health.js`. It has grown unbounded since it was
introduced, and this change adds the largest steady contributor to it.

That is a real consequence and it is **not** solved here: retention is a product decision (how long is
a loudness history worth keeping — a season? a year? long enough for an advertiser dispute?), and
guessing it silently would be worse than naming it. **Recommended next:** a size-or-age cap on the
ledger as a whole, applied to every event type rather than bolted onto this one. Flagged in the handoff.

## 4 · Files

| File | Change |
|---|---|
| `audiod/ether-audiod.js` | procmeters emitted from the station loop; gated on the processor only |
| `audiod/engine.js` | engine's meter timer removed (single writer); `_emitProcMeters` retained for the smoke test |
| `electron/audio-health.js` | per-minute processing record into the existing ledger |
| `src/components/HealthMonitor.tsx` | "waiting" keys off signal presence; bars/deck row gated on it |
| `src/components/ProcessingMeters.tsx` | the shared trio (earlier in this arc) |

## 5 · Gates

`node --check` on `ether-audiod.js`, `engine.js`, `audio-health.js` → OK ·
`npx tsc --noEmit` → **0 errors** · `npm run build` → clean. **No bump.**

## 6 · Verification — Jeff's, in dev

Needs a **full dev restart** (daemon and main both changed).

1. Jukebox playing alone, station AUTO off, Preferences → Audio Processing → *Process local output* ON.
2. Health Monitor → **Audio Processing** → three bars moving, ride swinging on quiet material.
3. The **Decks · aux D–F** row moving with them.
4. Preferences → Audio Processing → the same three bars, same scales.
5. After ~2 minutes: `health-events.jsonl` in the profile folder contains `"type":"processing"` lines.
   `findstr /C:"\"type\":\"processing\"" health-events.jsonl` is enough to confirm.

If the bars still do not move while audio is audible, the next question is whether procmeters frames
are reaching the renderer at all (the daemon emits them now, so the trace moves to main's forward and
the panel's station filter) — not whether a deck is playing, which was never the right question.
