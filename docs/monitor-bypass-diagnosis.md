# Monitor bypass — announcements play out of the speakers with the MONITOR fader off

**Date:** 2026-10-07 · **Type:** READ-ONLY diagnosis. No code changed. Nothing on the air machines, the installed
Ether, its profile or its database was touched; this is the source tree (`C:\openair`) only.
**Report (Jeff, verbatim as relayed):** *announcements play out of the local speakers with the MONITOR fader off.*
**Rule (Jeff):** the MONITOR fader is the local master output. Every sound that reaches a local output device passes
through the monitor gain stage; nothing bypasses it. The board is the sole gate for air; the MONITOR fader is the sole
gate for local output.

**CONFIRMED (Jeff, 2026-10-07):** *"the bypass is local monitors, not air. In a meeting with MONITOR all the way down,
music and sweepers were silent, but a scheduled announcement played out of the monitors."* Music (Rotation) and
sweepers (Sweeper) ride the main output, which MONITOR scales; the announcement (Source) rode the AUX path, which it
doesn't. That is exactly §1.

**RULING (Jeff, 2026-10-07): root fix APPROVED (§5).**
- Every local output, **including AUX**, passes through the MONITOR gain stage.
- It is enforced so a new path cannot skip it, and covered by the render test.
- **The only exception: PFL to a dedicated cue device.**
- So the renderer auditions, UI clicks and Iris are **not** exempt; they must obey MONITOR too.
- Build on its own branch **after today's show** (nothing before 4 pm, 2026-10-07). Test in dev and with a local
  build; no version bump.

**Status of the mechanism below:** read straight from the code (receipts) and now confirmed by the operator's
observation. Which physical device the AUX output is on the air machine still matters for tonight's workaround (§3, §4).

---

## 1. Answer — how announcements reach the speakers without the MONITOR gain

1. **An announcement plays on a Source channel** (the channel patched to *Announcement*): `fireAnnouncement` loads and
   plays it on every `deck_configs` row with `type='source' AND kind='announcement'` (`electron/main.js`, fireAnnouncement
   step 1 and step 4).
2. **In the mixer, Source channels are kept OUT of the main speaker feed.** `is_aux = deck.kind == SlotKind::Source`
   (`native/src/audio.rs:3975`). Only non-Source channels add to the room sum `room_*` / `core_*` (`:4091-4103`). Source
   channels add only to air (`mix_*`, `:4089`) and to the **AUX tap** `aux_* += lv × aux_monitor_gain[slot]`
   (`:4110-4115`). `aux_monitor_gain` is the channel's **room row** in Master Output → AUX monitors.
   Slot kinds: 0–2 Rotation, 6 Sweeper, **everything else Source** (`:1554-1560`).
3. **The AUX sum goes to its own output device with no MONITOR gain.** The mixer pushes `aux_l/aux_r` into the AUX ring
   as-is (`:4666-4684`, "the aux sum's ONE destination"). The AUX device's output callback writes those samples straight
   to the device, again with no gain (`MonOut` stream callback, `:3559-3574`).
4. **The MONITOR fader is applied in exactly one place: the main device feed.** `mvol = bus.monitor_vol ×
   bus.master_monitor_vol` multiplies only the station's main output (`:4727-4757`). The on-screen MONITOR fader drives
   `master_monitor_vol` (`src/components/MasterOutput.tsx:634-645` → `audio:setMasterMonitorVolume`
   `electron/main.js:6265-6279` → daemon `setMasterMonitorVolume` `audiod/ether-audiod.js:561` → `:3059`).

So with MONITOR at 0 the main output is silent, but any Source channel with a room row above 0 still plays on the
**AUX monitor device**. If that device is the studio speakers (the same physical output as the main one, or the
speakers the operator thinks of as "local"), announcements are heard with the MONITOR fader down. **That is the bug.**

It is not announcement-specific: **every Source channel** takes the same path, including the jukebox, carts fired on
aux channels, a mic or Remote Link feed placed on a Source channel, and the new channels 7+.

---

## 2. Every path from a sound to a local output device

### 2a. Inside the audio engine (daemon + native mixer, `native/src/audio.rs`)

The engine opens exactly two kinds of output stream. The main station output is built at `:2680` by
`start_station_mixer` (`:2487`, the only live mixer, `native/src/lib.rs:44`). The `MonOut` own-device outputs are built
at `:3534` and used for the AUX monitor and the PFL cue (`:2555-2581`). The legacy `start_audio_thread` (`:1249`) has
**no callers**, and `audio_engine.rs` exports analysis only (peaks/loudness/devices, `lib.rs:1005-1035`), no
playback.

| Source | Channel kind | Path to a device | MONITOR fader applied? |
|---|---|---|---|
| Rotation decks A/B/C | Rotation (0–2) | `room_*` → room chain (EQ, master, LOCAL processor) → main device (`:4508-4574`, `:4727`) | **YES** |
| Sweepers / jingles on slot 6 | Sweeper | same as rotation (`:1557`, `:4091-4103`) | **YES** |
| **Announcements** | Source | AUX tap × room row → AUX ring → AUX device (`:4110-4115`, `:4666-4684`, `:3559-3574`) | **NO** ← the bug |
| Jukebox | Source (slot D by default) | same AUX path | **NO** |
| Carts on an aux channel | Source | same AUX path (the "punches through on an aux channel" design, `:1533-1536`) | **NO** |
| Mic (live input) | whatever channel it is installed on (`:3266`; `lib.rs:403`) | Source → AUX path; Rotation/Sweeper → main | **NO** on a Source channel |
| Remote Link input | whatever channel it is installed on (`lib.rs:433`) | as mic | **NO** on a Source channel |
| PFL, cue on the main output ("PFL over monitor") | any channel's PFL | cue sum added to the main feed **before** `mvol` (`:4710-4718`, then `:4727`) | **YES** |
| PFL, cue on its own cue device | any channel's PFL | cue ring → cue device (`:4697-4708`; `MonOut` `:3559-3574`) | **NO** (possible intentional exception, §5) |
| Ducker | not a source | gain on the music; no output of its own | n/a |

The stream (Icecast) never touches the monitor and is unaffected by everything in this table (`:4461-4493`, pushed
before any monitor stage).

### 2b. Outside the engine: renderer playback straight to the system default device (bypasses the engine entirely)

These play through Chromium (`new Audio()`, `<audio>`, or Web Audio `ctx.destination`) to Windows' default output, or
to a device chosen with `setSinkId`. **None of them can see the MONITOR fader.**

| What | Where | When it plays |
|---|---|---|
| Announcement **▶ Test** (audition) | `src/components/Announcements.tsx:918-926` (`new Audio(url).play()`) | Operator presses ▶ Test (labelled "does NOT go to air") |
| UI click | `src/lib/uiSound.ts:7-22`; used by `src/components/ConsoleStrip.tsx:406`, `:456` | Some board buttons (rack, Take) |
| Cue editor preview | `src/components/CueEditor.tsx:225` | Auditioning in the cue editor |
| Broadcast editor playback | `src/components/BroadcastEditor.tsx:854`, `:1070`, `:1247`, `:1299`, `:1349` | Editor playback |
| Reel splitter / region audition | `src/components/ReelSplitter.tsx:43`, `src/audio/regionAudition.ts` | Auditioning cuts |
| Studio / DAW editors | `StudioEditor.tsx`, `StudioPro.tsx`, `TrackEditor.tsx`, `TakeEditor.tsx`, `VoiceTracker.tsx`, `StudioSendBar.tsx` (all create an AudioContext) | Editing / auditioning |
| PhoneDesk monitor and playback | `src/components/PhoneDesk.tsx:503` (live input → speakers), `:706` | Operator turns PhoneDesk monitor on / plays a take |
| Show+ local monitor | `src/components/ShowPlus.tsx:1934-2001` (`setSinkId` to a chosen device, its own monitor volume) | Show+ open with monitoring |
| AI voice previews / TTS test | `src/components/AIVoiceSettings.tsx:142` (speechSynthesis), `:269`; `AIVoiceStudio.tsx:293` | Operator previews a voice |
| Captions | `src/components/Captions.tsx:61` | Processor connected to the destination to run; outputs silence (UNVERIFIED) |
| `MixerChannelStrip` (live input → speakers) | `src/components/MixerChannelStrip.tsx:56-57` | **Never mounted**: no importer anywhere (dead code) |

No main-process or watchdog playback exists (no ffplay, SoundPlayer, beep or play-sound anywhere in `electron/`,
`audiod/` or `watchdog/`). Iris lives outside this tree: UNVERIFIED here. By design it uses its own sound card
(memory: Iris "NEVER on-air, separate sound card").

---

## 3. The 30-second read-only check on the air machine (Jeff / operator — changes nothing)

1. Open **Master Output** (the panel with the MONITOR fader) and scroll to **AUX monitors**
   (`MasterOutput.tsx:905` → `AuxMonitorSlots`).
2. Read two things:
   - **the AUX output device** chosen at the top;
   - **the room level on the Announcement channel's row**.
3. If the device is the studio speakers (or the same device as Settings → audio output) and the Announcement row is
   above 0, §1 is confirmed as the path.

Alternative, no UI: the audio engine log `…\userData\logs\ether-audiod.log` (`electron/audio-daemon-client.js:127`) has
a line `[RUST] Station N AUX monitor device: <name> (…Hz …ch)` (`audio.rs:3693`).

---

## 4. Operator workaround for TONIGHT — no code change, no effect on air

**What it relies on (receipt):** the room row never enters the air mix. Air is `mix_* += lv` (`audio.rs:4089`); the
row multiplies only the AUX tap (`:4110-4115`). Setting a row to 0 changes **only** what the AUX device plays. It
cannot change what airs or what the stream carries. Air is still the board: fader and channel ON.

**Option A (recommended, narrowest):**
- In Master Output → AUX monitors, set the **Announcement channel's row to 0**.
- Announcements still air (stream/listeners) exactly as before; they stop playing on the AUX device.
- Do the same for any other Source channel that must be silent in the room (jukebox, cart channel).
- The setting is saved per channel (`aux_monitor_levels`, `AuxMonitorSlots.tsx:53`) and survives a restart.

**Option B (everything on the AUX device at once):** set the **AUX output device to "none"**. That closes the AUX
stream: no device, no sound (`AuxMonitorSlots.tsx:199-205`, a machine-local setting; engine `audio.rs:3506-3509`). Air is unaffected. It silences
*every* Source channel locally, including the jukebox's local feed.

**Caveats, read before choosing:**
- **If the AUX device is the park PA** (the AUX bus was built to carry the jukebox to the park speakers,
  `audio.rs:4608-4611`), zeroing the Announcement row or choosing "none" **also silences announcements / the jukebox
  in the park**. Do the §3 check first. If the AUX device is the park PA and the speakers in question are the studio
  ones, the path is different and this diagnosis must be re-run before acting.
- **A show preset "Take" restores room levels** (`AuxMonitorSlots.tsx:126`; Takes carry `roomLevel` per channel, e.g.
  `audiod/smoke-show-presets.js:40`). Firing a Take after the workaround can bring the row back. Re-check the row after
  any Take, or update the Take.
- **Not a workaround:** Windows volume on the AUX device. It works, but it is outside Ether and easy to forget. It is
  also identical to Option B if that device is shared with the main output.
- **Not affected by either option:** the ▶ Test button and the editor previews (§2b). They play on Windows' default
  output regardless. Avoid pressing ▶ Test with the room silent tonight.

---

## 5. Proposed fix at the root (NOT built — awaiting approval)

**One local-output bus.** Every sample that leaves the engine for a local device is produced by **one** final stage
that applies the MONITOR gain, so a device stream can only ever receive post-MONITOR audio:

```
  room chain (Rotation + Sweeper)  ─┐
  AUX sum (Source rows × level)    ─┼─► per-device sums ─► × MONITOR (station strip × master) ─► main / AUX / cue devices
  PFL cue (if not exempt, §5.3)    ─┘
```

1. **Engine (Rust).**
   - Introduce a `PostMonitor` sample type that only `apply_monitor(local_sum, mvol)` can construct.
   - The main device write, the AUX ring producer and the cue ring producer accept **only** `PostMonitor` buffers.
   - Raw `room_*/aux_*/cue_*` stay private to the mixer, so any new output path that skips the monitor stage does not
     compile. That is the "structurally impossible" part.
   - The AUX feed becomes `aux × MONITOR`. That is a deliberate change: today the AUX device ignores MONITOR.
2. **Renderer auditions.** Move local playback (▶ Test, editor previews, region audition, PhoneDesk/Show+ monitors, UI
   click) onto **one engine "audition" input** summed into the local bus before the MONITOR stage, so they obey it
   too. Interim, until each is moved: each audition multiplies its own gain by the current MONITOR level from one
   shared store. That is weaker (not structural), and the guard below lists those paths as known exceptions until
   each is moved.
3. **Exceptions — your call before I keep any:**
   - **PFL to a dedicated cue device** (headphones). On consoles, cue usually ignores the monitor level. Keep it
     independent, or gate it with MONITOR?
   - **The park PA, if it is the AUX device.** Under the rule, MONITOR down would also silence the park. Is the park
     PA "local output" (gated by MONITOR) or a separate destination with its own master?
   - **Iris** (own sound card by design) and **UI clicks**: gated or exempt?
4. **Automated tests that fail the build:**
   - **Engine, every source × every local output.** Extend the offline render harness (`native/src/offline_render.rs`,
     already renders `monitor` and `stream` and has aux options, `:74-343`) to output the AUX and cue feeds too.
     - For each slot kind (Rotation, Sweeper, Source; mic/link feed) and each local output (main, AUX, cue), play a
       tone with **MONITOR = 0** and assert every local output is **exactly silent**.
     - Assert the stream is **bit-identical** to MONITOR = 1, so the monitor provably never touches air.
     - Runs in `npm run test:rust` (already a gate).
   - **Renderer guard (static, CI).** A ratchet like the station-identity leak-guard:
     - It counts `new Audio(`, `<audio`, `ctx.destination` connections, `speechSynthesis.speak` and `setSinkId` in
       `src/`.
     - It fails on any new one outside the audition module; the baseline drops as paths move. A new local playback
       path cannot appear without passing review.
   - **Runtime sense (Health Monitor).** A per-device "post-monitor peak" meter beside the existing room/AUX peaks
     (`audio.rs:4648-4654`, `:4719-4724`). With MONITOR at 0, any device peak above silence raises a red health event
     "local output bypassing MONITOR". The bug becomes visible instead of reported.
5. **Blast radius:**
   - **The mixer's final stage**: every station, every local device. The stream is untouched by construction, and the
     test proves it bit-identically.
   - **Behaviour change**: MONITOR now also controls the AUX device (and the cue device, unless exempt).
   - **Renderer auditions**: they change which device they play on (the engine's local device instead of Windows'
     default) once moved.
   - **Needs**: a daemon reload (full close and reopen) and a packaged smoke on a non-air machine before anything
     ships.

**Nothing above is built.** Approved 2026-10-07 with one exception (PFL to a dedicated cue device). It will be built on
its own branch after the 2026-10-07 show.
