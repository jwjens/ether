# AUX monitor bus — slot = room, board = air

**Date:** 2026-08-18 · **Ruling:** Jeff · **Status:** DESIGN → **BUILT**, native rebuilt and runtime-probed here. See §7 for the receipts.
**No version bump**, not on OV.

> **The requirement, in Jeff's words:** the AUX monitor slot **IS the listening path**. Decks D/E/F are
> heard locally ONLY through a slot that selects them. No selection = silent in the room, regardless of
> channel/fader state. D/E/F must **not** sum into the station's local speaker output — deck D riding
> the master out is the defect, not the feature.
>
> Air is separate and unchanged: channel ON + fader up = program bus / stream, per the board-gate
> ruling. **Slot = room. Board = air. Two gates, two destinations.**

**What I got wrong:** the 2026-08-18 aux-slots build delivered meters and then argued, in its own doc,
that "hearing comes from the board". That inverted the spec — "he HEARS it through his laptop speakers"
was in the first message. This design is the correction, and `docs/aux-monitor-slots-2026-08-18.md` §3
is superseded by it.

---

## 1 · The signal path today, and why the room hears D/E/F

`native/src/audio.rs`, mixer callback:

```
slots 0..6  ──sum──►  mix_l/mix_r        (every slot, post cut / trim / fader, :1151)
                        │
                        ├─ EQ (:1240)  ─►  × master_vol (:1265)  ─►  out_l/out_r
                        │                                              │
                        │                              [optional processor → proc_l/proc_r (:1291)]
                        │                                              │
   AIR   ◄── ring_prod ◄┴──────────────────────────────────────────────┤   (:1317, proc_stream ? proc : clean)
   ROOM  ◄── data[] × monitor_vol × master_monitor_vol ◄───────────────┘   (:1331, proc_local ? proc : clean)
```

**Both destinations tap the same summed mix.** The room feed is the air feed times the monitor gains —
which is exactly the console behaviour the comment at `:1258-1262` describes, and exactly why a deck D
that is ON and up is heard in the room. Nothing is malfunctioning; the structure has one mix and two
gains, and Jeff needs one mix per destination.

## 2 · What the ruling requires

| Destination | Contents |
|---|---|
| **AIR** (`ring_prod` → Icecast) | A, B, C, CART **and** D/E/F — unchanged, fully EQ'd and processed |
| **ROOM** (`data[]`) | A, B, C, CART **only**, plus a **monitor sum** of the D/E/F slots an AUX slot has selected, each at its own slot level |

So the room is no longer derivable from the air feed by a gain. It needs its own sum.

## 3 · Why this cannot be done by subtraction, and what it costs

The tempting cheap trick — room = air − (D/E/F contribution) — **is not sound**:

- After the processor it is plainly wrong: the loudness ride and the −1 dBTP limiter are **non-linear**,
  so the aux contribution cannot be removed by subtracting it from the output.
- Even before the processor it is fragile: EQ is linear, so `EQ(core+aux) = EQ(core) + EQ(aux)` holds
  mathematically, but obtaining `EQ(aux)` means running the **same stateful biquad chain** a second time
  on a different signal. `bus.eq` is one instance behind a `try_lock`; feeding it two different streams
  per callback corrupts its state. This is a trap, not an optimisation.

**Therefore: two chains.** The callback accumulates two sums and each gets its own EQ + processor
instance and its own state.

### 3.1 · The cost, stated plainly

- a second `Eq` and a second `ProgramProcessor` per station (allocation + state);
- up to **~2× the DSP work** in the audio callback when both chains are live — this is the real-time
  thread that, when it panicked once before, produced permanent dead air
  (`docs/incident-jingle-cart-panic-2026-07-15.md`).

### 3.2 · The mitigation that makes it acceptable

**The second chain runs only when it is needed.** If no AUX slot has a deck selected — which is every
station today — the room chain is not built at all and the device tap stays exactly as it is now,
**bit-identical to the current build**. The cost is paid only by a station actually monitoring an aux
deck, and only while it does.

```
if aux_monitor_active {                  // any slot selected AND that deck has a source
    room = chain_room(core)  +  Σ aux_i × slot_level_i
} else {
    room = today's path, untouched
}
```

## 4 · The build

### 4.1 · Native — `native/src/audio.rs`, `native/src/lib.rs`

1. **Split the accumulation** in the existing per-slot pull loop (`:1151`) — no second decode, the same
   pulled samples land in two accumulators:
   - `mix_*` ← every slot (unchanged, feeds AIR);
   - `core_*` ← slots 0, 1, 2, 6 only;
   - `aux_*[i]` ← slots 3, 4, 5, captured **PRE-fader and PRE-cut** (see §4.2).
2. **New bus state:** `aux_monitor_gain: [f32; 7]`, all `0.0` by default. Only indices 3/4/5 are ever
   non-zero. Zero = that deck is not in any slot = **silent in the room**, which is the whole ruling.
3. **Room chain**, only when `aux_monitor_gain[3..6]` has a non-zero and that deck has a source:
   `room = EQ_room(core) × master_vol → [processor_room if proc_local] + Σ aux_i × aux_monitor_gain[i]`,
   then `× monitor_vol × master_monitor_vol` as today.
   The aux monitor sum is added **after** the room's processing: it is a monitor feed, not program
   material, and must not be squeezed by the program limiter.
4. **Air chain unchanged** — `mix` → EQ → master → processor → `ring_prod`. Byte-for-byte the same code
   path. This is load-bearing: nothing in this change may alter what airs.
5. **New NAPI:** `audio_set_aux_monitor(station_id, deck, gain)` → `AudioCmd::SetAuxMonitor { deck, gain }`,
   resolved with the existing `deck_index` (D/E/F → 3/4/5) and **rejected for any other slot**, so this
   can never touch A/B/C or CART. Explicit literals only; nothing indexes `DECK_LETTERS`.

### 4.2 · The one sub-decision, named rather than assumed — PRE or POST fader

The ruling says the room gate and the air gate are **independent** ("two gates, two destinations", and
"no selection = silent in the room **regardless of channel/fader state**"). Independence has to run both
ways to be coherent: if the aux monitor were taken *post*-cut, then a channel switched OFF would also go
silent in the room, and the board would still be gating the room.

**So the design takes the aux monitor PRE-fader and PRE-cut — a true PFL.** An operator can audition
deck D in the room while its channel is OFF and nothing reaches air, which is what PFL is for and what
makes "slot = room, board = air" actually true.

If Jeff wants post-fader instead (room follows the channel level), it is a one-line change of which
sample is captured — but it makes the slot partially dependent on the board, so it needs to be his call
rather than mine.

### 4.3 · Renderer

- `AuxMonitorSlots.tsx`: the per-slot level becomes the **MONITOR level** (room), calling
  `audio_set_aux_monitor(stationId, deck, level)`. Selecting `(none)` sends `0` and the deck goes silent
  in the room immediately.
- The **CH FADER** control I put in the slots is removed — it belongs to the board, and having the air
  level live in the monitor panel is precisely the confusion this ruling removes.
- Per-slot monitor levels persist per station alongside the selections in `station_config_kv`.
- Asserted downward on mount, like every other level: the engine boots with `aux_monitor_gain` all zero,
  and the panel states the operator's saved position rather than assuming it.

### 4.4 · What this fixes on the board

Deck D no longer rides the local speakers by virtue of being ON. It airs when the board says so and it
is heard in the room when a slot says so — which is also the honest answer to the original symptom
("audio reaches MASTER while the strip shows nothing").

## 5 · Verification plan (before OV)

1. **Air is unchanged** — with no AUX slot selected, the stream path is the same code and the room tap
   is the same code. Confirm by ear and by `proc_*` meters that a normal station is unaffected.
2. **Room exclusion** — jukebox playing on deck D, channel ON, fader up, **no slot selected** → audible
   on the stream, **silent in the room**. This is the assertion that proves the defect is fixed.
3. **Slot audibility** — select Deck D in AUX 1 → heard in the room at the slot level; `(none)` → silent
   again, immediately.
4. **PFL independence** — channel OFF, slot selected → heard in the room, **nothing on air**.
5. **No regression** — A/B/C monitoring, `proc_local` PRE/POST choice, and `monitor_vol` /
   `master_monitor_vol` behave exactly as before.
6. Native runtime probe of the callback under load, then a real session on this machine. **Not OV until
   all of the above pass here.**

## 6 · The two open points — ANSWERED by Jeff, and built accordingly

1. **Destination** = "into the local output stream" — the `data[]` device tap. As assumed.
2. **Pre- or post-fader** — settled by "Channel ON/OFF affects the stream, never the room path": the
   monitor tap is **PRE-CUT and PRE-FADER**, a true PFL. Built that way and proven in §7.

## 6b · (superseded) Two things I needed before touching the callback

1. **Jeff's message was truncated** at *"…add a monitor sum fed by the selected AUX slots at per-slot
   levels into the"*. This design assumes **into the local device (room) output** — the `data[]` tap at
   `audio.rs:1331`. If the intended destination is something else (a separate headphone device, a
   dedicated output), the shape of §4.1 step 3 changes materially.
2. **§4.2 — PRE-fader/PRE-cut (true PFL) is my reading of "two gates"**, and it is what lets a cut
   channel still be auditioned. Confirm, or say post-fader.

Both are one word each. The moment they land I build §4 — native first, probe it here, then the
renderer.


---

## 7 · BUILD RECEIPTS — 2026-08-18

### 7.1 · Native

| Change | Where |
|---|---|
| `aux_monitor_gain: [f32; 7]`, all 0.0 — the per-slot ROOM level; 0 = silent locally | `BusState` |
| `eq_room` + `processor_room` — the room chain's own stateful instances | `BusState` |
| dual accumulation in the pull loop: `mix` (air, all slots) · `core` (room base, aux excluded) · `aux` (pre-cut, pre-fader, × slot level) | mixer callback |
| room chain at the device tap, built ONLY when an aux deck is live; otherwise the original path, untouched | mixer callback |
| `SetAuxMonitor { deck, gain }` — refuses any slot that is not 3/4/5 | `AudioCmd` + live handler |
| `SetEq` mirrored onto `eq_room`, so the room is never tonally different from air | live handler |
| `audio_set_aux_monitor(station_id, deck, gain)` | `lib.rs` NAPI |
| `room_peak` → `level_room` → `"room"` in `audio_get_levels` | see §7.3 |

Incident-note care: nothing indexes `DECK_LETTERS`; the aux slots are addressed by explicit literals
and an `is_aux = i >= 3 && i <= 5` range test. The addon was backed up before each swap
(`ether-audio.node.bak-pre-auxmonitor-20260818`).

### 7.2 · Jeff's acceptance, measured

`room` is the local-speaker peak; `master` is air. Deck D playing throughout.

```
1) deck D playing, NO slot   -> room=0.0000  air=0.1696     <- THE DEFECT, FIXED
2) slot selects D @0.9       -> room=0.4409  air=0.4898     <- heard, at the slot's level (0.4898 x 0.9)
3) deselected                -> room=0.0000  air=0.3944     <- silent again, still airing
4) channel CUT + slot @0.9   -> room=0.4219  air=0.0000     <- PFL: cut kills air, room unaffected
```

Sustained-state check after deselecting, because a max-over-window first showed a transition sample:

```
+0.6s off : room=0.0000 air=0.1979
+1.2s off : room=0.0000 air=0.2531
+1.8s off : room=0.0000 air=0.0436
+2.4s off : room=0.0000 air=0.1690
```

Room stays at exactly 0.0000 for 2.4s while air keeps running. The earlier non-zero was the
transition, not a leak.

### 7.3 · A new permanent sense, not a probe

The first probe could not answer "is it in the room" — the deck peak is the AIR peak by design. Rather
than instrument temporarily, the mixer now publishes **`room_peak`** (`"room"` in `audio_get_levels`),
the peak of what the speakers are about to get. The air VU has never answered that question, and with
this bus the two answers genuinely differ: a deck can be on air and silent in the room, or in the room
and off air. It is what makes "no slot = silence" observable instead of claimed — and it is what every
assertion in §7.2 is measured with.

`lib.rs` hand-builds the levels JSON from an explicit field list, so the field was added there too —
the documented trap that once dropped the `proc_*` meters.

### 7.4 · Renderer

`AuxMonitorSlots.tsx`: the slot control is now the **MONITOR** level (relabelled from CH FADER, which
belonged to the board and has been removed from this panel). Selecting a deck applies that slot's
level; `(none)` sends 0. Levels persist per station (`aux_monitor_levels`) beside the selections, and
**both are asserted downward on mount** — every aux deck is addressed, so a deck not in a slot is
explicitly silenced rather than left at whatever the engine booted with.

### 7.5 · Gates

`cargo build --release` clean · runtime probes §7.2 · `tsc --noEmit` 0 errors · `npm run build` clean ·
`node --check` on daemon/main/preload.

### 7.6 · Left for Jeff's ears, and for OV

The probes prove the signal separation at the bus. **Nobody has heard it yet.** The acceptance is the
original one: jukebox playing → no slot → silence in the room → select Deck D → heard through the
speakers at the slot's level → deselect → silence.

**Not on OV.** This is the audio hot path on every station; it wants a real session here first.

---

## 8 · AUX OUTPUT DEVICE — its own stream, its own device (2026-08-18, second pass)

**Jeff:** *"just like the station monitors you need to pick a device it cant just pick on output that
would be dangerous."* Correct, and it superseded the previous pass: routing aux to whatever the station
was using amounts to choosing an output on the operator's behalf. On a broadcast machine the "default"
could be anything, including the speakers feeding a mic.

### 8.1 · Reverted first

The "aux bypasses the station monitor fader" change was removed, and the aux sum was taken **out of the
room mix entirely**. The aux bus now has exactly ONE destination: the device chosen in the AUX MONITORS
section. The room chain still excludes D/E/F from the station's local output — that exclusion is the
precondition that makes the chosen device the only place they are heard.

### 8.2 · Built

| Piece | Detail |
|---|---|
| `aux_ring_prod: Option<HeapProd<f32>>` | `None` = no device = **the mixer writes nothing**. The gate lives in the audio path, not in a comment. |
| `open_named_output_device()` | a second opener with **NO default fallback** — the existing `open_output_device` falls back to the system default, which is exactly the vetoed behaviour. An absent device stays unopened. |
| AUX output thread (per station) | opens the second cpal stream on the chosen device, closes it when cleared, reopens on switch. Tears the producer down **before** dropping the stream, so the mixer never writes into a ring nobody drains. |
| drift mitigation | persistent-phase resample 44100 → aux device rate; **underrun writes silence, never a stretched sample**; the writer drops past `AUX_RING_HIGH` (~0.125 s) so latency cannot creep between two independent clocks. |
| slow retry | a requested-but-absent device (unplugged headphones) is logged **once** and retried every 5 s, instead of re-attempting every 250 ms (which spammed the log 4×/second) or giving up forever (which would never notice it come back). Both were found by the probe, not by review. |
| `audio_set_aux_device(station_id, device_name)` | `""` closes the stream |
| `aux_out_frames` → `aux_frames` in getLevels | frames the aux callback has actually written. **"The stream opened" is not evidence audio is flowing; this is.** |

### 8.3 · Runtime receipts, on this machine

Station output deliberately pointed at a DIFFERENT device than the aux, to prove they are independent
streams:

```
station output -> BBY LCD TV (3- HD Audio Driver for Display Audio)
aux output     -> Speakers (2- Realtek(R) Audio)

1) slot ON, NO aux device -> auxFrames=0                    [nowhere to go]
2) aux device OPEN        -> AUX monitor output opened (48000Hz 2ch), auxFrames rising
3) absent device          -> "device not found ... staying silent (will retry)"   NO fallback
4) device cleared         -> "AUX monitor output closed"
```

Flow and stop, sampled:

```
OPEN, every 1s:      0 -> 35136 (+35136) -> 83616 (+48480) -> 132096 (+48480)      <- exactly 48 kHz
CLEARED, every 2s:   181056 -> 193056 (+12000) -> 193056 (+0) -> 193056 (+0) -> 193056 (+0)
VERDICT: counter went STATIC after settle — the aux stream is stopped.
```

An earlier run of this probe reported "STILL RISING — leak!". That was the probe's settle being too
short to clear the in-flight buffer, not a leak; the longer series above settles it. Recorded because
the first answer was wrong and the second is the one to trust.

The station's room feed measured **0.0000 throughout** — D/E/F never touch the local speaker output.

### 8.4 · The picker

`AuxMonitorSlots.tsx` gains one **OUTPUT** dropdown in the AUX MONITORS header, station-monitor
grammar, defaulting to **"(none — aux silent)"**. Persisted per station as `aux_monitor_device` and
**asserted downward on mount**, like every level. A saved device that is no longer connected is shown
as "(not connected)" rather than silently swapped. With nothing selected the panel says so in amber —
an operator should never wonder why it is quiet.

### 8.5 · Defect #2 — the kiosk was blind to its own shuffle

Deck D was playing "Go Your Own Way" while the kiosk showed *"0 requests waiting"*. The rail only ever
listed `jukebox_requests`, and a shuffle pick creates no request row — so the window could not see the
music it had itself chosen.

- **NOW PLAYING** is read off the routed deck (`jukebox:state` → `info`), so it cannot claim a song the
  deck is not playing.
- **UP NEXT from the shuffle** required a look-ahead: the shuffle used to choose at the moment the deck
  freed, so "up next" did not exist until it was already "now playing". The pick is now made in advance
  and **the drive plays exactly that row** — the display is a promise the drive keeps, not a guess it
  re-rolls. A request always supersedes a held pick (FIFO among requests, requests over filler).

### 8.6 · Gates

`cargo build --release` clean · runtime probes §8.3 · `tsc --noEmit` 0 errors · `npm run build` clean ·
`node --check` on daemon/main/preload. **No version bump.** Addon backups:
`ether-audio.node.bak-pre-def-telemetry-20260818`, `.bak-pre-auxmonitor-20260818`,
`.bak-pre-auxdevice-20260818`.

### 8.7 · Jeff's ears — the acceptance

Relaunch dev → **AUX MONITORS → OUTPUT → pick the real speakers** → jukebox shuffle audible at the
slot's level → kiosk shows the playing song and what is next → set OUTPUT back to "(none)" → silence.
Channel ON/OFF should move the stream and never the room.

---

## 9 · INCIDENT — a source with no off switch (2026-08-18)

**Jeff, live:** AUTO off, deck D fader down, kiosk showing nothing, all VU meters at zero — **and the
aux monitor still playing music, with no control that stopped it.** Screenshots: the Jukebox channel
fader at the bottom of its travel while AUX 1 reads *Deck D · PLAYING · 0:28 · "Señorita"*.

### 9.1 · Root cause — my own design decision, now overruled

```rust
let vol = if deck.muted { 0.0 } else { deck.volume * trim };   // AIR: fader + cut apply
let mon = if is_aux { aux_gain[i] * trim } else { 0.0 };       // AUX: NEITHER applies
aux_l[f] += l * mon;                                           // raw source, slot level only
```

`mon` read neither `deck.volume` nor `deck.muted`. That was the PFL design from §4.2 — and PFL is
exactly "audio the board cannot kill". On a broadcast console that is a feature behind a momentary
button; as the standing behaviour of a source, it is a runaway.

### 9.2 · Why nothing on screen told him — THREE stacked blindnesses

1. **The tap** (above): fader down and channel off silenced air, not the monitor.
2. **The meter lied.** `ConsoleStrip` had no case for D/E/F, so they fell through to
   `(lvl.master ?? 0)` — an aux strip showed the PROGRAMME meter. Fader down ⇒ master silent ⇒ the
   Jukebox strip read **0 while the deck was playing**. It was additionally gated on `isPlaying`,
   which for an aux strip carries the channel switch, forcing 0 a second way.
3. **The kiosk showed nothing** — the rail listed only `jukebox_requests`, and a shuffle pick creates
   no request row (§8.5).

A meter that reads zero on a playing deck is worse than no meter, because it is used as evidence. All
three are fixed; the first two were what made the third dangerous.

Also true and worth stating: **AUTO off does not stop the current song** — it stops new picks. That is
correct behaviour, but with all three displays blind there was nothing to say a track was still live.

### 9.3 · The fix — POST-FADER, POST-CUT (Jeff's ruling)

```rust
let mon = if is_aux { aux_gain[i] } else { 0.0 };   // slot level only …
aux_l[f] += lv * mon;                                // … applied to lv/rv, which are POST cut+fader
```

The slot decides WHERE a deck is heard locally and at what level. It can no longer resurrect audio the
board has killed. `ConsoleStrip` now reads `decks[].peak` for D/E/F and does not gate them on the
channel switch — that peak is post-fader, so it reads zero exactly when it should.

### 9.4 · The kill chain, proven

```
0) all ON (baseline)     auxFeedPeak=0.2014   feeding
1) FADER DOWN            auxFeedPeak=0.0000   SILENT
2) CHANNEL OFF (cut)     auxFeedPeak=0.0000   SILENT
3) SLOT (none)           auxFeedPeak=0.0000   SILENT
4) DECK STOPPED          auxFeedPeak=0.0000   SILENT
5) DEVICE CLEARED        frame deltas after settle: [4320, 0, 0, 0]   STREAM STOPPED
```

Case 4 also settles suspect (c) from the brief: with the deck stopped the feed reads 0.0000 while the
frame counter keeps advancing — the aux stream writes **silence**, it does not loop stale ring content.

### 9.5 · A new instrument, because the first probe lied too

The first run of this probe reported **two failures** — "SLOT (none): STILL FEEDING" and "DEVICE
CLEARED: STILL WRITING". Both were the probe, not the product: it measured `decks[].peak`, which is the
DECK's level regardless of any slot, and case 5 had not settled past the snapshot lag.

So the mixer now publishes **`aux_peak`** — the peak of what the aux bus is actually sending, after the
fader/cut AND the slot level. It is the only honest answer to "is the aux monitor making sound", it is
distinct from `decks[].peak` (the deck) and `room_peak` (the station's speakers), and it is what §9.4 is
measured with. Recorded because a probe that reports a working control as broken is its own defect.

### 9.6 · Gates

`cargo build --release` clean · kill-chain probe §9.4 · `tsc --noEmit` 0 errors · `npm run build` clean.
Addon backup: `ether-audio.node.bak-pre-postfader-20260818`. **No bump.**

### 9.7 · What Jeff should now see

Fader down ⇒ silent everywhere, and the Jukebox strip's VU finally moves with deck D instead of the
programme. Slot (none) ⇒ silent. OUTPUT (none) ⇒ stream closed. The kiosk shows the playing song and
what is next, so a live track can no longer hide behind three blind displays.
