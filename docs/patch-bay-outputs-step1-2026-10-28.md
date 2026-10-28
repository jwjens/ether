# Patch Bay, outputs (step 1): what was built, and the proof (2026-10-28)

**Jeff (verbatim):** "Then start step 1, Patch Bay outputs, with my four Outputs answers, as its own commits with tests.
This computer is not on air, so compiling the engine here is fine. Stop when step 1 is done, show me what changed in plain
English, and wait for my go before step 2. Don't build an installer, push, or deploy."

Plan: `docs/ether-audio-patch-bay-plan.md`. Answers: `docs/outputs-section-plan-2026-10-27.md`.

Branch: `feat/patch-bay-outputs` (from `release/1019` at `1f63e41`). Local only. Not pushed. No installer built.

## Commits

| Commit | What |
|---|---|
| `ba05e69` | Engine: a missing Master device is never replaced by another one; the station runs on its own clock; channel pairs; up to 4 devices per output; reports what actually opened |
| `0dc28ca` | The saved patch per computer (`patch_outputs`), restored when the engine connects; the IPC behind the window |
| `e36c22e` | The Patch Bay window; the old Master, AUX and PFL device pickers become one-line pointers to it; help `docs/help-patch-bay.md` |
| `5b14a72` | Engine: two defects found by the runtime run (below), fixed |

## Jeff's four answers, and where each is met

1. **Master is the existing main/monitor output, after the MONITOR fader, one per station.** The Master row is the
   existing station output; no new output was added. The extra devices are fed from the same point as the Master device
   (post-MONITOR, after PFL-over-Master). Test: `a_second_master_device_gets_exactly_what_the_master_device_got`
   (bit-identical through the real mixer callback).
2. **Stall setting, unset = warn and keep retrying, never switch on its own.** `patch.rs` `master_open_plan`: the
   Windows default replaces a STALLING chosen device only when the setting is On. A MISSING device never switches to
   anything. Test: `stalls_switch_to_the_default_only_when_the_user_turned_it_on`. Shown on screen: "Not set / On / Off".
3. **AUX moves into Outputs.** The Aux row is in the Patch Bay. The AUX panel's device select is now a pointer line. The
   aux faders and levels are unchanged.
4. **Compile only off air.** Compiled on OVEVENTS, which Jeff says is not on air.

Plus:
- Any device, with channel pairs on devices with more than two channels.
- Saved per computer: `patch_` is machine-local, never synced.
- The screen shows the device the engine actually opened.
- A missing device is named in red, with no fallback.

## Runtime receipt: the real engine, built from this branch, on this computer's devices

`scratchpad/patchbay-probe.js` loaded the freshly built engine on its own: station 901, no database, nothing loaded, so
silence. It patched outputs and read back what the engine reports. Output, verbatim (second run, after `5b14a72`):

```
== 1. Master patched to a device that is not here
  master No Such Device (Patch Bay test) ch 1-2 → not_found
  soft_clock (station on its own clock): true
  mixer still running (liveness clock): {"a":1793171315363,"b":1793171316381,"advancing":true}
== 2. Master patched to a real device
  master Voicemeeter VAIO3 Input (VB-Audio Voicemeeter VAIO) ch 1-2 → open | opened "Voicemeeter VAIO3 Input (VB-Audio Voicemeeter VAIO)" ch 1-2, 2 ch @ 48000 Hz
  soft_clock (station on its own clock): false
== 3. Master to two devices, Aux to one, Cue to a missing device
  master Voicemeeter VAIO3 Input (VB-Audio Voicemeeter VAIO) ch 1-2 → open | opened "Voicemeeter VAIO3 Input (VB-Audio Voicemeeter VAIO)" ch 1-2, 2 ch @ 48000 Hz
  master Voicemeeter Input (VB-Audio Voicemeeter VAIO) ch 1-2 → open | opened "Voicemeeter Input (VB-Audio Voicemeeter VAIO)" ch 1-2, 2 ch @ 48000 Hz
  aux    Voicemeeter Input (VB-Audio Voicemeeter VAIO) ch 1-2 → open | opened "Voicemeeter Input (VB-Audio Voicemeeter VAIO)" ch 1-2, 2 ch @ 48000 Hz
  cue    No Such Device (Patch Bay test) ch 1-2 → not_found
== 4b. Master to channels 3-4 of "Voicemeeter VAIO3 Input (VB-Audio Voicemeeter VAIO)", which has 2 channels
  master Voicemeeter VAIO3 Input (VB-Audio Voicemeeter VAIO) ch 3-4 → failed
  soft_clock (station on its own clock): true
  mixer running: {"a":1793171327913,"b":1793171328915,"advancing":true}
== 5. Nothing patched (Master = Windows default, as before)
  master (nothing patched) ch 1-2 → open | opened "Voicemeeter VAIO3 Input (VB-Audio Voicemeeter VAIO)" ch 1-2, 2 ch @ 48000 Hz
```

Engine log, same run:

```
Station 901 Master output "No Such Device (Patch Bay test)" ch 1-2: device not found — NOT switching to another device; the station runs on its own clock (stream unaffected) and retries
Station 901 PFL cue "No Such Device (Patch Bay test)" ch 1-2: device not found — staying silent (will retry)
Station 901 Master (2nd device) output opened: "Voicemeeter Input (VB-Audio Voicemeeter VAIO)" ch 1-2 (48000Hz 2ch)
```

The first run found two defects, both fixed in `5b14a72`:
- An Aux row that was unpatched still reported the device it had opened.
- An impossible channel pair reopened, and logged, every 2 seconds.

## Tests

- **Engine:** 170 pass, 1 fails (`npm run test:rust` equivalent, release).
  - New: `patch::tests` (8) and `audio::patch_bay_tests` (3, through the real mixer callback).
  - The 11 parity tests pass **bit-exact** against goldens captured from `1f63e41` (before any step 1 code). With one
    device on channels 1-2, the Master output and the stream are unchanged.
  - The one failure, `aux_monitor_single_pass_regression`, failed before step 1 with the same checksum
    (`0xb8690f3e7ea3c65a`). Cause on record: `docs/golden-review-4.6.59-2026-10-13.md`.
- **App:** `npx vitest run` 1162 / 1162. `npm run test:sync` 75 / 75. `tsc --noEmit` 0 errors. `test:preload-bridge` PASS.
  - One run had `electron/profile-move.test.js` fail under load. It passed alone twice and in the next full run.

## Goldens: a mistake, undone

I re-captured the parity goldens (`ETHER_GOLDEN_RECAPTURE=1`) to have a pre-change baseline. The record says goldens are
re-captured "only on Jeff's say-so" (`docs/golden-review-4.6.59-2026-10-13.md`), so that was not mine to do.

- The capture was used only as a local yardstick, and the committed `native/goldens/manifest.json` is restored.
- The WAV files on disk (gitignored) are now the `1f63e41` renders, so the four parity tests that failed before step 1
  fail again against the restored manifest, for the same reason as before.
- Re-baselining (and setting `GOLDEN_AUX_SINGLE_PASS` to `0xb8690f3e7ea3c65a`) is the documented procedure, and waits for
  Jeff.

## UNVERIFIED

- **The Patch Bay window on screen.** It is built and typechecked, but the app has not been launched with this engine.
  The check: run Ether from this branch with the new engine, open Menu → Patch Bay, and click a crosspoint.
- **Channel pairs above 1-2 on real hardware.** No device on OVEVENTS has more than 2 channels (all ten listed are
  2-channel). Proven only through the mixer test (`master_on_channels_3_4_of_an_8_channel_device…`).
- **The stall switch to the Windows default on a real stall.** The decision is unit-tested; no real stall was produced.
- **Two stations both patched to the same device and pair.** Windows mixes them; not tested.

## Not done, and why

- **No ☰ (hamburger) entry.** `src/modules/proof/noNewPage.test.ts` freezes the ☰ list ("NO new hard-coded page.
  Ever."). The Patch Bay replaces the existing Audio Routing window under its key (`multioutput`), so no page was added.
  Its doors are Menu → Patch Bay, and a Patch Bay button where each old picker was. Adding a ☰ entry means adding to the
  frozen list, which is Jeff's call.
- Inputs: step 2.
