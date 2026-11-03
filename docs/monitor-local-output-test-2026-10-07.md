# MONITOR is the master of every local output — local build and how to test it

**Date:** 2026-10-07 · **Branch:** `fix/monitor-local-output` (from `release/build-fixes` `81438bb`) · **No version bump,
not pushed, not tagged.** Diagnosis and ruling: `docs/monitor-bypass-diagnosis.md`.

**What changed for the operator:** the MONITOR fader now controls **everything you hear locally**:
- the main speakers (as before);
- the **AUX monitor output** (announcements, jukebox and aux carts played locally). This one was the bug;
- every preview Ether plays itself: ▶ Test, editor auditions, PhoneDesk and Show+ monitoring, button clicks, voice
  previews.

MONITOR down = a silent room. **Air is unchanged.** The only thing that still plays with MONITOR down is **PFL sent to
its own cue/headphone device** (Preferences → PFL (pre-fader listen) → PFL output).

---

## The installer

- **File:** `C:\openair\dist-electron\Ether Setup 4.6.59.exe`
- **Built from:** `fix/monitor-local-output` `515698c`, 2026-10-07 11:41:16 PDT, **215,911,092 bytes**
- **sha256:** `e34a3d361f459cb460e0641474f9ff060ad7a1c40ce18fde5ab554824ccb8f0e`
- Packaged release gate PASS (twice). The packaged `ether-audio.node` is byte-identical to the one the Rust tests ran
  against.
- The other two local builds were renamed so they can't be confused with this one:
  - `Ether Setup 4.6.59 - release-build-fixes 81438bb.exe` (`fc8aab85…`, without this fix);
  - `Ether Setup 4.6.59 - ANNOUNCE-WIP 6f54afe - NOT FOR RELEASE.exe`.
- The filename says 4.6.59 only because package.json does. Identify it by the sha256.

---

## Test steps — a machine that is NOT on air

Unsigned local build: SmartScreen → "More info → Run anyway". Install over an existing Ether, then **fully close and
reopen Ether** (the audio engine doesn't reload on an update otherwise).

**Setup:**
- A station with automation playing music.
- An **Announcement** source channel on the board (press **+** → Announcement, fader up, channel ON).
- One announcement you can fire with **▶ AIR**.
- In **Master Out → AUX monitors**, choose an **OUTPUT** device you can hear (ideally the same speakers as the main
  output, which is how the bug was heard), and set the Announcement row's **MONITOR** level up.

| # | Test | Do this | Expect |
|---|---|---|---|
| 1 | **The bug, fixed** | MONITOR all the way down. Press ▶ AIR on the announcement | **Silence in the room.** Music, sweepers and the announcement are all silent locally. The announcement **still airs**: listen on the stream (`listen.ether-technologies.com` or any player on the station's mount) and it's there at full level |
| 2 | **MONITOR scales the AUX output** | MONITOR to about half, fire ▶ AIR again | The announcement plays in the room at the reduced level, in step with the music |
| 3 | **Air unchanged** | While doing 1–2, watch the **PGM / STREAM** meters in Master Out | They don't move with MONITOR. Only the MONITOR meter does |
| 4 | **▶ Test obeys MONITOR** | MONITOR down, press **▶ Test** on an announcement (Announcements panel) | Silent. MONITOR up: it plays |
| 5 | **Editor previews obey MONITOR** | MONITOR down, audition something in the Cue editor (or any editor's play) | Silent. Move MONITOR up **while it plays**: it comes up live |
| 6 | **UI click obeys MONITOR** | MONITOR down, click a board button that ticks (a channel's rack button) | No tick |
| 7 | **The one exception: PFL to a cue device** | Preferences → **PFL (pre-fader listen)** → **PFL output** → pick a headphone/second device. MONITOR down, press PFL on a playing channel | PFL **is heard** on that device; the room stays silent; air unchanged |
| 8 | **PFL without a cue device follows MONITOR** | PFL output back to **Same as main output**. MONITOR down, PFL on | Silent (PFL plays through the main output, which MONITOR scales) |
| 9 | **The bypass sense stays quiet** | After 1–8, open the Health Monitor timeline | **No** red "Monitor bypass error". It only appears if something makes sound with MONITOR at 0, which must not happen |
| 10 | **Normal operation** | MONITOR back up | Everything plays locally as before; automation, carts, jukebox and announcements are unaffected on air |

**Report anything that makes sound with MONITOR at 0** (other than PFL to a chosen cue device). It is a defect, and
the Health Monitor should show it red.

---

## Proof already run (on this machine, before the build)

- **The render test, every channel kind** (Rotation A, Sweeper 6, Source D = announcement/jukebox/aux cart, Source 7):
  - MONITOR 0 (and the station strip at 0): the main device and AUX are exactly silent.
  - The **air stream is bit-identical** to MONITOR 1.
  - AUX × 0.5 is exact.
  - At MONITOR 1 every path is producing sound (the test is live).
  - PFL to a cue device is the only output still sounding at MONITOR 0.
- **The test catches the bug:** with the AUX gain ignored (the old behaviour) it fails on "Source D: the AUX device made
  sound with MONITOR at 0 — the monitor bypass".
- **Air unchanged against the pre-fix engine:** the existing goldens (WAVs captured on the old code) still match:
  43/43 renders bit-exact on the monitor and stream taps through three independent paths. The room-chain and AUX
  single-pass goldens are unchanged.
- **Renderer guard:** passes on this branch; the same check flags 21 playback sites in 6 files of the pre-fix code.
  Mandatory in CI.
- **Gates:** see the report.
