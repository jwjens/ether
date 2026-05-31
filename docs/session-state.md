# Session State — Operational Snapshot

**Updated:** 2026-05-31
**Purpose:** Tells a fresh Claude conversation (or a returning operator) *where we are operationally* — what's deployed, what's in flight, what will bite you — as opposed to `roadmap.md`, which is the long-arc architectural plan. Read both. This one is "what's actually true right now."

---

## 1. Current version + what's deployed

**Current release:** **v4.3.23** (tag `v4.3.23` points at `HEAD` = `ddb9b61`).

**Repo state:** `HEAD == origin/main == ddb9b61`. Everything is pushed and tagged. **Nothing is local-only** in the committed history. (The working tree has a pile of untracked `scripts/tmp-*.js` / `diag-*` scratch files and a few dirty `*.js`/`*.ts` files — none of it is part of the shipped build; don't commit it.)

**Last 6 commits (newest first):**

| Commit | What it did |
|--------|-------------|
| `ddb9b61` | **Stage 2b** — stripped the renderer queue-mirror echo (`replaceQueue` is now a no-op in daemon mode). **v4.3.23** |
| `0b58bf8` | **Stage 3a** — serialize preload on `advanceP` + freshen `checkEnd` guards (root-cause race fix). **v4.3.22** |
| `9d42d2d` | **Stage 3b** — stall-recovery watchdog (+ `advanceP`-wedge reset) makes dead-air impossible |
| `82be67d` | **Stage 2a** — UI writes go through daemon intents, not the queue-mirror echo |
| `f61dcc1` | **Stage 1** — daemon intent commands (`queue:*` / `deck:*`) + `boundQids` cued-entry protection |
| `caf50b0` | **Stage 0** — daemon emits `deckReady` + qids; renderer consumes `onDeck` as authoritative state |

(Version-number ordering note: Stage 3b shipped before 3a/2b in commit order but the version tags landed 3a=v4.3.22, 2b=v4.3.23. The *arc* is complete regardless of the tag/commit interleave.)

---

## 2. Item 10 arc status — COMPLETE

**All stages shipped: 0 / 1 / 2a / 2b / 3a / 3b.** The audio-daemon state-coordination arc is done in code.

- **Daemon = single source of truth** for queue + deck state (`queue`, `deck`, `deckReady`). The renderer is **read-only** — it consumes `onDeck` / `onQueue` as authoritative and never mutates engine state directly.
- **Renderer writes are intents only** — `queue:*` and `deck:*` commands addressed by per-entry `qid`. The old renderer→engine `replaceQueue` echo is gone (Stage 2b no-op).
- **`boundQids`** protects deck-bound queue entries from queue intents — a cued/loaded entry can't be yanked out from under a deck by a stray queue mutation.
- **Stall-recovery watchdog is live:** detects a >1s playout stall and recovers in sub-second time. Respects `manualCue` (won't fight an operator-initiated cue) and resets the `advanceP` wedge. Combined with Stage 3a's serialized preload, the A→B→C rotation stall is fixed and dead-air is "impossible" by construction.

Architectural detail lives in the `project_audio_daemon.md` memory and `docs/audio-daemon-phase0.md`; the wiki page is "Audio Decks & Transitions."

---

## 3. Critical gotchas — the "I'll forget this and lose hours" list

1. **THE DAEMON DOES NOT RELOAD ON APP AUTO-UPDATE.** An auto-update swaps the app bundle but the already-running `ether-engine` daemon process keeps running the OLD engine code. Engine fixes only take effect after a **full close + reopen** of Ether. This is the single most expensive thing to forget — it bit OV-dev twice.
2. **Dev-mode daemon must be spawned manually:** `npx electron audiod/ether-audiod.js`. If you don't, the 5s connection probe times out and the app silently falls back to the **in-process** engine — so your daemon changes appear to "do nothing."
3. **Staged daemon location:** `%LOCALAPPDATA%\Ether\engine\audiod`. To refresh it in dev, **copy the repo's `audiod/*.js` there, then kill the process** so it respawns on the new code. (It runs as a staged `ether-engine.exe`.)
4. **Watchdog needs `_started=true`.** If the daemon respawns mid-session, the watchdog stays gated off (`_started=false`) and will NOT auto-resume the show — the app must reissue `automationStart` over the pipe. This is the documented auto-resume gap (see §4). Manual `automationStart` over the named pipe recovers a stall/wedge.
5. **DevTools console filters log output.** Use `await <expression>` to RETURN a value (return values always display) instead of `console.log(...)`, which gets swallowed by the console filter. Drive/inspect the daemon via the named pipe.
6. **Commits run through Claude Code in a separate PowerShell terminal.** Claude-in-chat is the architect/reviewer; Claude Code executes commands, runs PowerShell, and hits the daemon pipe directly.

---

## 4. Known open items — do NOT surface these as "new"

- **Auto-resume gap (the real prod follow-up).** On a fresh daemon reconnect, if the station *was on air*, the app must auto-reissue `automationStart`. Today the watchdog is gated on `_started=false`, so it won't; manual `automationStart` over the pipe is the current recovery. Full scope is in the `project_audio_daemon.md` memory. **This is the top open item of the arc** — bit OV-dev twice on 2026-05-30.
- **`loadToDeck` → `deck:cue` migration.** `JockStrip` / `Spots` / `PhoneDesk` / `DeckConfigurator` panels still call the legacy `loadToDeck` instead of the `deck:cue` intent. Cosmetic cleanup, **not urgent** — they still work; they just bypass the intent seam.
- **Item 10 is COMPLETE.** The next roadmap item is **operator choice** — Iris (assistant producer), AirLogger, Plugins/OSS/BYO-Cloud, and Onboarding are all open and don't block each other. No default has been picked.

---

## 5. Workflow rules — settled, do not re-deliberate

- **The human is NOT the message bus.** Jeff does not relay commands between Claude-in-chat and Claude Code. Claude Code drives commands, runs PowerShell, and hits the daemon pipe directly.
- **Engineering bar:** *"Better than RCS Zetta — customers never see broken air."* Correctness > speed, always.
- **Investigation first**, then a plain-language plan, **then** code. Never patch symptoms.
- **Stage-by-stage migrations with locked decisions.** Once an architectural decision is settled it is not re-debated.
- **Single commit per stage**, each with a CHANGELOG entry. **Never push or tag without an explicit operator OK.** (Local commits only; the operator runs parallel sessions on the same repo.)

---

## 6. Customer state

- **OV** — Opportunity Village, Las Vegas — **Windows**, live production.
- **USPH** — US Phenomenon — **macOS**, live production.
- Both should be running **v4.3.22 + v4.3.23** after auto-update **and a full close-and-reopen** (see §3 gotcha #1 — without the reopen, the daemon is still on old engine code).
- **Pending operator action:** send OV and USPH the **close-and-reopen notice** so the v4.3.22/23 engine fixes actually take effect.

---

## 7. Where to look next

- **Operational state:** this file.
- **Architecture / long arc:** `roadmap.md`.
- **Audio daemon deep dive:** `docs/audio-daemon-phase0.md` + the `project_audio_daemon.md` memory.
- **HA arc (complete):** prior detail preserved in git history / the `project_ha_phase3.md` memory — the whole arc (Phases 1–5 + 2.5) shipped 2026-05-24; only manual packaged-build validation remains.
