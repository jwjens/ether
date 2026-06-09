# Iris Read-Only Audit — 2026-05-31

Read-only. No edits, builds, or commits made. Findings only.

## 1 — Shape
- `C:\iris` dirs: `dist/ electron/ node_modules/ scripts/ src/`
- Root files: `hardware-server.js iris-alarms.js iris-brain.js iris-ether-feed.js iris-launch.log iris-memory.db iris-memory.js iris-server.js iris-stt.js iris-tcp-audio.js iris-voice.js Iris.bat package.json package-lock.json tsconfig.json vite.config.ts ether-tours.json .env .env.example`
- `src/`: App.tsx, index.tsx, index.html, styles.css. `electron/`: main.js, preload.js. `scripts/`: free-port.js, setup-vosk.js
- **package.json**: name `iris`, version `1.0.0`, main `electron/main.js`. Scripts: dev:renderer, dev:main, dev, build, start, hardware-server. Deps: @deepgram/sdk ^3.13, axios ^1.7.9, dotenv, electron ^41.1.1, express ^4.21.2, node-record-lpcm16, sql.js ^1.14.1. DevDeps: react 18.3, vite 6, typescript 5.7, concurrently, cross-env, wait-on.
- **Git: NOT a git repo.** `git -C C:\iris status` → fatal: not a git repository. No tags, no history.

## 2 — Server / port 3399
- Express entry = `iris-server.js`, started from `electron/main.js` boot (`irisServer.start(3399)`), bound `127.0.0.1:3399` (loopback only). `freePort(3399)` kills any prior listener first.
- Routes (3 total):
  - `POST /now-playing` — local clients (Ether) push track info; fires onTrackChange cb
  - `GET /now-playing` — inspect current cached track
  - `GET /health` — `{ok:true}`
- Separate Express app in `hardware-server.js` binds `0.0.0.0:3401` (`POST /audio` chunks → STT, `GET /health`). Run as its own `node` process via the `hardware-server` npm script / concurrently.

## 3 — Memory store
- Backed by **SQLite via sql.js** (pure-WASM, in-memory image serialized to `iris-memory.db` on every write via `persist()` = `db.export()` → `fs.writeFileSync`). NOT better-sqlite3, NOT flat files, NOT a vector store.
- Schema (3 tables, all in the one db):
  - `conversations(id, timestamp, role, content)` — rolling chat log
  - `facts(key UNIQUE, value, updated_at)` — key/value personal facts (upsert)
  - `alarms(label, fire_at, recurrence, custom_days, active, created_at)` — created in iris-alarms.js, shares `memory.rawDb()`
- Read/write path: `iris-memory.js` exports `init/saveMessage/getRecentMessages/setFact/getFact/getAllFacts/rawDb/persist`. The Electron **main process** is the only reader/writer — brain (`think()`) calls getRecentMessages(20)+getAllFacts() per turn and saveMessage() after. The **renderer** never touches the DB directly; it asks via IPC `iris:history` → getRecentMessages(50). No multi-frontend shared access; single-process owner.

## 4 — RAG / vector DB
- **Not wired. Not even stubbed.** No vector store, no embeddings, no ingest path, no broadcast corpus. Only sql.js relational tables (above). All "vector"/"embedding"/"rag" grep hits are incidental (node_modules, CSS `vector-effect`, auto-reconnect comments).
- Closest thing to a knowledge base = `ether-tours.json` (static JSON of `tours` + `concepts`) loaded once at boot in iris-brain.js and surfaced through the `ether_tour` / `ether_help` tools as plain string lookup + fuzzy substring match. No retrieval scoring.
- Row counts: conversations/facts/alarms in `iris-memory.db` (not queried — would need a script run; can do on request). **Vector count: N/A — no vectors exist.**

## 5 — LLM backend
- **Single provider, hardcoded to Anthropic Claude.** Direct `axios.post('https://api.anthropic.com/v1/messages', …)` in iris-brain.js. Model `claude-haiku-4-5-20251001` in two places: the main `think()` loop (max_tokens 300, tools) and `extractAndSaveFacts()` (max_tokens 200).
- **No BYO multi-provider abstraction.** No OpenAI/Gemini client, no provider switch, no router. (The forward-looking spec in docs calls for swappable LLM module — not built here.)
- API key read from `process.env.ANTHROPIC_API_KEY` via `dotenv` (`.env` in repo root). Sent as `x-api-key` header with `anthropic-version: 2023-06-01`.

## 6 — Voice / TTS
- Engine = **ElevenLabs** (cloud REST). `iris-voice.js` `fetchAudio()` → `POST /v1/text-to-speech/{voiceId}`, returns MP3 as base64.
- Runs **in-process** (no child process) inside the Electron main process. Invoked from `handleUserInput()` in main.js after `think()` returns; base64 is sent over IPC `iris:speak` and played in the renderer via a data-URI `<audio>` element. Fallback on failure → `iris:speak-text` (browser speechSynthesis).
- Voice/key from `ELEVENLABS_API_KEY` + `ELEVENLABS_VOICE_ID` (.env). Model `eleven_turbo_v2_5` (English) auto-swaps to `eleven_multilingual_v2` on language switch.
- STT (separate) = **Deepgram** Nova streaming (`@deepgram/sdk`, `DEEPGRAM_API_KEY`) in iris-stt.js. `scripts/setup-vosk.js` exists but Vosk is not the active engine.

## 7 — Front-ends that exist / connect today
- **Atom Echo TCP** — REAL. `iris-tcp-audio.js`: raw-PCM16 TCP server on `0.0.0.0:5555` (`IRIS_TCP_PORT`), single active client, feeds chunks to STT. Started at boot. (`hardware-server.js` `:3401 POST /audio` is a second HTTP path for the same WiFi-mic role.)
- **Standalone UI** — REAL. Electron BrowserWindow (440×700 frameless tray app) loading the Vite React app (`src/App.tsx`, built to `dist/`). Mic capture, text input, history, mute, alarms.
- **Ether "Executive Producer" client** — Iris is the *client of* Ether, not the reverse. It connects OUT to Ether on `127.0.0.1:3400`: SSE live wire `iris-ether-feed.js` (`GET /api/stream`), control via `control_ether` tool (`/api/transport`, `/api/macro`, `/api/status`, `/api/now-playing`, `/api/log`, `/api/gpio/status`), pushes captions to `/api/captions/iris`, and pings `/ping` every 10s. Ether running is optional (all calls fail-soft). There is no inbound Ether→Iris control client.

## 8 — Item-4 platform primitives (content types / templates / approval / triggers / audit)
Grepped whole repo. **None of the Iris-as-platform primitives exist** — this is a personal voice-assistant build, not the platform arc.
- Content categories (Music Tease / Station Promo / Rad Rewind / etc.) — **not started**
- Versioned templates (first-class, per-station overridable) — **not started**
- Approval modes AUTO / REVIEW / HOLD — **not started** (no approval queue, no UI)
- Trigger adapters (time / event / operator / listener / system) — **not started** (only inbound = wake word + SSE now-playing context)
- Audit log (non-deletable content-generation record) — **not started**
- Voice-track generation pipeline (data fetch → template fill → LLM → TTS → approval → schedule) — **not started**. Today Iris only does live conversational Q&A + Ether transport control. No content is generated *for air*.

## 9 — Design doc
Full contents of `C:\openair\docs\iris-as-platform-content-types.md` were read in-session (dated 2026-05-13, "forward-looking notes, NOT a spec"). 219 lines: §2 the third-party RadioDJ 6-agent pattern, §3 why it's wrong for Ether (latency/state/attack-surface/failure/no-reactivity), §4 what to import (named templates, AUTO/REVIEW/HOLD approval, read-only pipeline viz), §5 what not to (multi-process, FS message bus, cloud on critical path, public voice library default), §6 module shape (voice/script/data-fetch/template/approval/scheduling/audit modules), §7 trigger sources, §8 open questions (process model, template storage, multi-station, queue sync, LLM fallback, FCC), §9 doc relationships.

**Bottom line:** C:\iris is a working single-provider (Claude Haiku) personal voice assistant with Deepgram STT + ElevenLabs TTS, a sql.js relational memory, and a one-way client link into Ether. It is NOT under version control, has NO RAG/vector layer, NO multi-provider LLM abstraction, and ZERO of the Iris-as-platform Item-4 primitives. The platform arc described in the openair design doc is unstarted.
