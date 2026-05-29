# Iris Integration — Levels

**Date:** 2026-05-29
**Type:** Design note / locked contract for the Iris integration arc. Commit-1 artifact (two-commit boundary: this doc locks before code lands).

Iris is Ether's **assistant producer** — an operator-facing AI helper. She is **not** on-air talent: her voice goes to a separate operator monitor (see `docs/iris-as-platform-content-types.md` for the forward-looking platform notes, which are NOT a spec). Today she is a standalone Electron app at `C:\iris`, bridged to Ether over REST on port 3400.

This arc deepens that integration in **levels**, each a shippable increment:

- **L1 — Live wire + presence** *(this doc)*: Ether continuously feeds Iris live station state; Ether shows whether Iris is connected.
- **L2 — Operator audio path**: route Iris's TTS to a dedicated/separate sound-card output for the operator (never the broadcast bus).
- **L3 — Supervised lifecycle**: Ether launches/restarts Iris under the existing HA watchdog pattern.
- **L4 — Content platform**: named content types, DB-row templates, AUTO/REVIEW/HOLD approval, audit log. Tiered: pre-programmed (1st tier) vs full-AI (network tier, paid-Claude/BYO).

---

## L1 — locked contract

### Key architectural finding (from the 2026-05-29 audit)

- `audio.audioGetState()` (native engine, `native/src/lib.rs:128`) returns **only** seven decks (A–F + CART), each `{ id, status, title, artist, file_path, volume, is_finished }` (`native/src/audio.rs:38`). It has **no position, no duration, no queue**.
- The rich main-process events (`audio:daemon-playstart`/`-queue`/`-deck`) fire on the **daemon path only**; they vanish on the in-process fallback.
- Position, duration, and the up-next queue are derived **only in the renderer** (`engine.getDeck('A').getState().positionSec`, `engine.getQueue()`), and the renderer already builds a consolidated payload via `buildNowPlayingPayload()` (`src/App.tsx:424`), pushed on a 3 s heartbeat (`src/App.tsx:1475`).

**Therefore L1 is fed by the renderer, not by main tapping the daemon bus.** The renderer is the single path-independent source of the complete live picture. It pushes state to main over the existing `window.ether.emit → ipcRenderer.send` bridge (`electron/preload.js:336`); main relays it to Iris over SSE.

### Transport

`GET /api/stream` on Ether's existing port 3400 — Server-Sent Events (`text/event-stream`, keep-alive). One persistent connection per Iris instance; presence falls out of the connection (open = connected).

### Events (server → Iris)

| Event | Payload | Source |
|---|---|---|
| `snapshot` | latest consolidated state + `airLive` | sent once on connect |
| `nowplaying` | `{ deck, title, artist, positionSec, durationSec }` or null | renderer `iris:state`, emitted on change |
| `position` | `{ deck, positionSec, durationSec, remainingSec }` | renderer `iris:state`, every heartbeat (~3 s) |
| `queue` | `{ upNext: [{title, artist, duration}] }` | renderer `iris:state`, emitted on change |
| `airstate` | `{ live, liveCount }` | `stream:status:global` (both paths) |
| `:keepalive` | comment ping | every ~15 s |

### Presence

An open `/api/stream` connection sets `irisConnected = true` and broadcasts `iris:connected(true)` to Ether windows; the last connection closing sets it false. Legacy `/ping` (`main.js:3213`) stays for the existing bridge. Ether surfaces `iris:connected` as a visible status indicator.

### Deferred to later steps (NOT L1 — these need new detection/engine work)

- **Talk-over / segue window** — the engine computes `intro_end`/`outro_start`/`cue_out` (`native/src/audio_engine.rs:825`) but does not expose them in state. Exposing them is engine work.
- **Dead-air detection** — not emitted today; would derive from all-decks-idle + level silence.
- **Clock / daypart / legal-ID-due** — owned by the scheduler; not emitted from main today.
- **Alerts** beyond stream up/down (track load failure, missing file, over/under level).

These are real features, not wiring; they land as deliberate later steps, not under "live wire".
