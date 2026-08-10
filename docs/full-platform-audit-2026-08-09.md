# EtherCast — Full Platform Audit
**Date:** 2026-08-09 · **Branch:** `log-reader-flip` · **Method:** 6 delegated deep-read passes (DeepSeek v4-pro) over real source, + local verification of the critical claims by Claude Code.

> **Epistemic status.** Every finding below is derived from *source*, not from a running app. Per the project rule, a grep is a claim about the tree, never about the product. Findings I personally verified in this session are marked **[VERIFIED]** with the receipt. Findings that require a runtime receipt before you act on them are marked **UNVERIFIED — check X**. Nothing here should be treated as proof of runtime behavior unless it carries a [VERIFIED] tag.

---

## 0. EXECUTIVE SUMMARY

EtherCast is **further along than its reputation and further behind than its ambition**, and the gap between those two is almost entirely *structural debt*, not missing features.

**The honest headline:** you have built a genuinely differentiated broadcast platform — a never-dead-air playout ladder, complete per-station isolation, an out-of-process audio daemon with watchdog recovery, a real non-destructive multitrack DAW, and a coherent, *already-designed* AI assistant contract. Very few competitors have that combination and none have it in one installable app.

**The problem:** the product's correctness now depends on a small number of load-bearing structures that are each one bad day away from a customer-visible failure:

1. **Playout truth is duplicated three ways** (Rust `BusState` → daemon `stateA/B/C` → renderer `stateA/B/C`), and *none of them is the sample clock*. Position is extrapolated from wall-clock in both JS layers. Every timing feature you're building — segue accuracy, the time-anchored playhead, spot anchoring — is being built on an estimate.
2. **The renderer has no data layer.** ~86k lines of TSX call IPC directly, untyped, unvalidated. `App.tsx` is 6,294 lines and re-renders the whole tree on every deck tick.
3. **The main process is one 8,306-line file** exposing a generic SQL handler and a generic filesystem handler to the renderer, with `webSecurity: false` on eight windows. **[VERIFIED]**
4. **Secrets and a database dump are committed to git history.** **[VERIFIED]** — this is the one item that is genuinely urgent.

**On Iris:** the strategy question is already answered by your own binding docs, and the audit's independent recommendation landed on the same answer — a **typed internal intent API with a thin model adapter**, not MCP, not plugins. The single most valuable thing you can do for Iris is not AI work at all: it is **capturing scheduler decision data now** so `explainPick` is possible later. That is a schema change, not a model.

**The one-sentence verdict:** stop adding surfaces, spend one release hardening the four structures above, and Ether becomes very hard to catch — because the *architecture* is right and the competitors' architecture is 20 years old.

---

## 1. ARCHITECTURE REVIEW

### 1.1 Process topology (as built)

```
Renderer (React · engine-rodio.ts)      ← mirror copy of deck state
   │ contextBridge IPC
Electron Main (main.js, 8306 lines)      ← 200+ IPC handlers, no layering
   │ named pipe / unix socket
ether-audiod daemon (engine.js, 2038)    ← operational truth: queue, decks, advance
   │ NAPI
native/audio.rs (cpal + mixer)           ← ground truth: buffers, output, peaks
```

**Verdict: the process split is correct and is your biggest architectural asset.** Isolating audio in a separate process with a watchdog is what lets you survive a renderer crash. Keep it.

### 1.2 The core defect — three competing copies of playout truth

State duplicated across daemon and renderer: **deck state** (`stateA/B/C`), **queue**, **deckReady** (Set), **deckSched / deckContentClass**, **engine state**. The daemon and the renderer run *the same algorithms independently* on *separately maintained copies*.

This is the root cause under several bugs already in your memory ledger — the deck-UI-state-mixing defect and the countdown oscillation regression are both symptoms of two copies disagreeing about which track a deck holds.

**Worse: neither copy is the audio clock.** Both derive position by wall-clock elapsed time (`poll()`, ~250 ms tick). Rust exposes no sample-accurate position — this matches your own ledger entry *"daemon getState has no position/duration."* Therefore:

- **Segue/crossfade timing is an estimate**, drifting by accumulated extrapolation error (segue fires on `durationSec - positionSec`).
- **The time-anchored playhead** (log-reader flip §2.7) is being anchored against an estimated position.
- **Spot anchor drift** — already a documented open issue — has this as a plausible root cause.

> **Recommendation (highest structural leverage in the whole audit):** expose a **monotonic sample counter from Rust** as the single position authority, and extract a **pure `QueueEngine` state machine** (no I/O — takes tick/command events, emits state diffs) shared by daemon and renderer fallback. This kills the duplication *and* makes playout logic unit-testable for the first time.

### 1.3 Real-time hazard: the mixer callback zero-fills on lock contention

```rust
let mut bus = match bus_arc.try_lock() {
    Ok(b)  => b,
    Err(_) => { data.iter_mut().for_each(|s| *s = 0.0); return; }   // ← silence
};
```
`native/src/audio.rs`, `mixer_callback`. If the command thread holds the mutex when the audio callback fires, **the callback writes silence for that buffer** (~2–10 ms). Under a burst of commands this becomes audible.

**UNVERIFIED — check:** instrument a counter for the `Err(_)` branch and log its rate during a normal hour of playout. If it is non-zero under load, this is a real on-air artifact and the fix is a lock-free ring buffer / triple-buffer handoff rather than a mutex on the audio path.

### 1.4 Bottlenecks (ranked)

| # | Bottleneck | Evidence | Risk |
|---|---|---|---|
| 1 | Sync SQLite on the daemon's 250 ms poll path | `DaemonEngine.refillIfNeeded()` → `loggen.fillQueue()` (blocking `node:sqlite`) | Blocks the event loop → delays end-detection and overlap firing → gap or double-play |
| 2 | Mixer callback zero-fill under lock contention | `audio.rs mixer_callback` | Direct audible dropout |
| 3 | Serialized `_advance()` promise chain with unbounded work | `engine.js _advance()` | One slow op holds deferred stops → outgoing deck plays past crossfade (echo/overlap) |
| 4 | Whole-tree re-render on every deck tick | `App.tsx` `engine.on(...)` → `setDeckA/B/C` at top level; children not `React.memo`'d | UI stutter during playout; VU/countdown jank |
| 5 | Broadcast event herd | `ether-audiod.js` levels @100 ms + deck @300 ms, `JSON.stringify` per client | Background CPU, scales badly with stations/clients |

### 1.5 Failure modes & dead-air paths

| Failure | Behavior | Fallback | Honest? |
|---|---|---|---|
| Daemon dies | cpal stops → **immediate silence**; respawn ~1 s | Partial — in-process fallback only engages if daemon *never* connected; **no hot takeover** | ✗ no operator dead-air notification |
| Rust addon fails to load | `require` throws → daemon exits → **no audio, any station** | None | UNVERIFIED — check whether `main.js` startup surfaces this to the user |
| File missing/corrupt | `loadToDeck` → `_fileOk()` false → skip + advance | Yes | ✓ emits `error` + `loadskip` |
| DB locked | `busytimeout 5000` blocks daemon event loop | Watchdog eventually recovers | ✗ no "DB contention" alert |

The **daemon-dies path is your most likely customer-visible dead air**, and it compounds a known open item in your ledger (cold-stage daemon race on first launch after update). It deserves a hot-takeover path, not just respawn.

**Modularity score: 5/10.** Excellent process boundaries; poor internal cohesion. `DaemonEngine` (2,038 lines) and renderer `AudioEngine` (1,091) implement overlapping logic that must be fixed twice, every time.

---

## 2. SECURITY & TECHNICAL DEBT

### 2.1 🔴 CONFIRMED LEAK — secrets and a DB dump are in git history **[VERIFIED]**

I checked each file with `git ls-files --error-unmatch`. The delegate's blanket "committed secrets" claim was **partly wrong** — most of the loose files are untracked working-tree clutter. But three are real:

| File | Status |
|---|---|
| `key iris.txt` | **TRACKED IN GIT** |
| `keys  - weather.txt` | **TRACKED IN GIT** |
| `ether-backend-pre-migration.dump` | **TRACKED IN GIT** |
| `deepseek api.txt` | untracked (working tree only) |
| `ether-guests-couldflare-keys-tokens.txt` | untracked (working tree only) |
| `openair-backup.db`, `Ether_1.9.1_x64-setup.exe` | untracked (working tree only) |

`.gitignore` exists (921 bytes) but does not cover these. **Deleting the files now does not remove them from history** — anyone with repo access can recover them from any prior commit.

**Action:** rotate the Iris and weather keys, assess what the backend dump contains (it may hold customer license/station data), then decide on history rewrite vs. rotation-only. Per your standing rule I have changed nothing and am not treating chat-visible secrets as requiring panic — but *these are in a git repo*, which is exactly the "reached somewhere untrusted" condition.

### 2.2 🔴 `webSecurity: false` on eight BrowserWindows **[VERIFIED]**

`electron/main.js` lines 2103, 2127, 2341, 4587, 4690, 4770, and more. `contextIsolation: true` and `nodeIntegration: false` are correctly set throughout — good — but `webSecurity: false` disables same-origin policy, and `sandbox: false` (2126, 4690) removes the renderer sandbox. The stated reasons in comments are *"allow file:// assets"* and *"allow localhost in dev"* — both solvable with a custom protocol handler (`protocol.handle` for an `ether://` scheme) instead of switching off web security in production windows.

### 2.3 🔴 Generic SQL and filesystem handlers exposed to the renderer **[VERIFIED]**

```
main.js:3833  ipcMain.handle("db:query",       (_, sql, params) => …)
main.js:3881  ipcMain.handle("db:execute",     (_, sql, params) => …)
main.js:3909  ipcMain.handle("fs:readFile",    async (_, filePath) => …)
main.js:3922  ipcMain.handle("fs:readFileTail",async (_, filePath, n) => …)
```
The preload exposes ~174 functions. This is a **broad passthrough, not a narrow allowlist**: any renderer-side compromise (XSS through imported metadata, a bad dependency) yields arbitrary SQL over the station database and arbitrary file read. Combined with `webSecurity: false`, the blast radius is the whole machine.

Note this is a *defense-in-depth* finding, not an active exploit — there is no known injection vector today. But you ship to a managed corporate box with McAfee; this is the shape of thing that gets an install flagged.

### 2.4 Other confirmed risks

- **Cloud backups upload an unencrypted DB snapshot** containing plaintext license keys, JWTs, and Icecast passwords (`cloud-backup.js runBackup()`). TLS protects transit; the blob at rest on R2 is not encrypted.
- **Main-thread blocking in backup:** `fs.readFileSync` + `zlib.gzipSync` on a multi-hundred-MB DB. UNVERIFIED — check actual freeze duration against a real library.
- **Mobile server** (`mobile-app.js`) is upload/list only with a paired bearer token — *no playout control*, so risk is **moderate not critical** — but it runs over plaintext HTTP on the LAN and tokens never expire.
- **AI API keys are correctly protected** via `safeStorage`. Credit where due.

### 2.5 Repo hygiene

~300 loose `fix-*.js` / `patch*.js` mutation scripts in the repo root; **23 are tracked in git [VERIFIED]**. Plus stray top-level source (`LibraryPage.tsx`, `engine.ts`, `scheduler.ts`, `library.rs`, `models.ts`) that shadows the real `src/` tree and will mislead every future reader — human or AI. `package.json` still carries Tauri scripts from a previous life, which is why one audit pass mistakenly described the app as Tauri-based.

### 2.6 Renderer debt

- **No data layer.** Every component calls `(window as any).ether.invoke(...)` directly; `App.tsx` has 50+ such sites. IPC is typed `Promise<any>`; responses are never shape-validated. Your own ledger already records the `{rows:[...]}` unwrap trap — that trap exists *because* there is no boundary.
- **`App.tsx`:** 80+ `useState`/`useRef`, 35+ `useEffect`, holding routing, engine lifecycle, deck subscriptions, automation, the SSE command bus, cloud sync, now-playing heartbeat, auth gating, and skin/update UI. The SSE `execCmd` closure capturing `engine` at mount is the *exact* pattern behind your open "command-path station scoping" ledger item.

---

## 3. FEATURE COMPLETENESS vs ZETTA / GSELECTOR

### 3.1 What the scheduler actually does

A **four-tier fill ladder** (`loggen.js` / `loggen.ts`):
- **Tier 0** — `generated_schedule` read forward via cursor (authoritative)
- **Tier 1** — active show clock → one *random* song per category slot
- **Tier 2** — SmartRules (localStorage: energy/BPM/genre/day/hour) if Tier 1 yields <50%
- **Tier 3** — filtered random within on-format categories
- **Tier 3b** — least-recently-played across the station library (never dead air)

Separation: **artist** separation enforced station-scoped via `play_log` in the daemon. **Title** separation exists in schema but is not used on the default path. **Dayparting** via `daypart_mask` bitmask is solid and enforced in every tier.

> ⚠️ **Defect worth confirming:** the renderer copy `loggen.ts:373` uses `songs.last_played_at` — which is **shared across stations** — while the daemon correctly uses station-scoped `play_log`. If the renderer path is ever live, separation is wrong on multi-station installs. UNVERIFIED — check whether `loggen.ts` still executes in any shipping path post-flip.

### 3.2 GSelector parity

| Capability | Status |
|---|---|
| Multi-station isolation | **HAVE** — complete, and better than legacy Zetta installs |
| Rule relief ladder | **PARTIAL** — fixed relief order, not a configurable breakable/unbreakable hierarchy |
| Artist separation, configurable window | **HAVE** |
| Title / album / composer separation | **PARTIAL** (title in schema, unused) / **MISSING** |
| Dayparting | **HAVE** |
| Sound codes, tempo, energy, mood, texture | **PARTIAL** — energy/BPM via SmartRules only; no sound codes, mood, texture |
| **Rotation goals / turnover per category** | **MISSING** — `spins_per_hour` exists in the UI and **the scheduler never reads it** |
| Packets, gold/current balance | **MISSING** |
| "Why was this picked" explainability | **MISSING** |
| Manual log editing + violation warnings | **MISSING** |
| Non-destructive re-generate | **MISSING** — `generateDay` clears the day; manual edits are lost |
| Rotation histogram / artist burn / turnover reports | **MISSING** |

### 3.3 Zetta playout parity

| Capability | Status |
|---|---|
| Never-empty fill ladder | **HAVE** — genuinely ahead; Zetta/GSelector error out on rule conflict |
| Station-scoped everything | **HAVE** |
| AUTO / MANUAL | **PARTIAL** — no true live-assist mode |
| Silence detection, watchdog restart | **PARTIAL** — single machine only |
| Program-bus audio processing | **HAVE** (audit pass said MISSING — **that is wrong**; your ledger records Audio Processing v1, loudness ride + −1 dBTP limiter, shipped v4.4.91 with both toggles default-off) |
| Voice tracking | **PARTIAL** — `VoiceTracker.tsx` (1,241 lines) exists; not in the audited set, see §4.3 |
| Hard/soft/anchored times, backtiming, join-in-progress | **MISSING / IN FLIGHT** — this is the log-reader flip |
| Cart wall / hotkeys | **PARTIAL** |
| Log editing while on air | **MISSING** |
| As-run / affidavit / traffic reconciliation | **PARTIAL** — `play_log` exists; your ledger records an affidavit feature shipped, but traffic reconciliation is absent |
| GPIO / EAS / satellite | **PARTIAL** — `gpio-engine.js` and `EASLogbook.tsx` exist but were outside this audit's file set |
| Dual-machine failover | **MISSING** |

### 3.4 The five gaps that actually block a commercial sale

| # | Gap | Effort | "Done" looks like |
|---|---|---|---|
| 1 | **No rotation goals / turnover control** — clock slots pick *at random* | **L** | Category scheduler tracks turnover, honors `spins_per_hour` + priority, fills slots LRP-first under separation |
| 2 | **Playout drifts from wall time** (documented up to 41 min) | **M** | Finish the log-reader flip: playhead snaps to nearest row at each boundary, elapsed rows stamped `missed`, auto-fitter bounds drift |
| 3 | **No manual log editing / safe regeneration** | **M** | Drag-reorder + insert with live rule warnings; "regenerate" replaces only unfilled portions |
| 4 | **Voice tracking incomplete** | **L** | Waveform + overlap, 3-deck preview, insert into log |
| 5 | **No traffic reconciliation** | **M** | As-run vs scheduled export, spot counts by advertiser, traffic import/export |

**Gaps 1 and 2 are the ones that lose a bake-off.** A PD will forgive a missing editor; they will not forgive "the log says 3:14 and it's actually 3:55."

---

## 4. CREATIVE SUITE (Editor / DAW / Video)

### 4.1 What is genuinely built

**StudioPro is a real DAW**, not a mockup: dynamic multitrack, non-destructive region EDL, per-track 10-band EQ + compressor + convolution reverb + saturation + sidechain, master EQ/comp/brick-wall limiter, full **automation lanes** with breakpoints scheduled via `linearRampToValueAtTime`, LUFS-momentary metering, correlation meter, goniometer, auto-normalize to −23/−16/−14/−9, beat grid, markers, WAV + stem export, **session save/load as JSON**, and an undo/redo stack.

**BroadcastEditor** is a focused 3-track (BED/SONG/VOICE) production tool with 3-band EQ, mic recording, WAV + MP3 export.

That is well beyond what "built-in editor" usually means. Credit where due.

### 4.2 The real gaps vs Audition/Reaper (ranked by how often they block daily work)

1. **No time-stretch / pitch-shift** — no `playbackRate`, no phase vocoder. *You cannot squeeze a song to fit the clock.* For radio production this is the #1 daily blocker.
2. **No clip-gain envelope** — only a constant `clipGainDb`; you cannot ride a vocal internally.
3. **No noise reduction / de-essing** — every voice-over cleanup still requires leaving the app, which defeats the entire "don't need Audition" claim.
4. No automation *recording* (touch/latch), no scrubbing/jog, no VST/AU host, no submix busses.
5. Hard-coded 44.1 kHz with no sample-rate conversion.

### 4.3 🟡 Honest-UI violation — "Send to Deck" appears to be a dead end **[VERIFIED grep, runtime UNVERIFIED]**

`StudioPro.tsx:2642` and `VoiceTracker.tsx:732` both dispatch:
```js
window.dispatchEvent(new CustomEvent("ether:deck-load", { detail: { deck, filePath: url, … } }))
```
I grepped `src/`, `electron/`, and `audiod/` for `ether:deck-load`. **There are two dispatchers and zero listeners.** StudioPro additionally passes a `blob:` URL, while the real deck-load path takes a filesystem path.

**I am explicitly not calling this broken.** Your own rule exists because this exact inversion — "I grepped and found no case, therefore it's dead" — shipped a false premise before (the `videostudio` popout, 2026-07-29).

**UNVERIFIED — the one check that settles it:** in the running app, open StudioPro, click **To Deck**, and watch whether the deck loads. 30 seconds, and it is definitive. If it does nothing, this violates the stated *"send-to-deck must ride the real deck-load path or be omitted"* principle — and note **VoiceTracker has the same pattern**, which would make it a two-surface defect, not one.

### 4.4 Video: there is no clip editor

`ClipEditor.tsx` is a **recorder**, not an editor — `getUserMedia` → canvas composite → `MediaRecorder` → WebM, with aspect presets. There is no timeline, no trimming, no overlay, and **`ffmpeg-static` is a dependency that this code never calls**.

**Auto-clipping for social cannot ship on this foundation.** It needs: a video timeline with trim regions, an ffmpeg render path, caption burn-in, safe-zone presets, and a job queue so long renders don't block the UI. Treat "phone clip video editing" and "cross-platform distribution" as **not yet started**, not as partially built.

### 4.5 The AI seam is better than expected

StudioPro's reducer already exposes `ADD_TRACK`, `ADD_REGION`, `MOVE_REGION`, `TRIM_REGION`, `SPLIT_REGION`, `UPDATE_REGION`, and state is readable from `stateRef.current.tracks`. **An AI-generated arrangement is expressible as a sequence of these actions today.** The only missing piece is a batch/atomic applicator (`applyActions(Action[])`) plus a preview/accept gate. That is days of work, not months — and it means "Iris generates a DAW arrangement" is the *most* feasible of your creative-AI goals, not the least.

---

## 5. IRIS INTEGRATION STRATEGY

### 5.1 Your docs already decided this — and the independent audit agreed

Binding decisions confirmed in `iris-ether-contract.md` / `iris-integration-arc-2026-08-06.md`:
- Iris is a **separate process**, crash-isolated; **never on-air** (separate operator monitor, never the program bus).
- The deterministic playout floor is **Iris-independent** — the daemon never knows she exists.
- **Two-tier grant:** Tier 1 (scheduling/generation) autonomous; Tier 2 (transport) refused unless the command carries `source: "operator"`.
- **Ether is the server** on `:3400`; Iris is the client. State down via SSE, commands up via POST.
- Station identity is **UUID** across every boundary.
- Knowledge = curated operator help corpus + authored broadcast theory. **RAG/vector explicitly deferred.**
- Iris ships inside Ether's installer, spawned and supervised like `ether-audiod`.

**Architecture recommendation: (b) internal typed command/intent API with a thin model adapter.** Not MCP — MCP is built for remote model orchestration and would invert your "Ether is the server, Iris is the client" contract while adding a protocol you'd have to keep offline-capable. Not plugins — premature; the surface is finite. The intent API keeps the model **swappable** and lets a tiny local model (or even rule-based matching) drive the same intents when there's no network, which is the only way to satisfy offline-first.

### 5.2 🔴 Gate 0 — the transport side-door must close before anything else

`iris-phase1-report.md §7` already records it: **`/api/transport/*` is unauthenticated and bypasses `routeIrisCommand`**, which means it bypasses the two-tier gate. Everything else in the Iris arc is blocked behind this. Required:
- Bind `:3400` to `127.0.0.1` by default (decision D5), opt-in for remote.
- Mint a per-install API token; require it on every route except `/health`.
- Merge or delete `/api/transport/*` so **all** commands route through the gate.
- Every refusal becomes a ledger event visible on `:3401`.

**Acceptance test:** `curl -X POST http://<LAN_IP>:3400/api/transport/play` returns 403 and appears in the ledger.

### 5.3 What actually exists today

- **`ai-voice.js`** — production TTS: ElevenLabs + OpenAI, keys in `station_config_kv`, templates with `{{variable}}` fill, writes `ai_voice_segments` + MP3s. Cloud-only; no local TTS.
- **`whisper-engine.js`** — **local** transcription via `@xenova/transformers` whisper-tiny.en (~40 MB, ONNX, no Python). This is your offline-AI beachhead and it already works.
- **`AIVoiceStudio.tsx`** — full compose/library/template UI, can send generated audio to the queue.
- **`ShowPrep.tsx`** — **not AI at all**; manual liner cards and fill-in templates. Obvious first place to put Iris.
- **No local LLM inference anywhere.** All reasoning lives in the separate Iris process on a cloud API.

### 5.4 Where AI creates 10x value — ranked honestly

| Rank | Use case | 10x? | Why |
|---|---|---|---|
| 1 | **Explain scheduling decisions** | **Yes** | Highest trust-per-effort in the product. A PD who can ask "why this song?" stops fighting the scheduler. Zetta cannot do this. |
| 2 | **News summarize / write scripts** | **Yes** | Straightforward RSS + LLM, works with a local model, immediate daily time saving |
| 3 | **Generate DAW arrangements** | **Yes** | The reducer seam already exists (§4.5) — cheapest big win in the creative suite |
| 4 | **Propose audio edits (intro/outro/segue)** | Yes *if* cue points are exposed | Engine computes them; they are not in the state API |
| 5 | **Auto-level / fix audio** | **Demo** | Needs real-time analysis + DSP control, and *cannot be autonomous* — see conflict below |
| 6 | **Auto-clip video** | **Demo** | No video pipeline exists at all (§4.4) |
| 7 | **Predict hit songs** | **Astrology** | See §5.6 |

**The three data captures to start NOW** (these gate everything above, and they are schema work, not AI work):
1. **`scheduler_reasons`** — write per-row decision data *at generation time*: category, tier used, separation rule applied, LRP position, which rules were relaxed. Without this, `explainPick` is unbuildable retroactively.
2. **`news_sources` + `news_articles`** — station-configured RSS with a local article cache, so Iris can summarize **offline**.
3. **`trackCuePoints`** on deck state — intro_end, outro_start, cue_out. The engine already computes these internally; expose them.

### 5.5 Three conflicts between your brief and your binding docs

I am flagging these rather than quietly designing around them:

1. **"Auto-levels and fixes audio"** — conflicts with *never on-air*. Real-time program-bus correction would require Iris to hold DSP/fader control, which is outside her grant. **Resolution: she proposes; the operator applies.** (Your shipped Audio Processing v1 already owns the actual correction — Iris should drive *its* settings by proposal, not bypass it.)
2. **"Predicts hit songs"** — requires cross-station/external trend data, which conflicts with local-first and with the docs' limitation of Iris to local station data.
3. **"Like Alexa"** implies always-listening proactivity — that is the Phase 3 watchman, which is **hard-blocked behind Gate 0** and behind scheduler rework. It is sequenced, not forbidden.

### 5.6 Hit prediction — the honest answer

**A single station does not have the signal.** Play history alone cannot predict a hit; the confidence interval is meaningless. Anything shipped on that basis is astrology with a progress bar, and it will be the one feature a skeptical PD tests first.

**What is real and shippable:** a **rotation health analyzer** (what's burning, what's thin, what's under-spun against goal) plus an **external trend feed** (Chartmetric / Spotify charts / label feeds) that Iris *summarizes and recommends from*. That is honest, useful, and defensible — and it also feeds gap #1 in §3.4, so it's double-counted value.

---

## 6. PRIORITIZED ACTION ITEMS

### FIX FIRST — this week
1. **Rotate the two leaked keys; assess the committed backend dump.** [VERIFIED leak] Decide rotation-only vs history rewrite. Add the patterns to `.gitignore`.
2. **Close Iris Gate 0** — loopback bind + per-install token + fold `/api/transport/*` into `routeIrisCommand`. Blocks the entire Iris arc.
3. **Verify the "Send to Deck" path by clicking it** (StudioPro *and* VoiceTracker). 30 seconds; either clears a false alarm or exposes a two-surface honest-UI violation.
4. **Instrument the `mixer_callback` `try_lock` failure counter.** You cannot fix or dismiss on-air glitching without this number.

### FIX SECOND — this release
5. **Expose a monotonic sample position from Rust** and make it the single position authority. Everything timing-related depends on this.
6. **Move the daemon's sync SQLite refill off the poll path** (async / worker).
7. **Turn off `webSecurity: false`** — serve local assets via a registered custom protocol instead.
8. **Replace `db:query`/`db:execute`/`fs:*` with typed, parameterized, allowlisted handlers.**
9. **Finish the log-reader flip** (time-anchored playhead + auto-fitter) — gap #2, the bake-off loser.
10. **Start writing `scheduler_reasons` rows now**, even before anything reads them.

### FIX THIRD — next quarter
11. Extract the pure `QueueEngine` state machine shared by daemon + renderer.
12. Decompose `App.tsx` into `useBroadcastController` / `useCloudSync` / `useRemoteCommands`; add a typed IPC layer with runtime shape validation.
13. Build category rotation goals + turnover (gap #1).
14. Manual log editing with rule warnings + non-destructive regenerate (gap #3).
15. Encrypt cloud backups; move backup gzip to a worker thread.

---

## 7. QUICK WINS (low effort, high impact)

| Win | Effort | Impact |
|---|---|---|
| `React.memo` on `LivePanel`/`ConsoleStrip`/`UpNext` + `useMemo` the `AudioEngineProvider` value | hours | Kills playout UI stutter |
| Move ~300 loose `fix-*.js` scripts into `tools/` with a README; delete the 23 tracked ones that are obsolete | hours | Every future reader stops being misled |
| Delete stray top-level `LibraryPage.tsx` / `engine.ts` / `scheduler.ts` / `library.rs` / `models.ts` | minutes | These actively shadow the real tree |
| Strip dead Tauri scripts from `package.json` | minutes | An audit pass literally mis-identified the framework because of these |
| Wire the **title separation** field that already exists in schema into the default pick path | hours | Immediate scheduling quality gain |
| Make the scheduler read `spins_per_hour` — even as a soft weight | ~1 day | Partial credit on gap #1 long before the full rewrite |
| Add `applyActions(Action[])` batch applicator to the StudioPro reducer | ~1 day | Unlocks AI arrangements (§4.5) |
| Add an operator-visible **dead-air / daemon-down banner** | ~1 day | Turns your worst silent failure into an honest one |
| Bind `:3400` to loopback | minutes | Half of Gate 0 |
| Expose `trackCuePoints` on deck state | ~1 day | Unlocks Iris use case #4 |

---

## 8. LONG-TERM VISION (6–12 months)

**Months 1–2 — Foundations.** Sample-clock authority. `QueueEngine` extraction. Log-reader flip complete. IPC hardening. `scheduler_reasons` capture live. *Outcome: the timing story is true, and the platform stops fighting itself.*

**Months 3–4 — Scheduling credibility.** Rotation goals + turnover, title/album separation, manual log editing with violation warnings, non-destructive regenerate, rotation/burn reporting. Iris Phase 1 (read-only state API + `explainPick`). *Outcome: you can win a GSelector bake-off, and you win it with an explainability feature GSelector doesn't have.*

**Months 5–7 — The creative moat.** Time-stretch + clip-gain envelopes + noise reduction (closes the "don't need Audition" claim honestly). AI arrangements via the batch reducer. Real video pipeline: timeline + ffmpeg render + captions. *Outcome: "don't need Audition / don't need a DAW" becomes true rather than aspirational.*

**Months 8–12 — The thing RCS cannot copy.** See below.

### What RCS structurally cannot copy

RCS sells *seats on a workstation*. Their architecture assumes a studio machine, a traffic system, and a person who has been trained for a week. Three things follow that they cannot answer without rewriting their business:

1. **The account is the machine.** Your most radical decision is already made and already built: sign in anywhere, your stations and library pull down, you're live in minutes. RCS cannot do this — their licensing, their install model, and their support contracts all assume a fixed box. **This is the feature to market, and it is nearly done.** Lean into it: make "sign in on a hotel laptop and be on air in 10 minutes" a demo you perform live.

2. **Explainable programming.** Every automation vendor's scheduler is a black box that PDs distrust and override. A scheduler that *narrates its own decisions* — "I picked this because your Gold category was 40 minutes from turnover and everything fresher violated artist separation" — changes the relationship from adversarial to collaborative. This is cheap for you (a table + an endpoint) and structurally expensive for them (their engines were never instrumented for it).

3. **One app, one operator, no chain.** Audition → DAW → StreamYard → Opus Clip → scheduler → traffic. That is five tools and four handoffs. Collapsing them is not a feature, it's a *category*. Nobody at RCS is even trying.

### The 20-second workflow

Make this the concrete, measurable product promise: **from raw audio to on-air, scheduled, and clipped for social in 20 seconds.** Import → Iris proposes cuts → accept → SEND TO [Deck | Jingle | Library] → it's in rotation and a vertical clip is rendering. Every feature gets judged against whether it shortens that path. It's a benchmark you can demo, competitors can't match, and it forces the right architecture decisions internally.

### Positioning

- **Streamers/podcasters** — the wedge. They have no incumbent, no IT department, and they feel the five-tool chain most acutely. Free/Solo tier, "one app instead of five."
- **Small commercial stations** — the revenue. They want Zetta and cannot afford it. Gaps 1–5 in §3.4 are exactly the checklist.
- **Enterprise/networks** — the moat. Multi-station is already architecturally solid; that's where account-as-identity becomes decisive.

---

## 9. IRIS INTEGRATION ROADMAP

| Phase | Capability | Seam | Observability shipped with it | Acceptance test |
|---|---|---|---|---|
| **0 — Gate** (weeks) | Close the transport side-door | `main.js` `:3400` server; `routeIrisCommand` | Refusals as `security_denied` ledger events on `:3401`; Health Monitor row for the Iris listener | `curl -X POST http://<LAN_IP>:3400/api/transport/play` → 403 + ledger entry |
| **1 — Read-only truth** (offline-capable) | Versioned state API + `schedule.explainPick` | `GET /api/v1/state/*`, `/api/v1/schedule/why` | Every response carries `source: daemon\|db\|derived`; API health in Health Monitor | With the window closed, `/api/v1/state/now` returns real position; `/why?rowId=` returns a human sentence |
| **2 — Operator chat + gated transport** | Q&A over state + curated help corpus; "play next" via explicit operator GO | Intent API; badge states offline/connecting/idle/thinking/speaking/error | Every command + reply ledgered; refusals highlighted | "Why this song?" answers with **zero** transport side-effects |
| **3 — Watchman** (needs scheduler rework) | Proactive runway/category/burn warnings; autonomous Tier-1 regeneration | Telemetry events on SSE | `iris_watchman` ledger events; visible in Health Monitor | Deplete a category → Iris alerts and offers to regenerate |
| **4 — Production assistant** | News scripts, DAW arrangement proposals, edit proposals — **all propose-only** | `applyActions(Action[])` in StudioPro; `news_*` tables; `trackCuePoints` | Proposals appear as "review required"; approvals logged | Iris proposes a week / an arrangement; operator commits; nothing applies without commit |

**The offline ladder, at every phase:** cloud LLM → local small model → deterministic rule-based intent matching + help-corpus lookup. Whisper already proves local inference works in-process. Iris must always report *which* backend is live (`iris_inference_status`) — an assistant that silently degrades is a dishonest UI.

---

## 10. ARCHITECTURE COMPLIANCE

- **Designed within existing docs, not over them.** The Iris pass was given all seven `iris-*.md` docs as binding input and was instructed to flag disagreement rather than override. §5.1 restates their decisions; §5.5 flags the three brief-vs-doc conflicts explicitly.
- **ONE-scheduler model** — respected. The recommendations extend `generated_schedule` as the single playout source; the log-reader flip is treated as the path forward, not replaced.
- **One region engine, two surfaces** — respected. §4 recommends no new editor; AI arrangement work plugs into StudioPro's existing reducer.
- **Honest UI** — §4.3 flags a possible violation but explicitly refuses to declare it broken from a grep, and names the runtime check instead.
- **Build the sense, not the scaffold** — every Iris phase in §9 ships its own observability in v1. No diagnostic persistence is proposed anywhere in this audit.
- **Doors before rooms** — §4.4 treats the video pipeline as unbuilt rather than "in the code."
- **Nothing was changed.** This audit is read-only. No files were modified, no commits made.

---

## Appendix — Method & cost

Six delegated passes to `deepseek-v4-pro`, each given real source bytes directly (never routed through Claude's context):

| Pass | Scope | Tokens |
|---|---|---|
| A | Audio backbone: arch docs, daemon, Rust engine, renderer engine client | 126,769 |
| B | Electron main, preload, IPC, security, cloud backup, mobile server | 161,260 |
| C | Renderer architecture + technical debt | 190,790 |
| D | Scheduler/playout vs Zetta/GSelector | 125,213 |
| E | Creative suite: StudioPro, BroadcastEditor, ClipEditor | 135,628 |
| F | Iris strategy against all 7 binding Iris docs | 45,875 |

**Total ≈ 785,500 tokens · spent ≈ $0.36 · saved ≈ $4.29 vs Opus (92%).**

**Corrections applied to delegate output during synthesis:** (1) "no program-bus audio processing" — wrong, Audio Processing v1 shipped v4.4.91; (2) "committed secrets" overstated — only 3 of 7 files are git-tracked, verified individually; (3) one pass described the app as Tauri-based, misled by leftover `package.json` scripts; (4) "Send to Deck is decorative" downgraded from assertion to UNVERIFIED-with-named-check, per the standing rule against grep-to-runtime inversion.
