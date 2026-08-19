# AUX monitor slots + D/E/F telemetry

**Date:** 2026-08-18 · **Design:** Jeff · **Status:** BUILT, native rebuilt and runtime-probed here.
**No version bump** — more refinements expected before the next installer.

Two pieces: the slots, and the native rider that gives them something to meter.

---

## 1 · The rider first — D/E/F now publish telemetry

### 1.1 · Why it was needed

`native/src/audio.rs` built its per-deck telemetry array from
`[(0,"A"), (1,"B"), (2,"C"), (6,"CART")]` — slots 3/4/5 (D/E/F) were absent, so any strip for those
decks had a dead meter and no position. That is pre-existing and affects any source on those decks.

### 1.2 · The incident note was read first, as instructed

`docs/incident-jingle-cart-panic-2026-07-15.md`: the maiden jingle fire panicked the cpal output thread
with `index out of bounds: the len is 6 but the index is 6` — `DECK_LETTERS[6]` on a len-6 array, on the
CART-source-exhausted path. Killed station 3's audio thread → permanent dead air until restart.

**This change cannot repeat that.** It adds `(3,"D"), (4,"E"), (5,"F")` as **explicit literals in the
same tuple list**, exactly as `"CART"` is handled. Nothing here indexes `DECK_LETTERS`. Slots 3/4/5 are
valid indices into `decks: [DeckSlot; 7]`, unlike the out-of-range 6 that panicked.

### 1.3 · The two edits

| Edit | Detail |
|---|---|
| `DeckTel` gains `peak: f32` | `#[serde(default)]`, additive. `bus.peaks` is `[f32; 7]` and the mixer has **always** computed all seven (`for i in 0..7`, end of the mixer callback) — only A/B/C/CART were ever surfaced. The number a D/E/F meter needs already existed; it was never published. |
| the telemetry loop covers D/E/F | tuple list extended; `Vec::with_capacity(4)` → `7` |

**`active_decks` semantics are unchanged.** Its `if i < 3` guard still gates the counter, so
`electron/audio-health.js` — which consumes that number — sees exactly what it saw before, even with a
deck D playing. Verified at runtime below.

### 1.4 · Built and PROVEN AT RUNTIME (not just compiled)

`cargo build --release` → clean (2m16s; 33 pre-existing warnings, no new ones). The previous addon was
backed up to `native/ether-audio.node.bak-pre-def-telemetry-20260818` before the swap.

Probe: load and play a real file on deck D, then read the levels the strips consume.

```
load D: true          play D: true
t+0.6s  decks=7 [A,B,C,D,E,F,CART]  D: peak=0.0016 frames=24452  present=true active=true  active_decks=0
t+1.2s  decks=7 [A,B,C,D,E,F,CART]  D: peak=0.0016 frames=24452  present=true active=true  active_decks=0
t+1.8s  decks=7 [A,B,C,D,E,F,CART]  D: peak=0.0021 frames=51475  present=true active=true  active_decks=0
t+2.4s  decks=7 [A,B,C,D,E,F,CART]  D: peak=0.0014 frames=78498  present=true active=true  active_decks=0
t+3.1s  decks=7 [A,B,C,D,E,F,CART]  D: peak=0.0016 frames=105521 present=true active=true  active_decks=0
```

- **seven entries**, D/E/F present for the first time
- **`peak` is live** and moving — the VU has a real source
- **`frames_played` advances** 24452 → 105521 — position is the sample clock, not a wall-clock guess
- **`active_decks` stayed 0** with deck D playing — the health signal's meaning is intact

### 1.5 · The payload survives the relay to the renderer

Checked rather than assumed, because this is exactly where `lib.rs` warns that hand-built JSON drops
fields (the `proc_*` meters were lost that way):

- `native/src/lib.rs` `audio_get_levels` emits `"decks": decks` — serde carries the new field through.
- `electron/levels-scope.js:9-14` `scopeLevelsFrame` **spreads** (`{ ...rest }`), so `decks[]` is
  preserved on the daemon relay; it strips only the pipe envelope and the integer station id.
- `scripts/test-levels-scope.js` → **ALL CHECKS PASS** (station scoping, tagging, never-go-dark).

No new IPC channel was added. The array was already being broadcast; it simply had no D/E/F entries.

## 2 · The slots

`src/components/AuxMonitorSlots.tsx`, mounted under `<StationMonitorMixer />` in `MasterOutput.tsx` —
the Station Monitors area.

- **Three fixed slots**, each with a dropdown: `(none) | Deck D | Deck E | Deck F`.
- **Selected** → a live strip: what is loaded (title/artist), status, position, a VU that moves, and
  that deck's channel fader.
- **Unselected** → a quiet, dimmed placeholder. No controls, nothing pretending.
- **Persisted per station** in `station_config_kv` under `aux_monitor_slots` (a 3-entry JSON array),
  the same store every other per-station setting uses.
- Two slots may watch the same deck — both merely observe, and hiding the option would be more
  surprising than allowing it.

Sources, all real: VU ← `decks[].peak`; position ← `decks[].frames_played / 44100`; title/status ←
`ether.audio.getState(stationId)`, polled at 1s because this is a monitor panel, not the playout path.

**A bug caught in my own code before it shipped:** the levels subscription initially called
`matchesStation(lvl.stationUuid, …)`. The helper reads `.stationUuid` off its first argument, so
passing the string yields `undefined` → "untagged frame" → renders **every** frame, silently disabling
station scoping and metering other stations' audio. Now passes the whole frame, as `ConsoleStrip.tsx:144`
does.

## 3 · What was NOT built, and why — please read before testing

The design asked for **audio to the selected monitor output device** and **PFL** per slot. Neither is
built, because neither exists to be wired to, and a control that does not control is the exact defect
this week has been spent removing (the dead MUTE, the dead menu items, the handler with no door):

- **Per-slot output device.** Rust runs **one output stream per station** with one local-monitor gain
  (`native/src/audio.rs:377-379` — "applied to the DEVICE (speaker) output only … never the program
  bus"). There is no per-deck send, so a slot cannot route deck D to a device other than the station's
  own output. A dropdown offering that would be a lie.
- **PFL.** There is **no PFL bus anywhere in the product**. The PFL buttons that already exist
  (`ConsoleStrip.tsx:416`, `MicChannel.tsx:133`) toggle a local boolean and light a lamp; they route no
  audio. A fourth lamp is not a monitor.

The level control is therefore labelled **CH FADER** and is honestly the deck's channel fader — the air
level — not a monitor send. The panel says so in one line where an operator will look for it.

### What Jeff's acceptance depends on

> "jukebox playing on deck D → AUX slot set to Deck D → he HEARS it through his laptop speakers, VU
> alive, position moving."

**VU alive and position moving: delivered** (§1.4 proves the data, §2 renders it).

**Hearing it: comes from the board, not from this panel.** Deck D is summed into the station's program
bus and out the station's output device whenever its **channel is ON and its fader is up** — the
standing ruling from `docs/jukebox-board-gate-2026-08-18.md`. If the station's output device is the
laptop speakers, he hears it. If the channel is OFF, he will not — and no slot in this panel can change
that today, because monitoring a cut channel is precisely what a PFL bus is for.

**So if the intent was "hear it even with the channel OFF", that is a native feature, not a UI one.**
It needs a second mix in the mixer callback (a monitor/PFL sum, pre-cut, per selected slot), its own
device stream or a headphone tap, and a level per slot. That is a real piece of audio engineering in
the hot path, and it should be designed on its own rather than folded into a monitor panel. Say the
word and I will write that design first.

## 4 · Gates

- `cargo build --release` → clean, no new warnings
- native runtime probe → §1.4
- `scripts/test-levels-scope.js` → ALL CHECKS PASS
- `npx tsc --noEmit` → 0 errors
- `npm run build` → clean

**No bump, no installer** — as instructed. The rebuilt `ether-audio.node` is in the tree and the
previous one is beside it as `.bak-pre-def-telemetry-20260818`.

**Not yet tested on OV**, per the instruction to test here first. The native change affects the audio
hot path on every station, so it wants a real session on this machine before it travels.
