# Slice 7 — show presets (proposal, 2026-09-26)

**Status:** GO given 2026-09-26 (rulings below). Engine built; daemon and UI to follow. Dev only, branch
`log-reader-flip`.

## Jeff's rulings (verbatim)

1. "Live = ON. Full stop. A mic that is ON is live even in a pause between words; a deck that is ON is live. Simpler
   than "carrying audio" and never applies a change mid-sentence."
2. "Yes, save fader levels. A restart restores them; a Take moves non-live faders. Your Take is your hand."
3. "A Take never turns a channel ON. It may turn non-live channels OFF."
4. "20 ms ramp on every engine-applied level change (Take, TAKE NOW, restore, and drags). The goldens set static
   levels, so they must still null; add a test that a level step no longer clicks, with its deliberate-failure twin."
5. "Source presets filed as slice 7b."
6. "Current show synced with the station; the pending set machine-local."
7. "Built-in "Flat" preset."
8. "Ducker and monitor settings are in the preset."

**Where the proposal below is superseded:** §3 step 3 and Q1 proposed "ON **and** carrying audio"; ruling 1
makes LIVE = ON. §6 said `rt.rs` needed nothing new "unless Q4 adds a fader ramp"; ruling 4 adds it (in
`ramp.rs`, not `Params`).

**How ruling 1 is read for A/B/C (to confirm on screen):** a rotation deck's ON button is its start control, and
A/B/C are never cut on this board. So for A/B/C, ON means playing, and "goes OFF" means the deck stops, ends or is
taken off. For every other channel, ON is the channel switch.

**Governing:**
- `docs/strata-to-ethercast-build-spec.md` §4 slice 7: a full station snapshot keyed by UUID; Arm then Take; ON
  channels protected until OFF, with a flashing indicator; stored and applied by the blade; the verification.
- The same spec, §2: the LXE Event is armed then Taken; recalled Events don't change channels already ON, whose
  ON buttons flash; the E-6 SAVE form stores processing "to a channel, a source, an event…". **The blade keeps
  the last mix, and the UI reads its state back from the blade.**
- `docs/dsp-rack-framework.md` §4: Arm → Take, and the **reserved** `applyPreset(…, { protect })` branch. "Current
  show" was deliberately not shown until now.
- `docs/dsp-channel-dynamics.md` §3: channel presets.
- `docs/dsp-mic-in-engine.md` §4: mic patches are machine-local.

---

## What is there today (receipts)

| State | Stored | Applied by |
|---|---|---|
| **Fader level** (A–F, S1–S5, CART) | **Nowhere.** A restart resets it (`FaderSection.tsx:276-309` writes only on a drag; `crash_recovery` doesn't hold it, `main.js:2023-2028`) | a live drag → `SetVolume` |
| **Master fader** | **Nowhere** (`MasterOutput.tsx:446`, `useState(1.0)`) | a live drag |
| ON / cut | `deck_configs.channel_on` (synced) | the renderer on mount (`FaderSection.tsx:121-129`) |
| Source patch | `deck_configs.kind` / `address` (synced) | the UI; the engine's slot *kind* comes from its index |
| Duck on / duckable | `deck_configs.duck` / `duckable` (synced) | main at boot (`main.js:1496`, `:5533-5589`) and the renderer |
| Duck parameters | kv `duck_*` (synced) | main at boot; `DuckerSection` |
| Channel racks | kv `rack_ch_<slot>` (synced) | **the daemon's poll** (`engine.js:415`) |
| Master rack + link | kv `rack_master` (synced) | **the daemon's poll** (`engine.js:306`) |
| Monitor level | kv `monitor_volume` (synced) | the renderer (`StationMonitorMixer`) |
| Room / aux levels | kv `aux_monitor_levels` (synced) | the renderer (`AuxMonitorSlots`) |
| Master monitor level | `localStorage ether_monitor_vol` (machine-local) | the renderer |
| Channel **trim** | **Doesn't exist** as a channel control. `gain_db` is the *track's* loudness trim and travels with each load; the mic's input gain is machine-local (`mic_input_<slot>`). | — |
| Monitor **source** selector | **Doesn't exist** (slice 8) | — |

**The engine doesn't smooth fader moves:** `vol` is a per-buffer constant (`audio.rs:3633`, `:3729-3733`).

**Finding, stated plainly:** the board's state is applied from **four places**, and nothing puts the faders back
after a restart. The spec's "cold restart restores the identical state" needs a store that doesn't exist yet.

---

## 1 · What a show preset contains, and what it deliberately doesn't

A **show preset** is one JSON document: `{ v: 1, name, stationUuid, savedAt, board }`.

**`board.channels[slot]`**, for every fader (A–F, CART, S1–S5) that exists on the station's board:

| Field | Meaning |
|---|---|
| `enabled`, `type`, `kind` | Is it on the board, and the **source patch by kind** (music / announcement / jukebox / cart / sweeper / **mic**). **Never a device.** |
| `fader` | The level, 0…1. |
| `on` | The channel cut (→ Q3: may a Take *open* a channel?). |
| `duck`, `duckable` | The duck trigger, and whether this deck steps back. |
| `roomLevel` | The aux/room monitor level (`aux_monitor_levels[slot]`). |
| `rack` | The channel rack document (Filters / Gate / PEQ / Comp, with their INs). |

**`board.master`:**
- the master rack document (GEQ, ride, limiter per branch, and **link/split**);
- the master fader;
- the duck parameters (depth, threshold, attack, hold, release);
- the station monitor level.

**The monitor *source*** joins when slice 8 builds a monitor selector. A preset can't record a control that
doesn't exist.

**What it does NOT contain, and why:**

| Excluded | Why |
|---|---|
| **Machine-local device choices:** `audio_output_device`, `aux_monitor_device`, `pfl_cue_device`, every `mic_input_<slot>` (device, input number, **mic input gain**), and the master monitor level (`localStorage`) | A synced preset carrying a device name is exactly the defect fixed in `de8d833` and `42eb472`: another machine has no such device. A preset says a slot is **a mic**; *which* mic is this machine's patch. |
| **Processing on/off** (`proc_local`, `proc_stream`) | The Slice 4 ruling: presets never switch processing. |
| **Anything about the log or automation** (the queue, what's loaded, the schedule, the segue overlap, AUTO/MANUAL) | A show preset is the *board*, not the programme. |
| The PFL dim, the PFL device, and the PFL flags | Operator preferences and momentary state, not a show. |

**"Trim":** no per-channel trim exists, so there's nothing to store. A channel input-trim control would be a new
control (slice 8 with the monitor work, or its own ask), not part of this slice.

## 2 · Storage, the current show, the bar on the board

**Storage** (station_config_kv, station-scoped, **synced like `rack_presets`**):
- `show_presets`: the list;
- `show_current`: the name last Taken.

**Keyed by UUID:**
- **Every preset carries its `stationUuid`, and the blade refuses a preset whose UUID isn't this station's.**
- The rows travel with the station through the existing sync. That sync's identity layer has a known defect:
  peer-sync routes by the local station integer (see the peer-sync memory note). It is not made worse here, and
  the UUID check in each preset stops a misrouted preset from being taken.

**Current show:**
- the board shows **"SHOW: Morning Drive"**;
- **"· modified"** is derived by comparing the live board with that preset, value by value (never a flag), as
  the rack presets do.

**The preset bar on the board** (above the faders in `FaderSection`, so it's in the dashboard *and* the pop-out
board, not only a rack window):
- **Save** overwrites the current show; **Save As** makes a new one (the built-ins can't be overwritten).
- **Arm ▾** shows what Take would change: channels, levels, racks. It **says which channels are live and will
  wait.**
- **TAKE** and **DISARM**.

**Built-ins:** none except **"Flat"** (every rack empty, every fader at unity, the ducker at its defaults), so
there's always a known-clean state to take. **→ Q7.**

**The master and channel rack preset bars stay.** They recall one rack; a show recalls the board. Taking a show
sets `rack_preset_active` / the channel rack's preset name as it finds them. Nothing is derived twice.

## 3 · The live-channel rule, applied by the blade

**"The blade" is the daemon** (`audiod`). It already owns the engine, the deck state and the per-station poll. The
UI doesn't hold a preset's pending state.

**Take:**
1. The renderer sends **`show:take(stationUuid, name)`**. main reads the preset and checks its UUID.
2. main hands the daemon the preset and the **current** board.
3. The daemon sorts every channel:
   - **LIVE** = **ON (not cut) AND carrying audio**: a rotation deck that is playing, a source channel with
     something loaded and active, or a mic channel with an input patched. **→ Q1.**
   - **Not live:** applied **now**.
   - **Live:** keeps exactly what it has, and its values go into the station's **pending set**.
4. **Everything applied now goes to the engine atomically:** one new `AudioCmd::ApplyShow(Box<ShowApply>)`,
   handled in **one** dispatch-thread arm.
   - It edits `ctl.params` for every non-live channel: volume, mute, duck, duckable, room gain, channel-rack plan
     (computed there).
   - It also sets the master rack, the master fader, the duck parameters and the monitor level.
   - It calls `params_changed()` **once**, so it is **one Params block**. The callback adopts it at the top of a
     buffer: the whole show lands in the same buffer, or none of it does.
   - Racks crossfade 20 ms as always.
5. main **writes the stores** for what was applied (`deck_configs`, `rack_ch_*`, `rack_master`, `duck_*`,
   `aux_monitor_levels`, `monitor_volume`, and the new **board levels**, §5), plus `show_current`.
   - main stays the one DB writer.
   - The daemon's rack poll then finds the stored racks equal to what is running and sends nothing.
   - **A live channel's stores are not written until it goes OFF,** or the 3 s rack poll would apply them behind
     the protection.

**While pending:**
- The live channel's **ON button flashes amber, "PENDING"**, with the show's name.
- A **TAKE NOW** control on that strip forces it (→ Q4 on a forced fader move).

**The change lands when the channel goes OFF.** The daemon sees every OFF:
- a channel cut (`setMuted(true)`, which passes through it);
- a rotation deck that ends, stops or is taken off (its own rotation logic);
- a source that stops.

On that event it sends that channel's pending values as an `ApplyShow` for **that slot only**, tells main to
write that slot's stores, and removes the slot from the pending set.

**The pending set belongs to the blade:**
- It lives in the daemon, so **a UI reload changes nothing**. The reloaded board **reads it back**
  (`show:state` → `{ current, armed, pending: [{ slot, show }] }`), per the spec's "the UI reads its state back
  from the blade".
- It is also persisted by main as **`show_pending`**, a **LOCAL_ONLY** key: pending is about *this* machine's
  live board. So a daemon respawn or app restart re-arms it.
- On a cold start nothing is live, so every pending slot applies at once. That is the correct outcome: the
  channel is off.

**Arm is held by the blade too** (`show:arm` / `show:disarm`), so the dashboard board and the pop-out board show
the same armed preset.

## 4 · Source presets (the Axia lesson) — recommend FILING as 7b

**The idea:** a channel rack (and a trim, if one existed) that **follows a source**. "The host mic" carries its
EQ, gate and compressor to whichever fader it's patched onto.

**Recommendation: file it as slice 7b, don't build it here.**
- **What makes a "source" in EtherCast isn't settled.**
  - A source **kind** ("mic") is too coarse: the host and the guest are both "mic".
  - A mic **device** is machine-local: the host's mic on the OV box isn't a name the dev box has.
  - It needs a named, station-level **source profile** ("Host mic", "Guest mic 1") that a machine maps to its
    own device. That is a design of its own.
- **It needs a precedence ruling:** when a show preset and a source profile both set a channel's rack, which
  wins? Is a profile applied on patch, on Take, or both?
- **Slice 7 is already the biggest behaviour change since the mic:** the first time a recall touches faders and
  the ON rule.

**What 7 leaves ready for it:** the channel rack is a document; `ApplyShow` takes per-slot racks; and the
channel presets (slice 6) already store racks by name.

## 5 · Verification: through the real callback, plus the blade's logic

**Engine (Rust, through the real `mixer_callback`):**

| Claim | Test | Bar |
|---|---|---|
| **Take mid-song leaves the live deck untouched** | Deck A playing, ON, rack X; D and S1 not live. `ApplyShow` excluding A (the blade's live rule), with new racks, levels and duck for D/S1 and a new master rack. | A's channel tap, post-rack tap and contribution are **bit-identical** to the run without the show, sample by sample, until A's pending is applied. |
| **The change lands when it goes OFF** | Then A is cut, and A's pending is sent as `ApplyShow { A }`. | A now runs rack Y at the preset's level, measured |
| **Atomic** | One `ApplyShow` changing 12 channels + master | adopted in **one** buffer (the Params epoch moves once; no buffer sees half) |
| **A cold restart reproduces the state, and the harness nulls** | Render with a board reached by individual commands; build a fresh engine, apply the *saved* show as one `ApplyShow`, render the same input. | **bit-exact** |
| **Bypass** | No show taken, and a "Flat" show on a flat board | the 43 goldens bit-exact |
| **Allocation trap** | `ApplyShow` adoption with 12 racks crossfading | **0** in the callback (the preset is parsed and planned on the dispatch thread) |

**The blade** (`audiod/smoke-show-presets.js`, the real `DaemonEngine` with a recorded engine):
- **Take while A plays:** the engine call excludes A; A is in pending; the pending state is readable after a
  "UI reload" (a new `show:state` call).
- **A goes OFF** (cut, then end-of-track): A's pending is sent **for A only**, once, and the store write for A is
  asked for **only then**.
- **Force** (TAKE NOW) applies A immediately.
- **Survives a daemon respawn:** `show_pending` reloads, and a not-live slot applies on start.
- **A preset never touches a machine-local device:**
  - the snapshot builder never emits `audio_output_device`, `aux_monitor_device`, `pfl_cue_device`,
    `mic_input_*` or the master monitor level;
  - Take never writes them (it asserts over every store write);
  - a preset carrying one is stripped with a log line.
- **UUID guard:** a preset for another station's UUID is refused.

**UI (vitest + static smoke):**
- the snapshot/diff model (what Arm shows, "· modified" derived);
- the strip's PENDING flash follows the blade's state, not local state;
- the bar is on the board in both windows;
- the help exists.

**What the harness covers vs what it can't:**
- **Covered:** everything that reaches audio (the engine applies exactly what it's given, atomically, and a
  restored show renders bit-exact).
- **The daemon smoke covers the live rule, the pending set, persistence and the device exclusions.**
- **Neither covers:** the look of the flashing ON button and the feel of a Take mid-show. That's Jeff's screen
  check.

## 6 · Blast radius

| Area | Change |
|---|---|
| `native/src/audio.rs`, `lib.rs` | `AudioCmd::ApplyShow(Box<ShowApply>)` (per-slot `Option`s + master fields; racks planned on the dispatch thread) → one Params block; `audio_apply_show(station, json)` |
| `native/src/rt.rs` | nothing new in `Params` (every field already exists), unless Q4 adds a fader ramp |
| `audiod/show-presets.js` (new, pure) | snapshot, diff, the live rule, strip machine-local keys |
| `audiod/engine.js`, `ether-audiod.js` | take / arm / disarm / force / state; the pending set; the OFF hooks (cut, deck end/stop, source stop); events to main |
| `electron/main.js`, `preload.js` | `show:list`, `save`, `saveAs`, `delete`, `arm`, `disarm`, `take`, `force`, `state`; writes the stores on apply; `show_pending` persistence |
| `electron/sync/handlers/station_config_kv.js` | `show_pending` LOCAL_ONLY; `show_presets`, `show_current` and `board_levels` synced |
| `src/` | `ShowPresetBar` on the board; `ConsoleStrip`/`FaderSection`: PENDING flash + TAKE NOW, current-show indicator; **fader levels read back from the blade on mount** |
| **The fader store (new)** | `board_levels` = { slot: level, master: level }, written by main (debounced ~1 s) from the drags, **applied by the daemon at engine start** so a cold restart restores the faders. This is also the first time a restart doesn't reset the faders: a behaviour change, **→ Q2**. |
| `docs/` | `help-show-presets.md` (new); `help-channel-faders.md` (PENDING, a preset moving faders) |

---

## Decisions for Jeff

1. **What counts as LIVE:** ON (not cut) **and** carrying audio (recommended: a cut channel or a stopped deck takes
   the change at once). Or simply ON?
2. **Faders restored on a cold restart:** the new `board_levels` store (recommended: the spec's verification
   needs it). It is a behaviour change: today a restart resets every fader to unity. **And a Take moves faders**
   on non-live channels. That extends "nothing moves your fader but your hand": the operator's TAKE is the hand.
   Confirm.
3. **May a Take open a channel?** Recommended: a Take may **cut** a non-live channel (take it OFF), but **never
   opens one**. Opening a channel puts audio on air, so it stays the operator's press, and the strip shows
   "preset: ON" as a hint. Or apply ON as stored?
4. **TAKE NOW on a live channel:** its fader jumps at a buffer boundary (the engine doesn't smooth faders), which
   can click. Recommended: a **20 ms fader ramp in the engine, only when a level changes** (the goldens stay
   bit-exact at a constant level; drags get smoother too). Or leave faders as steps?
5. **Source presets:** file as **slice 7b** (recommended; §4), or build here?
6. **`show_current`** synced with the station (recommended, like `rack_preset_active`), **`show_pending`**
   machine-local (recommended). Confirm.
7. **One built-in, "Flat"**, as the always-available clean state? Or no built-ins?
8. **Duck parameters and the monitor level are in the show** (recommended: they change between shows). Or keep
   them station settings?

## What this deliberately does NOT build

- Source presets (7b).
- A monitor source selector (slice 8).
- A channel trim control.
- Scheduling shows by time (a clock-driven Take).
- Any change to automation or the log.

---

## Build — the engine (2026-09-26)

**Status:** built and proven through the real callback. Nothing is wired to the board yet (daemon and UI commits).

### The level ramp (ruling 4) — `native/src/ramp.rs`

- **`LevelRamp`**, one per fader plus one for the master (`BusState.vol_ramp[12]`, `master_ramp`):
  - a 20 ms raised-cosine ramp (882 frames, the channel rack's crossfade length) from the level the audio is
    **actually at** to the adopted level;
  - a second move mid-ramp continues from where the gain is, so it never jumps.
- **It only ramps while the channel sounds.** A level set on a silent channel (stopped, paused, nothing loaded;
  for the master, the whole programme silent) **snaps**. Nothing can click, and faders restored before anything
  plays render exactly like faders set by hand.
- **At rest the arithmetic is today's**, `feed × (volume × trim)`, untouched. That is why the goldens null.
- **The cut is not ramped.** ON/OFF stays a hard switch, as it was. The ruling names level changes.
- The **room / aux levels and the monitor level are not ramped** in this commit. They never reach air. Named
  here as deliberately not built.

### One-step show apply — `native/src/show.rs`, `AudioCmd::ApplyShow`, `audio_apply_show`

- **`ShowApply::from_json`:** `{ slots: { "<A–F|CART|S1–S5>": { fader?, cut?: true, duck?, duckable?, room?,
  rack? } }, master?: { fader?, rack?, duck?: { depthDb, thresholdDb, attackMs, holdMs, releaseMs }, monitor? } }`.
  - **All or nothing:** one bad field refuses the whole show.
  - **Structurally cannot open a channel (ruling 3):** a slot has `cut: true` and nothing that means ON.
    `cut: false` is refused with "a show cannot turn a channel ON (only the operator can)".
  - **Cannot carry a device, a mic patch or processing on/off:** unknown fields are refused
    (`deny_unknown_fields`).
- **One dispatch arm** writes the whole show into the Params copy and calls `params_changed()` **once**: one block.
- **The single-control commands now call the same setters** (`set_room`, `set_channel_rack`, `set_master_rack`,
  `set_duck_params`, `set_master_fader`, `set_monitor`). A Take and the same values set by hand are the same code.
- The live rule is **not** in the engine. The blade sends only the channels it has decided to apply.

### The fader store's engine side

`board_levels` (daemon commit) is applied at engine start as a **faders-only `audio_apply_show`**. Its engine
half is the restore receipt below: faders reached by hand and faders restored in one block render identically.

### Receipts (`npm run test:rust`, dev app stopped)

```
[level-no-click] 1 kHz −12 dBFS on A, level 1.0 → 0.25 (−12 dB) at a buffer boundary, through the real callback · 8 kHz-HP residual: fader ramped -141.5 dBFS, hard (twin) -26.1 · master ramped -141.5, hard (twin) -26.1 · floor -155.9 · bar −80
[show-live] Take at buffer 60 leaving A (playing, ON) out · air BIT-IDENTICAL over 200 buffers · A's pre- and post-rack taps bit-identical per buffer · with a new master GEQ in the Take: air changes (the Take landed), A's taps bit-identical · A cut, then its pending sent: fader 0.5 (cut true), rack post/pre +6.00 dB at 220 Hz (preset +6)
[show-atomic] one Take: 12 faders + 12 racks + master fader + ducker + monitor → 1 Params block · changed before the buffer: 0 · after ONE buffer: 12/12 faders, 12/12 racks, master 0.8, duck depth -6 · allocations in the callback over 61 buffers of ramps and crossfades: 0
[show-restore] board set by hand (11 commands, one per buffer, a fader dragged twice) vs a fresh engine given the saved show as ONE ApplyShow, same input, 150 buffers: stream 0 of 72000 samples differ, local 0 of 72000 · stream energy 546.9 (not silence) · (buffers compared from the stream: 151)
[rt-cmd] 2900 buffers, all uniform: 1446 with the channel cut, 1454 open
```

- **Goldens:** `[null]` 43/43 bit-exact; `[rack-null]` 43/43; `[ch-out-null]` 43/43; `[trap] 43 renders, 0
  allocations`. NAPI: `[napi] 43/43 renders bit-exact to the manifest` on the fresh build (sha256 `09ca87ce…ac65`).
- **Suite:** 99 lib + 7 bench + 2 doctests pass.
- **The export on the built `.node`:** `audioApplyShow` is a function. `cut:false`, a `device` field, slot `Q`
  and non-JSON are each refused with their reason. These were checked without starting an engine.
- **One existing test changed its probe:** `a_param_block_never_changes_mid_buffer` used the master fader to prove
  a Params block never changes mid-buffer. The master now ramps by design (proven on its own above). The probe is
  now the channel cut, still a hard switch. The property under test is unchanged.
- **JS gates** (unaffected, run anyway): tsc 0; vitest 483/483; rack-eq 30, mic-input 25, pfl 22, dynamics 10,
  meter contract 30; undefined-calls, preload-bridge, ipc-contract, one-switch PASS; audio-isolation PASS; leak
  guard OK; `npm run build` OK.

---

## Build — the daemon (the blade) and main's stores (2026-09-26)

**Status:** built and tested against a recorded engine. Nothing on the board uses it yet (UI commit).

### Where the blade lives

**`audiod/show-presets.js`** holds `ShowBlade`, one per station, created by `ether-audiod.js`. It sits beside the
engine and is **independent of automation**: the proposal said `engine.js`, but a station with no `DaemonEngine`
(the jukebox alone) still has a board.

**What passes through it:**
- `setMuted` → `noteMuted`
- `stop` → `noteStopped`
- `setVolume` → `noteVolume`
- `setMasterVolume` → `noteMaster`
- **`init` boots it:** the saved faders, then the saved pending set.
- **The station loop ticks it at ~2 Hz**, so a deck that ends or stops inside the engine goes OFF there.

**The verbs:** `showTake`, `showForce`, `showArm`, `showDisarm`, `showState`.

### The live rule (ruling 1)

- **A/B/C:** live = the engine reports `playing`.
- **Every other slot:** live = not cut.
  - For D/E/F/CART: the cut that passed through the blade, else the engine's `muted`.
  - The engine starts un-muted, so a slot never cut since the engine started counts as ON.
- **A slot not on the board right now** (deck_configs not enabled) has no ON button, so it is never live.
- **What the preset says about a slot never decides liveness.** A preset that removes a channel still waits for
  that channel to go OFF.

### A Take never turns a channel ON, and never needs to cut (ruling 3)

Under ruling 1 every channel a Take touches is already OFF, so "may turn non-live channels OFF" never has anything
to do. **The blade never sends a cut.** Main's deck_configs writes never include `channel_on`.

### Take, pending and OFF

- **Take:** one `audioApplyShow` covers every non-live named slot plus the master (fader, rack, ducker, monitor).
  The live slots go into the pending set, with their values.
- **On OFF:** that slot's pending goes in its own `audioApplyShow`, for that slot only and without the master.
- **TAKE NOW:** the same, immediately.
- **Store writes:**
  - `showapplied` carries exactly the applied part.
  - **main** writes it through **`planStoreWrites`**, the one planner the smoke also asserts over:
    - `deck_configs` enabled/type/kind/duck/duckable (never `channel_on`; A/B/C never re-patched);
    - `rack_ch_<slot>`, `aux_monitor_levels` (merged);
    - `rack_master` plus its legacy keys, `duck_*`, `monitor_volume`.
  - **A waiting channel's stores are never written**, so the 3 s rack poll can't apply them behind the
    protection.

### Storage (ruling 6)

- **Synced:** `show_presets` (the list), `show_current` (written by main on a Take), `board_levels` (written by
  main at most once a second from the blade's `boardlevels`).
- **LOCAL_ONLY:** **`show_pending`**, added to `LOCAL_ONLY_KEYS` and written with set-local from the blade's
  `showstate`.
- **At boot** the blade reads all of these itself (read-only). The engine starts open, so on a fresh daemon:
  - a pending A/B/C slot applies (nothing is playing);
  - a pending source channel waits until the renderer asserts its stored cut.

### UUID (station identity)

- **main** looks the preset up, compares its `stationUuid` with the station's, and refuses a mismatch.
- **The blade** checks again against the UUID main vouches for. A mismatch is refused with a log line, and the
  engine is never called.
- `show:list` lists another station's preset as **foreign** and never offers it for a Take.

### Flat (ruling 7)

- Every channel rack empty; 12 faders at unity; the ducker at main's defaults (−22 / −45 / 30 / 700 / 500).
- **The master is the shipped chain:** flat GEQ, with the ride and limiter kept. "Every rack empty" is read as the
  channel racks. An empty master would drop the limiter whenever processing is on.
- Flat names no layout, no duck toggles and no room levels.

### Never a machine-local value

- **Presets are rebuilt from a whitelist** (`sanitizePreset`): a device, a mic patch, the mic gain, processing
  on/off or the PFL settings can't ride one. Whatever is dropped is logged.
- **The snapshot** reads only board keys.
- **The engine** refuses unknown fields as well.

### main (`electron/main.js`)

- **IPC:** `show:list`, `show:snapshot`, `show:save` (also Save As; "Flat" can't be overwritten), `show:delete`,
  `show:state`, `show:arm`, `show:disarm`, `show:force`, `show:take`.
- **Events:** `showstate` → `show:state` to every window **by station UUID**; `showapplied` → the stores, then
  `show:applied` and `deck_configs:changed`, both carrying the UUID, never the integer; `boardlevels` →
  `board_levels`.
- **Without the audio service** (the in-process fallback), show presets say so and do nothing.

### Receipts

- **`npm run test:show-presets` → ALL PASS (35/35).** It covers:
  - Take while A plays and S1 (a mic) is ON: **one** engine call, A and S1 out, D and the master in; the store
    request covers D and the master only;
  - S1 cut → one call for S1 alone, and its store request only then;
  - A ends → the tick applies A alone;
  - no engine call ever carries a cut;
  - TAKE NOW;
  - a respawn restores the faders only, applies A's pending, keeps S1 waiting, and boots once;
  - the snapshot carries no device, mic patch or mic gain;
  - a preset carrying 5 machine-local values is stripped with a log line, and none reaches the engine or a store
    request;
  - every planned store key is synced (asked of the real `isLocalOnlyKey`), and no deck write touches
    `channel_on`;
  - `show_pending` is LOCAL_ONLY while `show_presets`, `show_current` and `board_levels` sync;
  - the UUID guard; Flat; the wiring.
- **grep receipt:** in `audiod/show-presets.js` and main's show section, the machine-local key names appear only
  in the lists that **exclude** them (`MACHINE_LOCAL_KEYS`, `MACHINE_LOCAL_PREFIXES`). No write path names them.
- **Gates:**
  - tsc 0; vitest 483/483;
  - rack-eq 30, mic-input 25, pfl 22, dynamics 10, meter contract 30;
  - undefined-calls, preload-bridge, ipc-contract, one-switch PASS; audio-isolation PASS;
  - cmd-routing 7, enginestate-wire 15, manual-mode 30, deck-identity 22, shutdown ✅;
  - leak guard OK (13, baseline held); `npm run build` OK.
- **Two gates changed:**
  - `smoke-pfl`'s "pfl_cue_device is LOCAL_ONLY" check matched the set's *last entry* by regex. It now asks the
    real `isLocalOnlyKey`.
  - The leak guard caught my first `deck_configs:changed` send, which carried the integer. It now carries the UUID
    instead; the baseline was not raised.

### Known limits (named, not built)

- A pending source channel that is **removed from the board** while it waits (not cut first) stays pending until
  its engine slot is cut.
- The blade's tick runs only while the app is connected to the daemon. That is always the case when the board is
  in use.
- **Room/aux and monitor levels are applied as steps.** They never reach air. The fader ramp (engine) covers the
  channel faders and the master.

---

## Build — the board (UI) (2026-09-26)

**Status:** built. **What it looks like on screen is UNVERIFIED until Jeff's check.** That includes the amber
flash, a Take mid-show, and the faders coming back after a restart.

### The SHOW bar (`src/components/ShowPresetBar.tsx`)

- It sits in `FaderSection` **above the faders**, so it's in the dashboard and the pop-out board.
- **What it shows:**
  - **SHOW: *name***;
  - **· modified**, derived value by value (`diffShow`) from a live snapshot (`show:snapshot`), refreshed on a
    Take, a board change, and every 3 s;
  - **· waiting: A, S1**, from the blade's state.
- **Arm a show…:** Flat plus the station's shows. Arming goes to the blade (`show:arm`), so both windows show the
  same armed show.
- **TAKE ▸ *name***, **▾** (the preview) and **DISARM**.
- **The preview** splits **CHANGES NOW** from **WAITS — ON NOW (A, S1)** and says "A Take never switches a channel
  ON". It applies the blade's live rule to what the board shows. The Take's own answer names what actually waited.
- **SAVE** overwrites the current show (disabled for Flat). **SAVE AS…** is an inline name field.
- **Other outcomes:**
  - a refused Take says why;
  - a stripped machine-local value is reported;
  - another station's presets are counted, never offered.

### The strips

`ConsoleStrip` gains `pendingShow` / `onTakeNow`, passed through `SourceChannelStrip`:
- the ON button **flashes amber** (`.on-pending`, `@keyframes on-pending-flash`) and reads **PENDING**;
- a **PENDING · *show*** line sits above it, with **TAKE NOW** (`show:force`);
- under reduced motion it holds steady amber;
- all three strip kinds (source, music deck, fallback) get it, from the blade's state.

### Reading back from the blade

**`useShowState`** reads `show:state` on mount and on a station switch, then follows the `show:state` and
`show:levels` events (both by station UUID).

**Faders:**
- **Every fader's level** is `levels[slot] ?? what it showed before`. A source channel used to show `?? 1` (no
  deck state exists for D–S5), so a restored or Taken level could never appear. It can now.
- **The master fader** reads `levels.master`.
- **The jukebox** no longer pushes its unity level on mount. That push undid the restored fader on every launch.
  It still asserts its cut.

**The room and monitor panels:**
- **AuxMonitorSlots** re-reads `aux_monitor_levels` after a Take.
- **StationMonitorMixer** re-reads `monitor_volume`, **display only**. Its loader also re-applies output devices,
  which a Take must never do, so that loader is not re-run.

**main** forwards the blade's `boardlevels` as **`show:levels`** (by UUID).

**The preload bridge** carries `show.list / snapshot / save / delete / state / arm / disarm / take / force` and
`onState / onLevels / onApplied`.

### Help

- **`docs/help-show-presets.md` (new):** what a show holds and deliberately doesn't, Take, PENDING and TAKE NOW,
  Save / Save As, Flat, faders after a restart.
- **`docs/help-channel-faders.md`:**
  - "nothing moves your fader but your hand — and a show you TAKE";
  - a restart restores the faders;
  - every level change glides over 20 ms;
  - PENDING on a channel.

### Receipts

- **vitest `showPresets.test.ts`, 7/7:**
  - a matching board isn't modified, a moved fader is;
  - racks compare by what runs, not by module id;
  - a field the preset doesn't name isn't compared;
  - the ducker and monitor are in the show;
  - the live rule;
  - Arm's now/waits split;
  - PENDING comes from the blade's state.
- **`test:show-presets` 48/48:** the blade's 35 plus 13 board checks:
  - the bar is on the board;
  - PENDING and TAKE NOW on all three strip kinds;
  - three faders read back;
  - no jukebox unity push;
  - the flash and its reduced-motion hold;
  - the state is read back, never kept locally;
  - the master reads back;
  - "· modified" is derived;
  - the Arm wording;
  - every preload verb;
  - `show:levels` by UUID;
  - the help exists.
- **Gates:**
  - tsc 0; vitest 490/490;
  - rack-eq 30, mic-input 25, pfl 22, dynamics 10, meter contract 30;
  - undefined-calls, preload-bridge, ipc-contract, one-switch PASS; audio-isolation PASS;
  - leak guard OK; `npm run build` OK.
