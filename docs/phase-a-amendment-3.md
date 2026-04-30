# Phase A — Amendment 3: Continuous Per-Station Streaming Architecture

## Trigger

What was discovered during first real-use testing of the Phase A streaming pipeline (2026-04-30):

The per-track ffmpeg spawn model was never end-to-end tested across a track transition. Testing exposed two architectural flaws:

1. **ffmpeg reads files from disk independently.** It doesn't track engine state. When the file reaches EOF, ffmpeg exits — the Icecast mount goes silent. There is no mechanism for ffmpeg to know the engine has moved on to the next track.

2. **Track transitions in the engine don't notify the streaming code.** `playout:track-started` fires when a track begins, spawning ffmpeg for that file. But when the track ends and the engine auto-advances to the next track, no IPC event triggers a new ffmpeg spawn. Result: dead air after the first track ends, even though audio continues playing locally.

The user articulated the correct model: **stations broadcast continuously, like real radio transmitters.** The streaming pipeline should be a continuous flow from the audio engine into the Icecast mount — not an event-driven chain of per-track file reads. The moment GO LIVE is clicked, audio should flow to the mount without interruption across every track transition, automation clock, cart, or live mic segment, indefinitely, until STOP STREAM is clicked.

## What Amendment 3 Changes from AD-1

AD-1 (the original Phase A architectural decision) stated: "native addon stays a singleton; the JS layer multiplexes per-station queue authority over shared Rust hardware."

Amendment 3 supersedes AD-1's singleton constraint. The central insight is that **continuous per-station broadcasting requires per-station audio engines running in parallel.** A single shared Rust engine cannot simultaneously drive two stations' audio streams — it produces one mixed audio output, not two independent station outputs. To stream OV and USPH independently to their respective Icecast mounts, each station must have its own audio engine with its own output path.

AD-1 remains correct for audio device routing (the `audio_routing.rs` architecture — one physical soundcard for local monitoring). The change is that the Icecast streaming path bypasses the soundcard entirely: it reads raw audio from a named pipe written by the station's engine.

## New Architecture

```
  Station 1 (OV)                         Station 3 (USPH)
  ──────────────────────                  ────────────────────────
  Engine 1 (Rust audio thread)            Engine 3 (Rust audio thread)
      │                                       │
      ├──→ soundcard output                   ├──→ (soundcard silent unless
      │    (when OV is monitored)             │     USPH is selected for monitor)
      │                                       │
      └──→ named pipe                         └──→ named pipe
           \\.\pipe\ether-program-1                \\.\pipe\ether-program-3
                    │                                       │
                    ↓                                       ↓
              ffmpeg(1) ─────────────────→ /ov       ffmpeg(3) ──────────────→ /usph
                         Icecast                                  Icecast
                         44.244.52.207:8000                       44.244.52.207:8000
```

**Key properties of this model:**

- Each engine writes a continuous PCM stream to its named pipe. The pipe is always live as long as the engine is running — it doesn't care what track is playing or whether the playlist has a gap.
- ffmpeg reads from the pipe as a streaming input (`-i \\.\pipe\ether-program-1`). Since the pipe never reaches EOF while the engine runs, ffmpeg never exits between tracks. Track transitions are invisible to ffmpeg.
- GO LIVE on station N opens the pipe connection and spawns one long-lived ffmpeg process. STOP STREAM kills that ffmpeg. The engine keeps writing the pipe regardless; the pipe data is discarded until the next GO LIVE.
- Local monitor is a separate concern: the operator can listen to any station's audio through the soundcard by selecting it in the monitor selector. Only one station routes to the soundcard at a time. Both stations' named pipes are always active.

## Implementation Pieces

Each piece is one or more sub-commits with a verification gate before the next piece begins.

---

### Piece 1 — Rust engine: multi-instance via per-station map

**Files:** `native/src/lib.rs`, `native/src/audio.rs`

Convert `static STATE: OnceLock<GlobalState>` to `static ENGINES: OnceLock<Mutex<HashMap<u32, GlobalState>>>` keyed by `station_id`.

- `init_audio_engine` takes an optional `station_id` parameter (defaulting to 1). Each call creates a new `GlobalState` and spawns a new audio thread for that station if one doesn't already exist.
- `get_or_create_engine(station_id)` is the internal helper that owns the map lookup and initialization logic.
- All existing NAPI functions (`audio_load`, `audio_play`, `audio_stop`, etc.) gain `station_id` as their first parameter. JS callers that don't pass it receive station 1 (backward-compatible default).
- Each station's audio thread has its own `AudioState`, `FinishedFlags`, and `OutputStream`. Engines are fully independent.

**Magnitude:** Significant Rust work. ~3–5 hours focused. This is the highest-risk piece.

**Sub-commit structure:**
- 1.1 — Restructure global state to `HashMap<u32, GlobalState>`; existing NAPI surface unchanged, all calls route to station 1. No behavior change. (Verification: build passes, smokes 32/33.)
- 1.2 — Add `station_id` parameter to NAPI surface; JS callers updated to pass active station's ID; backward-compat default preserved. (Verification: OV AUTO playback works with explicit station_id=1.)

---

### Piece 2 — Rust engine: dual audio output (soundcard + named pipe)

**Files:** `native/src/audio.rs`

Each station's audio thread feeds two outputs simultaneously:

- **Soundcard sink** (existing) — active only when this station is selected as the monitor station.
- **Named pipe sink** (new) — always active when the engine is running; carries raw PCM audio (44100 Hz, stereo, 32-bit float or 16-bit signed).

The pipe sink runs as an additional output in the audio thread's mix loop. Writing to the pipe is non-blocking with a drop policy: if the reader (ffmpeg) is not connected, bytes are discarded rather than blocking the audio thread.

**Pipe naming convention:**
- Windows: `\\.\pipe\ether-program-{station_id}`
- Unix/macOS: `/tmp/ether-program-{station_id}`

**Magnitude:** Moderate Rust work. ~2–3 hours.

**Verification (P2):** Dump first 10 seconds of pipe output to a raw file; open in Audacity or ffplay as raw PCM; confirm it contains the engine's audio.

---

### Piece 3 — main.js: continuous ffmpeg per station

**File:** `electron/main.js`

Replace the per-track `_streamFile` spawn model with a single long-lived ffmpeg process per station. ffmpeg's input is the named pipe; its output is the Icecast mount.

**Lifecycle:**
- GO LIVE on station N → open the named pipe (engine side is already writing) → spawn one ffmpeg reading from `\\.\pipe\ether-program-N` → encode to MP3 → push to `icecast://source:...@44.244.52.207:8000/mountN`. ffmpeg runs until killed.
- STOP STREAM on station N → `SIGTERM` the single ffmpeg process. The engine keeps writing the pipe; bytes are discarded. No other process is affected.
- `playout:track-started` listener removed entirely — no longer needed. Track transitions are invisible to the streaming layer.

The `_stationStreams` Map structure from Step 2a (`{ armed, proc, url, currentFilePath }`) stays; `currentFilePath` field becomes unused and can be removed.

**Magnitude:** Medium JS work. ~2 hours.

**Verification (P3):** GO LIVE on OV; play 3 tracks in AUTO mode; listener hears all 3 with no gaps between them.

---

### Piece 4 — Renderer: pass station_id to all audio IPC calls

**Files:** `src/audio/engine-rodio.ts` and all callers

Every `audio:*` IPC call gains a `station_id` parameter. The renderer's audio engine wrapper takes `station_id` at construction time. The active station's ID is passed to every deck command. Switching stations switches which engine instance the wrapper targets.

The `useAudioEngine` hook (or equivalent) receives station_id from the current station context and reconstructs or reconfigures the engine wrapper when the station changes.

**Magnitude:** Medium, mostly mechanical. ~2–3 hours.

**Verification (P4):** AUTO mode on OV plays decks A→B→C with the correct station_id on each call; listeners hear all three with no dead air.

---

### Piece 5 — Renderer: monitor selection

**Files:** `src/components/SettingsPanel.tsx` (or a new `MonitorSelector` component)

A UI control lets the operator choose which station's audio plays through the local soundcard. Default: the station currently being viewed in the dashboard. The operator can override — for example, monitor USPH's broadcast while viewing OV's playlist.

The selection triggers an IPC call that sets the "monitored station" flag in the Rust engine map; only that station's engine routes to the soundcard output.

**Magnitude:** Small. ~1 hour.

**Verification (P5):** Switch monitor to USPH while viewing OV; local audio output changes to USPH's deck; both Icecast streams continue independently without interruption.

---

### Piece 6 — Renderer: station switch as viewer-only

**File:** `src/App.tsx`

Remove the `engine.getDeck("A").stop()` (and B, C) calls in `handleStationSwitch`. Switching the dashboard view changes which engine the UI is observing — it does not touch any engine's playback state. Both engines keep running.

This is the fix for the AD-1 "stop() on switch" problem identified in Phase A Step 3 planning.

**Magnitude:** Very small. ~10 minutes.

**Verification (P6):** Switch dashboard from OV to USPH; OV's Icecast stream `/ov` continues uninterrupted; USPH engine state loads correctly in the UI.

---

## What's Deferred Past Amendment 3

- **Per-station physical audio devices** (AD-10 advanced case). `audio_routing.rs` already has `DeckRouting`, `AudioRouter`, and real CPAL enumeration — wiring this into the per-station engine map is deferred until launch audio hardware is confirmed.
- **Multiple Icecast servers.** A single Lightsail instance at 44.244.52.207 serves all stations at launch. Per-station server configuration is a post-launch concern.
- **Cloud-based engine fallback.** Local-first remains the model.

## Verification Milestones

| Piece | Milestone | Concrete test |
|-------|-----------|---------------|
| P1 | Two independent audio threads exist | `scripts/diag-multi-engine.js` reports two separate `AudioState` maps with station_id keys |
| P2 | Named pipe carries real audio | `ffplay -f f32le -ar 44100 -ac 2 \\.\pipe\ether-program-1` plays engine audio in real time |
| P3 | Continuous streaming across track transitions | GO LIVE → AUTO → 3 tracks → listener hears all 3 with no gap |
| P4 | station_id flows through renderer → IPC → Rust | Each deck command logs correct station_id; OV and USPH operate independently |
| P5 | Monitor selection works | Local audio follows monitor selection; Icecast streams unaffected |
| P6 | Station switch is view-only | OV broadcast uninterrupted across dashboard switch |

## Risk and Rollback

Each piece is committed separately with a verification gate before proceeding. The Rust pieces (P1, P2) carry the most risk because a broken addon makes the app unbootable. For those pieces specifically:

- Each sub-commit is compiled and boot-verified before the next sub-commit begins.
- The prior commit is the rollback point at every gate. `git reset --hard HEAD~1` + `cargo build` is the recovery path.
- Pieces 3–6 (JS/React) build on a stabilized Rust foundation and carry lower risk — they can be reverted individually without touching Rust.
