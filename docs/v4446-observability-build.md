# v4.4.46 — Native-Layer Observability BUILD checkpoint (2026-07-13)

**Scope:** observability/plumbing ONLY — capture native Rust stderr into the daemon log, and publish
a per-station mix-telemetry heartbeat. **No behaviour change** to playout, watchdogs, recovery,
scheduling, or advancement. **BUILT + isolated-run-validated. NOT deployed. HOLD for Jeff's
walkthrough — no commit/tag/push/release without his literal "GO."**

Source tree: `C:\openair` (git `main`, HEAD `03ddc18` = 4.4.44). Build: `cargo 1.94.0`, `node
v24.14.0`. Live broadcast box — the isolated validation below never touched the live daemon
(`\\.\pipe\ether-audiod` confirmed intact after every run).

---

## 0. Decisions that diverge from the literal ask (with receipts)

1. **Task 1 uses an inherited FILE fd, NOT a parent-held pipe.** The brief says "stderr is piped …
   verify a detached child's pipe survives app exit on Windows; if it cannot, [self-redirect to the
   log file]." **It provably cannot** (§1.1). A parent pipe is not merely lossy — it would *cause*
   dead air: Rust `eprintln!` panics on a failed stderr write, and the pipe's write end goes EPIPE
   the instant the app exits (every gapless update). So I implemented the safe variant.
2. **`native/src/lib.rs` was also edited** (not just `audio.rs`). The mixer publishes telemetry into
   the `AudioLevels` struct, but the napi getter `audio_get_levels` hand-builds its JSON and would
   have **dropped every new field** — the telemetry would have been silently empty in production too.
   The isolated run caught this (§4). The lib.rs edit is the plumbing that surfaces the published
   struct; still observability-only, additive JSON.
3. **Version NOT bumped; CHANGELOG untouched.** Not an enumerated task, and the working tree already
   carries someone's uncommitted 4.4.45 + isolation work (§5 blast radius). Version/commit decisions
   belong to Jeff at the walkthrough. The daemon self-reports `4.4.46-obs-test` only in the isolated
   harness via env; the tree's `package.json` is left at its current `4.4.45`.
4. **"Real sample from a local run" was captured in ISOLATION** (own pipe, DB copy, **monitor
   muted**, no Icecast) — mirroring the validation-gate soak's own safe method — because this is a
   live broadcast box. A silent WASAPI shared-mode stream contributes zeros to the OS mix and cannot
   alter the live daemon's output.

---

## 1. Task 1 — capture native Rust stderr into `ether-audiod.log`

**File:** `electron/audio-daemon-client.js`
- `:18` — added `const fs = require("fs");`
- `:110–137` — the spawn: open the daemon's log in append mode and hand that fd to the child as
  **stderr** (`stdio: ["ignore", "ignore", errFd]`), preserving `detached: !dev` + `child.unref()`.
  Best-effort: any `fs.openSync` failure falls back to the previous `"ignore"` (spawn never blocked).
  The parent closes its copy of the fd immediately after spawn — the child owns its own inherited
  handle (`:135` `fs.closeSync(errFd)`).

Before → after (the operative line):
```
-      detached: !dev, stdio: "ignore",
+      let errStdio = "ignore", errFd = null;
+      if (logFile) { try { errFd = fs.openSync(logFile, "a"); errStdio = errFd; } catch { errStdio = "ignore"; errFd = null; } }
+      ...
+      detached: !dev, stdio: ["ignore", "ignore", errStdio],
```

Why this captures the target diagnostics: the Rust addon runs **in-process** in the daemon, so its
`eprintln!` writes go to the daemon's fd 2 — which is now this log file. The discriminators the brief
wants (`[cpal]` errors `audio.rs:637`, `[RUST] Deck N finished (source exhausted)` `audio.rs:935`,
`source=None, path empty — skipping` `audio.rs:701`, `reload failed … skipping` `audio.rs:707`) all
land in the log instead of the null device.

### 1.1 Windows detached-stderr survival test (the required receipt)

Harness (scratchpad `stderrtest/`): a detached+unref child writes to its own fd 2 (`fs.writeSync(2,…)`
— closest to Rust `eprintln!`) 30× over ~6 s; the parent exits after 1 s. Two stderr targets tested.

| Test | stderr target | child survives app exit? | fd-2 writes after app exit | verdict |
|------|---------------|--------------------------|----------------------------|---------|
| **A** | parent-held **pipe** | yes | **EPIPE on every write** (tick 5→30, `sawError=true`) | ❌ would panic Rust `eprintln!` → poisoned mutex → **dead air on every gapless update** |
| **B** | inherited **append file fd** | yes | **all `ok`, `sawError=false`** (ticks 5→30 after `parentGone=true`) | ✅ survives the gapless-daemon lifetime, never EPIPEs |

Verbatim (Test A, the moment the app exits):
```
tick 4 fd2write=ok    parentGone=false
tick 5 fd2write=ERR:EPIPE parentGone=true
...
tick 30 fd2write=ERR:EPIPE parentGone=true
DONE sawError=true
```
Verbatim (Test B):
```
tick 5 fd2write=ok parentGone=true
...
tick 30 fd2write=ok parentGone=true
DONE sawError=false
```
This is why the pipe design is disqualified and the inherited-fd design is used.

### 1.2 What the captured native lines look like (REAL, from the isolated run)

`ether-audiod.log`, native `eprintln!` now present (were previously discarded):
```
[RUST] Station 1 Program Bus on TCP port 63953
[RUST] Station 1 device: Speakers (2- Realtek(R) Audio) (48000Hz 2ch)
[RUST] Station 1 audio output opened (48000Hz 2ch)
[RUST] Station 2 audio output opened (48000Hz 2ch)
```
These sit alongside the JS `… [INFO] …` lines. **Prefix/timestamp tradeoff (honest):** native lines
arrive **raw** — no ISO timestamp, no `[rust]` prefix — because per-line prefixing requires
intercepting the stream in JS, which is only possible via the (disqualified) pipe. The lines are
self-identifying (`[RUST]` / `[cpal]`), so they remain greppable. If Jeff wants true timestamped
`[rust]` prefixes, the only safe route is a Rust-side change to route those `eprintln!`s through a
non-panicking, self-timestamping logger — proposed as a **follow-up**, out of this build's scope.

**Two-writer note:** the JS `daemon-log` WriteStream and the inherited fd both append to the same
file. Windows `FILE_APPEND_DATA` appends are atomic per write and both writers emit one line per
write, so lines never tear — confirmed in the capture (no interleaved/torn lines observed).

---

## 2. Task 2 — per-station mix-telemetry heartbeat

### Native publish — `native/src/audio.rs` (no new lock, no RT-path allocation)
- `:95–104` — new `DeckTel` struct (per-deck `source_present/active/paused/volume/gain_db`).
- `:118–132` — `AudioLevels` gains `frames_total: u64`, `active_decks: u32`, `mon_vol: f32`,
  `decks: Vec<DeckTel>`, all `#[serde(default)]` (older readers/the legacy path are unaffected;
  `AudioLevels` is only ever built via `::default()`).
- `:314–318` + `:337` — `BusState.frames_consumed: u64` (init `0`).
- `:1028` (in `mixer_callback`, the cpal hot path) — the ONLY hot-path change: a single
  `bus.frames_consumed = bus.frames_consumed.wrapping_add(prog_frames as u64);` under the lock the
  callback already holds. No new lock, no allocation, no branch on the audio path.
- `:788–808` (in the live `GetLevel` handler, on the command thread — NOT the RT callback) — snapshot
  `frames_consumed`, `monitor_vol`, and per-deck A/B/C into `AudioLevels`. The `Vec`/`String` allocs
  here run on the command thread at the getLevels poll rate, never in the cpal callback.

### Native surface — `native/src/lib.rs`
- `:159–171` — `audio_get_levels` now also serializes `frames_total / active_decks / mon_vol / decks`
  into the existing getLevels JSON (additive keys; renderer VU still reads `a/b/c/master`).

### Daemon log line — `audiod/engine.js`
- `:98–124` — new `_mixHeartbeat(now, s)`: emits one `[mix sN]` line every 5 s, **only when a deck
  reports `status=playing`** (silent when idle), reading the telemetry off the getLevels call and
  logging the frames DELTA since the last line. Diagnostic only — never gates playout, never throws.
- `:157` — one call added at the top of `poll()`: `this._mixHeartbeat(now, s);`

### What the line looks like (REAL, from the isolated run — s1 deck A at −3 dB, monitor muted)
```
[mix s1] active=1 frames=+231246 peak=0.000 mon=0.00 | A src=1 a=1 p=0 vol=0.71 g=-3.0 | B src=1 a=0 p=1 vol=1.00 g=+0.0 | C src=1 a=0 p=1 vol=1.00 g=+0.0
[mix s2] active=1 frames=+231689 peak=0.000 mon=0.00 | A src=1 a=1 p=0 vol=1.00 g=+0.0 | B src=1 a=0 p=1 vol=1.00 g=+0.0 | C src=1 a=0 p=1 vol=1.00 g=+0.0
```
Reads: `active` = decks being mixed; `frames=+N` = program frames consumed since the last line (the
live "callback is pulling PCM" signal — advances ~230k/5 s here); `peak` = post-EQ program peak;
`mon` = monitor gain; then per-deck `src`(source present) `a`(active) `p`(paused) `vol` `g`(gain dB).
Note `vol=0.71` for s1-A = 10^(−3/20) — the −3 dB deck gain, proving the gain/volume plumbing.

**Honest anomaly:** `peak=0.000` while `frames` advanced. I did **not** touch the `level_master`
path, so this is not the telemetry — in this isolated, monitor-muted run the sampled program peak read
zero while the deck consumed frames (likely a decode/timing artifact of the muted shared-device run;
in production the VU/`master` field is non-zero). Flagging it rather than hiding it; worth a glance at
the walkthrough, but it does not affect the new fields.

Idle correctness confirmed: before decks were playing, `_mixHeartbeat` emitted nothing (the gate held);
lines only appeared once a deck was `status=playing`.

---

## 3. Build receipts
- `cargo check --release` → **Finished, 0 errors** (31 pre-existing unused-fn warnings only).
- `cargo build --release` → **Finished in ~1m55s, 0 errors** → `native/target/release/ether_audio.dll`
  (4006 KB, 2026-07-13 10:33). **Live `native/ether-audio.node` NOT swapped** (git shows only the
  pre-existing `M`; I never wrote it).
- To deploy for a packaged test (Jeff, on GO): `copy native\target\release\ether_audio.dll
  native\ether-audio.node` **with the app closed** (Windows locks a loaded DLL).

## 4. Isolated validation (how the real samples were captured, safely)
Harness `scratchpad/v4446run/run-v4446.js`: spawns an OWN daemon (loads the new `.node`) on
`\\.\pipe\ether-audiod-v4446`, against a **copy** of the live DB, spawned exactly as the modified
client does (inherited stderr fd). It muted the monitor (`setMonitorVolume 0`) before any deck played,
started automation, then load+played real files on deck A of s1/s2; no Icecast stream. Captured 10
`[mix sN]` lines + the `[RUST]` device lines above. Post-run checks: `\\.\pipe\ether-audiod` (live)
still present; no `v4446` pipe; no stray daemon. **This run also caught the lib.rs serialization gap**
(§0.2) — the first attempt logged `active=0 frames=+0 decks=[]`, which is how the missing napi
plumbing surfaced.

## 5. Blast-radius audit
- **Files touched (mine):** `electron/audio-daemon-client.js` (spawn stdio only),
  `native/src/audio.rs` (additive struct fields + 1 counter add + GetLevel snapshot),
  `native/src/lib.rs` (additive JSON keys), `audiod/engine.js` (one gated diagnostic method + 1 call).
  **Nothing else** — no watchdog, recovery, scheduler, advance, or engine-state code changed (Task 3).
- **RT audio hot path:** exactly one `u64` add (`audio.rs:1028`). No new lock, no allocation, no I/O.
- **Task-1 failure modes:** log-open failure → falls back to `"ignore"` (identical to today);
  detached/unref/gapless semantics unchanged; no EPIPE risk (§1.1); parent fd closed → no handle leak.
- **getLevels JSON:** additive keys only; existing consumers (renderer VU, main) ignore unknown keys.
- **`[mix sN]` volume:** ≤ 1 line/station/5 s and only while playing → negligible log growth; the
  existing 5 MB rotation in `daemon-log.js` still applies.
- **Pre-existing dirty tree (NOT mine, flagged):** the working tree already carried uncommitted work
  before I started — `native/src/audio.rs`, `native/src/lib.rs`, `audiod/ether-audiod.js`,
  `electron/main.js`, `native/ether-audio.node`, `package.json` (@ 4.4.45) et al. (the per-station
  isolation fix). My changes **stack on top**; my rebuilt `.dll` therefore contains that isolation
  work + this observability. Jeff should decide how to sequence/commit these.
- **Customer isolation:** all changes are local dev source, undeployed; nothing platform-wide.
  Accounts **netgeak** and **cristianmalliani** untouched.

## 6. Packaged-build verification steps (for Jeff, on GO)
1. With the app closed: `copy native\target\release\ether_audio.dll native\ether-audio.node`.
2. `npm run build` / electron-builder as usual. Confirm packaging still `asarUnpack`s `audiod/**` and
   `native/ether-audio.node` (per `audio-daemon-client.js:29–36`) — the stderr-capture path relies on
   the client resolving `logFile` via `app.getPath("userData")`, which it does in packaged mode.
3. Launch the packaged app; open `%APPDATA%\Ether\logs\ether-audiod.log` and confirm:
   - `[RUST] Station N audio output opened …` / `[cpal] …` lines now appear (Task 1), and
   - `[mix sN] active=… frames=+… …` lines appear every 5 s while a station is on air (Task 2), and
   - no `[mix sN]` spam while stations are idle.
4. **Gapless-survival check:** with a station on air, quit/relaunch the app; confirm the daemon keeps
   running AND its stderr keeps landing in the log after the app exits (the inherited-fd guarantee).
5. 2-station on-air soak to confirm no torn log lines and no playout regression.

---

**STOP — awaiting Jeff's walkthrough. No commit, tag, push, `.node` swap, or release without GO.**
Not committed.
