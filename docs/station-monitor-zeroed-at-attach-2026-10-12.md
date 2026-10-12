# Station fader up but silent on launch (2026-10-12)

## Jeff's report (verbatim)

"it just happend first thing when i opened ether the halloween fader was up i had to nudge it for audio to play."

## Not a stale install

The installed build is the new one:
- The engine on disk is `7598aef6be66488d5120688d8a4f67bbdb582965a87999227908a4925225658c`.
- Every Ether and ether-engine process started between 13:25:39 and 13:26:00 local.

Reinstalling would not change anything.

## Runtime receipts

**Daemon log** (`%APPDATA%\Ether\logs\ether-audiod.log`, UTC):

```
20:26:05.828Z [board s2] saved board applied (app connect): 43 setting(s)
20:26:06.325Z [engine s2] adopt: deck snapshot re-emitted (A/B/C) + automation state for a (re)attaching renderer
20:26:06.334Z [board s2] setMonitorVolume=0 → true
...
20:28:01.253Z [board s2] setMonitorVolume=0.195884467350599 → true    <- Jeff's nudge
```

**Rotation log** (`profiles\ETH-STN-BAA8-E056-6FC8\logs\rotation.log`):

```
[2026-10-12 20:26:06.344] [ROT] monitor asserted to 0.00 at attach (station 2) — SILENT by default
```

Stations 1, 3 and 4 got the same zero. Station 1 got it at 20:26:06; stations 3 and 4 got it at 20:27:11, when they attached.

**It also happened on 2026-10-11 at 20:21–20:22**, the same four stations zeroed the same way. So it isn't new in 7e218ca/77c5e85: an older behaviour the board-restore work never removed.

## Cause

`src/audio/engine-rodio.ts:579` `assertMonitorSilence()` (D2, 2026-08-03) writes station MONITOR = 0 when the renderer attaches. It does this unless the operator raised the fader in this same renderer session.

It was written when nothing restored the board, and the Rust default was a unity monitor. The daemon now restores the saved board itself:
- It restores it at engine start and again at app connect, and the station MONITOR level is part of that board.
- The master MONITOR is silent until it is known (277e750).

So the attach-time zero lands about 0.5 s **after** the restore and overwrites the saved level. The fader keeps showing the saved value from the store, because nothing told the UI. Result: the fader is up and the station is silent until it's touched.

**The connect pass did catch it, late.** The startup log shows the second pass (handover) at 20:26:11.876Z reporting `s2 LIVE ≠ SAVED: monitorVol saved 0.68 live 0`. `health-events.jsonl` has a red `board-state-mismatch-error` for station 2 at 20:26:11.879Z, about 5.5 s after the zero. The first pass (20:26:05.8) ran before the zero and matched. Stations 1, 3 and 4 had a saved station MONITOR of 0, so the zero changed nothing there. Jeff's ruling still stands: one check per connect is too coarse. A write landing between passes is only seen at the next connect.

## Jeff's ruling (2026-10-12, verbatim)

> Approved: remove the "monitor asserted to 0.00 at attach" zero (src/audio/engine-rodio.ts:579). Opening the app leaves every station at the level the engine restored.
> 1. Audit every place the window/renderer writes ANY engine value on startup, attach, mount, or reconnect without the operator touching a control (zeroes, defaults, "asserts", primes). List each with file:line. Rule: the window never writes a board value it didn't get from the operator; the engine's restored state is the truth. Remove every such write, or convert it to a read.
> 2. The board-state mismatch check missed this because it only compares at connect. Make it continuous: compare saved vs live engine values on every change the engine reports (and a periodic check), and raise the red board-state-mismatch-error within a second of any divergence, naming the setting.
> 3. Test: simulate the exact sequence from today's log (engine restores, then the window attaches) and prove no station's level changes and no fader needs a nudge.
> 4. Rebuild the local installer, full Rust suite single-threaded, report sha256 and engine hash. Goldens still on hold.

## 1 · The audit: every write the window made without the operator

Line numbers are at the pre-fix commit (`ad3f958`). Every one is removed or converted to a read.

| # | Where (pre-fix) | What it wrote, and when | Now |
|---|---|---|---|
| 1 | `src/audio/engine-rodio.ts:285` → `:593` (`assertMonitorSilence`) | Station MONITOR = **0** on every first attach (today's bug), ~0.5 s after the engine restored it. | **Removed.** Attach writes nothing. |
| 2 | `src/audio/engine-rodio.ts:598` → `:620` (`reassertMaster`) | Re-sent this window's cached MASTER on re-attach. The cache could be stale against a Take, the remote or the other window. | **Removed**, with its cache (`operatorMasterLevel`). The engine restores MASTER. |
| 3 | `src/audio/engine-rodio.ts:384` (`attachDaemonEvents` → `pushSegueOverlap`) | Segue overlap at the window's **hard-coded 3 s** on every attach, before Preferences had loaded. On this box stations 1, 3 and 4 have **5 s** saved, so each launch overwrote them for up to 3 s, until the daemon's KV poll put 5 back. Seen in the control run below. | **Removed.** The daemon reads `segue_overlap_sec` itself (`audiod/engine.js _applySegueOverlapFromKv`). |
| 4 | `src/audio/engine-rodio.ts:544` (`startDaemonAutomation` → `pushSegueOverlap`) | The same cached value, on the AUTO press. The press is the operator's; the segue value was not. | **Removed.** |
| 5 | `src/App.tsx:1964` (segue load effect) | Re-sent the stored segue overlap to the engine whenever the active station or engine changed. | **Read only.** It updates the display; `App.tsx:1941` (the operator's slider) still sends. |
| 6 | `src/App.tsx:4036` (CART channel cut) | The jingles/CART ON/OFF from **this window's localStorage**, on every mount and station switch. No control writes that key any more (`toggleCartChannel` had no caller), so the engine was driven by a stale browser value. Today: `setMuted CART=true` for s2 at 20:27:16. | **Converted.** Saved with the station (`cart_channel_on`) and restored by the engine (`audiod/board-state.js`). The old local value is handed over **once** through `board:migrate-cart-cut`; a value already saved wins. If it is OFF, main asks the engine to re-apply the saved board. The window sends nothing. |
| 7 | `src/components/FaderSection.tsx:218` | The jukebox cut, on every mount. | **Read only.** The engine restores it from `jukebox_channel_on`. |
| 8 | `src/components/DuckerSection.tsx:133` | All five ducker parameters, every time the panel opened. | **Read only.** The engine restores them (same defaults). The drag and release paths are unchanged. |
| 9 | `src/components/AudioRoutingPanel.tsx:100` | **Every station's output device**, each time the routing picker mounted. That reopens the device stream, a possible gap on air. | **Removed.** The engine opens the saved device itself, and only when it is not already on it. Picking a station or device (operator) still sends. |
| 10 | `src/components/MasterOutput.tsx:673` + `src/components/BroadcastMonitor.tsx:385/418` | On a machine with no saved master MONITOR, the main panel sent a "legacy" localStorage level to the room. The pop-out wrote a **0.8 placeholder** into that same key on every mount. That is a path to playing the room at a placeholder, against the 2026-10-11 ruling. | **Removed.** Both MONITOR faders show the level main reports (`src/audio/localOutput.ts` `monitorLevel`/`onMonitorLevel`): the saved one, then every change. The pop-out no longer reads or writes localStorage. |
| 11 | `src/hooks/useMicMigration.ts:73` | On **every launch**, re-patched any unpatched mic slot from the old browser device in localStorage. A mic the operator deliberately unpatched came back. | **One time.** The old value is read once and deleted, whatever the outcome. |
| 12 | `src/components/AuxMonitorSlots.tsx:157,168` | Loaded every saved AUX row capped at **1.0** (rows go to +10 dB). The next move of *any* row saved the whole map, writing every hotter row back at 1.0. The operator never touched those rows. | **Read at the real level** (cap = `MAX_GAIN`). `StationMonitorMixer.tsx` display reads got the same fix (display only). |

**Checked and left alone (operator-driven, or not reached):**
- Channel faders: `MixerChannelStrip.tsx:244/369`, `FaderSection.tsx:301/334/449`, `DeckWidget.tsx:30`, `DeckConfigurator.tsx:812`.
- MIDI (`MidiEngine.tsx:208–211`) and the remote `set_volume` command (`App.tsx:1529`).
- The broadcast delay toggle (`App.tsx:797`), PFL (`FaderSection.tsx:81`, `PflSettings.tsx`) and the rack and channel-rack editors (`useMasterRack`, `useChannelRack`, which send on edit only).
- Processor bypass (`useProcessorParams.ts:97`), the mic patch editor (`useMicInputs.ts:83`), the station strip and its device (`StationMonitorMixer.tsx` `setMonitor`/`setDevice`), and the AUX rows and device (`AuxMonitorSlots` `setLevel`/`chooseDevice`).
- `PodcastMode.tsx useAutoDuck` ramps the decks, but **nothing calls it**.
- Main, not a window: `electron/main.js armAllStationDuckers` re-sends the saved duck routing and parameters at boot and on connect. It reads the same applier, so it never sends anything but the saved values. It is redundant with the daemon's restore; left in place.

## 2 · The continuous check

`electron/board-watch.js` is new; `electron/main.js` wires it in.

**What gets compared:**
- **On every change:**
  - every board setter main routes (`_boardSend`, which covers every fader, cut, AUX row, MONITOR, MASTER, device, ducker and smoothing);
  - every blade level event (`boardlevels`);
  - every Take (`showapplied`).
- **On a beat:** every station, every **500 ms**.
- **Saved** = the database, plus the `board_levels` main is about to write (written at most once a second). So a fader drag counts as saved the moment main holds it.

**When it fires:**
- A difference must **survive 300 ms** before it is an error, because an operator's strip sends and then saves.
- Worst case from divergence to the red `board-state-mismatch-error` is **≤ 800 ms**, naming each setting by its board name with saved and live values.
- One event per distinct set of differences. A later match gives one green `board-state-match`.
- The connect pass and the watch share one writer, so the same difference is never raised twice.

**What it ignores:**
- It is quiet while the connect pass re-applies the board.
- An engine that cannot answer is not reported as a mismatch (the connect pass reports that).
- It runs in daemon mode only, like the connect pass. The in-process fallback has no blade to save fader levels.

## 3 · Today's sequence, replayed

- **`scripts/smoke-attach-after-restore.js --control`** (`npm run test:attach-restore`): today's sequence end to end.
  - The **real daemon and native engine** run on a private pipe, against a throwaway DB holding halloVeen's board (station MONITOR 0.68, CART OFF, jukebox ON, segue 5 s).
  - The engine restores at its start, then main's `applySavedBoard "app connect"` runs.
  - Then the **real renderer engine** (`engine-rodio.ts`, bundled) runs its whole attach for two stations. Its bridge routes every setter to the daemon exactly as main does.
  - 1.5 s later, the live board is read back.
  - **Result:** the window wrote nothing; every value, control and applied, is unchanged; live = saved on both stations, so nothing needs a nudge. The CART cut is restored OFF by the engine.
  - **Control:** the same run with the pre-fix `engine-rodio.ts` from git HEAD shows the window writing `setMonitorVolume[1,0], setMonitorVolume[2,0]` and live ≠ saved: "station MONITOR strip: saved 0.68, live 0 (control); … (applied)". That is today's log, reproduced.
- **`src/audio/attach-restore-sequence.test.ts`** (vitest): the same sequence for all five stations of this box, against an engine model.
  - It proves the window wrote nothing, nothing changed, and live = saved.
  - The board watch then sees no difference.
  - A control case puts the old zero back, and the watch names `station MONITOR strip: saved 0.68, live 0` within 1 s.
  - Run against the pre-fix `engine-rodio.ts` it fails, listing five `setMonitorVolume([n,0])` and five `daemon:setSegueOverlap({seconds:3})` writes.
- **`electron/board-watch.test.js`** (7 tests):
  - an unannounced divergence is raised within 1 s, naming the setting;
  - a poke after a change raises it within ~0.4 s;
  - an operator change saved a moment later is not an error;
  - a drag main has not written yet is not an error;
  - each difference is raised once, and the match is said once;
  - an engine that cannot answer is not a mismatch;
  - nothing is said while paused.
- **`src/lib/noStartupBoardWrites.test.ts`** (8 tests): a source guard over the component mount effects this suite cannot render. A removed write coming back fails here.
- **`audiod/board-state.test.js`** (+4 tests): the CART cut is restored, applied and compared like any cut, and a CART board row of its own wins.
- `scripts/smoke-monitor-and-flicker.js` sections 1–2 were rewritten to the new rule (they asserted the old attach behaviour). Its section 4 (two trace markers) already failed at HEAD before this change; it is not in CI, and was left alone.

## 4 · Behaviour changes to know about

- **A station whose station MONITOR was never saved** now plays at the engine's own default for that strip, unity, times the master MONITOR. That is also what the strip shows (`StationMonitorMixer` reads an unsaved strip as 1). Before, the window zeroed it at attach while the strip showed 1. The room stays silent until the master MONITOR is known (277e750).
- **CART ON/OFF** now travels with the station (synced, like the jukebox cut) instead of living in one window's browser storage.
- **A machine updating from a build older than 2026-10-11, with MONITOR only in browser storage,** comes up with the room silent and MONITOR reading OFF until it is raised. It used to send the browser value, which the pop-out could have overwritten with its 0.8 placeholder. This follows the "silent until known" ruling. **OV is such a machine** if it updates straight from an older build.
- **The old browser mic pick** is handed over once per channel letter. If two stations both had an unpatched mic on the same letter, only the first station seen gets it; the other says "no input — Preferences → Audio".
