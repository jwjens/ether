# Release 4.6.69 — the Mac engine fingerprint failure, 4.6.68 withdrawn (2026-10-29)

**Jeff (verbatim):** "The Windows signing failure was my Azure subscription being disabled; I've paid and reactivated it,
and it can take up to 24 hours to show Active. Nothing in the workflow needs changing. Meanwhile: fix the Mac engine
fingerprint failure at its root cause as its own commit, delete the 4.6.68 draft and tag, and get 4.6.69 ready to
release. When I tell you Azure is active, run the release build for 4.6.69, keep it a draft until every platform builds
and Windows is signed, then publish it with the release notes. Local builds and installs continue as normal."

## 1. The Mac failure (run 40958219110, tag v4.6.68 @ 2f3126a)

The failed step was "Build and publish (Mac)", in electron-builder's beforePack:

```
⨯ [engine-source] native/target/x86_64-apple-darwin/release/libether_audio.dylib was NOT built from the engine source being packaged.
  engine file: carries no source fingerprint (built before this check, so older than the source)
  engine source in this tree: 4c5e4ca6a1c3bd65
    at assertEngineMatchesSource (build-resources/engine-source-fp.js:55:11)
    at beforePack (build-resources/engine-pack.js:78:14)
```

The dylib was **not** stale. The same job built it fresh a minute earlier (`file …/x86_64-apple-darwin/…/libether_audio.dylib:
Mach-O 64-bit dynamically linked shared library x86_64`, 21:38:33Z), and CI caches no Rust build. The Linux job passed the
same check on the same source (`native/ether-audio.node built from this engine source (4c5e4ca6a1c3bd65)`).

**Root cause.** Only one piece of code used the string `ENGINE_SOURCE_MARK` (native/src/lib.rs): the `.to_string()` in
`audio_engine_source_mark()`. On x86_64 macOS, LLVM compiles that copy of the 43-byte literal into five `movabsq`
immediates. After that, no code points at the string, and LTO (`lto = true`) plus ld64 dead-stripping remove it from the
dylib, so the binary has no `ETHER_ENGINE_SOURCE_FP:…:END` to find. On Linux, the copy reads the string from memory, so
it stays.

**Receipt (local, rustc 1.94.0, `--emit=asm -C opt-level=3`, the same pattern):**
- `x86_64-apple-darwin`: the function is five `movabsq $…, %rcx` stores, with no reference to the string.
- `x86_64-unknown-linux-gnu`: the function copies from the string.

Not established: whether the arm64 Mac engine kept the mark. The x64 pack ran first and failed the job, so arm64 was
never checked. The fix covers both.

**Fix — commit `3e97d50`** (its own commit):
- `#[used]` on `ENGINE_SOURCE_MARK`. On Mach-O this emits `.no_dead_strip`, and on ELF a retained section (`"awR"`).
- `std::hint::black_box(ENGINE_SOURCE_MARK).to_string()` in `audio_engine_source_mark()`, so the copy cannot be folded
  into immediates.
- Checked in asm as a fat-LTO cdylib for both targets: no `movabs` fold; the string, plus `.no_dead_strip` (Mac) or the
  retained section (Linux), is present.
- Engine rebuilt: `native/ether-audio.node` now = source `d4a2c71b654d31da`. `engine-source-fp` tests: 33/33.
- The packaging check itself (engine-source-fp.js / engine-pack.js) is unchanged. It was right: the binary really had no
  mark.

**UNVERIFIED until the 4.6.69 tag's Mac job:** that job must log `[engine-pack] macOS x64: … (engine source d4a2c71b…)`
and the same for arm64. That is the one check that settles it.

## 2. The Windows failure

Jeff: his Azure subscription was disabled. He has paid and reactivated it, and it can take up to 24 hours to show Active.
The workflow is not changed.

## 3. 4.6.68 withdrawn

- Before deletion: release `4.6.68` was a **draft** with only the Linux assets (`Ether-4.6.68.AppImage`,
  `latest-linux.yml`, `openair_4.6.68_amd64.deb`); the remote tag `v4.6.68` pointed at `2f3126a`.
- `gh release delete v4.6.68 --yes --cleanup-tag`. Afterwards: `release not found`; `git ls-remote --tags origin
  'v4.6.68*'` is empty; there is no local tag. Nothing was ever published, and no client could have auto-updated to it.
- Unrelated and untouched: a separate old draft, `4.6.59` (2026-10-11), is still in the release list.

## 4. 4.6.69 — ready, waiting on Azure

- Branch `release/1019`, `package.json` = 4.6.69. It contains everything 4.6.68 had, plus `3255f59` (Settings opens at
  once), `f9591b2`, `136d882` (version + changelog) and `3e97d50` (this fix).
- `tsc --noEmit`: 0 errors.
- **Local installer (rebuilt with the new engine):** `C:\openair\dist-electron\Ether Setup 4.6.69.exe`, 216,406,599 bytes,
  sha256 `54f263c61d7df1fb64b714aaf64daeaeafe12918c70778e914be87399ba13402`, built 17:17 local from `3e97d50`. It is
  unsigned, unpublished and not installed anywhere. It replaces this morning's 4.6.69 build (docs/build-4.6.69-2026-10-29.md,
  sha256 `2354fa07…`), which had the old engine.
  - Build log: `[engine-source] native/ether-audio.node built from this engine source (d4a2c71b654d31da)`, `packaged
    engine OK … (pe, engine source d4a2c71b654d31da)`, all engine app files unpacked, HA helper packaged, `unsigned build
    (Ether.exe NotSigned)`.
  - Packaged launch smoke (`win-unpacked\Ether.exe`, `ETHER_SMOKE=1`, empty temp LOCALAPPDATA/APPDATA/user-data-dir, no
    installed Ether running): `[SMOKE] PASS react_mounted=true root_children=1 renderer_error=false daemon_desired=true
    daemon_started=true daemon_log_staged=true station_count=0 air_isolated=true`; exit 0. The staged `ether-engine.exe`
    in the temp profile was still running after the smoke exited (pid 24856). Only that process was stopped, and the
    temp folder was deleted.
  - The full side-by-side check from this morning (queue from today's log, sign-in first on a computer that keeps a sign-in) was **not**
    repeated. Only the engine binary changed since then; the app code is the same.

### When Jeff says Azure is Active — the release run

1. Tag `v4.6.69` on `3e97d50` (or on whatever HEAD Jeff names) and push **only the tag**. That is what triggers build.yml.
2. Watch the run. Every platform must pass: Windows **"Sign HA helper"** and the electron-builder signing, Mac
   `[engine-pack]` for x64 **and** arm64, and Linux.
3. Keep the release a draft until then. Check the Windows assets: `Ether Setup 4.6.69.exe` carries a Valid signature
   (afterSign already fails the build if the HA helper is not Valid).
4. Publish with the notes below, and add the wiki Releases entry.

### Draft release notes (operator-facing — for Jeff to edit before publishing)

The last published release is **4.6.57**, and 4.6.68 was never published, so these notes cover everything in CHANGELOG
`[4.6.68]` + `[4.6.69]`. Sign-in is described as Jeff ruled (2026-10-29): 4.6.69 did not reverse "stays signed in". When
Ether is opened, the sign-in screen comes first. While Ether runs, the sign-in renews silently and nothing ever signs
anyone out or shows a sign-in screen. Both are said.

> **4.6.69 — Patch Bay, Remote Link through Ether, and Settings that opens at once**
>
> **New**
> - **Patch Bay (☰ → Patch Bay):** one place for each station's outputs (Master, Cue and Aux, to any device and channel
>   pair, up to four devices at once) and its inputs (device inputs, Park mics and the Remote Link feed, patched to
>   faders). A missing device is shown in red and never swapped for another.
> - **Remote Link through Ether's relay:** pick the computer and station. No address, port or router setup.
> - **The board:** real fader caps, double-click a fader for 0 dB, and the board scrolls sideways with Master Out pinned.
>   Decks A, B and C can collapse into one strip that follows the playing deck.
> - **Settings** (was Preferences) has its own sections for Remote Link, Jukebox, Park Page and Audio Devices.
> - **Settings → Links:** every public page of your account and stations, with Open and Copy.
> - **Stays signed in:** while Ether runs, your sign-in renews silently in the background. Nothing ever signs you out
>   or shows a sign-in screen. If it can't renew, only account features pause (Health Monitor → Account sign-in).
>   Remember me is on by default.
>
> **Fixed**
> - Settings opens at once. It no longer freezes Ether for several seconds.
> - The account sign-in screen comes first whenever Ether is opened.
> - Your sign-in is kept in this computer's protected storage, never in the station database or a backup.
> - The board's remove button (−) takes a channel off in one click, even with a Link input or Park mic patched on it.
>
> After updating, fully close Ether and open it again so the audio engine updates too.

**Resolved (Jeff, 2026-10-29):** CLAUDE.md rule 1 now reads: when Ether is opened, the account sign-in screen comes
first; while Ether is running, nobody is ever signed out and no sign-in screen ever appears, because the sign-in renews
silently in the background.
