# Ether — Free Broadcast Automation

![Ether](https://img.shields.io/badge/version-1.5-blue) ![Platform](https://img.shields.io/badge/platform-Windows-lightgrey) ![License](https://img.shields.io/badge/license-MIT-green)

**Ether is a free, open-source broadcast automation platform for radio stations, theme parks, venues, and anyone who needs professional-grade audio scheduling without the $10,000/year price tag.**

Built as a modern replacement for RCS Zetta, GSelector, and similar systems — Ether runs on any Windows PC and handles everything from live assist to 24/7 automation.

---

## ⬇️ Download

**[Download Ether v1.5 for Windows →](https://github.com/yourusername/ether/releases/latest)**

> **Note for Windows users:** Windows may show a security warning when installing because Ether is new software without a paid Microsoft certificate. This is normal for independent apps.
>
> To install: click **"More info"** → then **"Run anyway"**
>
> Ether is fully open source — you can review every line of code in this repository.

---

## What Ether Does

- **Live Assist** — Three-deck player with waveform display, VU meters, crossfade, and intro/outro detection
- **24/7 Automation** — Schedule-based log generation with artist and song separation rules
- **Song Library** — Import and manage your entire music catalog, with loudness normalization
- **Voice Tracking** — DAW-style recording studio with live waveform, hour programming clock
- **Show Prep** — Write scripts, manage liner cards, monitor the board — all in one screen
- **Spots & Promos** — Manage jingles, PSAs, commercials, and liners
- **Scheduled Announcements** — Auto-play audio at specific times with music ducking
- **Play Logs** — Full traffic logs with BMI/ASCAP export and PDF generation
- **Remote Control** — Control Ether from any phone on your network, no app needed
- **Now Playing Screen** — Dedicated display window and JSON endpoint for your website

---

## System Requirements

- Windows 10 or 11 (64-bit)
- 4GB RAM minimum, 8GB recommended
- Any audio interface or built-in sound card
- 500MB disk space (plus your music library)

---

## Installation

1. Download the `.msi` installer from the [Releases page](https://github.com/yourusername/ether/releases/latest)
2. Double-click the installer
3. If Windows shows **"Windows protected your PC"**:
   - Click **"More info"**
   - Click **"Run anyway"**
4. Follow the installer prompts
5. Launch Ether from the Start menu or desktop shortcut

### Why does Windows show a warning?

Windows SmartScreen flags software that doesn't have a paid code-signing certificate from Microsoft. These certificates cost $200–400/year and are typically only purchased by large companies. Ether is free and open source — every line of code is visible in this repository. The warning does not mean the software is harmful.

---

## Getting Started

### 1. Import your music
Go to **Library → Import Music** and select your music folder. Ether will scan and import all MP3, FLAC, WAV, and M4A files automatically.

### 2. Assign categories
In the Library, use the Category column to assign songs to rotation categories (A, B, C, D). Category A = your most played hits, B = currents, C = recurrents, D = gold.

### 3. Set up a clock
Go to **Schedule** and create an hour clock. Drag categories into time slots to define your rotation format.

### 4. Go live
Hit **Auto ON** on the main screen and Ether will start playing automatically based on your clock.

---

## Running from Source

If you want to build Ether yourself:

### Prerequisites
- [Node.js 18+](https://nodejs.org)
- [Rust](https://rustup.rs)
- [Tauri CLI](https://tauri.app/v1/guides/getting-started/prerequisites)

### Setup
```bash
git clone https://github.com/yourusername/ether.git
cd ether
npm install
```

### Development
```bash
npm run tauri dev
```

### Build installer
```bash
npm run tauri build
```
The `.msi` installer will be output to `src-tauri/target/release/bundle/msi/`

---

## Tech Stack

- **Frontend:** React + TypeScript + Vite
- **Backend:** Rust (Tauri)
- **Audio:** Rodio (Rust audio engine)
- **Database:** SQLite (via tauri-plugin-sql)
- **UI:** CSS custom properties, no UI framework

---

## Contributing

Pull requests are welcome. For major changes please open an issue first to discuss what you'd like to change.

Areas where help is especially welcome:
- macOS and Linux support
- Additional audio formats
- Streaming output (Icecast/SHOUTcast integration improvements)
- Translation/localization

---

## License

MIT — free to use, modify, and distribute. No attribution required.

---

## About

Ether was built out of frustration with the broadcast automation industry — where basic software costs tens of thousands of dollars per year and hasn't meaningfully improved in decades. Small stations, theme parks, venues, and hobbyists deserve professional tools too.

If Ether saves your station money, consider starring the repo or spreading the word.

---

*Ether is not affiliated with RCS, GSelector, WideOrbit, or any other broadcast automation vendor.*
