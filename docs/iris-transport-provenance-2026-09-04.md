# Iris transport provenance — the mechanism, and what the live test proved

**Status: CURRENT · last verified 2026-09-04**
Companion to `docs/iris-audit-2026-09-04.md` §6 and §8.1. Settles that doc's §9.
**Nothing was built. This is the measurement and the design, reported for approval.**

---

## 0 · Jeff's ruling (2026-09-04), recorded

> §9 ruled: verbatim operator relay passes through with `source:"operator"`. Iris-initiated transport
> is gated — her own reasoning and watchman logic never fire transport without a GO. That's what
> contract §2 already says; I'm confirming it, not changing it.

And the question that gates the build:

> Tell me exactly WHERE the operator/Iris-initiated determination is made, and how `source:"operator"`
> can't be set by Iris on her own initiative. If she can set it because a tool was named transport,
> the gate is decorative.

**The answer is: today that determination is made NOWHERE, and the gate is decorative — for a
broader reason than the one Jeff named.** Evidence below.

---

## 1 · THE LIVE TEST — run 2026-09-04, Ether 4.5.0 running, Iris not running

Iris being down does not weaken the test. **`curl` is the unauthenticated caller.** Iris only matters
for the ledger, not for the door.

### 1.1 · The same verb at both doors, back to back

```
$ curl -s -X POST http://127.0.0.1:3400/ -H 'Content-Type: application/json' -d '{"action":"stop"}'
{"ok":false,"error":"transport_requires_operator_command","action":"stop"}

$ curl -s -X POST http://127.0.0.1:3400/api/transport/stop
{"ok":true,"action":"stop","deck":"A"}

$ curl -s -X POST "http://127.0.0.1:3400/api/transport/play?deck=A"
{"ok":true,"action":"play","deck":"A"}
```

**Same verb. Same process. Same second. Two answers.** The two-doors finding is proved, not argued.

**Measured vs inferred — stated precisely.** Deck A had nothing loaded (`/api/now-playing` reported
`status:"idle"` before and after), so I did **not** hear audio stop. What is *measured* is that the
route accepted the command and called `audio.audioStop` / `audioPlay` with no provenance check at
all. That the audio would have stopped is inference from the call, not observation. The refusal /
acceptance asymmetry is the receipt, and it needs no audio.

### 1.2 · The guarded door is ALSO decorative

```
$ curl -s -X POST http://127.0.0.1:3400/ -H 'Content-Type: application/json' \
       -d '{"action":"stop","source":"operator"}'
{"ok":true}
```

**An unauthenticated caller simply claimed to be the operator, and the gate opened.** `cmd.source` is
a field on a JSON body. Whoever sends the body sets it. There is no issuer, no verification, nothing
that could distinguish a relay from a fabrication.

So Jeff's suspicion is right and generalises: it is not that *Iris* could set the flag because a tool
was named transport — **anything that can reach the port can set it**, Iris included.

### 1.3 · And the port is not local

```
electron/main.js:7561:  irisHttpServer.listen(3400, '0.0.0.0', ...)
```

`0.0.0.0`, not `127.0.0.1`. Both doors are open to **every machine on the station's LAN**, with no
auth on either. On a managed corporate network (OV) that is a wider surface than the Iris question.

---

## 2 · WHERE the determination is made today: nowhere

| element | `file:line` | what it actually is |
|---|---|---|
| the gate | `electron/main.js:7034` | correct logic, reading an unverifiable field |
| `cmd.source` | anywhere | a caller-supplied string; nothing issues or checks it |
| the second door | `electron/main.js:7421` | never calls `routeIrisCommand`; reaches `audio.*` directly |
| Iris's transport call | `iris-brain.js:29` | posts to the second door; never sets `source` at all |
| `tierForTool` | `iris-brain.js:492` | labels ledger rows; gates nothing |

`grep` for `source.*operator` across `electron/ src/ audiod/` returns only unrelated
`generated_schedule` row-stamping. **Nothing in Ether has ever set this field for a transport
command.** The gate has never once been satisfied legitimately — it has only ever been bypassed,
because the route in use does not read it.

---

## 3 · THE MECHANISM — provenance the asserting party cannot forge

### 3.1 · The principle

**Provenance cannot be asserted by the party whose initiative is in question.** If Iris sets the flag,
the flag means *"Iris says this came from the operator"* — which is precisely the claim the gate
exists to doubt. A model deciding its own provenance is not a gate at any level of prompt discipline,
and no amount of tool naming or system-prompt instruction changes that. The determination has to be
made somewhere Iris's reasoning cannot reach.

### 3.2 · The premise that makes it possible — verified in code

**The operator's words reach Iris THROUGH Ether.** `electron/main.js:7305-7310`:

```js
// ── Iris chat channel (operator ↔ Iris over the same :3400 link) ──
// Prompt DOWN: the renderer's Iris panel sends operator text → pushed to Iris on the SSE as a `chat`
// event. ... Keeps Iris a pure client (no inbound port on her side).
ipcMain.on("iris:chat-send", (_evt, msg) => {
  sseBroadcast("chat", { id: (msg && msg.id) || null, text: (msg && msg.text) || "" });
});
```

Ether sees **every operator utterance, first, verbatim, before Iris does**, and already carries an
`id` per utterance. That is the hook. The mechanism costs no new channel.

### 3.3 · The design: a verb-scoped capability token, minted by Ether

1. Operator types or speaks into the Iris panel: *"skip this track."*
2. **Before broadcasting**, the `iris:chat-send` handler runs a **deterministic verb match on the raw
   text** — plain string matching in `main.js`, no model anywhere in this step.
3. Finding `skip`, Ether mints into an in-memory map:
   `{ token, verb:'skip', utteranceId, expiresAt: now+90s, used:false }`
   and includes the token in the SSE `chat` event.
4. Iris reasons and relays as she does today. **To fire transport she must present that token.**
5. `routeIrisCommand` **stops treating `cmd.source` as a trust signal entirely.** It looks up the
   token and requires: exists · unexpired · unused · **and the verb matches the action requested.**
   Then it executes and burns the token.

### 3.4 · What that buys — each one checkable

- **Iris cannot mint a token.** She has no path to the map, and Ether never honours one it did not
  issue. Neither can curl, or anything else on the LAN.
- **No operator utterance → no token → no transport, ever** — regardless of what the model concludes,
  what a tool is named, or what any prompt says.
- **Verb-scoped.** *"What's playing?"* mints nothing. *"Skip"* mints a token that can **only** skip.
  Iris relaying an utterance cannot widen it into `stop`.
- **Single-use + 90 s expiry** closes the stale-command hazard already flagged in audit §8.1 — a
  transport command firing ten minutes late is its own accident.
- **Two independent derivations must agree.** Ether extracted `skip` from the raw text; Iris relayed
  `skip`. Both name the same verb, and one of them is not a model. Disagreement refuses.

### 3.5 · The residual risks — stated, not buried

- **A deterministic matcher will miss phrasings.** *"Kill it"*, *"get us out of this song."* Those
  fail **closed**: no token, gate holds, operator repeats or uses the board. Degradation in the safe
  direction, and it is the reason the matcher must be reviewed as a list, not written once.
- **Negation.** *"Don't skip this"* must not mint a skip token. The two-derivations rule in §3.4 helps
  but does not fully cover it; the matcher needs explicit negation handling and a test per phrase.
- **It does not defend a compromised Iris process** replaying inside the 90 s window for the same
  verb the operator just authorised. Accepted: that is the same trust boundary as the operator's own
  keyboard.
- **None of it matters while the second door is open.** A token gate on `routeIrisCommand` is
  worthless if `/api/transport/:action` still reaches `audio.*` directly. **That is why the Ether door
  closes first** — Jeff's ordering, and it is the correct one.

---

## 4 · Order of work (Jeff's, 2026-09-04)

1. ~~Live confirmation of the two doors~~ — **DONE, §1 above.**
2. **8.2** — port 3401 collision (`hardware-server.js` → 3402, loud bind failures).
3. **8.3** — ledger persistence (`decisions` table; stop returning success-shaped failures).
4. **8.1a** — `/api/transport/:action` routes through `routeIrisCommand`, so ONE function decides
   every transport verb. **Close the door before building the gate.**
5. **8.1b** — the Iris-side pending / GO / deny / expire mechanism, and the Watch screen's
   `HOLDING FOR OPERATOR GO` becomes a real row with a real button.

**Nothing above has been built.** Awaiting go.

---

## 5 · OPEN — needs Jeff

1. **Does the token mechanism in §3.3 get built, or does `source:"operator"` stay a trusted field?**
   As it stands the field is unforgeable-in-principle and forgeable-in-fact (§1.2). Building §3.3 is
   the difference between a gate and a label, and it is a bigger change than 8.1a alone.
2. **Should `:3400` bind `127.0.0.1` instead of `0.0.0.0`?** (§1.3) Noted incidentally while proving
   the doors — **not investigated further, per the stay-on-task rule.** It may be deliberate: external
   automation and traffic integration are named in the route's own comment. If anything off-box calls
   it, the answer is auth, not a rebind.
