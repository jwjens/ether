# Addon rebuild — trace before touching the audio engine

**Date:** 2026-07-31 · **Mode:** READ-ONLY. Toolchain queried, git and source inspected, live daemon
queried over its pipe. **Nothing built, nothing swapped.**
**Why:** the shipped `ether-audio.node` predates two features whose JS halves are already live — the
Audio Processing DSP (park season) and the empty-deck play refusal (manual mode).

---

## 1. What a rebuild involves

**Toolchain: present and current.**

```
rustc 1.94.0 (4a4ef493e 2026-03-02)
cargo 1.94.0 (85eff7c80 2026-01-15)
```

**Build shape:** `native/Cargo.toml` → `crate-type = ["cdylib"]`, `napi = { version = "2", features =
["napi4", "tokio_rt"] }`, `napi-derive = "2"`, with `native/build.rs` calling `napi_build::setup()`.

**Command:** `cargo build --release` from `native/`, then copy
`native/target/release/ether_audio.dll` → `native/ether-audio.node`. **There is no npm script and no
napi-cli step** — nothing in `package.json`, `electron-builder.json` or `scripts/` builds it. The `.node`
is produced by hand and committed. That is worth knowing before assuming a one-liner exists.

### The ABI question — and why this is NOT the better-sqlite3 trap

**`napi4` is N-API version 4, which is ABI-stable by design.** A module built against N-API works across
Node and Electron versions without recompilation — that is the entire point of N-API. This is the
opposite of `better-sqlite3`, which links the **V8** ABI and therefore must be rebuilt per Electron
version (the mismatch that forces `ELECTRON_RUN_AS_NODE` for the migration scripts).

**Corroborating evidence, not just the spec:** the same `.node` file is loaded by three different hosts
today — Electron main, the renamed-Electron daemon (`ELECTRON_RUN_AS_NODE`), and plain `node` in
`scripts/spike-audiod-load.js` — and works in all three. A V8-ABI module could not do that.

**So: no Electron-version target matching is required.** Build for the host platform/arch
(`x86_64-pc-windows-msvc`) and it loads everywhere the current one does.

## 2. The `.bak` / `.new` files — and which is source truth

```
native/ether-audio.node                       4,132,864 B   Jul 27 14:08   ← TRACKED IN GIT, live
native/ether-audio.node.bak-20260711_095606   4,104,192 B   Jul 11 09:56   untracked
native/ether-audio.node.bak-20260711_101910   4,090,368 B   Jul 11 10:19   untracked
native/ether-audio.node.new                   4,093,440 B   Jul 11 10:19   untracked
```

**`native/ether-audio.node` is tracked in git** (`git ls-files` confirms) — the binary is committed, not
generated at install. The other three are untracked leftovers from a **2026-07-11** session, all
*smaller* and nearly three weeks older than the live one. **None of them is newer than what ships**, so
none is a candidate to swap in and none needs preserving. They are debris from an earlier swap, not a
build artifact to promote.

**Source truth is `native/src/`, and it is AHEAD of the binary.** The source contains
`program_processor.rs` (`LoudnessRide` + `TruePeakLimiter`), the fork at `audio.rs:1110`, the
`proc_*` fields on `AudioLevels` (`:131-137`), and today's `audio_play` refusal + `audio_stop`
`file_path` clear in `lib.rs`. **The Jul 27 binary has none of the proc metering** — proven at runtime,
below.

## 3. The swap procedure — and the path that actually matters

**The repo `.node` is NOT what the daemon runs.** There are three copies, and only the third is live:

```
native/ether-audio.node                                     ← repo (tracked, what you rebuild)
  → packaged into resources/app.asar.unpacked/native/       ← installer (asarUnpack "native/**/*.node")
    → %LOCALAPPDATA%\Ether\engine\native\ether-audio.node   ← STAGED — the daemon loads THIS
```

`audiod/stage-engine.js:93` does the last hop:

```js
cpSoft(path.join(unpacked, "native", "ether-audio.node"), path.join(dir, "native", "ether-audio.node"));
// "may be loaded/locked"
```

**`cpSoft` swallows `EBUSY`/`EPERM`/`EACCES` and keeps the existing staged copy.** So if the daemon is
running when the app starts, the addon copy **silently fails and the old binary keeps running** — the
staged file is version-marked by the app version, so a version bump alone does not guarantee the addon
refreshed. **This is exactly the failure mode that let a stale binary persist**, and it is why "install
the new build" is not by itself sufficient.

**Therefore the swap requires the daemon fully stopped**, not just the app closed: Ether quit **and**
`ether-engine.exe` gone (the installer's `installer.nsh` taskkill covers this — the same mechanism as the
"Ether cannot be closed" install blocker). Verify with the process check before and after.

## 4. Verification plan — runtime receipts, not greps

**I am specifying this in reaction to my own error.** In
`docs/stream-local-processing-trace-2026-07-31.md` I claimed the DSP was "in the running addon ✅" on the
strength of `grep -c audioSetProcessing`. That was wrong: NAPI **export names** are plain strings in the
binary, but serde **struct fields** are not — `level_master` and `frames_total` also grep to zero while
demonstrably working. A grep proves nothing about this binary either way.

**The receipt that settles it** — ask the live daemon over its pipe:

```
cmd: getLevels, stationId: 2
```

**Today (Jul 27 binary):**

```
proc_* fields from the LIVE addon: *** NONE ***
other fields: a, active_decks, b, c, cart, decks, frames_total, master, mon_vol
```

**That is the proof the DSP is absent**, and the direct cause of "waiting for audio": `_emitProcMeters`
returns at `if (!lv || (!lv.proc_local && !lv.proc_stream)) return;` because `lv.proc_local` is
`undefined`.

**After a rebuild, before any swap on the broadcast box, both features must show a runtime receipt:**

1. **Processing** — load the new `.node` in plain `node`, call `audio_set_processing(1, true, true, -14)`
   then `audio_get_levels(1)`, and assert the JSON **contains `proc_local`, `proc_in_lufs`,
   `proc_out_lufs`, `proc_gr_db`**. Fields present = the DSP and its metering are in the binary.
2. **Empty-deck refusal** — call `audio_play("A", 99)` on a fresh engine with nothing loaded and assert it
   returns **`false`** (today it returns `true`). Then `audio_load` a real file and assert `audio_play`
   returns `true`. That is the whole contract, testable off-air in seconds.

Both are pure addon calls needing no audio device, no DB and no daemon — the same discipline as the
smoke benches. **Neither is a grep.**

## 5. Risk and rollback

**This binary is the audio engine for four live stations.** It is the single most consequential file in
the tree — a bad one is silence on every station at once, not a degraded feature.

**Rollback is genuinely cheap, and that is the mitigating fact:**

- The current binary is **tracked in git** (`native/ether-audio.node`, committed Jul 27), so
  `git checkout -- native/ether-audio.node` restores byte-identical source truth.
- Before swapping, copy the **staged** binary aside (`…\Ether\engine\native\ether-audio.node` →
  `.bak-<timestamp>`). **Recovery is: stop the daemon, copy the `.bak` back, start.** Under a minute, no
  reinstall, no build.
- The staged copy is what runs, so a rollback does not require rebuilding or re-releasing anything.

**On dev/OVEVENTS first — yes, and §4 makes it stronger than a smoke test.** The two verifications above
run against the `.node` file directly under plain `node`, so they can be run **on this machine without
touching the staged copy or the running daemon at all** — build, verify the new file in isolation, and
only then decide to swap. That is better than "test on another box": it is testing the exact artifact
before it goes anywhere near the audio path.

**What I cannot verify from a file test:** that the DSP *sounds* right and that its `try_lock` never
starves the callback under real load. That needs one station, on air, watched — halloVeen, which already
has the toggles on and is the station with the complaint.

## Recommended sequence

1. `cargo build --release` in `native/` — **produces a file, touches nothing live.**
2. Run the two §4 assertions against `native/target/release/ether_audio.dll` directly. **Stop here if
   either fails.**
3. Copy to `native/ether-audio.node`, commit (it is tracked), bump, build the installer.
4. **Stop Ether and confirm `ether-engine.exe` is gone** — otherwise `cpSoft` silently keeps the old
   binary and the whole exercise is a no-op.
5. Install, start, re-run the live `getLevels` receipt: `proc_*` fields present = the swap took.
6. Watch halloVeen with the meters open.

**Steps 1-2 are free and reversible.** I would do those and report before anything is copied.

## Scope note

Read-only. Toolchain queried; git, `Cargo.toml`, `stage-engine.js` and `native/src/` read; the live
daemon queried over its pipe with `getLevels` (a read command). No file changed, nothing built, nothing
swapped.
