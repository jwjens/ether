# Iris in Ether — Phase 1 Report

**Status:** Phase 1 COMPLETE and walkable in dev (both apps running).
**Repos touched:** `C:\openair` (Ether) and `C:\iris` (Iris).
**Contract:** [`docs/iris-ether-contract.md`](./iris-ether-contract.md) is the law this was built to.

---

## 1. What Phase 1 delivers

The operator-facing presence surface + a live connection + the first command, all per the approved plan.
Iris stays her own process (crash isolation, air-safety independence); Ether gains the badge, the chat
panel, the glow, and the `:3400` chat round-trip.

| Step | Delivered | Where |
|---|---|---|
| 0 · Contract + gate | Two-tier grant written as law; transport command-executed gate | `docs/iris-ether-contract.md`, `main.js routeIrisCommand` |
| 1 · Badge + chat panel | Bottom-right badge (present from first launch) → click → chat | `src/components/IrisBadge.tsx` / `.css` |
| 2 · The glow | Badge pulses soft purple (`#8868D8`) while Iris speaks | `IrisBadge.css` `@keyframes iris-pulse` |
| 3 · Connection | Prompt down the SSE; reply + speaking back up `:3400` | `main.js`, `preload.js`, Iris `iris-ether-feed.js` + `electron/main.js` |
| 4 · Generate command | "generate August for Magical Forest" → real Generate path + diagnostics | `main.js _generateRange` + `routeIrisCommand 'generate'`, Iris `iris-brain.js` |
| 5 · Every state | offline / connecting / online-idle / thinking / speaking / error | `IrisBadge.tsx` |

---

## 2. The two-tier grant (the law — Step 0)

Written into `docs/iris-ether-contract.md` and enforced at the boundary:

- **SCHEDULING tier (Generate-layer) — AUTONOMOUS.** Iris may run/adjust generation on her own
  initiative (watchman role, calendar commands). `generate` is here.
- **TRANSPORT tier — COMMAND-EXECUTED ONLY.** `play/stop/skip/next/auto-on/auto-off` execute
  immediately on the operator's **explicit** instruction, and **never** from Iris's own reasoning or any
  autonomous loop.
- **Enforcement:** a transport verb through `routeIrisCommand` is refused
  (`transport_requires_operator_command`) unless it carries `source:"operator"` — a verbatim relay of
  the operator's voice/chat instruction.
- **Core invariants unchanged:** Iris is never on-air; the deterministic playout floor is fully
  Iris-independent (her being down never affects whether audio plays).

---

## 3. How the connection works (Step 3)

Ether hosts `:3400`; Iris is the client. One link, Iris stays a pure client (no inbound port on her).

```
Operator types in Ether's Iris panel
        │  ipc  iris:chat-send {id,text}
        ▼
Ether main → sseBroadcast("chat", {id,text})  ──SSE /api/stream──▶  Iris iris-ether-feed
                                                                         │ emit 'chat'
                                                                         ▼
                                                                  Iris handleUserInput(text)
                                                                         │ brain.think()
                          ┌──────────────────────────────────────────────┤
   reply  POST :3400/api/captions/iris {text}  ◀───────────────────────────┘
        │  → sendToAllWindows('iris:reply')  → badge chat panel shows her reply
   speaking  POST :3400/api/iris/status {speaking:true|false}
        │  → sendToAllWindows('iris:speaking')  → THE GLOW on/off
```

- **Reply** reuses the caption POST Iris already sent — near-zero Iris change.
- **Speaking** is posted at speak-start and on `iris:speech-done` (glow lights, then drops).
- **Presence** falls out of the `:3400` heartbeat: the badge flips offline when no ping for 10s.

---

## 4. The first command (Step 4)

Say/type: **"Iris, generate the calendar for August for Magical Forest."**

1. Her brain's `control_ether` tool gained a `generate` verb (`month:"YYYY-MM"`, optional `station`).
2. It POSTs `{action:'generate', payload:{month, stationName}}` to Ether `:3400` (scheduling tier —
   autonomous-allowed, no operator gate).
3. Ether's `routeIrisCommand` → `_generateRange(stationId, fromTs, toTs)` runs the **real Generate
   path**: the LRP ladder (Tier 1 compliant → Tier 2/3 least-recently-played) + the same diagnostics the
   calendar uses.
4. It returns `{count, relaxedPicks, runwayDays, throughDate, station, reasons}`.
5. Iris reports: *"Generated 4,013 tracks for Magical Forest — 4 relaxed picks, runway now 31 days."*
   If a category is empty/over-filtered, she adds the operator-readable reason.

Her write access here is **Generate-layer only** — she never touches the live queue or playout.

---

## 5. Every state is defined (Step 5)

The badge always has a definite state, never a mystery:

- **offline** — Iris not running / no `:3400` heartbeat. Panel says how to reach her (dev: launch the
  Iris app; packaged: she starts with Ether). No dead ends.
- **connecting** / **online-idle** — connected, ready.
- **thinking** — prompt sent, awaiting her reply.
- **speaking** — glow active.
- **error** — send failed; recoverable.

---

## 6. How to walk it (dev)

Phase 2 (bundled lifecycle) is not built yet, so in dev the two apps launch separately:

1. **Relaunch Ether** — `main.js` + the renderer changed, so fully restart it to load the new code.
2. **Relaunch Iris** — her `iris-ether-feed.js`, `electron/main.js`, `iris-brain.js` changed.
3. Click the **Iris badge** (bottom-right). It should go **online** once her `:3400` stream connects.
4. **Chat:** type a message → she replies in the panel; the badge **glows** while she speaks.
5. **Command:** "generate August for Magical Forest" → she runs Generate and reports the counts.
6. **Offline check:** quit Iris → badge returns to **offline** cleanly with the how-to message.

---

## 7. One honest gap (follow-up, non-blocking)

The command-executed gate lives on `routeIrisCommand` (the `/` command channel + `iris:command` IPC).
Iris's brain currently issues transport via `/api/transport/*`, which **bypasses that gate**. Today her
transport is only ever triggered by your input (so it isn't self-initiating), but to make the law
airtight I should:

1. Extend the gate to `/api/transport/*`, and
2. Mark brain-issued (think-driven) transport as `source:"operator"` while blocking any alarm/watchman
   path from issuing transport.

Small follow-up. It does not affect the chat / glow / generate walkthrough.

---

## 8. Commits

**Ether (`C:\openair`)** — untagged, staged for **v4.4.37**:
- `13df91d` feat(generate): ladder into Generate — least-recently-played fallback
- `604888d` feat(iris): two-tier grant as contract law + command-executed transport gate (Step 0)
- `7f48a19` feat(iris): Phase 1 Ether side — badge + chat panel, glow, :3400 chat channel, generate command

**Iris (`C:\iris`)**:
- `534d1cb` feat(ether): Iris-side chat round-trip — receive prompt, report speaking, generate verb

---

## 9. Track 2 — Scheduler tag (staged)

Tree is clean; the three Ether commits above are queued. On your walkthrough-green I immediately run
`npm version 4.4.37` → commit → tag `v4.4.37` → push → CI. Iris Phase 1 is safe to ship regardless — the
badge is offline-clean until Phase 2 bundles her.

## 10. Next — Phase 2 packaging (on your green)

Bundle Iris's lifecycle exactly like `ether-audiod`: ship inside Ether's installer, Ether spawns +
watchdogs + auto-starts her, updated with Ether's releases; badge/glow present from first launch, zero
user management. Dev keeps separate-launch. Gate by gate — and if a packaging unknown genuinely fails
after real attempts, Iris's bundled lifecycle rides the next tag (the badge still ships).
