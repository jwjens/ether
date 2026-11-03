# What compiling the audio engine takes (2026-10-19)

Jeff (verbatim): "Stalled-song resume at the exact spot: tell me exactly what's needed to compile the engine (the build server via a tag, or which tools on which machine), and I'll decide."

## The code change itself (same on either path)

- `native/src/audio.rs` `build_source` (line ~4192) opens every file from its start. Add a start position: seek the decoder (rodio 0.19 `try_seek`, falling back to decode-and-discard) before the deck is fed, and start the deck's sample clock (`frames_played`) at that position so the countdown is right.
- `native/src/lib.rs` `audio_load`: an optional start-seconds argument (absent = today's behaviour, bit-identical).
- `audiod/engine.js` `_resumeStalled`: pass the position the watchdog last saw (`this._lastLive`).
- Before it is trusted: the engine's DSP parity tests. **Today 5 of 159 engine tests fail on the untouched engine** (4 offline-render parity null tests and `aux_monitor_single_pass_regression` — the recorded goldens predate later engine changes). Those need re-baselining or explaining first, or a seek change cannot be told apart from them.

## Path A — this machine (OVEVENTS)

Already installed and found: Rust 1.94 (`stable-x86_64-pc-windows-msvc`), Visual Studio Build Tools 2022 (MSVC), CMake inside the Build Tools (found by `scripts/cargo-native.js`). The engine DLL in `native/target/release` was compiled here on 2026-10-16 16:24.
- Build: `node scripts/cargo-native.js build --release`, then copy `native/target/release/ether_audio.dll` → `native/ether-audio.node`, then the normal installer build.
- **Not yet proven tonight:** a fresh compile was started into a scratch folder and was stopped by Claude Code for low memory before it finished; the in-place build had nothing to recompile. Memory is the constraint: an LTO release build of the engine plus the on-air Ether on the same box. Do it when the machine is off air.
- Unsigned (local builds are unsigned, as every local build is).

## Path B — the build server

- `.github/workflows/build.yml` builds the engine on GitHub's Windows runner (`cargo build --release`), and builds the HA helper.
- A **v\* tag push** = a signed release: it publishes (as a draft, `EP_DRAFT`) and is the release path. Tag only on your GO.
- **Without a tag:** the workflow also has `workflow_dispatch` — run from a branch it builds **unsigned** and uploads to a **draft** GitHub release (drafts are not offered to auto-update). That needs the branch pushed to GitHub first (I never push without your say-so).
