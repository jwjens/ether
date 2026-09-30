# Mac install: no audio engine, 725 OUTSIDE (2026-09-30)

**Jeff's report (verbatim):** the installed Mac app shows **"725 OUTSIDE"** on the board and **"show presets
need the audio engine service — fully close and reopen Ether"** — three restarts, same.

Machine: Jeff's Mac (Apple Silicon, arm64, Darwin 25.6.0). Installed build: **4.6.52**, run straight from the
mounted DMG (`/Volumes/Ether 4.6.52`, translocated, read-only) — never copied to /Applications.
Investigation was read-only; every DB read used `?mode=ro`.

---

## 1. No audio engine service

### Cause
The daemon loads the native engine from `path.join(__dirname, "..", "native", "ether-audio.node")`
(`audiod/ether-audiod.js:140`) = `Contents/Resources/app.asar.unpacked/native/ether-audio.node`.
**That file is not in the package.** The only copy is `Contents/Resources/native/ether-audio.node`
(the `extraResources` copy). The `app.asar` header has no `native` entry either, so the main process's
in-process fallback (`electron/main.js:387`, `require("../native/ether-audio.node")`) misses too.

And the one copy that is there **cannot load in this app anyway**:

| file | architecture |
|---|---|
| `Contents/MacOS/Ether` (the DMG Jeff ran) | **x86_64** (runs under Rosetta) |
| `Contents/Resources/native/ether-audio.node` | **arm64** |
| repo `native/ether-audio.node` (tracked) | PE32+ x86-64 Windows DLL |

CI (`.github/workflows/build.yml`) builds the engine once on `macos-latest` (arm64), copies it with
`cp … || true` (a missing engine is swallowed), then `electron-builder --mac` packages **both** x64 and
arm64 DMGs from that one arm64 binary.

### Receipts
- `~/Library/Application Support/Ether/logs/ether-audiod.log`, every spawn:
  `Error: Cannot find module '…/Ether.app/Contents/Resources/app.asar.unpacked/native/ether-audio.node' … code: 'MODULE_NOT_FOUND'`
- `ether-startup.log`, session 2026-09-30T14:24:39Z (v4.6.52, packaged):
  - `[audiod-client] spawned daemon (detached) pid 28309 … [attempt 2/5]` … `[attempt 5/5]`
  - `daemon unreachable after 5 spawns — STOP spawning (no PID storm), KEEP probing`
  - `[ENGINE] station 1: daemon never attached after 122s — staying in-process` (station 2 same)
  - then `post-spawn connect failed — scheduling reconnect` every ~8 s.
- `file`: app binary `Mach-O 64-bit executable x86_64`; engine `Mach-O 64-bit … arm64`.
- `ps`: no `ether-audiod` process.

### UNVERIFIED
The in-process fallback most likely fell to the silent JS stub (`electron/main.js:388-409`): the
`[AUDIO] Failed to load native addon` line is not in `ether-startup.log`. Check: launch with console
captured, or read the Health Monitor's engine line.

---

## 2. 725 OUTSIDE

### What OUTSIDE counts
A row in an audio table whose stored `file_path` is **not inside this machine's catalogue**, whether or not
the file plays (`electron/library-health.js:164`; label `src/components/HealthMonitor.tsx:2177`). Tables:
songs, announcements, spots, cart_slots, library_asset, published_episodes, voice_tracks
(`electron/audio-library-index.js:119-125`).

### What the rows are
Profile `~/Library/Application Support/Ether/profiles/ETH-STN-BAA8-E056-6FC8/openair.db`. Catalogue on this Mac:
`/Users/admin/Music/ether music library` (from `music-dir.txt`). It exists — 646 entries.

**Every outside row is a Windows path from Jeff's PC.** No Mac paths among them.

| table | outside | same filename present on this Mac |
|---|---|---|
| songs | 331 | 314 |
| library_asset | 407 | 404 |
| announcements | 5 | 5 |
| spots | 6 | 6 |
| cart_slots | 12 | 12 |

By folder: 706 under `C:\Users\jensj\AppData\Local\Ether\catalogue\`, 32 under
`C:\Users\jensj\Music\ether music library\`. Example: `C:\Users\jensj\AppData\Local\Ether\catalogue\ABC.mp3`.
Raw total across tables is 761; the board's 725 is the station-scoped figure (the ledger shows 705 for
station 1, Open Format). The exact 761 → 725 reconciliation was not done.

### The audio already came down
The cloud restore ran 2026-09-25 (`restore-failures.log`: "restored DB — 560 songs"); 543 files landed that
day. Only ~20 rows have no file of that name here (17 songs, 3 library assets). **More downloading does
not clear OUTSIDE** — the stored paths are still Windows paths, and the relink cannot match them on macOS.

### Why it cannot relink on a Mac — `path.basename` does not split on `\` on POSIX
`findInIndex` (`electron/audio-library-index.js:85`) and the materializer (`electron/library-health.js`,
~line 872) take the name with `path.basename(storedPath)`. On macOS that returns the **whole Windows path**.

Receipts:
- **92 files in the catalogue folder are literally named** `C:\Users\jensj\AppData\Local\Ether\catalogue\<song>.mp3`,
  all written 2026-09-26 18:31 — the materializer writing a download under the unsplit "basename".
- Health ledger (`health-events.jsonl`, 14:44Z) for Open Format: `resolvesElsewhere: 2, r2Only: 161` —
  while the files with those names sit in the catalogue.
- Re-sync reads the same lookup (comment, `audio-library-index.js:94-96`), so it misses the same way
  (UNVERIFIED at runtime — settled by running Re-sync once).

---

## 3. The v4.6.52 arm64 DMG crashes on launch ("Ether quit unexpectedly")

### Cause
The arm64 DMG is built right: app binary, Electron Framework and engine are all arm64. dyld kills it
before any Ether code runs.

- Crash report `~/Library/Logs/DiagnosticReports/Ether-2026-09-30-083127.ips`, `termination.namespace: DYLD`,
  "Library missing": `Library not loaded: @rpath/Electron Framework.framework/Electron Framework … code
  signature … not valid for use in process: mapping process and mapped file (non-platform) have different
  Team IDs`.
- `codesign -dv`: app and Electron Framework both `Signature=adhoc`, `TeamIdentifier=not set`,
  `flags=0x10002(adhoc,runtime)`. `spctl -a`: rejected.
- `electron-builder.json` had `mac.hardenedRuntime: true`, and CI has no Apple identity, so electron-builder
  falls back to ad-hoc signing. Under Hardened Runtime, library validation requires every loaded library to
  share the app's Team ID. Ad-hoc signatures have none, so the framework is refused.
- The x64 DMG launched, likely because electron-builder leaves x64 unsigned without an identity, so
  Hardened Runtime never applied (UNVERIFIED).

### Fix (Jeff's ruling, option a)
`mac.hardenedRuntime: false` while Mac builds are unsigned. **It returns — `true`, with a Developer ID and
notarization — when Apple signing exists.** (The note lives here and in the commit: `electron-builder.json`
cannot carry a comment, `481d689`.)

---

## 4. The audio callback allocated on macOS — fixed

**Jeff's ruling (verbatim):** *"the "audio callback allocated" failures on macOS are not to be skipped — find
what allocates on the Mac callback and fix it before packaging; the RT rule holds on every platform."*

### Cause
On macOS, `std::sync::Mutex` is a pthread mutex that std allocates **lazily** (a `OnceBox`) on the first
`lock`/`try_lock`. `mixer_callback` `try_lock`s seven mutexes, so each one's first touch allocated **on the
audio thread**. That covers every station's first buffers on a Mac, the live callback included (`audio.rs:2490`
is the live bus). Windows (SRWLOCK) and Linux (futex) never allocate, which is why only the Mac failed.

Receipt: the allocation trap (`rt.rs`), temporarily patched to print a backtrace per counted allocation
(local diagnostic, not committed). **All 104** counted allocations across the three failing tests were this
one mechanism:

| mutex (`try_lock` site) | count |
|---|---|
| `ProgramProcessor` (`audio.rs:4196`, `:4334`, `:4418`) | 62 |
| `EqChain` (`audio.rs:4106`, `:4315`) | 40 |
| `BusState` (`audio.rs:3637`) | 2 |

Frame: `Mutex<…>::try_lock → pthread::Mutex::get → OnceBox::initialize → Box::new`.

### Fix
`rt::RtMutex<T>` takes and releases the lock once at construction, off the audio thread, so the OS mutex
exists before the callback sees it. It is a **type**: `SharedEq`, `SharedBusState` and the four processor
fields are `Arc<RtMutex<…>>`, so a construction that skips the prewarm does not compile. The compiler found
the live bus and 17 test rigs that a text search had missed.

### Receipts (this Mac, arm64, `npm run test:rust`)
- `the_callback_never_allocates`: **`[trap] 43 renders, 0 allocations inside the callback`** (was 97).
- `channel_rack_cost_one_and_twelve_channels`, `callback_timing_with_loudness`: pass (were 3 and 4).
- The trap's own sanity test still passes, so it still sees an allocation when there is one.
- Suite: **131 passed, 5 failed** (was 115 / 21). The 5:
  - `ebu_test_set_every_case`: the EBU test set zip is not unpacked on this Mac (third-party input).
  - 4 goldens null tests: the same 13 processed `music`/`sweep` renders, the case in §5.

## 5. Goldens on macOS — the Mac reference

**Jeff's ruling (verbatim):** *"Goldens captured on Windows can differ by last-bit float on arm64; record the
macOS null figure (−144 dBFS) as the Mac reference in the doc, don't recapture Windows goldens."*

The goldens (`native/goldens/manifest.json`) were captured on Windows x64 and stay the contract. On macOS:

| build | bit-exact to the Windows goldens |
|---|---|
| arm64 (native) | 30/43 |
| x86_64 (Rosetta) | 35/43 |

- Every clean (`OFF`) render is bit-exact on both, so the decode is identical. Only processed `music` and
  `sweep` renders differ.
- The golden WAVs are gitignored and not on this Mac, so the harness cannot measure the Windows delta here.
- **Mac reference null: arm64 vs x86_64, `music__LINKED` monitor — 0.67% of samples differ, max |Δ| 5.96e-08
  = −144.5 dBFS**, 24 dB under the −120 dBFS null bar. That is last-bit float, not a DSP change.
- Inputs: the four synthetic signals are regenerated by `cargo test`. `music.wav` and `speech.wav` are the
  catalogue files, SHA-256 equal to `docs/dsp-parity-harness.md`.
- `scripts/make-loudness-corpus.js` on this Mac (ffmpeg 6.0 vs 6.1.1 on Windows) writes a byte-different
  `ref_m23.wav` that measures the same −23.000 LUFS. The tracked `manifest-loudness.json` was **not** changed.

## 6. Mac packaging — the engine lands where it is loaded, per arch, or the build fails

### Why the engine was missing from `app.asar.unpacked`
electron-builder turns every `extraResources` pattern into an **exclude** for the app files
(`app-builder-lib/out/platformPackager.js:190-219`, v26.8.1). The `{ "from": "native", "to": "native" }`
entry therefore removed `native/*.node` from `app.asar.unpacked`, and copied it (plus any stray
`native/target/**/*.node`) to `Resources/native`, which nothing loads. Proven by a scratch config with that one
entry removed: `app.asar.unpacked/native/ether-audio.node` appeared. The same exclusion applies on Windows
packaging, so whether Windows installers carry the engine in `app.asar.unpacked` is **UNVERIFIED** (the
`afterPack` check below settles it on the next Windows build).

### Fix
- `electron-builder.json`: the `native` `extraResources` entry is gone; `!native/target/**` keeps build output
  out of the app; `beforePack`/`afterPack` hooks (`build-resources/engine-pack.js`).
- `beforePack` (macOS): copies `native/target/<triple>/release/libether_audio.dylib` for the arch being packed to
  `native/ether-audio.node`, after checking it is a Mach-O for that CPU. Missing → build fails.
- `afterPack` (every platform): `app.asar.unpacked/native/ether-audio.node` must exist and be the right format
  (Mach-O of the packed CPU / PE / ELF) → otherwise the build fails before anything is published.
- CI (`build.yml`): macOS builds `aarch64-apple-darwin` and `x86_64-apple-darwin` separately
  (`MACOSX_DEPLOYMENT_TARGET=11.0`); the `cp … || true` is gone (Linux copies plainly and fails if missing).
- `audiod/verify-packaged.js` (the release gate) now runs on macOS too, against a private DB path and log.

### Receipts (this Mac)
- **Negative:** with no arm64 engine built, `electron-builder --mac --arm64` → exit 1,
  `ENGINE MISSING for macOS arm64: …/native/target/aarch64-apple-darwin/release/libether_audio.dylib`, no app.
- **Positive:** `[engine-pack] packaged engine OK: Ether.app/Contents/Resources/app.asar.unpacked/native/ether-audio.node (macho:arm64)`
  and the same for x64 (`macho:x64`). `Resources/native` no longer exists.
- Signature: `flags=0x2(adhoc)`, no `runtime` (§3).
- `node audiod/verify-packaged.js`: `packaged daemon answered ping: true` … `✅ RELEASE GATE PASS`.
- Offline render against the packaged arm64 engine (SHA-256 `4b9dbab3…421d`): 30/43, **all 43 hashes identical
  to the pre-RtMutex engine** (§4 changed no output).
- **Launch:** `open dist-electron/mac-arm64/Ether.app` → `ether-startup.log` 16:02:38Z, v4.6.52 packaged, pid 66618:
  `[audiod-client] connected to daemon (after spawn)` · `daemon pid 66625` ·
  **`[AUDIO] daemon ACTIVE — out-of-process engine (connected in 847ms)`**; daemon log: both stations
  `audio output opened (48000Hz 2ch)` on MacBook Pro Speakers.
- The screen itself: **UNVERIFIED** (no screen-recording permission for a screenshot) — Jeff's look settles it.

### Local Mac build toolchain (this machine)
Rust stable (targets aarch64 + x86_64), Node 22.23.3 and CMake 4.4.3 in `~/.local`. The CLT's stray
`MacOSX27.0.sdk` breaks `ld` (`unknown architecture arm64e.x1-macos`), so local builds set
`SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk`. `beforePack` overwrites the tracked Windows
DLL `native/ether-audio.node` (as CI always did) — `git checkout native/ether-audio.node` after a local build.

## 7. Cross-platform filenames, Re-sync, and this Mac's DB

### Fix
- `storedBasename()` (`electron/audio-library-index.js`, exported): Windows-shaped (drive letter, UNC, any
  `\`) → `path.win32.basename`, else `path.posix`. It lives in the index module, not a new file: the daemon
  requires that module, and a new file the Windows stage does not copy is the 4.4.114 failure.
- Every basename taken from a stored path uses it: `findInIndex` (health classifier, Re-sync, daemon resolver),
  the materializer's `localTargetFor` (`library-health.js`), the five `file_key`s in `generate-core.js`,
  `audio-library-migrate.js` `destinationFor`, `audio-library-r2.js` claimed keys, nine sites in `main.js`
  (resolver log, R2 safe name, `file_key`s, the catalogue upload), and the daemon's resolver log line.
  Renderer: `App.tsx:3169` and `ImportDialog.tsx:73` split on `/` only → now `\` and `/`.
  `sync/mutation-writer.js` already split on both inline and is staged with the daemon, so it is unchanged.
- Test: `electron/stored-basename.test.js` (vitest; CI's test job runs on ubuntu-latest — POSIX, where the bug
  lives). 19 tests: the splitter, the index lookup, and a real Re-sync (`matchStation` → `applyRelink`) over
  Windows-path rows in songs, schedule, announcements and library_asset. **With the fix reverted, 7 fail.**
- Help: `docs/help-resync.md` (there was no help entry for Test sync / Re-sync).

### Gates
`npx tsc --noEmit` 0 errors · `npx vitest run` 69 files / 627 tests pass · `test:relink` 21/21 ·
`test:resolver` 15/15 · `test:library-foreign` 28/28 · `test:audio-library` 41/41 · `test:catalogue-r2` PASS ·
`test:copy-on-import` PASS · `node --check` on every edited main/daemon file.
`test:audio-library-r2` fails (`uploadLibrary is not a function`) **identically on the committed tree** —
pre-existing, not in CI, not touched.

### The 92 (now 93) literally-named files — all DELETED as duplicates
93 by the time of the fix: the installed old-code app wrote more today (07:28, 07:30, 08:25). For each, the
real name is the `path.win32.basename`. **All 93 had the real file present and byte-identical (SHA-256), so
all 93 duplicates were deleted; none needed renaming; none differed.** 104 songs and 108 library_asset rows
pointed at them; the dry run showed all 104 songs inside some station's Re-sync scope before anything moved.

### Re-sync on the installed app's DB (Jeff approved this one write)
App and daemon closed; DB backed up first (`openair.db`, 748 MB, SHA-256 equal to the live file). Re-sync =
the app's own `matchStation` → `applyRelink`, every station, with this Mac's catalogue as the folder.

| station | linked | schedule entries NULLed (miss) | assets re-pointed |
|---|---|---|---|
| 1 Open Format | 138/138 | 0 | 447 |
| 2 halloVeen | 291/292 | 1 | 17 |
| 3 Magical Forest | 156/156 | 0 | 1 |
| 4 Christmas in Jully | 126/126 | 0 | 1 |
| 9 Fall VIbes | 0/0 | 0 | 0 |

**OUTSIDE, by the board's own classifier (`classifyAll`): before 576–593 per station → after 48 on every
station.** (Jeff saw 725 on the old build; the new build's classifier read 576–593 before the write, because
it already resolves these rows by name.)

- **The 48:** MUSIC rows with Windows paths filed in categories no station's clock plays — "Open Format" (35),
  "70s" (7), uncategorised (6). Re-sync is station-format-scoped by design, so it does not touch them. They
  resolve by name here (`elsewhere 48`, `dead` unchanged). Filing them in a clock category and Re-syncing
  clears them.
- **3 dead** (unchanged, not a path problem): Mac-path rows whose files never reached this Mac — the Ariana
  Grande "Hate That I Made You Love Me" live edit (songs 1104 / library_asset 1016, and the halloVeen miss,
  song 1105) and "GC Sponsorship EnglishVersion 15 Secs Normalized" (spots 7 / library_asset 1015).
- What the Health Monitor shows on screen: **UNVERIFIED** until the app is opened.

## Side notes (not investigated)
- `ether-startup.log` on this Mac is 2.4 MB — the never-rotating log already on the backlog.
- The daemon's resolver requires `../electron/audio-library-index` inside a `try` (`audiod/engine.js:1769`,
  `:1790`), and `stage-engine.js` stages only `mutation-writer.js` and `synced-tables.js` from `electron/`. On
  Windows the staged daemon's library resolver may therefore be failing silently. UNVERIFIED.
