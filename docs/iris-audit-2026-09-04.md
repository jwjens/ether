# Iris audit — current reality, 2026-09-04

**READ-ONLY AUDIT. Nothing was changed.** Supersedes `docs/iris-audit-2026-05-31.md`.
Tree: `C:\iris` · Ether side: `C:\openair`

**Headline: `C:\iris` has not been touched since 2026-07-08.** Two commits exist in total
(`a006c1e` baseline, `534d1cb` "Iris-side chat round-trip with Ether"). The drift since the May
audit is the July Iris Watch work and nothing after it.

**Three things claim to work and do not**, and one of them is a safety claim over live transport on
a broadcast station. Those are §8; the audit is §1–7.

---

## 1 · What runs today

**A per-session Electron app. Not a service.** `package.json` → `main: electron/main.js`, launched
by `Iris.bat` or `npm start`:

```
"start": "concurrently -k \"electron .\" \"node hardware-server.js\""
```

Nothing installs it as a service, nothing supervises it, nothing restarts it.

`electron/main.js` loads eight modules — `iris-server`, `iris-ether-feed`, `iris-brain`,
`iris-voice`, `iris-memory`, `iris-alarms`, `iris-stt`, `iris-tcp-audio` — plus `iris-ledger` at
`:377`.

### Ports

| port | bound by | address | note |
|---|---|---|---|
| **3401** | `iris-ledger.start(3401)` — `electron/main.js:377` | `127.0.0.1` | Iris Watch |
| **3401** | `hardware-server.js:32` | `0.0.0.0` | **COLLISION** |
| 5555 | `iris-tcp-audio` (`IRIS_TCP_PORT`) | `0.0.0.0` | |
| 5173 | vite | — | dev only |

`npm start` and `npm run dev` launch Electron **and** `hardware-server.js`, so both bind 3401. See §8.2.

---

## 2 · The brain loop

`iris-brain.js`, 28.9 KB.

**Hardcoded to Anthropic. There is no provider abstraction.** Two direct `axios.post` calls to
`https://api.anthropic.com/v1/messages` (`:468` and `:551`), both:

```
model: 'claude-haiku-4-5-20251001'
headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }
```

URL, headers and model string are inline at each call site. Swapping or adding a provider means
editing both sites; there is no client, no adapter, no config.

**12 tools**, dispatched by an `if (name === …)` chain rather than a registry:

`get_weather` · `search_web` · `get_wikipedia` · `control_ether` · `ether_tour` · `ether_help` ·
`set_quiet_mode` · `set_alarm` · `list_alarms` · `cancel_alarm` · `snooze_alarm` · `set_language`

`control_openair` survives as a back-compat alias that rewrites `getStatus`→`now_playing` and
`next`→`skip` (`:457`).

---

## 3 · Memory

`iris-memory.js` (sql.js) declares **three** tables. The live DB has **two**.

```
conversations   3,262 rows
facts              32 rows
decisions       ABSENT — "no such table: decisions"
```

`iris-memory.db` is dated **2026-04-18**; the `decisions` DDL arrived with the July ledger work
(`iris-memory.js:40`). The module does export and `writeFileSync` back to disk (`:58-59`), so
`CREATE TABLE IF NOT EXISTS` should materialise it on a run — it has not. Either Iris has not been
run since that change, or the persist path is not reached on this route. **Not verified which.**

Consequence: every `ledger.record()` currently lands in a catch. See §8.3.

**Nothing is shared with or synced to Ether.** Local sql.js file, no sync registration, no
cross-process access.

---

## 4 · Knowledge

**No retrieval beyond the keyword KB. No vector store, no embeddings, no document ingestion.**
Greps for `embedding`, `vector`, `faiss`, `chroma`, `pinecone`, `cosine` return nothing.

What exists: `ether-tours.json`, read once at boot into `ETHER_KB = { tours, concepts }`
(`iris-brain.js:41-44`). Tour keys are interpolated into the system prompt and into the `ether_tour`
tool description. `ether_help` "fuzzy-matches against the knowledge base" by string matching.

That is the whole of the knowledge layer.

---

## 5 · Iris Watch

Present in source, wired, and **probably not listening** because of the 3401 collision.

- **Ledger server** — `iris-ledger.js`, `start(port = 3401)` on `127.0.0.1`.
- **SSE** — yes. `/ledger` serves the HTML screen; the stream route sets `text/event-stream`, pings
  `: ping` every 15 s, and cleans up clients on close.
- **Incident bridge** — `record(evt)` is the single entry point: persists to `iris-memory.decisions`
  and streams to connected clients. Called from `iris-brain.js:562` (chat replies) and `:577` (tool
  calls, classified by `tierForTool`).
- **The GO gate is presentational only.** `iris-ledger.js:70` renders
  `HOLDING FOR OPERATOR GO` when `tier === 'transport'`. It is a label in generated HTML. There is
  no gate in the command path: nothing waits, nothing blocks, no GO is ever required. See §8.1.

---

## 6 · The Ether contract — THE CENTRAL FINDING

`docs/iris-ether-contract.md` §2 states the law: Iris may **NEVER** initiate a transport action from
her own reasoning. Transport commands must carry `source: "operator"` — a verbatim relay of the
operator's instruction — and Ether's `routeIrisCommand` **refuses any transport verb that lacks it**
(`transport_requires_operator_command`).

**Ether's gate is written, and it is correct** (`electron/main.js:7034`):

```js
if (IRIS_TRANSPORT_VERBS.has(action) && cmd.source !== 'operator') {
  console.warn(`[iris] TRANSPORT '${action}' REFUSED — not operator-commanded`);
  return { ok: false, error: 'transport_requires_operator_command', action };
}
```

Reached by `POST /` → `routeIrisCommand` (`:7360`) and `ipcMain.handle('iris:command')` (`:7101`).

**But there are TWO doors into transport, and only one is guarded** (`electron/main.js:7421`):

```js
if (req.method === 'POST' && url.startsWith('/api/transport/')) {
  if (action === 'play')  audio.audioPlay(deck);      // straight to the audio engine
  else if (action === 'pause') audio.audioPause(deck);
  else if (action === 'stop')  audio.audioStop(deck);
```

This route **never calls `routeIrisCommand`**, never reads `cmd.source`, and reaches the engine
directly. And `iris-brain.js:29` posts to exactly this path:

```js
axios.post(`${ETHER_BASE}/api/transport/${action}?deck=${deck}`, {}, { timeout: 3000 })
```

### So the answer to "does Ether refuse, or fail to enforce?"

**Neither refusal nor enforcement — the commands execute.** Iris never sets `source:"operator"`
(grep for `source.*operator` / `provenance` in `iris-brain.js` returns nothing), and the route she
uses does not look for it. The contract's central safety invariant is **unenforced in practice**,
because the guarded door is not the one in use.

Iris *does* classify tiers — `tierForTool` (`iris-brain.js:492`) — but only to label rows on the
Watch screen. It gates nothing.

**Live confirmation still worth running**, because it is a safety claim and should be proved rather
than argued: start both, `curl -X POST 127.0.0.1:3400/api/transport/stop`, observe whether audio
stops. One command, definitive.

---

## 7 · Half-built or abandoned

| item | state |
|---|---|
| `iris-server.js` | required at `electron/main.js:14`, never invoked beyond that; has its own `app.listen` nothing calls |
| `decisions` table | declared, written to, does not exist in the live DB |
| GO gate | a label, not a gate (§8.1) |
| Contract provenance | `source:"operator"` never set by Iris; the route used bypasses the check anyway |
| Port 3401 | two servers, one port, no error handling |
| Provider abstraction | never started — Anthropic hardcoded at two call sites |

---

## 8 · THE PLAN — four items, reported not built

### 8.1 · Make the GO gate real (Jeff's ruling: a real gate, not a removed label)

The gate belongs **in Ether, at the air layer**, not only in Iris — Iris asking permission of herself
is not a gate, and the contract already says refusal happens at the air layer.

1. **Close the second door.** `/api/transport/:action` routes through `routeIrisCommand` instead of
   calling `audio.*` directly, so ONE function decides every transport verb and the existing refusal
   starts applying. Iris sets `source:"operator"` only when relaying a verbatim operator instruction.
2. **Then the gate in Iris.** A transport tool call does not execute: `runTool` returns
   "pending operator GO", `ledger.record` writes `tier:'transport', result:'awaiting GO'`, and the
   command sits in a pending map keyed by id. The Watch screen's `HOLDING FOR OPERATOR GO` becomes a
   real row with a **GO** button; `POST /go/:id` releases, `POST /deny/:id` drops, and anything
   unreleased **expires** — a stale transport command firing ten minutes later is its own hazard.
   Only on GO does Iris send, with `source:"operator"`.

**Ordering matters: close the Ether door FIRST.** Until that lands, an Iris-side gate is advisory —
anything bypassing Iris still reaches the engine.

### 8.2 · Port 3401

- **Move `hardware-server.js` to 3402**, bound to `127.0.0.1` rather than `0.0.0.0`. It serves
  `POST /audio` and `GET /health`; the only references to 3401 are its own two lines, so the move is
  contained. Check `Iris.bat` and any external caller first.
- **The ledger keeps 3401** — it is baked into the HTML, the comments and `iris-memory.js` docs.
- **Make the failure loud.** `server.on('error', …)` in `iris-ledger.start()` logging port and code,
  and the `try/catch` at `electron/main.js:377` logging rather than swallowing. A health screen that
  is not listening is worse than none, because its silence is read as "no alarms".

### 8.3 · Ledger persistence

- **Create the table on the live DB.** The DDL exists; verify the export/`writeFileSync` path is
  actually reached on this route rather than assuming it.
- **Stop returning a success-shaped failure.** `iris-ledger.js:24-25` catches, logs
  `persist failed`, and returns `{ id: null, …evt }` — which streams to the screen and looks like a
  recorded decision. Return `{ ok: false, error }`, still stream it (the operator needs to see it
  happened) but render it as **un-persisted**, and surface the failure on the screen rather than only
  in a console nobody reads.
- `catch { /* ledger must never break think() */ }` at `iris-brain.js:581` stays — that instinct is
  right — but it should log rather than swallow silently.

### 8.4 · Order of work

**8.2 → 8.3 → live confirmation (§6) → 8.1.**

Nothing observes anything if the Watch is not listening; nothing is recorded if it does not persist;
and the gate's whole value is that its refusals are visible and recorded, which needs both.

---

## 9 · OPEN — needs Jeff before 8.1 is built

**Does a verbatim operator relay pass straight through, or is every transport verb gated?**

As described in 8.1, a human confirms every transport verb — so Jeff saying "skip this track" would
need a second confirmation click. In a live show that may be worse than useless.

The alternative, and what §2 of the contract actually says: a **verbatim operator relay** passes
through with `source:"operator"`, and only **Iris-initiated** transport (her own reasoning, watchman
logic) is gated or refused outright.

These are different designs. Settle it before building 8.1.
