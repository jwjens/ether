# Source faders silent in the room after a fresh start: diagnosis and audit (2026-10-11)

**Jeff's report (verbatim):** "after a fresh start, all Source faders were silent in the room (meters moving). Moving
the AUX row did NOT fix it. Touching/adjusting the channel FADER itself made it work immediately."
**Rule (Jeff):** "a fader is never asleep. Whatever the board shows must be live in the engine from the moment Ether
opens, with no touch required."

Read-only. Machine OVEVENTS, build v4.6.59 CI draft (engine `6d843289…`), station 2. No code changed.

## 1. What the engine lacked at startup: receipts

A passive listener read the engine's own `levels` frames: it sends nothing, and the `levels` frame reports the callback's
published params (`audio.rs:3120–3136`).

**20:36:28–34 (sweeper on Source E, before any touch):**
- E is playing at a peak of 0.65, `vol=1 muted=false duck=true aux_routed=true`.
- `master_air` follows E (0.27 → 0.65), so **E is on air and in the stream**.
- `duck_gain` is **0.02**, so the music was ducked about −34 dB in the room and on air.
- `aux_peak` = **0** throughout.
- The AUX device is open: `aux_open:true`, `aux_state:"open"`, frames rising, 0 stalls, "Speakers (2- Realtek(R) Audio)".
- MONITOR: `master_monitor` 0.464 × strip `mon_vol` 0.73 = 0.34.

`aux_peak` is measured on `aux_l` **before** MONITOR (`audio.rs:4783–4787`), and `aux_l = Σ lv × aux_monitor_gain[slot]`
(`:4237`). E's `lv` peaked at 0.65 while `aux_peak` stayed at 0. So **the callback's AUX row for E was 0**. Every other
factor was right.

**20:39:38 (after Jeff's touches):** D, F and S1 playing, `aux_peak` 0.07–0.13. The room path is live.

**What a fader touch delivers.** `setVolume` → native `SetVolume` → `ctl.params_changed()` (`audio.rs:2962–2966`)
publishes the **whole** control-side `Params` block. The callback copies every field, including `aux_monitor_gain`
(`apply_params`, `:1042–1055`). So a touch re-publishes every value the control thread holds.

**Not yet proven:** why moving the AUX row did not do the same. `SetAuxMonitor` also ends in `params_changed()`
(`:3040`), so at the engine both should publish the same block. The engine cannot report its AUX rows (there is no read
command), and the daemon does not log setters. The read commands in §4 are what settle it on the next fresh start.
Nothing else does.

## 2. Two defects found on the way (receipts)

**A. The saved fader levels are never restored at start.**
- The design of record (`docs/dsp-show-presets.md` ruling 2, §253, §323) is that `board_levels` is applied by the
  daemon's show blade at engine start (`ShowBlade.boot()`, `audiod/show-presets.js:274`).
- `boot()` runs only from the daemon's `init` command (`ether-audiod.js:401`), and **nothing sends `init`**.
- There are zero `[show sN] faders restored` lines in either daemon log (2026-10-06 → now).
- Saved station 2 `board_levels`: E **0.153**, B **0.0013**, C **0**, D 1, S2 0. After the 20:21 restart the engine ran
  B, C and E at **1.00** (`[mix s2]` lines). Before it they were `B 0.00 C 0.00 E 0.15` (19:05).

**B. Every "re-apply after start" in the renderer runs once per mount and swallows failure.**
- `AuxMonitorSlots.tsx:184–191`: each AUX row is asserted once and marked applied. A failed send is caught and dropped
  (`:90`), and never retried.
- `MasterOutput.tsx:650–655`: the MONITOR level is "primed" once. The send is in a `try { } catch { }` (`:645`).
- The MONITOR level is saved **only in renderer localStorage** (`ether_monitor_vol`), so main cannot read it from
  the database at all.
- At this launch the window loaded at **20:21:31.716**, and the app connected to the engine at **20:21:32.064**.
- In the local-build session the order was reversed: the engine at 19:28:58.122, the window at 19:28:58.596.

## 3. Audit: every engine setting, its boot default, where it is saved, and whether it is restored on connect today

| Setting (native command) | Engine boot default | Saved | Who sends it today | Restored on every connect? |
|---|---|---|---|---|
| Fader level, every slot (`SetVolume`) | 1.0 (`audio.rs:89`) | kv `board_levels` (main, debounced) | panels on a drag; show blade `boot()` (never runs) | **No** (defect A) |
| Master fader (`SetMasterVolume`) | 1.0 | `board_levels.master` | MasterOutput on a drag; `boot()` | **No** |
| Channel ON / cut (`SetMuted`) | not muted | `deck_configs.channel_on` | renderer on mount (`FaderSection`) | **No**: renderer mount only |
| Slot kind (`SetSlotKind`) | per slot (`default_kind_for`) | `deck_configs.kind` | renderer | **No**: not verified that anything sends it on connect |
| Duck on / duckable (`SetDuck`/`SetDuckable`) | off / duckable | `deck_configs.duck` / `duckable` | main `armAllStationDuckers` on connect | **Yes** |
| Duck parameters (`SetDuckParams`) | −28 dB, −45 dBFS, 30/700/500 ms | kv `duck_*` | main at boot / `armAllStationDuckers` | Yes (not re-verified line by line) |
| Station strip MONITOR (`SetMonitorVolume`) | 1.0 | kv `monitor_volume` | `StationMonitorMixer` (renderer) | **No** |
| Master MONITOR (`SetMasterMonitorVolume`) | 1.0 | **localStorage only** | MasterOutput, once per mount, swallowed | **No**, and main cannot |
| AUX row per Source slot (`SetAuxMonitor`) | **0.0** (`:935`) | kv `aux_monitor_levels` | `AuxMonitorSlots`, once per mount, swallowed | **No** |
| AUX device (`SetAuxDevice`) | none | kv `aux_monitor_device` (machine-local) | `AuxMonitorSlots` on mount; opened at automationStart | Partly |
| PFL on (`SetPfl`) | off | not saved (momentary) | — | n/a |
| PFL dim, cue device (`SetPflDim`, `SetCueDevice`) | default / none | kv `pfl_dim_db`, `pfl_cue_device` | daemon reconciler (`engine.js` poll) | **Only while a playout engine runs** |
| Processing, master rack, GEQ (`SetProcessing`, `SetMasterRack`, `SetEq`) | off / flat | kv | daemon reconciler | **Only while a playout engine runs** |
| Channel racks (`SetChannelRack`) | empty | kv `rack_ch_<slot>` | daemon reconciler | **Only while a playout engine runs** |
| Mic inputs (`SetMicInput`) | none | kv `mic_input_<slot>` (local) | daemon reconciler | **Only while a playout engine runs** |
| Link input / send (`SetLinkInput`/`SetLinkSend`) | none | kv | daemon | not verified |
| Output device (`SwitchDevice`) | system default | station setting | at automationStart (`SwitchDevice` lines) | Partly |
| Show presets (`ApplyShow`) | — | `show_current`, `show_pending` | blade `boot()` | **No** (defect A) |

"Daemon reconciler" means `_apply*FromKv` in `DaemonEngine.poll()` (`engine.js:635–640`). That poll runs only after a
station's playout engine starts (`pollTimer`, `:536`).

## 4. The design question for Jeff (not built)

The spec asks for **main** to push the full saved board state on every engine connect. The design of record
(`dsp-show-presets.md`, ruling 2) puts the fader restore in the **daemon at engine start**, and the daemon already
reconciles racks, processing, mic and PFL from the database on its own. Building the spec as written moves that
responsibility.

**Recommendation:** one applier in main, `applySavedBoardState(stationId)`.
- It runs on every connect (first start, restart, reconnect) and at in-process boot, for every station.
- It covers every row above, because main has the database and is the only side present in both the daemon and the
  in-process fallback.
- The blade's `boot()` restore is retired in favour of it (and its unwired `init` trigger removed).
- The daemon reconcilers stay as the live-change path for edits from other machines. They write the same saved
  value, so they are idempotent.
- The master MONITOR level moves from localStorage into machine-local kv, so it can be applied.

Then:
- **Panels send changes only.** A failed send is queued per (station, setting, slot), logged, and flushed on connect
  after the saved state.
- **Read commands:** the engine reports the callback's applied value for every row.
- **Health:** a red `board-state-mismatch-error` after connect, naming each field whose live value differs from the
  saved one.
- **Tests:** a window-before-connect test, and a render test of a Source fader with saved settings after a late
  connect, with no touch.
