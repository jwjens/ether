# VU meters not station-scoped — read-only diagnosis (2026-07-07, v4.4.38)

Meters show whichever station's deck is emitting, regardless of the station the UI is bound to.
**Read-only. Receipts (file:line) for every claim. No fix, no commit, no tag until GO.**

## Verdict
The daemon meters every station and **tags each frame with `stationId`**, but the **main-process relay
drops the tag** when it rebuilds the levels payload, then broadcasts it to all windows. The renderer
therefore receives untagged `{a,b,c,master}` frames on a **global, once-at-boot subscription** with no
station field to filter on — so the last station to emit wins. The identical relay a few lines away keeps
`stationId` for deck and queue, which is the smoking gun.

## Trace, hop by hop

**1. Rust engine (per-station):** `A.audioGetLevels(sid)` is called with a station id — metering is
per-station at the native layer.

**2. Daemon — tags every frame, meters ALL stations** — `audiod/ether-audiod.js:190-194`:
```
for (const sid of stations) {
  broadcast({ event: "levels", stationId: sid, ...JSON.parse(A.audioGetLevels(sid)) });
}
```
Frame = `{ event:"levels", stationId, a, b, c, master }`. ✅ station identity PRESENT.

**3. Main relay — DROPS stationId (FIRST hop where identity is lost)** — `electron/main.js:348-351`:
```
if (m.event === "levels") {
  const lv = { a: m.a || 0, b: m.b || 0, c: m.c || 0 };          // m.stationId NOT copied
  lv.master = typeof m.master === "number" ? m.master : Math.max(lv.a, lv.b, lv.c);
  sendToAllWindows("audio:levels", lv);                           // global broadcast, no station
}
```
❌ **This is the defect.** The relayed frame has no station identity and goes to every renderer.

**Smoking gun — the same handler keeps the tag for deck/queue** — `electron/main.js:359-361`:
```
} else if (m.event === "deck")  { sendToAllWindows("audio:daemon-deck",  { stationId: m.stationId, deck, state, ready }); }
} else if (m.event === "queue") { sendToAllWindows("audio:daemon-queue", { stationId: m.stationId, items, source }); }
```
Deck and queue preserve `m.stationId`; **only levels (line 349) drops it.**

**4. Preload — global subscription, no filter** — `electron/preload.js:26`:
`onLevels: (cb) => { const h = (_, v) => cb(v); ipcRenderer.on("audio:levels", h); return h; }`

**5. Consumers — can't filter (identity already gone), subscribed once:**
- `src/components/VUMeter.tsx:222-229` — `onLevels((lvl) => { raw = deckId==="A"?lvl.a : deckId==="C"?lvl.c : lvl.b })`. Reads by **deck only; no station field exists on the frame.**
- `src/components/MasterOutput.tsx:60-66` — `useEffect(() => { onLevels(lvl => masterRef.current = lvl.master ...) }, [])`. **Empty deps → subscribed once at mount, never rebound/filtered on station switch.**
- Same global pattern: `ConsoleStrip.tsx:133`, `BroadcastMonitor.tsx:407`, `DeckConfigurator.tsx:490`.

**Answer to "first hop where station identity is absent/dropped": `electron/main.js:349`.**

## Subscription lifecycle
Global, once-at-boot; not rebound or filtered per station (`MasterOutput.tsx:60` deps `[]`; `VUMeter.tsx`
deps are `isPlaying`/`deckId`, not station). Even if rebound, there is no `stationId` on the frame to
filter by — the tag was dropped upstream at main:349.

## Daemon scope
Meters ALL running stations concurrently and tags each frame (`ether-audiod.js:190-194`). So this is
exactly "frames station-tagged at the daemon, tag ignored downstream" — dropped at `main.js:349`.

## Regression — where scoping was lost
- Daemon has tagged levels with `stationId` since it was scaffolded: **`fa65b4f`** (`git log -S 'event: "levels", stationId' -- audiod/ether-audiod.js`).
- The main relay that drops it was written in **`3bd3718`** — "Phase 2 Step 1 — main forwards audio:* to the daemon" (`git log -S 'const lv = { a: m.a' -- electron/main.js`).
- **So the regression is `3bd3718` (the daemon-forwarding wiring):** the levels relay was authored without copying `stationId`, while the deck/queue relays in the same handler kept it. Not the is_active/PlayerBar work.

## Blast radius
- **Levels (`audio:levels`): BROKEN** — tag dropped at main:349. Affects every `onLevels` consumer:
  VUMeter, MasterOutput, ConsoleStrip, BroadcastMonitor, DeckConfigurator.
- **Deck / queue (`audio:daemon-deck` / `-queue`): tag PRESERVED** (main:359-361). Frames are filterable;
  **needs a separate check that the renderer consumers actually compare `stationId` to the active station**
  — if they don't, deck/queue state can cross-contaminate too, but the fix there is filtering, not a
  dropped tag.
- **Spectrum: OK** — pull path scoped by station: `preload.js:13 getSpectrum(stationId)` → `main.js:2659`
  `audiodClient.cmd("getSpectrum", { stationId })`.
- **Position/time:** rides deck state (tagged) — same status as deck/queue.

## Proposed fix (NOT applied — awaiting GO)
1. **`electron/main.js:349`** — carry the tag, mirroring deck/queue:
   `const lv = { stationId: m.stationId, a: m.a||0, b: m.b||0, c: m.c||0 };`
2. **Renderer** — meter components filter frames by the station the UI is bound to: in each `onLevels`
   handler, `if (lvl.stationId !== activeStationId) return;`. Pass the active station id into VUMeter /
   MasterOutput / ConsoleStrip (they currently take none).
3. **Verify deck/queue consumers** filter by `stationId` (tag is already present); fix if not.
4. **Identity rule note:** the local audio channel uses the **integer** station id uniformly today —
   `getLevels(sid)`, deck/queue (`m.stationId` integer), `getSpectrum(stationId)`, `audio:daemon` all
   integer. The minimal, consistent fix carries that same integer stationId on the levels frame. The
   standing "UUID, never local integer" rule targets cross-machine/sync identity; applying it to this
   purely-local real-time channel would mean re-keying the entire local audio IPC (daemon `stations` is a
   Set of integer ids) — a much larger change. **Decision for Jeff:** minimal integer-scoped fix
   (consistent with deck/queue) vs. full UUID re-keying of local audio IPC.

**Blast radius of the fix itself:** additive — one field at main:349 + a station filter in the meter
consumers. No playout impact; the audio path is untouched.

No code changed. No commit, no tag. Awaiting GO.
