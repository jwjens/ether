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

## Side note (not investigated)
`ether-startup.log` on this Mac is 2.4 MB — the never-rotating log already on the backlog.
