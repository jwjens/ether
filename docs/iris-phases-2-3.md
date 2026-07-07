# Iris — Phase 2 (bundling) + Phase 3 (watchman) plan

Companion to [`iris-ether-contract.md`](./iris-ether-contract.md) (the law) and
[`iris-phase1-report.md`](./iris-phase1-report.md) (what's built). Sequenced, gated.

---

## Architecture confirmation — "does anything assume Iris is reactive-only?"

Checked against the code, not asserted:

1. **The deterministic floor is fully Iris-independent.** `grep -rni iris audiod/` → **0 matches**. The
   daemon's queue/advance/rotation/never-empty selector run with zero knowledge of Iris. She is the
   **fifth layer watching the four**; her being down changes nothing about playout. ✅ (Law §1.3 holds.)
2. **She already has an autonomous timer loop.** `iris-alarms.js` runs `setInterval` ticks — so a
   watchman loop is architecturally feasible; nothing forces her to be reactive-only. ✅ **But** this is
   exactly why §7 must close first: an autonomous loop + an ungated transport door = the law violation.
3. **Restart survival is already supported.** `iris-ether-feed.js` auto-reconnects to Ether's
   `/api/stream` every 3s → she re-attaches after an Ether restart and the watchman resumes. ✅
4. **Gap — the watchman's telemetry does not exist on the wire yet.** The SSE live-wire currently
   publishes only `airstate / position / nowplaying / queue / chat`. It does **not** publish runway,
   pool depth, tier-usage, auto-extend results, emergency-floor engagements, or resolve-exclusions —
   and several of those are **produced by scheduler rework layers that aren't built yet** (see deps).

**Verdict:** nothing structurally assumes reactive-only. Phase 3 is feasible, with two hard
prerequisites (the §7 gate, and the telemetry channel + its scheduler sources).

---

## PHASE 2 — Bundled lifecycle (Alexa-style)

Runs on Phase-1 walkthrough green. Gate by gate.

**Gate 0 (HARD PREREQUISITE — first item): close the §7 transport side-door.**
- Extend the command-executed gate to `/api/transport/*` (not just `routeIrisCommand`).
- Mark brain-issued (think-driven) transport as `source:"operator"`; block any alarm/watchman path from
  issuing transport at all.
- **No watchman loop is built until this is done.** An always-running Iris with an ungated transport
  door violates the two-tier law structurally, even if nothing exploits it today.

**Gate 1:** bundle Iris inside Ether's installer (electron-builder `extraResources` / `asarUnpack`,
like `audiod`).
**Gate 2:** Ether spawns + supervises Iris on startup — the `ether-audiod` watchdog pattern (auto-start,
respawn on crash, clean shutdown). Crash isolation preserved.
**Gate 3:** updated with Ether's releases; badge/glow present from first launch; zero user management.
**Dev unchanged:** separate-launch workflow stays.

**Fallback (only condition):** if a packaging unknown genuinely fails after real attempts, Iris's
**bundled lifecycle** rides the next tag — the badge (offline-clean) still ships.

---

## PHASE 3 — The watchman (Iris is never dormant)

Immediately after Phase 2. **This is the point of her existence.** Hard prerequisite: Phase 2 Gate 0
(the §7 fix) is done — no watchman loop exists until the transport door is structurally closed.

### What she does
1. **WARNS proactively** — voice + chat + badge state, **unprompted**, when telemetry trends toward
   trouble. E.g. *"Magical Forest's runway drops below 48 hours tomorrow"*, *"Christmas category is down
   to 12 compliant songs."*
2. **FIXES autonomously — SCHEDULING TIER ONLY** — regenerate / extend / adjust at the Generate layer on
   her own initiative, then **reports what she did and why**.
3. **NEVER touches transport from any autonomous path** — enforced structurally by Phase 2 Gate 0.

### Telemetry she monitors (must be published — see deps)
- Log **runway** per station.
- **Pool depth** per category (compliant-song count).
- **Tier-usage** rates (how often Tier 2/3 fallback fires).
- **Auto-extend** results.
- **Emergency-floor** engagements.
- **Resolve-exclusions**.

### Principles
- Her monitoring **survives Ether restarts** (re-attach + resume — already supported by the feed's
  auto-reconnect).
- Her being down **never degrades the deterministic defenses**. She is the **fifth layer, watching the
  four** (generated log → auto-extend → runway/warnings → emergency floor) — never replacing them.

### Dependencies (Phase 3 cannot complete without these)
- **Phase 2 Gate 0** (§7 transport gate) — hard prerequisite.
- **Scheduler rework layer #2 (runway + auto-extend)** — source of runway + auto-extend telemetry.
- **Scheduler rework layer #3 (emergency floor)** — source of emergency-engagement telemetry.
- **A new telemetry channel on the `:3400` SSE** — new events carrying runway / pool-depth / tier-usage
  / auto-extend / emergency / exclusions, so Iris consumes them as a pure client (same pattern as the
  live-wire).

---

## Sequence of record

1. Phase-1 walkthrough green → **tag `v4.4.37`** (ships Generate ladder + Iris Phase 1 badge).
2. **Phase 2**: Gate 0 (§7 fix) → Gate 1–3 (bundling). Fallback: lifecycle rides next tag.
3. Finish **scheduler rework layers #2 (auto-extend/runway) + #3 (emergency floor)** + publish their
   telemetry on the SSE (Phase-3 prerequisite; can proceed in parallel with Phase 2 bundling).
4. **Phase 3**: watchman — warn + scheduling-tier autonomous fix, never transport.
