# Fader type, source loudness, fader taper — read-only findings (2026-10-11)

Three of Jeff's asks, plus one blocking finding about the board-state build (34e622c3). Read-only, except the approved
change in §0. Station 2 on OVEVENTS. Board names: A–F; S1 = **G**, S2 = **H**, S3 = **I** (board order A–F,S1–S3).

## ⚠ BLOCKING — do not install board-state build 34e622c3 as it stands

The saved fader levels for station 2 (`board_levels`, written from the engine's own fader values) are:

| Fader | Saved gain | dB | What the build would do |
|---|---|---|---|
| B (music) | 0.0013 | **−57.7** | music on deck B **near silent on air** |
| C (music) | 0 | **off** | music on deck C **silent on air** |
| E (sweeper) | 0.153 | −16.3 | sweeper 16.3 dB quieter than it plays today |
| D (announce) | 1 | 0 | unchanged |
| H | 0 | off | (disabled channel) |

These were genuinely where the faders sat. The `[mix s2]` line at 2026-10-11T19:05:58Z shows `B a=1 vol=0.00 | C vol=0.00 |
E vol=0.15` with `peak=0.000`: deck B playing at volume 0. The 20:21 restart silently put them back to 1.0 (defect A),
which is why music played since.

**Second defect in the same build:** the channel faders DISPLAY the Show blade's mirror (`FaderSection.tsx:90`,
`show.levels[slot] ?? fallback`). The blade never boots (nothing sends `init`), so after the build restores B to −57.7 dB
the fader would still show unity. The board would lie in the other direction.

**Fix needed before it can be installed (for approval):** the daemon's restore also sets the blade's mirror and
broadcasts it (`showstate`), so every fader shows what the engine was given. And Jeff decides B and C: raise them first,
or accept that the restore puts music decks B and C at the levels the board last showed.

## 0 · Fader type removed from the board-state applier (approved, done locally)

`audiod/board-state.js` no longer reads, sends or compares a fader type. The "E channel type" check is gone; the help entry
is updated. `deck_configs.kind` is still read for one thing only: the jukebox's own ON key. It is the **source input
selected** on the fader, not a fader type. Tests 18/18, show presets 52/52.

## 1 · Everything that depends on a fader's TYPE today (engine `SlotKind`: Rotation / Sweeper / Source)

The type is fixed by ADDRESS: `default_kind_for` (`audio.rs:1570–1575`). 0–2 (A/B/C) are Rotation, 6 (CART) is
Sweeper, everything else is Source. `set_slot_kind` (`show.rs:159–165`) exists, but no shipped path calls it. Every
dependency below hangs off `is_aux = deck.kind == Source` (`audio.rs:4185`) or `default_kind_for`:

| # | Behaviour | Where | Today | Should follow instead |
|---|---|---|---|---|
| 1 | **Air / stream sum** | `audio.rs:4296–4297` (`mix_l += lv`, "AIR — every slot") | every fader, every type | already generic: no change |
| 2 | **Room (main output) vs AUX** | `:4301–4313` (non-Source into `core`/`room`), `:4320–4323` (Source → `aux_l × row`) | Rotation/Sweeper → main room output; Source → AUX device only | an explicit **per-fader "local output: Main / AUX"** setting |
| 3 | **Who triggers the duck** | `:4202` (`is_aux && duck_enabled`), `:4314–4318` (detector fed by Source only) | only a Source fader with "duck" on can duck | the per-fader **"ducks music"** toggle (`deck_configs.duck`), for every fader |
| 4 | **Who gets ducked** | `:4301–4313` (`core`/`imm` sums; duck applied to `core` only, `:4407–4412`); Source sums into `src`, added **after** the duck (`mix = core*g + src`) | Rotation/Sweeper ducked (unless `duckable` off); a Source fader is **never** ducked, whatever `duckable` says | the per-fader **"ducked by others"** toggle (`deck_configs.duckable`), for every fader |
| 5 | **AUX room row accepted** | `audio.rs:3093` and `show.rs:151` refuse non-Source **addresses** | A/B/C/CART can't have an AUX row | allowed on any fader whose local output is AUX |
| 6 | **Room level (`room_gain`)** | `show.rs:153` | not for Rotation | any fader on Main |
| 7 | **Mic / Link input** | `lib.rs:409`, `lib.rs:439` refuse non-Source addresses | A/B/C/CART can't take a mic or Link | the source selection: any fader can take any input |
| 8 | **Meters / health "aux_routed"** | `audio.rs:3211`, `lib.rs:792` | true for Source | the per-fader local-output setting |
| 9 | **AUX chain present** | `audio.rs:4201` (`aux_present`) | any Source deck present | any fader whose local output is AUX |
| 10 | **board-state read-back** | `board.rs:16,27` (`kind` field) | reported | report the new per-fader settings instead |

UI side: the board still has fader **types** in `deck_configs.type` ("music" / "source" / "mic" / "guest") and renders
different strips for them (`FaderSection.tsx:286`: "source" → `SourceChannelStrip`, else `ConsoleStrip`). The sweeper
deck for jingle fires is chosen by the source selected (`kind` "jingle"). That is a source selection, so it is fine.

### Proposal (not built)

- Replace the fixed type with **three explicit per-fader settings**:
  - **Local output: Main / AUX**;
  - **Ducks music** (the existing `duck`);
  - **Ducked by others** (the existing `duckable`).
- The mixer reads only these. Nothing reads the address.
- The **source input** stays the operator's selection on the fader.
- **Migration** writes today's behaviour into the settings, so **nothing changes on air or in the room at the update**:
  - A/B/C/CART: Main, ducks = (their saved `duck`, but today ineffective, so **off**), ducked = saved `duckable`;
  - D–F/S1–S5: AUX, ducks = saved `duck`, ducked = **off** (today a Source is never ducked).
- **Effect on air: none at migration**, by construction. The air sum (row 1) never depended on type. Afterwards the
  operator can make any fader duck or be ducked.
- Tests: a render matrix (every fader × each setting) proving the migrated settings reproduce today's air, room and
  AUX bit-for-bit.

## 2 · Sweepers and carts much louder than music

**2.1 Same processing chain on air? Yes.** Every fader sums into one programme. Rotation and Sweeper go via `core` (ducked),
Source via `src` (not ducked), and `mix = core + src` (`:4409–4410`). The ONE mix then goes:

```
            ┌ Rotation/Sweeper faders ─→ core ─→ × duck ┐
deck → trim → rack → fader ┤                                        ├→ mix → master EQ → MASTER fader → PGM ┬→ stream processor (ride → limiter) → STREAM (air)
            └ Source faders ───────────→ src ──────────┘                                      └→ (local branch, below)

LOCAL (room):
  Rotation/Sweeper → room sum × duck → room EQ → MASTER → room processor (if Process local) → × MONITOR → MAIN DEVICE
  Source            → × AUX row → AUX processor (if Process local) → × MONITOR → AUX DEVICE
```

- **Air and stream:** identical processing for every source. Station 2: `processing local=true stream=true … target=-16
  ceiling=-1` (daemon log 20:22:20).
- **Room:** separate processor instances with the same parameters (`audio.rs:4700+`).
- So **nothing bypasses processing on air**.
- The processor is a slow loudness **ride** plus a **limiter**. A 5-second sweeper 6–8 LU hotter than the song is
  mostly *above* the ride's time constant. The ride is also frozen while the duck holds the music down (`:4610`), so
  the sweeper passes at its own loudness, limited only at the ceiling.

**2.2 Per-track gain (normalization): applied to NOTHING in practice.**
- The engine applies `gain_db` per deck (`audio.rs:4175–4178`).
- Music: the daemon's queue items carry `item.gainDb` (`engine.js:1781`), but nothing in the daemon fills it.
- Sweepers are fired with **0** (`engine.js:2805`). Announcements are loaded with **0** (`main.js:5209`).
- Every `[mix s2]` line shows `g=+0.0` on every deck.
- So songs, sweepers, carts and announcements all play at their **file's own loudness**.

**2.3 Measured** (`ffmpeg ebur128` on the files that aired at 20:22–20:30. Air level = file + fader + 0 trim, then the
shared chain):

| Source | Integrated | True peak | vs music |
|---|---|---|---|
| Music: Dancing In the Dark | −15.8 LUFS | −1.0 dBFS | — |
| Sweeper (E): audiocoffee impact _11 | −9.6 LUFS | −0.1 dBFS | **+6.2 LU** |
| Cart (G): dragon-studio scary transition | −7.3 LUFS | +0.1 dBFS | **+8.5 LU** |
| Cart (G): idoberg creepy fx v3 | −21.7 LUFS | −7.0 dBFS | −5.9 LU |
| Announcement (D): HALLOVEEN CLOSED | −15.1 LUFS | −0.8 dBFS | +0.7 LU |

Live, the capture at 20:36:28–34 has E (sweeper) peaking at **0.65–0.68** at fader 1, and the music **ducked to 0.02
(−34 dB)** underneath it. The duck makes the jump sound even bigger.

**2.4 How much was the fader not being restored?**
- **E (sweeper): +16.3 dB.** Saved 0.153 (−16.3 dB), played at 1.0 since the 20:21 restart. Together with the file's
  +6.2 LU, the sweeper ran about **+22 LU** over the music relative to what the board was set to.
- **G (carts):** never saved (no `board_levels` entry), so it was 1.0 either way. The +8.5 LU is the file itself.
- **D:** saved 1.0, so no difference.

### Proposal (not built)

- **One loudness normalization for every source on the air path** (music, sweepers, carts, announcements, jukebox):
  - measure each file's integrated loudness once on import or first play (ebur128), stored per file;
  - load every deck with `gain_db = target − measured`, through the same `audioLoad` trim already in the engine;
  - one target for all (Jeff's number; the stream ride target today is −16).
- Effect on air:
  - hot sweepers and carts come **down** about 6–9 dB, quiet ones come up (capped, so the limiter never has to work
    harder than today);
  - music changes by its own offset from the target (this song −15.8 → −16 = −0.2 dB);
  - the fader then means the same thing for every source.
- The duck depth stays the operator's setting.
- Tests: the gain applied per source equals target − measured; a render with a −7 LUFS cart and a −16 LUFS song at
  equal faders comes out within ±1 LU on the stream tap.

## 3 · Fader taper

**Position → gain today** (the engine takes linear gain; the law is in the UI):

| Fader | 0% | 10% | 25% | 50% | 75% | 90% | 100% |
|---|---|---|---|---|---|---|---|
| **Channel faders** (`ConsoleStrip.tsx:59–61`, `:230–235`: dB-linear, −60…0) | off | −54.0 | −45.0 | **−30.0** | −15.0 | −6.0 | 0.0 |
| **MASTER, MONITOR** (`MasterOutput.tsx:155–165`: linear), **station MONITOR strips** (`StationMonitorMixer.tsx:138`), **AUX rows** (`AuxMonitorSlots.tsx:342`), **MixerChannelStrip** (`:233`, `/100`) | off | −20.0 | −12.0 | −6.0 | −2.5 | −0.9 | 0.0 |

- On a channel fader **50% is −30 dB**, and everything below about 40% is under −36 dB: the "dead bottom half".
- Five different laws are in use.
- **Zipper:** the engine applies a fader as a constant per buffer (`audio.rs` per-slot `vol`). It ramps only during a
  Show Take (`vol_ramp`), so a drag steps every ~10 ms.

**Proposed law** (Jeff's points, interpolated linearly in dB between them; one shared module used by every fader):
100% = +10, 75% = 0 (unity, marked), 50% = −10, 35% = −20, 25% = −30, 15% = −40, 5% = −60, 0% = off.

**Migration: stored values are GAINS, not positions.** `board_levels`, `aux_monitor_levels`, `monitor_volume` and
`master_monitor_volume` all hold linear gain. The new law changes only where the fader *sits* for that gain; **nothing
changes level on air**. Station 2, before/after:

| Fader | Stored gain | dB | Position today | Position under the new law |
|---|---|---|---|---|
| B | 0.0013 | −57.7 | 3.8% | 6.2% |
| C | 0 | off | 0% | 0% |
| D | 1.0 | 0.0 | 100% | 75% |
| E | 0.153 | −16.3 | 72.8% | 40.6% |
| H | 0 | off | 0% | 0% |
| A, F, G, I | (none saved, 1.0) | 0.0 | 100% | 75% |
| MONITOR | 0.4641 | −6.7 | 46.4% | 58.3% |
| Station 2 MONITOR strip | 0.73 | −2.7 | 73% | 68.2% |
| AUX row D | 0.82 | −1.7 | 82% | 70.7% |
| AUX row E | 0.83 | −1.6 | 83% | 71.0% |
| AUX row G | 0.74 | −2.6 | 74% | 68.5% |
| AUX row F | 0.56 | −5.0 | 56% | 62.4% |
| AUX row H | 1.0 | 0.0 | 100% | 75% |

**Engine changes the law needs:**
- Allow up to +10 dB (3.16): MONITOR and master MONITOR are clamped to 0…1 today (`main.js` `_localMonitorLevel`, the
  applier, `board-state.js`); `set_room` already allows 4.0.
- **Gain smoothing:** every SetVolume / room row / MONITOR change goes through the existing per-slot ramp
  (`vol_ramp`, ~20 ms), so no zipper.

Tests: the law's points exact; position→dB→position round-trip; every stored station-2 gain unchanged by the
migration (the table above, pinned); a render step with the ramp shows no discontinuity.
