# Iris transport gate — 8.2, 8.3, the bind check, 8.1a, and the token mechanism

**Status: CURRENT · last verified 2026-09-04**
Build record. Follows `docs/iris-transport-provenance-2026-09-04.md` (the measurement) and
`docs/iris-audit-2026-09-04.md` (the audit). Trees touched: `C:\openair` and `C:\iris`.

**All code is LOCAL AND UNCOMMITTED. Nothing is tagged, pushed or released.**

---

## 1 · 8.2 — the port 3401 collision · DONE

`npm start` launched Electron **and** `hardware-server.js`, and both bound 3401. Whichever lost the
race died silently, and the loser was usually Iris Watch — a health screen that isn't listening reads
as "no alarms", which is worse than no screen.

Read-only first: every `3401` reference in the tree is either the ledger's own, or
`hardware-server.js`'s own two lines. **Nothing external calls it**, so the move is contained.

- `hardware-server.js` → **port 3402, bound `127.0.0.1`** (was `0.0.0.0`). It takes raw audio for STT
  off studio hardware with no auth of any kind and has never needed to be reachable off the box.
- **The ledger keeps 3401** — it is baked into its own HTML, its comments, and `iris-memory.js`'s docs.
- **Bind failures are now loud** on both servers. `server.on('error', …)` names the port and the code.
  A `listen` failure is asynchronous and never reached the `try/catch` around `start()` in
  `iris/electron/main.js:377`, which is exactly why the collision produced no error anywhere.

## 2 · 8.3 — ledger persistence · DONE, and the audit's open question is settled

The audit could not say whether the `decisions` table was missing because the persist path was broken
or because Iris hadn't run since July. **Verified rather than assumed** (Iris not running, DB backed
up to `C:\iris\iris-memory.db.bak-2026-09-04` first):

```
DB          : C:\iris\iris-memory.db
size/mtime  : 626688 bytes   2026-04-19T02:04:02.110Z
--- running init() ---
tables now  : conversations, decisions, facts, sqlite_sequence
decisions   : PRESENT
probe row   : id 1        (written, read back, then removed)
size/mtime  : 630784 bytes   2026-09-04T14:24:49.016Z
file rewritten: YES — persist() reached disk
```

**The persist path was never broken. Iris simply had not been run since the July change.** The table
now exists on the live DB.

**And the ledger stops reporting success it did not achieve.** `record()`'s catch used to build
`{ id: null, ...evt }` and return it — success-shaped. It streamed to the Watch screen and rendered
identically to a recorded decision, so a ledger writing nothing looked exactly like one that worked.
On a screen whose entire job is to be believed, that is the worst available failure mode. Now a
failure returns `{ ok:false, error }`, still streams (the operator needs to see the decision
happened), and renders as **NOT RECORDED** in red with a dashed border. The two
`catch { /* ledger must never break think() */ }` sites in `iris-brain.js` still never break
`think()` — that instinct was right — but they log now instead of swallowing.

---

## 3 · THE `:3400` BIND CHECK — **DO NOT FLIP. Something off-box legitimately calls it.**

Jeff's instruction was to confirm read-only first, and *"if something does, the answer is auth on that
route, not staying open."* Something does. Two things, and both are cross-machine **by design**:

| caller | `file:line` | what breaks if `:3400` becomes loopback-only |
|---|---|---|
| **Site replication** | `electron/site-replication.js:217` — `` `http://${peer.host}:${peer.port}${path}` ``, default port 3400 (`:39`, `:85`) | station-to-station peer sync stops entirely |
| **Mobile pairing** | `src/components/PairMobileApp.tsx:81` — `` `http://${localIp}:3400/m` ``, shown to the user as the URL to open on their phone; repeated in `HelpPanel.tsx:87` | the phone can no longer reach the studio |

The watchdog also polls `:3400/health`, but on `127.0.0.1` — unaffected either way.

**So the bind stays as it is, and the answer is auth on the routes.** For transport specifically,
that auth is now the token mechanism in §5 — which is a *stronger* control than a loopback bind,
because a loopback bind never protected against Iris (she is local) while the token does.

**Flagged, not investigated further** (stay-on-task): the other mutating routes on `:3400` —
`/api/macro/:id/run` among them — remain unauthenticated and LAN-reachable. That is a separate
decision and I have not touched it.

**One loose end noticed while checking:** the UI advertises `http://<studio-ip>:3400/m` in two places,
but I could not find a `/m` route in `electron/main.js`. Either it is served elsewhere or the UI
points at nothing. Not chased — one line, as flagged, and it does not change the bind answer, because
site replication settles that on its own.

---

## 4 · 8.1a — the second door is closed

`/api/transport/:action` used to call `audio.audioPlay/Pause/Stop` **directly** — never
`routeIrisCommand`, never reading provenance. It now routes through `routeIrisCommand`, so **one
function decides every transport verb regardless of which door it arrived through.**

Three things that would have been regressions, caught while wiring it:

1. **`?deck=` had to survive.** `routeIrisCommand` hardcoded deck `'A'` in every case. Routing the
   HTTP door through it unchanged would have silently redirected every B/C/aux transport command onto
   deck A. The switch now threads `payload.deck`.
2. **`pause` was missing from `IRIS_TRANSPORT_VERBS`** — while `/api/transport/pause` cheerfully
   paused the air chain. A gate that omits a verb is a gate with a hole in it. Added, plus a `pause`
   case in the switch, which previously existed only on the unguarded route.
3. **`body` is not in scope in that route.** Every POST route on this server collects its own body;
   the old direct-to-engine version never needed one. The route now collects it before dispatching.

Refusals return **403** (a deliberate, reportable outcome), unknown verbs **400**, and the response
shape `{ok, action, deck}` is unchanged for existing callers.

---

## 5 · THE TOKEN MECHANISM — provenance Iris cannot assert

### 5.1 · What it replaces

```
$ curl -X POST http://127.0.0.1:3400/ -d '{"action":"stop","source":"operator"}'
{"ok":true}
```

`cmd.source` was a field on a JSON body. Whoever sent the body set it. **`cmd.source` is no longer a
trust signal anywhere in the transport path.**

### 5.2 · Where the determination is made — `electron/main.js`, the `iris:chat-send` handler

**Here, and nowhere else.** The operator's words reach Iris *through* Ether — she is a pure client
with no inbound port — so Ether sees every utterance first, verbatim. Before relaying, it extracts a
transport verb by **deterministic string matching** and mints a token that is:

- **verb-scoped** — a token minted from "skip" can only ever skip; a relay cannot widen it to `stop`
- **single-use** — burned on first successful verification
- **short-lived** — 90 s, so a command cannot outlive the operator's attention
- **unforgeable** — 256 bits of CSPRNG; Ether honours only tokens it issued itself

Iris receives the token beside the text. **She cannot mint one**, so she cannot manufacture the
authority to move the air chain: the determination is made before her reasoning begins, on evidence
she does not control. No authorising utterance → no token → every transport verb refused, whatever
the model concludes or a tool is named.

### 5.3 · The reviewed phrase list — `electron/iris-transport-phrases.js`

The file Jeff asked to be able to open and add to. It states, in prose, why it exists, how it fails,
and how to edit it. **49 phrases across 7 verbs.** No model anywhere in it.

**It fails CLOSED.** An uncovered phrasing mints nothing, the gate holds, and the operator repeats
themselves — one second of friction. The opposite failure puts dead air on a live station. So the
list should grow from real operator language observed to fail, not from imagined phrasings.

**The safety net that lets the list be imperfect:** a token proves *an operator spoke a verb*, not
that they meant it as a command. "Stop talking" mints a `stop` token — a real false positive, and
tolerable, because **two independent derivations must agree**: Ether extracted the verb from raw
text, and Iris independently decided to call transport with that same verb. One of the two is not a
model. If Iris correctly doesn't treat "stop talking" as transport, the token expires unused.

**Negation is explicit**, per Jeff's instruction. `NEGATORS`, `DELIBERATIVE_OPENERS`, and four
ordered resolution rules — longest phrase wins at a position (so **"stop automation" is `auto-off`,
not `stop`**, which would otherwise have been a dead-air bug), and **more than one distinct verb
authorises nothing** ("stop and skip" is ambiguous, and ambiguity about the air chain resolves to
silence, not to a guess).

**Two design errors the tests caught, both corrected:**

- **`stop` was in the negator list.** It is a verb. As a negator it made *"stop and skip"* veto the
  skip and quietly mint a `stop` token — resolving an ambiguous compound by picking one, which is
  precisely what the ambiguity rule exists to prevent.
- **The 4-token negation window leaked.** *"id rather you didnt move to the next"* → `rather`
  correctly vetoed the long phrase `move to the next`, but the bare `next` matched again six tokens
  later, outside the window, and minted. A long phrase pushes its own trailing short phrase out of
  range. **The window is gone**: a negator anywhere before a match vetoes it. Blunter, cannot leak
  that way, and its cost is false vetoes across sentence boundaries — which fail closed.

### 5.4 · Tests — `npm run test:iris-phrases`

```
── every phrase in the reviewed list → its own verb ──   49 phrases
── every phrase, negated → null ──                       49 phrases x 5 negations
── traps ──                                              23 cases
── capability tokens ──                                  verb-scoping, single-use, expiry, forgery
──────────────────────────────────────────────────────
PASS — all 332 checks
```

**The per-phrase tests are generated from the list itself**, so a phrase cannot be added without
being tested — which is what makes it a living list rather than one that rots.

---

## 6 · KNOWN GAP — voice and Iris's own text box are refused

**Stated plainly rather than papered over.** Three input paths reach `handleUserInput`:

| path | `file:line` | mints? |
|---|---|---|
| Ether's Iris chat panel | `iris/electron/main.js:384` | **yes** — wired |
| **Voice / STT** | `iris/electron/main.js:249` | **no** |
| **Iris's own text box** (`iris:send`) | `iris/electron/main.js:261` | **no** |

Only the Ether chat channel passes through Ether, so only it can be minted from. **Transport by voice
is currently refused at the air layer.**

Minting locally for those paths would defeat the entire mechanism — Iris asserting her own provenance
is the exact thing being prevented, and a comment in `iris-brain.js` says so at the token holder, so
nobody "fixes" it later by synthesising one. The real fix is for those transcripts to reach Ether for
minting (or for Ether to own the STT), **which is a decision, not a patch.** See §8.

---

## 7 · Files changed — all local, uncommitted

**`C:\openair`**
- `electron/iris-transport-phrases.js` — **NEW** · the reviewed list + matcher
- `electron/iris-operator-tokens.js` — **NEW** · mint / consume / expire
- `electron/main.js` — mint on `iris:chat-send`; token gate in `routeIrisCommand`; `pause` added to
  the verb set + switch; deck threaded; `/api/transport/:action` routed through
- `scripts/test-iris-transport-phrases.js` — **NEW** · 332 checks
- `package.json` — `test:iris-phrases`

**`C:\iris`**
- `hardware-server.js` — 3402 / loopback / loud bind errors
- `iris-ledger.js` — loud bind errors; honest persist failures; NOT RECORDED rendering
- `iris-brain.js` — turn-scoped token relay; ledger catches log
- `iris-ether-feed.js` — comment: the whole chat object is emitted deliberately
- `electron/main.js` — token threaded chat → `handleUserInput` → `think`
- `iris-memory.db.bak-2026-09-04` — backup taken before the verification run

---

## 8 · OPEN — needs Jeff

1. **RUNTIME UNVERIFIED.** Everything above is static: syntax-checked, unit-tested, typechecked. The
   running app is still 4.5.0 with the old code. **The check that settles it** is, with the new build
   running: `curl -X POST 127.0.0.1:3400/api/transport/stop` must now return **403
   `transport_requires_operator_command`**, where an hour ago it returned `{"ok":true}`; then the
   same verb typed into the Iris panel must succeed.
2. **The voice gap (§6).** Voice is a primary operator path and it is currently refused. Options:
   route STT transcripts through Ether for minting, move STT into Ether, or accept voice as
   non-transport. This needs a ruling before 8.1b.
3. **8.1b is not built** — the Iris-side pending / GO / deny / expire mechanism, and turning
   `HOLDING FOR OPERATOR GO` from a label into a real row with a real button. Per §0 of the
   provenance doc, this gates only **Iris-initiated** transport; a verbatim operator relay passes
   through on its token.
4. **The other unauthenticated `:3400` routes** (§3) — flagged, untouched.
