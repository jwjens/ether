# OpenAir — Architecture & Tech Stack

Free, open-source broadcast automation for internet streamers, small stations, and college radio.
A cross-platform replacement for RCS Zetta / GSelector.

---

## Tech Stack Decision

### Primary Recommendation: Tauri 2 + React + TypeScript + SQLite

| Layer | Choice | Why |
|---|---|---|
| App shell | **Tauri 2** (Rust) | ~8MB binary vs Electron's ~100MB; 1/10th the RAM; proper OS-native menus/tray |
| UI | **React 18 + TypeScript** | Huge ecosystem, great audio UI libs, easy hire |
| State | **Zustand** | Minimal boilerplate, perfect for broadcast "channels" mental model |
| Database | **SQLite via tauri-plugin-sql** | Zero-config, single file, survives offline, fast reads |
| Audio | **Web Audio API** (in-renderer) | Works in Tauri webview; crossfades, gain nodes, precise timing |
| Styling | **Tailwind CSS** | Rapid prototyping, dark-mode-first |
| Build | **Vite** | Fast HMR during development |

### Tradeoffs vs Alternatives

**vs Electron:**
- ✅ 10–15x smaller installer
- ✅ Dramatically lower RAM (Tauri shares OS webview, no bundled Chromium)
- ✅ Rust backend = memory safety, no callback hell for file/DB ops
- ❌ Smaller ecosystem than Electron, fewer community plugins
- ❌ Rust build step adds CI complexity

**vs Pure Web App / PWA:**
- ✅ Direct filesystem access (scan music library, write audio files)
- ✅ No server required — runs on a $200 station PC
- ✅ Lower audio latency (AudioContext not throttled when window unfocused)
- ❌ Can't run from a browser bookmark

**vs Qt (C++/Python):**
- ✅ Much easier UI development — web devs can contribute
- ✅ Better audio visualization options (Canvas, WebGL)
- ❌ Qt has better low-latency audio primitives (ASIO, JACK)

**vs Flutter:**
- ✅ Far stronger web audio ecosystem
- ✅ React talent pool is enormous
- ❌ Flutter has better cross-platform widget parity

### Audio Latency Note
Web Audio API in Tauri is adequate for **live-assist** (human-triggered playback),
not suitable for sub-millisecond automation. For automation playout with frame-accurate
cueing, migrate the playback engine to a Tauri Rust command using **rodio** or **cpal**.
The engine.ts abstraction makes this swap transparent to the UI.

---

## Project Structure

```
openair/
├── src-tauri/                    # Rust backend (Tauri)
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   └── src/
│       ├── main.rs               # Tauri app entry, plugin registration
│       ├── commands/
│       │   ├── library.rs        # scan_folder, import_file, update_song
│       │   ├── schedule.rs       # generate_log_hour, lock_hour
│       │   ├── audio.rs          # (future) low-latency rodio playback
│       │   └── system.rs         # open_file_dialog, get_audio_devices
│       └── db/
│           ├── mod.rs            # DB pool setup, migration runner
│           └── migrations/
│               └── 001_initial.sql
│
├── src/                          # React frontend
│   ├── main.tsx                  # React root
│   ├── App.tsx                   # Router + layout
│   │
│   ├── types/
│   │   └── models.ts             # All TypeScript interfaces (mirrors DB)
│   │
│   ├── db/
│   │   ├── client.ts             # tauri-plugin-sql wrapper + helpers
│   │   ├── songs.ts              # CRUD queries for songs
│   │   ├── clocks.ts             # CRUD for clocks + slots
│   │   ├── logs.ts               # Log generation + queries
│   │   └── spots.ts              # Spot inventory queries
│   │
│   ├── store/
│   │   ├── engine.store.ts       # Zustand: live audio engine state
│   │   ├── log.store.ts          # Zustand: current log hour
│   │   ├── library.store.ts      # Zustand: song library + filters
│   │   └── ui.store.ts           # Zustand: active panel, theme, etc.
│   │
│   ├── audio/
│   │   ├── engine.ts             # Web Audio API dual-deck player
│   │   └── scheduler.ts          # Rule-based rotation scheduler
│   │
│   ├── components/
│   │   ├── layout/
│   │   │   ├── Sidebar.tsx
│   │   │   ├── TopBar.tsx        # Station name, clock, on-air status
│   │   │   └── StatusBar.tsx
│   │   │
│   │   ├── live-assist/          # PRIMARY screen for on-air use
│   │   │   ├── LiveAssist.tsx    # Main container
│   │   │   ├── DeckPlayer.tsx    # Single deck (A or B) with waveform
│   │   │   ├── DeckControls.tsx  # Play/pause/cue buttons
│   │   │   ├── WaveformDisplay.tsx # Canvas waveform + position scrubber
│   │   │   ├── LogQueue.tsx      # Next-up items from log
│   │   │   └── CartWall.tsx      # Grid of hot buttons
│   │   │
│   │   ├── library/
│   │   │   ├── SongLibrary.tsx   # Searchable, filterable song list
│   │   │   ├── SongRow.tsx
│   │   │   ├── SongEditor.tsx    # Edit song metadata + cue points
│   │   │   ├── CuePointEditor.tsx # Visual waveform cue setter
│   │   │   └── ImportDialog.tsx  # Scan folder / import files
│   │   │
│   │   ├── clock-builder/
│   │   │   ├── ClockBuilder.tsx  # Main clock editor
│   │   │   ├── FormatWheel.tsx   # SVG radial clock visualization
│   │   │   ├── SlotList.tsx      # Linear slot editor
│   │   │   └── FormatGrid.tsx    # 7×24 format schedule grid
│   │   │
│   │   ├── log-builder/
│   │   │   ├── LogBuilder.tsx    # Manual log editing
│   │   │   ├── LogHourView.tsx   # Single hour's entries
│   │   │   └── GeneratePanel.tsx # Trigger auto-generation
│   │   │
│   │   ├── spot-inventory/
│   │   │   ├── SpotInventory.tsx
│   │   │   ├── SpotEditor.tsx
│   │   │   └── BreakBuilder.tsx
│   │   │
│   │   └── settings/
│   │       ├── Settings.tsx
│   │       ├── RulesEditor.tsx   # Scheduling rules UI
│   │       └── AudioDevices.tsx
│   │
│   └── hooks/
│       ├── useEngine.ts          # Subscribe to AudioEngine events
│       ├── useSongs.ts           # Song library queries
│       ├── useLog.ts             # Current log hour
│       └── useKeyboard.ts        # Global hotkey handler
│
└── package.json
```

---

## Module Roadmap (suggested build order)

### Phase 1 — Foundation (Weeks 1–3)
- [ ] Tauri project scaffold + SQLite migration runner
- [ ] Song library import (scan folder, read ID3 tags via `music-metadata`)
- [ ] Basic song list UI with search/filter
- [ ] Category management

### Phase 2 — Scheduling (Weeks 4–6)
- [ ] Clock builder UI (slot list + SVG format wheel)
- [ ] Format schedule grid (7×24)
- [ ] Scheduler engine (rule scoring + log generation)
- [ ] Log viewer + manual overrides

### Phase 3 — Playback (Weeks 7–9)
- [ ] Dual-deck live assist player
- [ ] Waveform visualization (via Web Audio AnalyserNode + Canvas)
- [ ] Intro/outro cue point editor
- [ ] Log queue with auto-advance

### Phase 4 — Production Features (Weeks 10–14)
- [ ] Cart wall with hotkeys
- [ ] Spot inventory + break builder
- [ ] Scheduling rules editor UI
- [ ] Crossfade / segue automation
- [ ] Export logs to CSV/PDF

### Phase 5 — Polish
- [ ] Audio levels meter (VU/PPM)
- [ ] BPM detection (via Essentia.js WebAssembly)
- [ ] LUFS normalization on import
- [ ] Multi-station profiles
- [ ] Theme system

---

## Key Design Decisions

### Why no server?
Target users run this on a single Windows/Mac/Linux PC. A local SQLite file
is faster than any network round-trip, survives internet outages, and requires
zero devops knowledge to deploy.

### Why SQLite over IndexedDB?
SQL joins are essential for scheduling queries (find all songs by artist X
played in the last 2 hours, crossing category, log, and song tables).
IndexedDB has no JOIN. tauri-plugin-sql gives full SQLite with WAL mode.

### Daypart Bitmask
24-bit integer where bit N = "song is allowed to play during hour N".
Single integer → fast WHERE clause, no join to a schedule table.
`SELECT * FROM songs WHERE (daypart_mask >> 14) & 1 = 1` → songs allowed at 2pm.

### Separation Rules via Scoring
Rather than hard-blocking and backtracking (expensive), the scheduler scores
all candidates and finds the best-fitting song. Hard violations drop score by
10,000 (effectively blocks); soft violations drop by 100 (warns but allows).
This matches how real music directors think: "try not to repeat artists but
if the category is small, bend the rule."
