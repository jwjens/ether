# Iris ↔ Ether Contract

Iris is EtherCast's operator-facing AI producer ("Executive Producer"). This document is the **law**
for how Iris and Ether relate. Code that crosses this seam must conform to it.

---

## 1. Core invariants (never negotiable)

1. **Iris is her own process.** Her brain (LLM) and voice (ElevenLabs) live in her process, not Ether's.
   This is for **crash isolation** and **air-safety independence** — if Iris dies, air does not.
2. **Iris is never on-air.** She never occupies a broadcast deck or the program bus. (When she speaks to
   the operator it is monitor-only, through her own output path — a separate sound card in the full build.)
3. **The deterministic playout floor is fully Iris-independent.** The daemon's queue, advance, rotation,
   and the never-empty selector floor run with no knowledge of Iris. Iris being absent, crashed, or
   offline changes nothing about whether audio keeps playing.
4. **To the user, Iris is part of Ether.** The separate-process seam is an implementation detail and is
   invisible in the packaged product (see §6). There is never a separate download, launch, or management.
5. **Station identity is the UUID — on every boundary.** Any station reference that crosses a process,
   persistence, API, or contract boundary (including Iris's local live-wire, chat, and generate command)
   uses the station **UUID**, never a per-machine integer id. The integer may exist only as a private DB
   auto-increment PK or a process-private engine handle, never observable across a boundary. (Amended
   2026-07-07 with the station UUID re-key, v4.5.0; closes the prior gap where `iris:state` was integer.)

---

## 2. Iris's grant — TWO TIERS (the law)

Iris's write authority into Ether is split by **whose judgment moves the fader**:

### Tier 1 — SCHEDULING (Generate-layer) · AUTONOMOUS
Iris **may act on her own initiative** here — watchman role, calendar/generation commands.
- Run / adjust generation (`schedule:generate`, `schedule:generateDay`) — the ladder + diagnostics.
- Read station state, runway, diagnostics.
- She may initiate these from her own reasoning or an autonomous loop.

Her judgment is allowed at the **planning layer**.

### Tier 2 — TRANSPORT · COMMAND-EXECUTED ONLY
Verbs: **`play`, `stop`, `skip`, `next`, `auto-on`, `auto-off`.**
- Iris executes these **immediately** on the operator's **explicit instruction** (voice or chat).
- Iris may **NEVER** initiate a transport action from her own reasoning, watchman logic, or any
  autonomous loop.

Only the **operator's** judgment moves the fader at the **air layer**.

### Enforcement
Transport commands must carry explicit operator provenance: `source: "operator"` — a **verbatim relay**
of the operator's voice/chat instruction. Ether's `routeIrisCommand` **refuses any transport verb that
lacks `source:"operator"`** (`transport_requires_operator_command`). Iris MUST set `source:"operator"`
**only** when relaying a real operator instruction — never for anything her own reasoning produced.
Scheduling-tier and read-only commands need no such flag (autonomous is allowed).

> Iris is a trusted client: the provenance flag is contract-enforced at the boundary, not cryptographic.
> The gate exists so an autonomous slip can never reach the air layer by construction.

---

## 3. Connection

- **Ether hosts port `3400`** (`irisHttpServer`). **Iris is the client** that connects in.
- **State down:** Ether relays `iris:state` (now-playing, decks, up-next, runway) on the SSE live-wire.
  An open stream *is* Iris's presence signal (`irisConnected` / `irisLastSeen`).
- **Commands up:** Iris POSTs commands to `:3400`; Ether routes them through `routeIrisCommand` under the
  two-tier gate above.
- **Chat:** the operator types in Ether's Iris panel → Ether pushes the prompt **down the SSE** → Iris
  answers with her brain, speaks via ElevenLabs, and POSTs **reply text + `speaking` on/off** back up to
  `:3400` (correlated by request id). Iris stays a pure client — no inbound port on her side.

---

## 4. Presence surface + THE GLOW

- **Badge:** bottom-right corner of Ether, present from first launch. Collapsed = small Iris badge;
  clicked = live chat panel (text in, her replies shown, her voice playing). Never obscures broadcast UI.
- **Badge states:** `offline` · `connecting` · `online-idle` · `thinking` · `speaking` · `error`.
  Iris not running → `offline` cleanly, with a clear message (dev: how to start her; packaged:
  "reconnecting…", since she is supervised). No dead ends.
- **THE GLOW:** while Iris is `speaking`, the **badge glows/pulses soft purple** (`#8868D8`, ~1–1.5s
  pulse, gentle bloom), driven by her `speaking` on/off events. **No screen-wide glow** — it must never
  obscure broadcast UI.

---

## 5. First command (reference)

"Iris, generate the calendar for August [for station X]" → Iris (Tier 1, autonomous-allowed) posts a
`generate` command → Ether runs the real Generate path (LRP ladder + diagnostics) for that month +
station → returns `{count, relaxedPicks, throughDate, runway, reasons}` → Iris reports in chat + voice:
"August generated for Magical Forest — 4 relaxed picks, runway now 31 days."

---

## 6. Packaging & lifecycle (Alexa-style — one product)

- **Packaged build:** Iris ships **inside Ether's installer** and Ether **spawns + supervises** her
  process on startup — the **same lifecycle as `ether-audiod`**: bundled, auto-started, watchdogged,
  updated with Ether's releases. The badge/glow are simply present from first launch. No user ever
  downloads, launches, or manages Iris.
- **Dev mode:** keep the separate-launch workflow.
- Under the hood she is always her own process (§1); that seam is invisible to the user.
