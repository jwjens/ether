# OpenAir — Setup Guide

## Prerequisites

Install these once, then you're good forever:

### 1. Node.js (v20+)
https://nodejs.org — download LTS installer

### 2. Rust + Cargo
```bash
# macOS / Linux:
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Windows: download rustup-init.exe from https://rustup.rs
```

### 3. Tauri system dependencies

**Windows:** Install Microsoft Visual Studio C++ Build Tools
https://visualstudio.microsoft.com/visual-cpp-build-tools/
(Check "Desktop development with C++")

**macOS:**
```bash
xcode-select --install
```

**Linux (Ubuntu/Debian):**
```bash
sudo apt update
sudo apt install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf
```

---

## First Run

```bash
# 1. Install JS dependencies
npm install

# 2. Start dev mode (opens the app window)
npm run tauri:dev
```

That's it. The app will open, SQLite DB auto-creates, migrations run.

---

## Build for Distribution

```bash
npm run tauri:build
```

Output goes to `src-tauri/target/release/bundle/`.
- Windows: `.msi` installer + `.exe`
- macOS: `.dmg` + `.app`
- Linux: `.AppImage` + `.deb`

---

## Project Structure Quick Reference

| Directory | What's in it |
|---|---|
| `src/` | React frontend (TypeScript) |
| `src/pages/` | Top-level page components |
| `src/components/` | Reusable UI components |
| `src/db/` | SQLite query functions |
| `src/store/` | Zustand state stores |
| `src/audio/` | Audio engine + scheduler |
| `src/types/` | TypeScript interfaces |
| `src-tauri/src/` | Rust backend |
| `src-tauri/src/commands/` | Tauri invoke handlers |
| `src-tauri/src/db/migrations/` | SQL migration files |

---

## Adding a Song to the Library

1. Click **Library** in the sidebar
2. Click **+ Import Music**
3. Choose a folder — the scanner reads ID3 tags automatically
4. Assign a default category (or leave blank to assign later)
5. Click **Import X Tracks**

---

## Development Notes

- The DB file lives at: `%APPDATA%/openair/openair.db` (Windows) or `~/Library/Application Support/openair/openair.db` (macOS)
- To reset the DB during development: delete that file and restart
- Audio playback currently uses Web Audio API — works in the Tauri webview
- For 24/7 automation mode: set the mode selector to **AUTO** in the top bar — the engine will auto-advance through the log queue when each track ends

---

## Phase 2 (next session) will add:
- Clock builder with SVG format wheel
- Log generator (fills a clock with real songs from your library)
- 24/7 automation auto-advance logic wired to the audio engine
- Crossfade between decks
