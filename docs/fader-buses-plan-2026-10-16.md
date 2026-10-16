# Fader routing, the console way: MAIN / AUX / STAFF buses: plan and mock (2026-10-16)

Nothing is built. Plan and mock for approval.
Mock: https://claude.ai/artifact/5SKzAd4v51onS5bur7nbTk (file: session scratchpad `bus-routing-mock.html`).

## Jeff (verbatim)

> Fader routing, the console way (plan and mock first, no build yet):
> - Buses: MAIN, AUX and a new STAFF bus. Each bus is a strip on the board with its title and its own bus fader, and under it the sources assigned to it are listed (e.g. AUX: Source E, Source D, Source F, Source G).
> - Each source's fader picks which bus(es) it feeds. The bus fader controls that whole group.
> - MAIN and AUX both go to the park speakers through MONITOR (and to the stream per the stream rules). STAFF goes only to staff phones: never the park speakers, never the stream.
> - Listen on the Park page: "Park mix" (default: MAIN + AUX after MONITOR and MUTE) or "Staff channel" (the STAFF bus).
> - Hold to talk: PARK TALK is a source; assign it to MAIN/AUX to talk to the park, or to STAFF to use it like a walkie-talkie to staff.
> - Remove the MONITOR/AUX choice from the Listen settings; fix "buffer 0 shows as not set".
> First tell me in plain words how AUX works in Ether today (separate output? bus? per-fader switch?), then show me a mock of the board with the bus strips and their sources listed, and the Park page channel switch. Build only after I approve.

## How AUX works in Ether today (read from the code)

- **AUX is a second local output: a separate sound-card output.**
  - It's picked in Master Out → AUX monitors → OUTPUT (`audio_set_aux_device`).
  - With none picked, AUX is closed and silent.
  - It has its own processing (the same chain as the station's), and its own meters.
- **It is a per-fader switch, not a bus with its own fader.**
  - Each fader strip has a **MAIN / AUX** button (`src/components/FaderRouting.tsx`, engine `local_aux`).
  - It decides where that fader is **heard locally**: the main speakers or the AUX output. It's one or the other, never both.
  - Defaults: music A/B/C and sweepers on MAIN; the source faders (D–F, S1–S5) on AUX.
- **Each AUX fader has its own AUX row level** in Master Out → AUX monitors (`AuxMonitorSlots.tsx`, engine
  `aux_monitor_gain`), one row per fader. There is **no AUX master fader**. A MAIN fader has a room level of its own.
- **Both local outputs go through MONITOR and MUTE** (MONITOR is master of all local output).
- **The stream is separate from MAIN/AUX:**
  - every fader always goes to the stream, whatever its MAIN/AUX setting (`audio.rs:4589`);
  - its fader and channel ON affect both the stream and the local output;
  - its row level only affects local.
- **Ducking is per fader:** DUCKS (this fader pulls the music down) and DUCKED (this fader is pulled down).
- **Listen until today** sent MAIN, AUX or both, by a station setting. ovowforestmusic had MONITOR (= MAIN only), so
  announcements on AUX were missing.
  - **Fixed locally, commit `b111628`:** Listen always sends MAIN + AUX after MONITOR and MUTE, and the choice is
    removed from Preferences.
  - Tested on the real engine: the AUX announcement is silent with the old setting (177,200 samples, peak 0), present
    with MAIN + AUX (−34.6 / −38.7 dBFS at the test's quiet −30 dB MONITOR), and silent at MONITOR 0.

## The proposal (what the mock shows)

- **Three bus strips on the board: MAIN, AUX, STAFF.** Each has its title, its bus fader, where it goes, and the list of
  sources assigned to it. The list updates as faders are assigned.
- **Every fader has MAIN / AUX / STAFF buttons** (one or more), plus **TO STREAM: ON/OFF**.
  - TO STREAM is greyed when the fader feeds STAFF only, because STAFF never reaches the stream.
- **MONITOR + MUTE** stay the park's level, over MAIN and AUX. STAFF is not under MONITOR.
- **Park page:** a **Park mix / Staff channel** switch above LISTEN; HOLD TO TALK says where it talks (park, staff or
  both), and "Park is muted. Unmute to be heard." when it talks only to the park and the park is muted.
- **PARK TALK strip:** "Talking now / Last talk" lines and a STOP TALK button.

## What it takes (engine): bigger than the Hold-to-talk E2

- Today a fader's local feed is MAIN *or* AUX, and every fader goes to the stream. Buses need, in the mixer's
  per-fader loop:
  - a set of buses per fader;
  - a level per bus (the bus fader);
  - a new STAFF sum;
  - the stream gated per fader (TO STREAM, and STAFF-only never).
  - It **replaces E2** from `park-hold-to-talk-engine-2026-10-16.md`.
- **A second Listen feed** (the STAFF bus) next to the park mix. Each phone picks one; the station sends whichever
  channels have listeners.
- **Risk: medium–high**, because it is the loop every station plays through.
  - The defaults reproduce today exactly (each fader on its current MAIN or AUX, TO STREAM ON, bus faders at 0 dB, STAFF
    empty).
  - So the exact-match goldens (74/74) and the existing mix tests must not move. They gate it, plus new tests per rule.
- **Not engine:** board strips, the per-fader buttons, saving, the Park page switch, the server's channel choice, the
  help docs.

## Questions for Jeff

1. **Bus faders and the stream.** Should the MAIN/AUX bus faders change only what the park hears (the stream keeps its
   own master fader), or the stream too? Recommended: park only. This keeps "MONITOR and local levels never touch air".
2. **A fader on both MAIN and AUX** is heard twice in the park (two outputs). Allow it, or make MAIN/AUX one-or-the-other?
3. **The AUX rows** in Master Out → AUX monitors (one level per fader): keep them as each fader's send level into its
   bus, or retire them now that each bus has its own fader?
4. **PARK TALK on STAFF:** should it still duck the park's music? Recommended: duck only while it talks to MAIN or AUX.
5. **Staff channel and MUTE:** the mock assumes park MUTE does not silence the STAFF channel. Right?

Still open from Hold to talk: E1 (the talk input, low risk), E3 (its own duck, medium), limiter L1 or L2.
