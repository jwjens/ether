# Session handoff — 2026-08-18/19

**Read this first. It is the bridge into a fresh session.** Written at context death; the session that
produced it is over.

---

## 1 · STATE

### Commit and version

| | |
|---|---|
| HEAD | `4aa9cc7` — *fix(jukebox): the board is the gate — channel ON/fader now govern the kiosk's audio (4.4.228)* |
| `package.json` | **4.4.228** |
| Installers built this session | `Ether Setup 4.4.226.exe`, `4.4.227.exe`, `4.4.228.exe` (all `--publish never`, in `dist-electron/`) |
| Tree vs HEAD | **ahead — substantial uncommitted work, see below** |

Committed since 4.4.226: `94f8283` (4.4.227, jukebox pool scoping fix) and `4aa9cc7` (4.4.228, board
gate). **Nothing after 4aa9cc7 is committed.**

### Uncommitted in the tree (all of it the aux-monitor arc)

```
 M audiod/engine.js                    procmeters frame carries aux:{...}
 M audiod/ether-audiod.js              jukebox:play/stop/state, setAuxMonitor, setAuxDevice
 M electron/main.js                    aux IPC, procmeters tagged with stationUuid, jukebox IPC
 M electron/preload.js                 audio.setAuxMonitor / setAuxDevice, ether.jukebox.*
 M native/src/audio.rs                 aux bus: ring, 2nd cpal stream, post-fader tap, processor, meters
 M native/src/lib.rs                   audio_set_aux_monitor / audio_set_aux_device, levels JSON fields
 M native/ether-audio.node             REBUILT AND INSTALLED
 M src/components/ConsoleStrip.tsx     D/E/F read decks[].peak instead of master, ungated
 M src/components/HealthMonitor.tsx    Audio Processing panel un-hidden + deck row
 M src/components/Jukebox.tsx          now-playing + shuffle look-ahead
 M src/components/MasterOutput.tsx     mounts AuxMonitorSlots
 M src/components/SettingsPanel.tsx    imports the shared ProcessingTrio (de-dup)
 M src/components/health/HealthMeters.tsx   procmeters subscription station-scoped
?? src/components/AuxMonitorSlots.tsx  NEW — the three AUX slots + OUTPUT picker
?? src/components/ProcessingMeters.tsx NEW — Meter/RideMeter/ProcessingTrio, moved out of SettingsPanel
?? docs/aux-monitor-bus-design-2026-08-18.md
?? docs/aux-bus-clipping-fixes-2026-08-18.md
?? docs/aux-monitor-slots-2026-08-18.md
?? docs/mac-min-os-audit.md
```

Untracked scratch NOT part of this work and deliberately unstaged all session: `check-designation.js`,
`marked-for-deletion.json`, `temp-extract/`, `scripts/prove-filekey-filepath.js`,
`scripts/r2-orphan-report.js`, and four unrelated design docs.

### Gates at handoff — all green

`cargo build --release` clean · `npx tsc --noEmit` **0 errors** · `npm run build` clean ·
`node --check` on main/preload/daemon OK. Nothing half-edited.

### Addon backups (in `native/`)

`ether-audio.node.bak-pre-def-telemetry-20260818` · `.bak-pre-auxmonitor-20260818` ·
`.bak-pre-auxdevice-20260818` · `.bak-pre-postfader-20260818`
(A `.bak-pre-auxproc-20260818` was attempted while the app held the file and did not write.)

### This machine (OVEVENTS)

- Installed app: **4.4.228**. The **tree is ahead of it** — the entire aux bus is dev-only.
- `native/ether-audio.node` **is the new build**. The installed 4.4.228 does not contain it.
- **The addon cannot be swapped while the app runs** (file lock). Ask Jeff to close dev before any
  `cp` into `native/`.
- Re-key repair **applied** 2026-08-18: 186,160 rows re-pointed, orphans 0, 52 config rows restored,
  `integrity_check ok`, FK violations down 12. Rollback:
  `openair.db.bak-prerekeyrepair-20260818` beside the live DB.

### OV (the other machine) — as reported by Jeff, not verified from here

**4.4.226 installed, pending 0, boxes checked.** The CLEAR PENDING button shipped in 4.4.226, which is
what made clearing its 29,226-mutation backlog possible. Nothing since 226 has been installed there.

---

## 2 · THE LIVE THREAD — deck-A VU (UNRESOLVED, next action known)

**Symptom (Jeff's screen):** halloVeen (station 2) shows empty decks and an empty queue, yet deck A's
VU moves and audio is audible.

**Established from the daemon itself:**

```
station 1 (Open Format)  engine=off queue=0   deck D: status=playing  "Love On Top"   ← the jukebox
station 2 (halloVeen)    engine=off queue=0   deck A: status=ended    "The Wizard And I"
station 3, 4             nothing
```

- **The audible source is the jukebox on station 1, deck D.** All four stations open the SAME output
  device (`Speakers (2- Realtek(R) Audio)`, per `ether-audiod.log`), so it is heard whichever board is
  on screen. **halloVeen showing empty decks is honest.** The `s3`/`s4` LOG-READER rows in the activity
  feed belong to stations 3 and 4.
- The jukebox was deliberately **left playing** as a live signal source for this trace.

**Still unexplained: why station 2's deck A VU moves.** `ConsoleStrip` gates A/B/C on `isPlaying`, and
that deck is `ended`, so it should read 0.

**Next action — the probe is written and works:** `scratchpad/ask-daemon.js` connects to the daemon
pipe and prints per-station deck state, engine state, queue depth and sampled levels
(a/b/c/master/room/`decks[].peak`). **It needs the app running** — the pipe only exists then; it died
`ENOENT` when Jeff closed the app. (Scratchpad is session-temporary — recreate from this description if
gone.) Run it with halloVeen on screen and the jukebox playing on station 1, then read station 2's `a`:

- `a > 0` while deck A is `ended` → **Rust is reporting a level for an ended deck** — a third cause
  neither hypothesis covered;
- `a == 0` but the strip moves → **(b) crosstalk**: another station's frame is rendering on halloVeen's
  strip. `matchesStation` renders untagged frames by design ("never go dark"), so one unresolved id is
  enough. `_stationUuidById` (`electron/main.js:615`) is DB-backed and cached and all four stations have
  uuids, so this is the less likely of the two;
- `a == 0` and the gate is open → **(a) the renderer's deck mirror says "playing"** while the engine
  says `ended`.

Fix whichever it is. A VU that moves on a stopped deck is the same class of lie as the one that read 0
while deck D played (fixed this session in `ConsoleStrip`).

---

## 3 · OPEN ITEMS, ranked

1. **deck-A VU trace** — §2 above. A board lying about what is on air outranks everything else.
   → this doc.
2. **Aux crackle unverified by ear** — the shear and the clamp are gone and peaks are the limiter's job,
   but nobody has listened. The tone + artifact-counter harness was built and **removed at Jeff's
   instruction** as extra machinery. → `docs/aux-bus-clipping-fixes-2026-08-18.md` §6.
3. **Health Monitor meters test** — the "Audio Processing" panel now renders (it was hidden behind
   `{procOn && …}`) and shows "waiting for audio", which is honest while every engine is off. **Needs a
   station audibly playing on its own decks** to confirm the bars move, and the deck row to confirm the
   aux chain reports. → `docs/aux-monitor-bus-design-2026-08-18.md` §8.
4. **Kiosk queue blind** — now-playing + shuffle look-ahead were built; unverified on screen.
   → `docs/aux-monitor-bus-design-2026-08-18.md` §8.5.
5. **"Playout mode: In-process — daemon not answering"** shown while the daemon was demonstrably alive
   and answering on its pipe. A false statement about the running system. → this doc.
6. **4.4.229 build gate** — do NOT cut until: (a) deck-A VU resolved, (b) Jeff has heard the aux bus
   clean at a chosen device, (c) the Health Monitor meters seen moving, (d) full gates green, (e) a
   packaged smoke on the artifact. The native addon is in this build, so it reaches every station's
   audio path.
7. **Jukebox Phase 2** (public request page) — designed, not started, **no deploy without explicit GO**.
   → `docs/jukebox-rebuild-design-2026-08-17.md` §2.
8. **`queryScoped` sweep** — 5 real sites lack `skipScoping` on `FROM songs`: `App.tsx:3339`, `:4948`,
   `AutoCue.tsx:231`, `CueEditor.tsx:79`, `DeckConfigurator.tsx:360`. They throw rather than mis-filter.
   → `docs/jukebox-pool-mismatch-2026-08-18.md` §5 (that section was **corrected** — an earlier claim of
   ~10 sites was wrong).
9. **D/E/F metering gap — now closed in the tree** but only for `decks[].peak`; `audio_get_levels` still
   names only `a/b/c/cart/master`. → `docs/jukebox-deck-source-design-2026-08-17.md` §10.2.
10. **Orphaned engine process** — `ether-engine.exe` survived app close with no window and no tray icon,
    so an operator cannot see or quit it. Same family as the old "Ether cannot be closed" blocker.
    → `docs/rekey-repair-dryrun-2026-08-18.md` §7.1.
11. **118,555 pre-existing `generated_schedule → songs` FK violations** — unrelated to the re-key
    incident, never diagnosed. → `docs/rekey-repair-dryrun-2026-08-18.md` §7.7.
12. **macOS floor** — Electron 41 requires Monterey; Big Sur needs pinning Electron 39, which is global
    and would downgrade Windows too. Run the `plutil` check first. → `docs/mac-min-os-audit.md`.
13. **Native Monitors submenu has no Jukebox entry** while the ☰ drawer does — one-line parity fix.
    → `docs/native-menu-audit-2026-08-17.md` §5.

---

## 4 · THE RULINGS that govern this work

- **Slot = room, board = air. Two gates, two destinations.** An AUX slot decides where a deck is heard
  locally; the board decides what airs.
- **The AUX tap is POST-FADER, POST-CUT.** Fader down or channel off = that deck silent *everywhere*,
  monitor included. A slot never resurrects audio the board has killed.
- **No default device, ever.** Aux audio leaves only through a device the operator picked; no device =
  silence. `open_named_output_device` deliberately has no fallback.
- **The aux bus runs through the EXISTING Preferences processor** — same ride, same −1 dBTP limiter,
  same `Process local output` toggle and target. Not a clamp (a clamp is a clipper) and not a second
  implementation. The park's Disney dialogue is inaudible without the ride.
- **ONE scheduler.** The jukebox schedules nothing on the station; it owns a deck the station's
  scheduler structurally cannot see.
- **D/E/F isolation is structural, not a flag.** Station automation enumerates `["A","B","C"]` and never
  names D/E/F, so an aux deck is invisible to rotation by construction.
- **THE BOARD IS THE TRUTH.** Whatever fader is live is what streams. No suppression, no stealth — a
  jukebox play emits deck/playstart events and writes `play_log` like any deck play.

---

## 5 · STANDING RULES

- **Read `docs/README` order — this handoff first.** Read `docs/sync-systems-map.md` before touching
  anything sync-related.
- **Jeff's screen is ground truth.** His report defines the defect; a technical restatement may be added
  as diagnosis but never replaces it, and the fix is sized to the report. Twice this session his memory
  was right and my summary was wrong (the three meters were in Preferences; the panel was hidden, not
  missing).
- **Receipts, `file:line`.** A grep is a claim about the tree, never about the product. A claim about the
  running app needs a runtime receipt — a log line, a probe, or Jeff's word — otherwise mark it
  UNVERIFIED and name the one check that would settle it.
- **No bump, no build, no deploy, no commit without an explicit GO.** Local commits only; never push.
- **Dev needs a FULL restart after native or main-process changes**, and the addon cannot be replaced
  while the app is running — ask Jeff to close it rather than killing his session.
- **Verification runs FIRST in a new session** — re-establish state before changing anything. Several
  faults this session were only visible by asking the daemon rather than reading code.
- **Don't add instrumentation that duplicates what the product already has.** Counters and a test tone
  were built and removed for exactly this reason; the processing meters are the sanctioned observability.
