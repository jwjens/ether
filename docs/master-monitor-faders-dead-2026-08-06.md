# The MASTER and MONITOR faders don't control anything — trace (2026-08-06)

**Status: BUILT 4.4.154 — AWAITING JEFF'S RUNTIME VERIFICATION (§6).** Two dead controls, broken two different ways, needing
two different sized fixes. Decision needed on the second (§4).

Jeff's report, verbatim:

> "The MASTER fader does not control master output — moving it doesn't change the master level."
> "The MONITOR fader does not control the station monitors — moving it doesn't change monitor level."
> "These are the same 'control that doesn't control' pattern as the JINGLES button."

Both live in `src/components/MasterOutput.tsx` (the right master/health panel):

```jsx
<Fader label="Master"  value={masterVol}  onChange={setMasterVol} />    // :793
<Fader label="Monitor" value={monitorVol} onChange={setMonitorVol} />   // :794
```

---

## (1) MONITOR — unwired, but the whole engine path already exists

`onChange={setMonitorVol}` is a plain `useState` setter. The only effect it feeds
(`MasterOutput.tsx:643`) writes **localStorage** and nothing else:

```js
useEffect(() => {
  try { localStorage.setItem('ether_monitor_vol', String(monitorVol)); } catch {}
}, [monitorVol]);
```

Meanwhile the real path is complete and proven, end to end:

| layer | symbol |
|---|---|
| Renderer API | `electron/preload.js:25` — `audio.setMonitorVolume(stationId, volume)` |
| Main | `electron/main.js:3267` — `ipcMain.handle("audio:setMonitorVolume", …)` |
| Daemon | `audiod/ether-audiod.js:138` — `setMonitorVolume: (m) => A.audioSetMonitorVolume(...)` |
| NAPI | `native/src/lib.rs:150` — sends `AudioCmd::SetMonitorVolume(volume)` |
| Rust | `native/src/audio.rs:254` (variant), handled at `:941` |

**The fader never calls any of it.** The only caller of `setMonitorVolume` in the whole renderer is the
engine's own attach-time assert, `src/audio/engine-rodio.ts:550`.

### Why the monitor is not merely unchanged but actively SILENT

`engine-rodio.ts` asserts the monitor bus on every attach:

```js
const level = this.monitorRaisedByOperator ? this.operatorMonitorLevel : 0;
await window.ether?.audio?.setMonitorVolume?.(this.stationId, level);
```

`operatorMonitorLevel` / `monitorRaisedByOperator` are only ever set by
`noteOperatorMonitor(level)` (`engine-rodio.ts:554`) — a method that exists precisely so an operator's
monitor level survives a daemon respawn — **and nothing calls it.** So `monitorRaisedByOperator` is
permanently false, and every attach re-asserts the monitor bus to **0**. The fader can be dragged to
the top and the engine still holds the bus at silence.

### Second dead copy

`src/components/BroadcastMonitor.tsx` (the popout) has its own `monitorVol` that reads and writes the
**same** `ether_monitor_vol` key (`:383`, `:416`) and likewise never calls the engine. Both monitor
controls in the product are dead, and they agree with each other only because they share a
localStorage key.

### Fix — renderer-only, no Rust, no native rebuild

`onChange` must call `audio.setMonitorVolume(stationId, v)` **and** `engine.noteOperatorMonitor(v)` so
the level survives a daemon respawn instead of being re-zeroed at the next attach. Both monitor
surfaces get the same handler.

---

## (2) MASTER — worse: there is no master gain in the engine to wire to

`onChange={setMasterVol}` is also a plain state setter. Its effect (`MasterOutput.tsx:639`) publishes a
global:

```js
useEffect(() => { window.__etherMasterVol = masterVol; }, [masterVol]);
```

Every consumer of that global is in `src/components/MixerChannelStrip.tsx`:

```js
// :234 — inside a DECK fader's own onChange
const master = window.__etherMasterVol ?? 1;
engine.getDeck(deckSlot)?.setVolume((v / 100) * master);
```

So master is applied **only at the moment somebody drags a deck fader.** Moving master by itself
changes no audio at all — the value just sits in a global waiting for a deck fader to be touched.
(The one exception is the mic strip, `:89`, which re-applies master to a WebAudio gain node on a 100ms
interval — so master does move mic level, which is likely why it feels intermittently "alive".)

### There is no master gain stage in Rust

Full `AudioCmd` enum (`native/src/audio.rs`):

```
Load · Play · Pause · Stop · SetVolume{deck} · SetMuted{deck} · GetLevel · Ping
StartStream · StopStream · UpdateMetadata · SwitchDevice · ReopenOutput
SetEq · SetMonitorVolume · SetProcessing{local, stream, target_lufs}
```

`SetVolume` is **per deck**. `SetMonitorVolume` is the monitor bus. **Nothing addresses the program
bus.** The `master` symbols that do exist — `level_master` (`audio.rs:120`), `master_peak` (`:340`,
`:1169`) — are **metering only**, the VU feed. `SetProcessing` is the loudness ride/limiter
(`docs/` audio-processing v1), not an operator fader.

**So the master fader is not mis-wired — it has nowhere to land.** Scaling deck faders by a global is
a workaround for the missing stage, and it is why the control behaves as if it does nothing.

---

## (3) Why this is the JINGLES-button pattern

Both faders present as working controls: they move, they render a value, they persist. Neither reaches
the audio. That is the honest-UI defect Jeff has flagged before — a control that doesn't control is
worse than a missing one, because the operator trusts it during a show.

---

## (4) Proposed fixes — different sizes, second one needs Jeff's go

**A. MONITOR (small, renderer-only, no rebuild of native):**
1. `MasterOutput.tsx` monitor `onChange` → `audio.setMonitorVolume(stationId, v)` + `noteOperatorMonitor(v)`.
2. Same for `BroadcastMonitor.tsx` so both surfaces drive the one bus.
3. Keep the localStorage persistence; it is fine as a UI memory, it was just never a control path.

**B. MASTER (touches the Rust audio engine — needs approval before I start):**
A real program-bus gain has to be added:
1. `AudioCmd::SetMasterVolume(f32)` + a `master_gain` applied in `mixer_callback` at the program-bus
   sum — the same place `master_peak` is already computed, so the fader is pre-meter and the VU
   reflects what the operator hears.
2. NAPI export in `native/src/lib.rs`, daemon route in `audiod/ether-audiod.js`, IPC in
   `electron/main.js`, `preload.js`, engine method in `engine-rodio.ts`.
3. `MasterOutput.tsx` calls it; **remove** the `__etherMasterVol` scaling from `MixerChannelStrip` so
   master is applied once at the bus and not multiplied into deck faders (today's behaviour double-
   scales the moment a deck fader is dragged).

**Why B needs a decision, not just a go-ahead:** it requires rebuilding `native/ether-audio.node` and
it changes the gain structure of the on-air path. That is the most safety-critical code in the product
and there are already several `ether-audio.node.bak-*` files in the tree from previous manual swaps.

**Open question for Jeff:** should the master fader ride **program-out only** (what listeners hear:
stream + local output), or should the local speakers be independently trimmed from the stream feed?
On a real console those are separate; today Ether has one output path plus a monitor bus. The answer
changes where the gain goes in the Rust mixer, so it should be settled before code.

---

## (5) Verification (once built)

- **Monitor:** drag the fader with a station attached; monitor level follows immediately. Restart the
  daemon (or let it respawn) and confirm the level is **restored**, not re-zeroed — that is the
  `noteOperatorMonitor` half, and it is the part that has silently failed until now.
- **Master:** drag master with a deck playing and NO deck fader touched — the program VU and the
  audible level must both follow. Today neither does.

---

## (6) BUILT — 4.4.154

Design confirmed by Jeff: **MASTER = the broadcast** (stream + program out — pull it down and listeners
hear it quieter). **MONITOR = the local station monitors** (the speakers in the room; never touches air).

### MONITOR (renderer only, no rebuild)
- `MasterOutput.tsx` — `applyMonitor()` calls `audio.setMonitorVolume(stationId, v)` **and**
  `engine.noteOperatorMonitor(v)`. The second call is the one that stops every attach re-asserting the
  bus to 0; without it the fader would go dead again at the next daemon respawn.
- Also primes the remembered level once the station is ready, so the monitor returns at the operator's
  setting after a restart instead of sitting silently at 0 until touched.
- `BroadcastMonitor.tsx` (pop-out) — resolves the active station over `stations:get-active` (it has no
  station context of its own) and drives the same bus. Both monitor surfaces are now real controls.

### MASTER (new gain stage, Rust rebuild)
- **`Bus::master_vol`** (`native/src/audio.rs`), default 1.0.
- **`AudioCmd::SetMasterVolume(f32)`**, clamped **0..=1** — an attenuator. Allowing >1 would let the
  operator push the program bus into clipping ahead of the limiter.
- **Applied on the program bus AFTER the mix+EQ and BEFORE the VU peak and before the stream push**, so
  it rides what listeners hear and the master VU shows the level that actually went out. Unity is a
  no-op multiply, so an untouched station is bit-identical to the previous build.
- `monitor_vol` is untouched and still applies only in the device branch, after the stream push — so
  the room level still cannot affect air.
- Path: `lib.rs audio_set_master_volume` → `audiod/ether-audiod.js setMasterVolume` →
  `main.js audio:setMasterVolume` → `preload.js` → `engine-rodio.setMasterVolume()` →
  `MasterOutput.tsx applyMaster()`.
- `engine-rodio.reassertMaster()` re-applies the operator's level on attach, next to the monitor
  assert — a respawn must not silently return the station to full level mid-show.
- **`__etherMasterVol` deck-scaling REMOVED** from `MixerChannelStrip.tsx` (3 sites). It only applied
  master at the instant a deck fader was dragged, and leaving it would now apply master twice.

### Proof BEFORE the installer was built (Jeff's hard rule)
Ran against the real rebuilt binary:

```
NAPI exports:        audioSetMasterVolume / audioSetMonitorVolume / audioSetVolume   PASS
call surface:        audioSetMasterVolume(station, 1.0 / 0.5 / 0.0) → true, no throw  PASS
path wiring:         daemon · main IPC · main→daemon · preload · engine · respawn ·
                     fader · monitor · monitor-persist · popout                       PASS (10/10)
hack removed:        no __etherMasterVol left in MixerChannelStrip                    PASS
Rust placement:      master BEFORE the VU peak                                        PASS
                     master BEFORE the stream push                                    PASS
                     clamped 0..=1 (attenuator)                                       PASS
                     monitor_vol still AFTER the stream push (local only)             PASS
```

`cargo build --release` clean (33 pre-existing warnings). Previous binary backed up as
`native/ether-audio.node.bak-premaster-<timestamp>`.

### Acceptance (Jeff's eyes)
- **Monitor:** drag it with a station attached → room level follows immediately. Let the daemon respawn
  (or restart the app) → the level is **restored**, not re-zeroed. The stream is unaffected throughout.
- **Master:** with a deck playing and **no deck fader touched**, drag master → the **program VU and the
  audible broadcast level both follow**. Deck faders do not move.

### Help
`docs/help-master-monitor-faders.md` — plain-language: MASTER is heard by everyone, MONITOR is heard by
you, and how to read the meter to tell which one is wrong.

---

## (7) MONITOR ROUTING BUG — 4.4.154 wired it to a CHANNEL, not the room (fixed 4.4.155)

**Jeff's report, verbatim:**

> "The monitor fader is controlling the LAST-TOUCHED channel fader instead of the overall monitor
> output. Halloween fader DOWN, then monitor UP → Halloween comes back UP. A channel pulled down must
> STAY down."

**He was exactly right, and the cause was §6's fix.** `bus.monitor_vol` is the **per-station strip
level**, and it is already owned by `src/components/StationMonitorMixer.tsx:68` — the "how much of this
station do I want in the room" fader, persisted to `station_config_kv.monitor_volume`. 4.4.154 pointed
the MASTER OUT panel's MONITOR fader at `setMonitorVolume(activeStationId, v)` — **the same variable**.
Two controls, one memory location: raising MONITOR wrote the active station's own strip level back up.
It appeared to follow "the last-touched channel" because it only ever wrote the **active** station's id.

**Correct model (Jeff):** MONITOR is a MASTER MONITOR level. It scales the finished monitor mix and
calls nothing on any channel. Channel/station strips set the mix; MONITOR makes that mix louder or
quieter in the room, as-is.

### The fix — a separate global gain

- **`static MASTER_MONITOR_VOL: AtomicU32`** in `native/src/audio.rs` — process-wide, f32 bits, relaxed
  load, no lock or allocation on the audio thread. Deliberately **global**: a per-station field would
  reintroduce exactly this class of collision.
- Applied in the device branch only: `let mvol = bus.monitor_vol * master_monitor_vol();` — the
  station's own strip level **times** the one room level. Still after the stream push, so the room
  level can never reach air.
- `audio_set_master_monitor_volume(volume)` (NAPI, **no station id**) → daemon
  `setMasterMonitorVolume` → `audio:setMasterMonitorVolume` → preload → both MONITOR faders.
- `StationMonitorMixer` is untouched and remains the sole writer of per-station `monitor_vol`.

### Proof BEFORE the installer (Jeff's hard rule)

```
global control:   audioSetMasterMonitorVolume exported · daemon route + IPC pass a volume and NO stationId   PASS
MONITOR faders:   both call setMasterMonitorVolume; NEITHER calls setMonitorVolume, noteOperatorMonitor,
                  getDeck or setVolume                                                                       PASS (8/8)
station strips:   StationMonitorMixer still owns per-station monitor_vol; never calls the global            PASS
Rust placement:   strip x master in the device branch · AFTER the stream push (never airs) ·
                  MASTER OUT still BEFORE the stream push (does air) · clamped 0..=1                        PASS
separation:       MONITOR writes ONLY the global gain; the strip writes ONLY the per-station gain           PASS
```

The two controls now write **different memory**, so raising MONITOR cannot restore a strip that was
pulled down. That is the invariant Jeff's test checks.

### A note on the proof itself

The first run of this proof FAILED — the export was missing, because the Rust had been compiled but the
built `.dll` had not been copied over `native/ether-audio.node`. The proof caught a genuinely broken
build before it was packaged. Two later FAILs were the test's own fault (NAPI exports all report
`.length === 0`, and a final check echoed an already-failed flag) and were corrected to assert the real
invariant at the call sites.

### Acceptance (Jeff's eyes)

1. Pull **Halloween's station strip** down. It stays down.
2. Raise **MONITOR**. The whole room gets louder — and **Halloween stays down**. It never comes back.
3. Lower **MONITOR** to zero: the room goes silent, every station keeps broadcasting.
