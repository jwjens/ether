# Audio output selectors — what is wired to the engine (2026-10-27)

**Jeff's report (verbatim):** "On OV, "Where music plays" shows ACTIVE on Voicemeeter Input but Voicemeeter receives no
signal on that device."

**The ask (verbatim):** "Check, read-only, that every audio output selector in Ether is actually wired to the audio
engine: Settings → Audio "Where music plays", "Cue / headphone output", "Phone hybrid input", and Station Monitors →
OUTPUT on the board."

Read-only trace on release/1019 (HEAD 637824e). No code changed. Everything below is what the **source** says; the
runtime on OV is UNVERIFIED until the check at the end is run.

## Summary

| Selector | Saved? | Reaches the engine? | What it is meant to carry |
|---|---|---|---|
| Settings → Audio → **Where music plays** | No (on-screen state only) | **No.** Nothing is sent anywhere | The station's main local output (the room) |
| Settings → Audio → **Cue / headphone output** | Browser storage `ether_cue_device` | **No.** Used only by the Track Editor's own browser preview | Cue / PFL headphones |
| Settings → Audio → **Phone hybrid input** | Browser storage `ether_phone_input` | **No, and by design.** It is an input for the Phone Desk's browser capture | Caller audio *into* the Phone Desk (record / headphone monitor) |
| Board → Station Monitors → **OUTPUT** | Yes (`station_config_kv.audio_output_device`, this computer only) | **Yes** | The station's local monitor mix (the programme after MONITOR and the station strip). Never the air/stream |
| Settings → Audio → **PFL (pre-fader listen)** device (not in the ask, but it is the real cue picker) | Yes (`pfl_cue_device`, this computer only) | **Yes** | PFL cue only |

## 1. "Where music plays": not wired

- `src/components/SettingsPanel.tsx:2469`: `const [currentOutput, setCurrentOutput] = useState("")`.
- `SettingsPanel.tsx:3133`: clicking a device calls `setCurrentOutput(d.deviceId)` and nothing else. No IPC call, no
  save, no engine command. `setCurrentOutput` has no other caller.
- `ACTIVE` (`:3141`) means "the button you clicked", not "where the engine plays". It starts empty each time Settings
  opens, so it shows only after a click and should be gone the next time Settings opens (UNVERIFIED on screen).
- The list comes from Chromium's `enumerateDevices()`: browser device ids, not the device names the engine uses.
  Even if a click were sent on, it would not be in the form the engine accepts.
- An older component, `src/components/AudioDevices.tsx`, has the same "Where music plays" wording. It is imported in
  App.tsx:107 but never rendered.

**So on OV:** clicking Voicemeeter Input there changed nothing in the engine. The engine plays wherever Station
Monitors → OUTPUT says (or the Windows default device if that is "System Default").

## 2. Station Monitors → OUTPUT: wired

Screen → engine:
- `src/components/StationMonitorMixer.tsx:140-146` `setDevice`.
- → `ether.audio.setOutputDevice(sid, name)` (`electron/preload.js:97`).
- → `ipcMain "audio:setOutputDevice"` (`electron/main.js:7074`).
- → `_boardSend("setOutputDevice")`.
- → daemon `audiod/ether-audiod.js:632`.
- → native `audio_set_output_device` (`native/src/lib.rs:986`).
- → `AudioCmd::SwitchDevice` (`native/src/audio.rs:3510`). This drops the station's output stream and reopens it on
  the chosen device.

Saving and re-applying:
- The choice is saved machine-local as `station_config_kv.audio_output_device` (`station_config_kv:set-local`).
- The daemon re-applies it on every connect (`audiod/board-state.js:226, 270`).
- The device list here is the engine's own (`audio:listOutputDevices` → cpal device names), so the names match what
  the engine opens.

What it carries:
- The station's local output: the programme after the master MONITOR fader and that station's strip
  (`audio.rs:1837`, the local-output stage).
- MONITOR at 0, or the station strip at 0 / MUTE, makes this output exactly silent while air keeps going. So even when
  correctly routed to Voicemeeter, Voicemeeter hears nothing if MONITOR or the strip is down.
- Air (MASTER → stream / Icecast) never goes to a local device through this selector.

**A silent fallback, and it matters for this report.** `open_output_device` (`audio.rs:3831-3847`): when the named
device is not found, it opens the **Windows default device** instead (`found.or_else(default_dev)`), with no error to
the screen. So if OV's saved name no longer matches exactly (Voicemeeter's devices are renamed or re-enumerated after a
Voicemeeter update or restart), the engine plays to the Windows default and Voicemeeter gets nothing. The daemon log
line `[RUST] Station N device: <name>` shows which one it really opened. (The AUX and PFL outputs never fall back;
this main output does.)

## 3. "Cue / headphone output": not wired to the engine

- `SettingsPanel.tsx:2475-2476` saves the browser device id to `localStorage.ether_cue_device`.
- Its only reader is `src/components/TrackEditor.tsx:369-394`, which points the Track Editor's own Web Audio preview at
  it (`setSinkId`).
- The engine's PFL never reads it.

The engine's real cue device is a **different picker on the same page**: Preferences → Audio → "PFL (pre-fader
listen)" (`src/components/PflSettings.tsx`).
- Path: `audio:set-cue-device` (`main.js:7107`) → daemon `setCueDevice` (`ether-audiod.js:638`) → native
  `audio_set_cue_device` (`lib.rs:246`). It is saved machine-local as `pfl_cue_device` and re-applied on connect
  (`board-state.js:224, 263`).
- "" means PFL goes to the main local output (the programme there dips).
- A missing device means PFL is silent; it never falls back. The page shows the engine's own state (`cueWords`).

So the page has two cue pickers. Only the PFL one moves the engine's cue.

## 4. "Phone hybrid input": an input for the Phone Desk, not an engine route

- `SettingsPanel.tsx:2472-2473` saves a browser device id to `localStorage.ether_phone_input`.
- `src/components/PhoneDesk.tsx:466-482` reads it. It first calls `invoke("get_audio_devices")`, which has **no handler
  in main** (that call always fails), then falls back to `enumerateDevices()`, where the saved id matches.
- The Phone Desk captures with `getUserMedia({deviceId: exact})` (`:497`, `:580`) for its headphone monitor ("not on
  air") and for recording takes.
- It is not an output and does not go through the engine's mixer. It is correctly wired for what it does: choosing
  the input the Phone Desk records and monitors.

## The one check that settles OV

On OV, without changing anything:

1. Board → Station Monitors → the station's **OUTPUT**. What does it show?
2. In `%APPDATA%\Ether\logs\ether-audiod.log`, the latest `[RUST] Station <n> device:` line for that station. This is
   the device the engine actually opened.
3. The master **MONITOR** fader and that station's strip level / MUTE.

If the log line names something other than Voicemeeter Input, the engine is not sending there. The usual causes are
"System Default" in OUTPUT, or a saved name that no longer matches and so fell back to the default. If it does name
Voicemeeter Input and Voicemeeter still hears nothing, look at MONITOR / the strip next.

## Not changed

No code. Fixes to propose when asked:
- Wire or remove "Where music plays".
- Remove or merge the browser-only "Cue / headphone output" with the PFL picker.
- Make the main output's not-found fallback visible, or stop it.
- Remove the dead `get_audio_devices` call and `AudioDevices.tsx`.
