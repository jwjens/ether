# Settings → Audio → Outputs: plan and open questions (2026-10-27)

**Jeff (verbatim):** "Replace the dead "Where music plays" section in Settings → Audio with a real Outputs section, wired
to the audio engine:
- Each Ether output (Master, each station's Monitor, PFL/cue) can be sent to any audio device on this computer, and to a
  specific channel pair on devices with more than two channels.
- The screen shows the device the engine actually opened, not just what was clicked.
- Saved for this computer only.
- If a chosen device is missing: a clear on-screen warning naming it, no fallback to another device.
One place per output: don't leave a second picker for the same thing anywhere else. Each change its own commit with a
test. Prove it on OVEVENTS with whatever devices are plugged in there. Type-check and all tests, then stop. Do not
build, push, or deploy."

Background: `docs/audio-output-selectors-wiring-2026-10-27.md` (what is wired today).

## What the engine has today (per station)

| Output | Engine command | Picker today | Carries | Missing device |
|---|---|---|---|---|
| Main local output ("Monitor") | `SwitchDevice` (`native/src/audio.rs:3510`), `open_output_device` `:3831` | Board → Station Monitors → OUTPUT | Programme after MONITOR and the station strip | **Falls back to the Windows default, silently** (`found.or_else(default_dev)`) |
| AUX | `SetAuxDevice` (`:3291`) | AUX rows (`AuxMonitorSlots.tsx:198`) | Source-kind channels to the room, post-MONITOR | Silent, never falls back |
| PFL cue | `SetCueDevice` (`:3325`) | Preferences → PFL (`PflSettings.tsx`) | PFL only (the one exception to MONITOR) | Silent, never falls back; state shown |
| **Master (air)** | **none** | none | Air goes only to the encoder / stream | n/a |

Channels:
- Every open uses at most 2 channels: `cfg.channels().min(2)` at `audio.rs:3851`.
- There is no channel-pair choice anywhere.

A second automatic switch:
- `outwatch.rs` (FALLBACK_AFTER = 2). A device that stalls or fails to open twice in a row is replaced by the Windows
  default and logged. Added for the OV dead air on 4.6.51.
- With today's not-found fallback, a missing device never reaches it.
- Once not-found stops falling back, a missing device would count as "failed to open" and reach this switch after two
  tries, unless it is changed too.

## Plan (once the questions below are answered)

1. **Engine: no fallback for a missing device.**
   - `open_output_device` returns the not-found state instead of the default.
   - A not-found device is never counted toward the outwatch switch.
   - Per-output status (requested device, opened device, channel pair, state: open / opening / not_found / failed),
     on the model of `CueStatus` (`audio.rs:1837`), for main, AUX and cue. It is read by a new `audio:output-state`
     and logged on every change.
   - Rust tests: a missing name → no stream and state `not_found`; never the default.
2. **Engine: channel pair.**
   - Open the device with its real channel count.
   - Write L/R into the chosen pair (1-2, 3-4, …) and silence into the rest.
   - `audio_list_output_devices` returns each device's channel count.
   - Rust tests on the pair mapping.
3. **Outputs section in Settings → Audio**, in place of the removed picker.
   - One row per output, per station: Monitor, PFL, (Master: Q1).
   - Each row has a device and a channel pair, and shows what the engine actually opened: "Opened: <device> ch 3-4",
     or a red line naming the missing device.
   - Saved machine-local (`audio_output_device` / `pfl_cue_device` already are; new `*_channels` keys the same way).
     The daemon re-applies them on connect (`audiod/board-state.js`).
4. **One place per output.** Remove the Station Monitors → OUTPUT select and the PFL device select (the PFL dim
   amount stays); each gets a one-line pointer to Settings → Audio → Outputs. Test: no second caller of
   `setOutputDevice` / `setCueDevice` in `src`.
5. **Proof on OVEVENTS:**
   - Run an isolated engine (own pipe, empty database, nothing scheduled, so nothing can air).
   - Set each output to each plugged-in device and a channel pair, and an unplugged name.
   - Read back the engine's opened-device state and log lines.

Each step is its own commit with its test.

## Questions for Jeff (blocking)

1. **Master.** The engine has no Master device output. What should it carry?
   - (a) Air: the same signal as the stream, after the MASTER fader, not affected by MONITOR. This would be a second
     exception to your 2026-10-07 rule ("every local output passes MONITOR; only PFL to a cue device is exempt").
   - (b) The programme after MONITOR, which is what the station's Monitor output already carries.
   - Also: one per station, or one for the computer?
2. **Stalls.** A device that is present but keeps stalling switches to the Windows default after two tries (the 4.6.51
   OV dead-air fix). Keep that, or never switch (stay on the chosen device, keep retrying, warn on screen)?
3. **AUX.** The AUX output device is also a device picker (on the AUX rows). Move it into Outputs as well, or leave it
   where it is?
4. **Compiling the engine on OVEVENTS while it is on air.** Every step above changes the native engine, so it has to
   be compiled here, and the Rust tests compile it too.
   - Free memory now: 2.9 of 15.7 GB.
   - The last compile attempt on this box was stopped for low memory (`docs/engine-compile-requirements-2026-10-19.md`).
   - 5 of 159 engine tests already failed before any change (old DSP goldens).
   - Options: compile now at low parallelism, or when the station is off air. Does "do not build" leave compiling the
     engine (no installer) allowed?

## Jeff's answers (verbatim, 2026-10-27) — PARKED

"Simple rules, no others:
- On air goes to Icecast. That's it.
- Master is the local audio output. It plays to whatever device the user assigns. On OV right now that's the Realtek
  headphone jack that feeds the Bose. What Station Monitors → OUTPUT does today is this output: make it the Master output
  in Settings → Audio → Outputs, in one place only. Keep its existing level and mute controls, including the Park page,
  working exactly as they do now.
- Cue (PFL) and Aux each go to whatever device the user chooses.
- Any device on this computer, with channel pairs on devices with more than two channels. Saved per computer. The screen
  shows the device the engine actually opened. If a device is missing: a clear on-screen warning naming it, no fallback."

Then: "Park the Outputs work for now. Keep the plan doc and don't change any engine code for it yet."

What the answers settle:
- Q1: Master = today's main local output (the Station Monitors → OUTPUT one); no new air tap; the 2026-10-07 MONITOR
  rule is unchanged.
- Q3: AUX moves into Outputs too.
- "no fallback" covers a missing device.
- Still open when this resumes: Q2 (whether a plugged-in device that keeps stalling still switches to the Windows
  default) and Q4 (compiling the engine on OVEVENTS while it is on air).

## Jeff's answers to the four questions (verbatim, 2026-10-27) — for later, do not start yet

"1. Master is the existing main/monitor output, after the MONITOR fader, one per station. Rename it Master. No new output.
2. Stalls: make it a setting, "If the output device stalls, switch to the Windows default", on or off. Until the user
   sets it, warn on screen and keep retrying; never switch on its own.
3. AUX moves into Outputs.
4. Compile the engine only when this computer is off air. Compiling the engine with no installer is allowed then."

## Done so far today (local, not pushed)

- `d1e2065`: isolated launch keeps its own `--user-data-dir` and its own engine pipe. This is why the 4.6.66 check
  quit: it lost the on-air app's single-instance lock (`%TEMP%\ether-diag.txt` POINT-2b).
- `f901541`: the dead "Where music plays" picker is removed (a pointer line stands in its place until Outputs lands);
  "Cue / headphone output" becomes "Track Editor preview player".
