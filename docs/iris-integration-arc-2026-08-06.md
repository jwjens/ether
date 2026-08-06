# Iris Integration Arc — from "Iris on dev" to "Iris useful on installs"

**Date:** 2026-08-06 · **Status: DESIGN OF RECORD — NOTHING BUILT, NOTHING EDITED.**
Architecture-before-code for the Iris arc. Decisions for Jeff are collected in §9.

**Builds on (does not redesign):**
- `docs/iris-ether-contract.md` — the law. Two-tier grant, provenance enforcement, packaging.
- `docs/iris-integration-levels.md` — L1–L4; L1 live-wire contract.
- `docs/iris-audit-2026-05-31.md` — the shape of `C:\iris` (now partly superseded, see §0.2).
- `C:\iris\iris-ledger.js` — **IRIS WATCH**, the real decision ledger on `:3401`.

**The thesis:** Iris is not blocked on Iris. She is blocked on **Ether not exposing state a headless
process can read**, and on a **command surface that cannot safely be opened**. Part 1 is Ether-side
work and it is the whole prerequisite.

---

## 0. Grounding — what is actually built today

### 0.1 The contract (unchanged, still law)
- Iris is her own process; never on-air; the deterministic playout floor is Iris-independent
  (`iris-ether-contract.md` §1).
- **Two-tier grant** (§2): **Tier 1 scheduling = autonomous**; **Tier 2 transport = operator-commanded
  only**, enforced by `routeIrisCommand` refusing any transport verb without `source:"operator"`
  (`electron/main.js:4849`, `transport_requires_operator_command`).
- Ether hosts `:3400`; Iris is the client. State down over SSE `/api/stream`; commands up over `POST /`.

### 0.2 The ledger is real and newer than the audit
`C:\iris\iris-ledger.js` — "IRIS WATCH — the REAL decision ledger feed + live screen (port 3401)".
`record(evt)` is the only entry point; it persists to `iris-memory.decisions` **and** streams SSE to a
live screen; the recent ledger replays on connect. Transport-tier rows render amber
**"HOLDING FOR OPERATOR GO"**; scheduling-tier rows render green. Bound `127.0.0.1`.

This supersedes the 2026-05-31 audit's description of `:3401` (which was `hardware-server.js`
`POST /audio`, the WiFi-mic path). **Both still bind 3401** — `hardware-server.js` on `0.0.0.0:3401`,
the ledger on `127.0.0.1:3401`. One line, not investigated: if both ever start together, one fails to
bind. Worth resolving before either ships on an install.

### 0.3 Two terms I could not verify — Jeff to confirm
Jeff's brief names **"the 4-layer lock"** and **"the incident bridge"** as existing architecture. Neither
string appears anywhere in `C:\openair` or `C:\iris`. What I *can* verify as layered safety is four
distinct mechanisms, which may be exactly what he means:

1. **Contract invariants** — own process, never on-air, playout floor Iris-independent (§1).
2. **Two-tier grant** — scheduling autonomous, transport operator-only (§2).
3. **Provenance enforcement at Ether's boundary** — `transport_requires_operator_command`.
4. **Ledger visibility** — every decision recorded; transport shown as HOLDING FOR OPERATOR GO.

**Decision D1 (§9):** confirm that mapping, or point me at the doc, so this arc cites it correctly
instead of guessing. The same for the incident bridge — I found no such component.

---

# PART 1 — The three walls (Ether-side prerequisite)

Each wall re-checked against the tree today, not taken from the audit.

## Wall 1 — Live telemetry is renderer-bound → Iris goes blind headless
### Status: **STILL TRUE**, and the HTTP surface is worse than "blind" — it is *confidently wrong*.

- `iris:state` is still emitted by the **renderer**: `src/App.tsx:2131`, relayed by main at
  `electron/main.js:5029`. The renderer remains the only path-independent source of
  position/duration/queue, exactly as `iris-integration-levels.md` §L1 described in May.
- The HTTP endpoints do **not** use that payload. `/api/status` and `/api/now-playing`
  (`main.js:5196`, `:5202`) both read `audio.audioGetState()`, which returns **no position and no
  duration** (per the standing trap: `audio_get_state` yields raw deck info only). So
  `/api/now-playing` answers **`positionSec: 0, durationSec: 0` always**. A headless caller does not get
  an error — it gets zeros that look like data.
- What *has* shipped since the audit is main-side and real, but not queryable: daemon `onDeck`/`onQueue`
  streams, per-station processing meters, `library-health` senses, `health-events.jsonl`. The material
  exists; **there is no read API over it.**

### Design — a read-only state API (the "Iris can read the live system" layer)
One versioned, read-only surface on `:3400`, served from **main**, sourced from the daemon streams and
the DB — never from a renderer:

| endpoint | answers |
|---|---|
| `GET /api/v1/state/now` | on-air item, deck, position, duration, remaining, next item, air state |
| `GET /api/v1/state/decks` | per deck: loaded item, status, position/duration, ready |
| `GET /api/v1/state/queue` | up-next with durations and scheduled times |
| `GET /api/v1/state/levels` | program peak/LUFS, per-deck peak, processing meters, silence flag |
| `GET /api/v1/state/health` | the Health Monitor snapshot (the existing library-health senses) |

**The rule that makes this durable:** these endpoints must be answerable **with the window closed**.
Any field that can only be computed in the renderer is either (a) moved to main, or (b) omitted and
documented as unavailable — never faked with a zero. A `source` field on each response (`daemon` /
`db` / `derived`) keeps it honest.

**This also fixes a product bug, not just Iris:** `/api/now-playing` is a public integration endpoint
(traffic systems, monitoring). It has been returning zeros to everyone, not just Iris.

## Wall 2 — Scheduler/clock/daypart state is internal, not queryable
### Status: **STILL TRUE.**

The `:3400` route table today is: `/remote`, `/ping`, `POST /`, the Iris chat round-trip routes,
`/api/status`, `/api/now-playing`, `POST /api/transport/*`, `/api/log`, `/api/macros`,
`/api/macro/:id/run`, `/api/gpio/status`, `/api/repl/*`, `/api/stream`. **There is no clock, show,
daypart, runway, or rotation endpoint.**

The state exists and is computed constantly — `getActiveShowClock` (`audiod/loggen.js`),
`_buildScheduleCtx` / `_generateDayRows` (`electron/main.js`), `library-health` depth + last-Generate
summaries — but only inside the processes that use it. Iris cannot answer "why this song" or "what
happens at the top of the hour" because nothing tells her the clock.

### Design — read-only scheduler state
| endpoint | answers |
|---|---|
| `GET /api/v1/schedule/clock` | active show, its clock, the slot grid, position within the hour |
| `GET /api/v1/schedule/daypart` | current daypart, what changes next and when |
| `GET /api/v1/schedule/log?from&to` | generated log rows with state (pending/playing/played/missed) |
| `GET /api/v1/schedule/runway` | days generated ahead, last Generate result, gaps, relaxed picks |
| `GET /api/v1/schedule/why?rowId` | the picked item + why: category, separation, LRP, relaxations |

`/why` is the one that makes Iris an explainer rather than a narrator, and it is the natural home for
`scheduler_reasons`, which already exists as a table and is otherwise unread.

**Explicitly read-only.** Nothing here mutates. Generation stays a command (§Wall 3, Tier 1).

## Wall 3 — The command surface is unauthenticated
### Status: **STILL TRUE — and broader than the audit recorded. This is the sharpest finding here.**

Receipts:
- `irisHttpServer.listen(3400, '0.0.0.0')` (`main.js:5337`) — bound to **every interface**, not
  loopback. Anyone routable to the machine can reach it.
- `Access-Control-Allow-Origin: '*'`, and **no authentication check anywhere** in the server.
- `POST /` → `routeIrisCommand` — the entire command surface, including Tier-1 scheduling.
- **`POST /api/transport/{play|pause|stop|skip}` (`main.js:5213`) calls `audio.audioPlay/Pause/Stop`
  DIRECTLY.** It never goes through `routeIrisCommand`, so the `transport_requires_operator_command`
  provenance gate **does not apply on that route at all.**

That last point matters more than the missing auth: the contract states the gate exists "so an
autonomous slip can never reach the air layer **by construction**." Today the gate guards one door
while a second, unauthenticated door opens onto the same room, from any host on the network. The
contract's §2 enforcement is not currently true of the product.

### Design — an authed command surface
1. **Bind loopback by default.** `127.0.0.1:3400`. Remote access becomes an explicit, off-by-default
   station setting — and when enabled, requires auth (below) plus a visible indicator that it is open.
   (Note: this may affect existing LAN users of `/remote` — see decision D4.)
2. **One token per client, per install.** A local API token minted at install, stored with the
   install's secrets, presented as `Authorization: Bearer …`. Iris receives hers at provisioning
   (§Part 4). Every non-`/health` route requires it.
3. **Every command routes through `routeIrisCommand`.** `/api/transport/*` either becomes a thin
   wrapper that calls it with the same provenance rules, or is deleted. No second path to the fader.
4. **Tier stays in the router, not the transport.** Scheduling = autonomous with a token; transport =
   token **plus** `source:"operator"`. The token proves *who*; the provenance flag proves *whose
   judgment*. They are different questions and both must be answered.
5. **Refusals are ledger events**, not silent 401s — a rejected transport attempt is exactly what an
   operator needs to see.

---

# PART 2 — The knowledge model

Iris needs two kinds of knowledge, and conflating them is what makes assistants confidently wrong.

## 2.1 Operational knowledge — she fetches it herself
Everything in Part 1. Iris queries the live state APIs **autonomously**, on her own initiative, as
often as she needs. No human relays state to her; no state is pasted into a prompt; nothing is stale.
This is read-only by construction, so autonomy here is safe by construction.

**Consequence for prompting:** operational facts are never baked into her system prompt. If she says
"you're 40 seconds from the top of the hour," she just asked.

## 2.2 Stable knowledge — a curated base, not the dev docs
Broadcast theory, FCC obligations (legal ID, EAS), rotation and separation theory, dayparting, and
**how Ether works from the operator's side**.

**This must NOT be the raw `docs/` tree.** Those are engineering documents carrying the full history of
how conclusions were reached — including wrong theories that were later killed. Two live examples from
today alone: `docs/generate-freeze-and-calendar-history-2026-08-06.md` contains three superseded
diagnoses before the correct one, and `docs/master-monitor-faders-dead-2026-08-06.md` §6 describes a
monitor fix that §7 then corrects as a routing bug. An assistant retrieving from that tree will quote a
dead theory as current truth with full confidence.

**The curated base carries settled conclusions only**, written for the operator, versioned with Ether,
with a stated "as of version" on every entry. The natural seed already exists and is already
operator-facing: the `docs/help-*.md` corpus (the same one the tour layer consumes), plus
`ether-tours.json`. That corpus is written to a template, is plain-language, and is by construction
about behavior rather than implementation.

**Decision D2 (§9):** is the curated base *exactly* the help corpus plus broadcast theory, or a separate
authored artifact? My recommendation: help corpus + a small hand-written theory set, both shipped with
the installer, with a hard rule that **nothing from `docs/*-design-*.md` is ever ingested**.

## 2.3 Actions — knowing is autonomous, doing stays gated
Unchanged from the contract. Reading = autonomous. Scheduling/generation = autonomous (Tier 1).
**Anything that reaches air = operator GO (Tier 2).** The ledger already renders that distinction; the
command surface must enforce it on every route (Wall 3, item 3).

---

# PART 3 — The tiers (Jeff's product call)

## BASIC — ships with every install
**Iris knows and explains.** She reads the Part 1 APIs and answers the operator's questions:

- "What's playing? What's next? Why this song?" (`/schedule/why`)
- "How far ahead am I generated?" "What broke last night?" (`/schedule/runway`, `/state/health`)
- "What is a legal ID and when is mine due?" (curated base + `/schedule/daypart`)
- Explains Ether itself — the help corpus, in conversation, instead of a manual.

**Cost shape:** light. Short factual turns against fetched state. Bundled in the product price.

## ENTERPRISE — paid
**Iris programs.** Program-director work:

- Intelligent calendar generation — reads the library, the clocks, what actually aired, and proposes a
  week that a PD would sign.
- Automation and rotation tuning — spotting burn, thin categories, separation that is fighting the
  library, and proposing changes.
- Format and daypart advice grounded in this station's real airplay history.

**Cost shape:** heavy — long reasoning turns over large context. Covered by the enterprise price.

**Both tiers, one rule:** generation output is a **proposal**. Iris may run Tier-1 generation
autonomously per the contract, but **committing a programming change an operator has not seen is not in
her grant** — she proposes, the operator commits. The existing GO gate covers air; this extends the
same principle to programming.

**Decision D3 (§9):** does ENTERPRISE Iris commit a generated calendar autonomously (Tier 1 already
permits generation), or is a generated week always presented for operator commit? My recommendation:
**always presented**. A week of programming is a bigger act than a transport verb, and the tier's value
is the proposal quality, not the unattended commit.

---

# PART 4 — Dev-to-install

## 4.1 What Iris connects to, per install
One Iris process per install, connecting to **that install's** `127.0.0.1:3400` — never to a network
address, never to another machine. Ether spawns and supervises her exactly like `ether-audiod`
(contract §6). Station identity on every boundary is the **station UUID** (contract §1.5).

## 4.2 Provisioning
| item | BASIC | ENTERPRISE |
|---|---|---|
| Local API token (Wall 3) | minted at install, injected at spawn | same |
| Model access | bundled small-model key, tight budget | enterprise key, larger budget |
| Curated knowledge base | shipped with installer | same + programming/PD material |
| Ledger (`:3401`) | on, loopback | on, loopback |

Tier comes from the account's plan (the existing plan ladder — `free/pro/station/station_lifetime/
operator`), read from `/account/connect`, which is already the authoritative source. **Tier is not a
local flag**; a local flag would be a licensing hole.

**Decision D4 (§9):** BASIC bundles a model key, which means Ether pays per install for conversational
turns. Is that acceptable at the free tier, or is BASIC-Iris gated to paid plans? This is a real cost
question and it is Jeff's, not mine.

## 4.3 The structural guarantee — she cannot touch another account, or air
Three independent reasons, none relying on Iris behaving:

1. **She is loopback-bound to one install.** With `:3400` on `127.0.0.1` (Wall 3), an Iris on Jeff's
   machine has no route to any other install. `netgeak` (lic 21) and `cristianmalliani` (lic 23) are
   customers on their own machines; there is no address Iris could reach them at.
2. **The install is single-tenant.** One account per install (CLAUDE.md, desktop tenancy). Everything
   Iris can read through the state APIs is scoped to the signed-in account's stations by construction —
   she has no cross-account query surface because Ether does not have one.
3. **Air is gated by provenance, not by trust.** Transport requires `source:"operator"` at the router,
   and Wall 3 closes the second door. Even a fully compromised or hallucinating Iris cannot move a
   fader without an operator instruction to relay.

The cloud console (`platform.ether-technologies.com`) is the only cross-account surface in the product
and **Iris has no presence there**. That should be stated as an invariant of this arc, not an accident
of what is built.

---

## 5. Sequencing

| step | what | why this order |
|---|---|---|
| **1** | Wall 3 — loopback + token + one command path | Security before capability. Nothing else should ship onto installs while `/api/transport` is open on `0.0.0.0`. |
| **2** | Wall 1 — read-only state API from main | The prerequisite for every Iris behavior. Also fixes `/api/now-playing` returning zeros to existing integrations. |
| **3** | Wall 2 — scheduler state + `/why` | Turns Iris from narrator into explainer; unlocks BASIC. |
| **4** | Curated knowledge base | Ship BASIC. |
| **5** | ENTERPRISE programming | Built on 1–4; heavy model work last. |

Steps 1–3 are **Ether work with no Iris dependency** and are worth doing on their own merits: they are
the honest public API this product does not yet have.

## 6. Explicitly NOT in this arc
- Rebuilding the two-tier contract, the ledger, or the presence/glow surface — all built, all law.
- Iris on-air, in any form.
- RAG/vector infrastructure — the curated base is small and versioned; retrieval scoring is a later
  question, not a starting requirement.
- The Item-4 content platform (`iris-as-platform-content-types.md`) — separate arc, unstarted.
- Anything touching customer accounts.

## 7. Verification posture
No claim in Part 1 is from memory; each was re-checked in the tree today and is cited to file and line.
When this arc is built, each wall closes with a **runtime** receipt, not a grep:
- Wall 1: query every state endpoint **with the Ether window closed** and get real values.
- Wall 2: `/schedule/why` on a real aired row matches what the operator sees in the log.
- Wall 3: an unauthenticated `POST /api/transport/play` from another host on the LAN is **refused**, and
  the refusal appears in the ledger.

## 8. Open risks
- **Renderer-only fields.** Some of the L1 payload may have no main-side source without engine work
  (`iris-integration-levels.md` §"Deferred" already flagged intro/outro/segue windows). Where that is
  true, the honest answer is to omit the field, not to zero it.
- **Loopback binding is a behavior change.** If any operator uses `/remote` from a phone on the LAN
  today, closing `0.0.0.0` breaks them. That is the right default, but it needs the explicit
  station-setting escape hatch and a release note.
- **Port 3401 collision** between `iris-ledger.js` and `hardware-server.js` (§0.2).

## 9. Decisions for Jeff
1. **D1** — Confirm what "the 4-layer lock" and "the incident bridge" refer to. Neither string exists in
   either tree; §0.3 lists the four mechanisms I *can* verify. I would rather cite yours than invent one.
2. **D2** — Curated knowledge base = help corpus + authored theory, with `docs/*-design-*.md` **never**
   ingested? (Recommend yes.)
3. **D3** — Does ENTERPRISE Iris commit a generated calendar autonomously, or always propose for
   operator commit? (Recommend always propose.)
4. **D4** — Does BASIC (bundled model cost) ship on free plans, or only paid?
5. **D5** — Loopback default for `:3400`: accept the `/remote` breakage with an opt-in setting?
   (Recommend yes — it is currently an unauthenticated fader on every interface.)
6. **D6** — Sequencing: agree Wall 3 ships before anything else Iris-related reaches an install?

**Nothing in this document has been built. No code was changed to produce it.**
