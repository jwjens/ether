# Deck fill-sweep — station-identity trace (read-only, 2026-07-28)

**Read-only investigation. No code changed, nothing fixed.** Deliverable: every place station identity
enters the deck-fill-sweep render path, what each does when the key is missing/stale/created-after, and what
change removes station identity from that hop so all stations are structurally identical shells over one
function. Verified receipts below; `UNKNOWN` where only runtime inspection can decide.

---

## Headline — two structural facts that reframe the bug

**A. The fill effect that got the 4.4.93 fix is DEAD CODE.** `function ThreeSlotBar` (`src/App.tsx:5669`)
contains the fill effect at `App.tsx:5715-5746`, and commit `0f67835` ("4.4.93: deck progress fill re-arms
per track") edited **only** its key line (`App.tsx:5726`). But `ThreeSlotBar` is **never rendered** —
`grep '<ThreeSlotBar'` across `src/` returns nothing; `App.tsx:3859` is the removal note ("The top DECK
A/B/C title strip (ThreeSlotBar) was removed"). **So the 4.4.93 fix never reached the screen.**

**B. The LIVE sweep is `ConsoleStrip.tsx` — and it still has the pre-4.4.93 key.** The on-air deck cards
render `<ConsoleStrip>` (`App.tsx:3883, 3926, 3951, 3972`). Its fill effect is `ConsoleStrip.tsx:107-133`,
and the re-arm key is still duration-only:
- `ConsoleStrip.tsx:112` — `const trackKey = \`~${Math.round(da.durationSec ?? 0)}\`;`
- guard `ConsoleStrip.tsx:115` — `if (da.status === "playing" && da.durationSec > 0 && trackKey !== fillTrackRef.current)`

Commit `0f67835`'s diff header is `diff --git a/src/App.tsx`; it never touched `ConsoleStrip.tsx`. So the
duration-collision re-arm bug the 4.4.93 message describes is **still live** in the real component — and that
part is **per-track, not per-station**.

The *station*-specific divergence (works on some stations, not on Christmas In July) is a separate defect in
how the live component's engine is initialized — HOP 4 below.

---

## The path — value → rendered element

Daemon-sourced in daemon mode:

`audiod/engine.js:485` `emit("deck", {stationId, deck, state, ready})` (from the daemon's 250 ms `poll()` /
`_maybeEmitDeck`, `audiod/engine.js:236, 277, 471-489`)
→ `electron/main.js:574` `sendToAllWindows("audio:daemon-deck", {stationId, deck, state, ready})`
→ `electron/preload.js:37` `onDeck` (`ipcRenderer.on("audio:daemon-deck", …)`)
→ `src/audio/engine-rodio.ts:198-211` daemon subscription → **stationId filter `:200`** → updates
`stateA/stateB/stateC` (`engine-rodio.ts:79-81`) → `this.listeners.forEach(l => l(id, st))` `:210`
→ `ConsoleStrip.tsx:109` `engine.on(() => …)` callback → reads `engine.getDeck(id).getState()`
(`ConsoleStrip.tsx:110`, `engine-rodio.ts:592`) → imperative `fill.style.transition = \`width ${remaining}s
linear\`; fill.style.width = "100%"` (`ConsoleStrip.tsx:119-123`) → the fill DOM node
(`ConsoleStrip.tsx:256` label-visible / `:292` slim accent, both `ref={fillRef}`).

The listener set fires from two sources, **both gated behind `engine.init()`**: the renderer 250 ms poll
(`engine-rodio.ts:152`, fires listeners `:383/385/387`; in daemon mode poll only advances `positionSec`
locally, `:376-381`) and the daemon deck events (`attachDaemonEvents`, fires listeners `:210`).
`attachDaemonEvents()` is reached **only** via `init()` → `detectDaemon()` → `attachDaemonEvents()`
(`engine-rodio.ts:153 → 167 → 172`). **An engine on which `init()` never ran fires no listeners at all.**

---

## Hop-by-hop station-identity table

Station identity does **not** enter the fill effect body directly — it enters entirely through *which
`AudioEngine` instance the component holds and whether that instance was ever initialized.*

| Hop | Station-keyed thing | Where set | Missing / stale / created-after | Init cadence | Remove-identity change |
|---|---|---|---|---|---|
| **1** | `stationId` from `useActiveStation()` — module-level `_cached` | `src/hooks/useActiveStation.tsx:37`, notify `49-53`, `"station-switched"` `105-113` | If IPC gives no active station → **silently falls back to id 1** (`:68/:115`) → wrong-station engine, no throw | Re-resolved on `"station-switched"` | (this *is* the selector; the silent id-1 fallback is the risk — make the fallback an explicit error/loading state, never a wrong id) |
| **2** | context value = `stationId` | `src/audio/AudioEngineContext.tsx:6,9,27`; `useAudioEngine()` = `getEngine(stationId ?? …)` `:35-37` | re-renders on switch → returns new station's engine; ConsoleStrip effect dep `[deckId, engine]` re-subscribes | **Re-resolved per switch — NOT stale** | — (already correct) |
| **3** | per-station engine registry `Map<number, AudioEngine>` | `src/audio/engine-registry.ts:7`; lazy create `:10-13`; `initializeRegistry` `:24-30` | `getEngine(4)` never throws — lazily `new AudioEngine(4)` (`:11`); but a freshly-created engine has had **no `init()`** (ctor only stores stationId, `engine-rodio.ts:72-74`). Registry guarantees an *object*, not a *subscribed* engine. | object created on demand | call `.init()` at creation in the registry (`:11/:27`), or drive the fill from a station-agnostic per-deck stream instead of a per-station engine object |
| **4 ⟵ PRIMARY DEFECT** | `engine.init()` bound to the wrong deps | only active-engine `init()` is `App.tsx:1514`, in an effect with deps **`[accountSignedIn, wasOnAir]`** (`App.tsx:1652`) — NOT `[engine]`/`[stationId]` | `engine` (`App.tsx:531 getEngine(stationId)`) re-evaluates every render, but the effect body re-runs only on account/wasOnAir change → `init()` is called on **whichever station was active at login**. A later **soft** switch (`handleStationSwitch` `App.tsx:1940-1948`, no `location.reload()`, contrast `:1917`) does **not** re-init. → `getEngine(4).init()` never runs → `attachDaemonEvents()`/poll never start → engine 4 never subscribes → its listener set never fires → `ConsoleStrip.tsx:109` callback never runs → **sweep never arms. Silent (no throw; `on()` returns a valid unsub).** | **Once, at mount, tied to the login-time station** | add `engine`/`stationId` to the init effect deps (`App.tsx:1652`), or `.init()` in the registry on creation |
| **5** | daemon deck-event `stationId` self-filter | `engine-rodio.ts:200` `if (m && m.stationId != null && m.stationId !== this.stationId) return;` (`this.stationId` ctor `:70-74`; siblings queue `:182`, playstart `:217`, enginestate `:224`) | daemon forwards ALL stations' events to ALL windows (`main.js:574`); engine 4 keeps only its own — **iff `this.stationId===4` and the subscription exists** (HOP 4). Wrong id (HOP 1) or no subscription (HOP 4) → correct events silently dropped/never delivered. `m.stationId != null` guard means a **null**-stationId event would pass to every engine (not this failure, but flagged). | set once in ctor | deliver deck state on a channel already scoped per station so the renderer needn't self-filter |
| **6** | fill effect's own `engine` closure | `ConsoleStrip.tsx:60` `useAudioEngine()`; dep `[deckId, engine]` `:133` | **Re-resolved per render/switch — NOT stale.** No `Map<stationId>`, no per-station index, no stationId filter inside the effect. `fillRef`/`fillTrackRef` are per-strip, not per-station. | per render | — (already correct) |

**The two hops that can silently diverge for a switched-to station:** **HOP 4** (never-init'd engine ⇒ no
events ⇒ no sweep — the primary defect) and **HOP 1** (wrong id ⇒ wrong engine, and the same resolver feeds
SHOW PROGRESS, explaining the "HalloVeen shown while Christmas In July active" screenshot — see below).

---

## Answers to the six questions

1. **Full path:** above ("The path"). Rendered element: `ConsoleStrip.tsx:256/292`.
2. **Value + cadence:** `da.status`/`positionSec`/`durationSec` from `engine.getDeck(id).getState()`
   (`engine-rodio.ts:592`, backing `stateA/B/C` `:79-81`). `engine.on` is a `Set` (`engine-rodio.ts:578`)
   fired by the 250 ms daemon `poll()` and by daemon deck events — **both only after `init()`**.
3. **Per-track re-arm:** the fix (`da.filePath || title~artist~duration`) exists at `App.tsx:5726` but in
   **dead** `ThreeSlotBar`. The **live** `ConsoleStrip.tsx:112` still keys on rounded duration alone →
   same-length back-to-back tracks don't re-arm (per-track bug, all stations).
4. **Station scoping:** the hop table. Primary: HOP 4 (`init()` deps `[accountSignedIn, wasOnAir]`,
   `App.tsx:1652`). It fails **silently** — `engine.on` simply never fires.
5. **Daemon vs renderer:** daemon-sourced; the `deck` event **is per-station** (`audiod/engine.js:485`).
   Whether station 4's engine is subscribed depends entirely on HOP 4 — **UNKNOWN at static analysis**
   (runtime-dependent on login-time station vs later soft-switch). **MANUAL mode does NOT suppress deck
   events** — the daemon `poll()` runs unconditionally (`audiod/engine.js:236`), recomputes `positionSec`
   for any `playing` deck (`:266-270`), and emits per tick (`_maybeEmitDeck` `:277/471-489`); `_started`
   only gates auto-advance/engine-state (`:302-314`), not deck emission. So MANUAL is not, by itself, a
   reason the sweep wouldn't arm — provided a deck is actually `playing` with `durationSec > 0`.
6. **Silent skips (live effect, `ConsoleStrip.tsx:107-133`):**
   - `:108` `if (!deckId) return;`
   - `:109` `engine.on(...)` **never fires** if engine 4 was never `init()`'d (HOP 4) or `stationId`
     mismatch drops events (HOP 5) — **the station-specific killer, no log.**
   - `:111` `if (!da) return;`
   - `:114` `if (!fill) return;` (`fillRef.current` null on the unrendered variant)
   - `:115` guard fails silently if `status !== "playing"` (events not arriving → status stuck at seed
     `"idle"`, `engine-rodio.ts:53-67`), or `durationSec === 0`, or `trackKey === fillTrackRef.current`
     (the un-fixed duration collision).
   - `:118` `remaining = max(0, durationSec - positionSec)` — a fresh event with `positionSec ≈ durationSec`
     (adopting a near-end deck on attach) → `remaining ≈ 0` → `width 0s` → fill **jumps to 100% instantly**
     (looks like "no animation"), then no re-arm until `trackKey` changes.
   - `:125` `if (status !== "playing")` sets a static width, `transition:"none"`, and clears
     `fillTrackRef.current = ""` (`:129`).

---

## The "HalloVeen while Christmas In July is active" screenshot

`useActiveStation` (HOP 1) is the **same** resolver feeding both the fill engine (`App.tsx:531`) and the
header SHOW PROGRESS (`App.tsx:520, 748-757` → `getActiveShowClock(stationId)`). `getActiveShowClock` is
itself correctly station-scoped (`src/audio/loggen.ts:378/385` `… AND station_id = ?`). So the wrong show
name means **either** `useActiveStation` resolved the wrong `stationId` (which would *also* hand the fill the
wrong engine — a single upstream corrupting both) **or** station 4's own `shows` table has a `HalloVeen`
row `is_active=1` matching the current hour/day (`loggen.ts:388-408`). Distinguishing them needs live
inspection (below).

---

## What would make all stations structurally identical

1. **Move the 4.4.93 re-arm fix to the live component** — `ConsoleStrip.tsx:112` → the identity key
   (`da.filePath || \`${da.title}~${da.artist}~${Math.round(da.durationSec)}\``), mirroring the
   applied-but-dead `App.tsx:5726`. Kills the per-track collision on the real UI.
2. **Remove HOP 4's mount-scoping** — add `engine`/`stationId` to the init effect deps (`App.tsx:1652`), or
   call `.init()` inside the registry on engine creation (`engine-registry.ts:11/27`), so *every* active
   station's engine subscribes to daemon events regardless of switch order. This is the change that makes a
   switched-to station behave identically to the login-time station.
3. **Delete dead `ThreeSlotBar`** (`App.tsx:5669-5886`) so the "fill sweep" has exactly one definition and a
   future fix can't land in the wrong copy again (this trace exists because 4.4.93 did).
4. **(Optional) Drop the per-engine `stationId` self-filter** (HOP 5) in favor of a subscription already
   scoped per station, so a wrong `this.stationId` cannot silently drop the right events.

Ranked by what unblocks Christmas In July: **#2 (init scoping) first** (it's why the sweep never arms for a
switched-to station), then **#1 (live re-arm key)** (why even an arming deck may not re-sweep per track),
then #3/#4 (hardening so the divergence is structurally impossible).

---

## UNKNOWN (runtime-only)
- Whether, this session, station 4 was the login-time station (engine init'd) or a later soft-switch (not
  init'd). Decides whether HOP 4 is the active cause right now. Needs live inspection of which engine has a
  running poll/subscription.
- Whether "HalloVeen" SHOW PROGRESS is a wrong `stationId` (HOP 1) or a station-4 `shows` row — needs the
  live `useActiveStation` `_cached.id` and the `shows`/`stations` rows.

## Key receipts
- Live sweep + stale key: `src/components/ConsoleStrip.tsx:60, 107-133` (key `:112`, guard `:115`, fill
  `:256`/`:292`, deps `:133`); render sites `src/App.tsx:3883, 3926, 3951, 3972`.
- Dead sweep (where the fix landed): `src/App.tsx:5669` (def), `5715-5746` (effect), `5726` (fixed key);
  removal note `App.tsx:3859`; zero `<ThreeSlotBar/>` usages.
- Engine resolution: `src/audio/AudioEngineContext.tsx:6,9,27,35-37`; `src/audio/engine-registry.ts:7,10-13,24-30`;
  `src/hooks/useActiveStation.tsx:37,68,105-113,115`; `src/App.tsx:520,531`.
- init scoping (PRIMARY): `src/App.tsx:1514` + deps `1652`; soft switch `App.tsx:1940-1948` (no reload,
  contrast `:1917`); `engine-rodio.ts:149-154, 159-170, 172, 210`.
- stationId filter + daemon chain: `engine-rodio.ts:70-74, 200`; `audiod/engine.js:236, 277, 471-489, 485`;
  `electron/main.js:574`; `electron/preload.js:37`.
- SHOW PROGRESS shared resolver: `src/App.tsx:520, 748-757`; `src/audio/loggen.ts:366-408` (`station_id = ?`
  `:378/385`).
