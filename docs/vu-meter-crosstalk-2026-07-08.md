# VU meter cross-talk on v4.4.39 — read-only diagnosis (2026-07-08)

Report: v4.4.39 on jensj still shows OV's meter signal on all three stations (Halloween shows OV levels).
READ-ONLY; receipts each step. **HOLD for GO — no code changes.**

## Verdict
**This is expected, not a regression.** v4.4.39 shipped **VU Fix 1 only** (the "meters are taps" gate
removal — a channel could read flat under a playing song). **Fix 2 — station-scoping the levels frame —
was explicitly DEFERRED to the v4.5 re-key** and documented as known+bounded cross-talk. So OV's levels
rendering on all three meters is exactly the deferred Fix 2, not a broken Fix 1.

## Q1 — is jensj on 4.4.39 with a fresh daemon?
I **cannot verify jensj's live runtime from this box** (no remote access to the live machine). But it
doesn't change the diagnosis, because **this bug is not in the daemon path.** The cross-talk lives in the
**main process + renderer**, downstream of the daemon:
- The daemon **correctly** tags each levels frame with its station: `audiod/ether-audiod.js:194`
  `broadcast({ event:"levels", stationId: sid, ...getLevels(sid) })`.
- `electron/main.js:349` then **drops** that tag (below). So even a fully-restarted 4.4.39 daemon exhibits
  the cross-talk — a stale pre-install daemon is **not** the cause. (To confirm the version anyway:
  Help → About in-app, and the auto-updater's applied release; but it won't change this.)

## Q2 — the live VU path, and where the station tag dies
1. **Daemon tags it** — `audiod/ether-audiod.js:194` emits `{stationId, a, b, c, master}` per station. ✓
2. **main.js DROPS it (root)** — `electron/main.js:349` `const lv = { a: m.a||0, b: m.b||0, c: m.c||0 }`
   (rebuilds the frame, omitting `stationId`) → `:351 sendToAllWindows("audio:levels", lv)` — broadcast to
   **every** window with **no station tag**. ❌
3. **preload is global** — `preload.js:26` `onLevels` = `ipcRenderer.on("audio:levels")`, no filter.
4. **renderer fans one stream to all meters** — `VUMeter.tsx` reads `lvl.a/b/c` **by deck only**, no
   station check; `MasterOutput.tsx:63` / `ConsoleStrip.tsx` same. So whichever station emitted last
   (OV, updating every ~100ms) paints **every** station's deck-A/B/C meter.
- **Contrast (proves it's just this channel):** deck & queue DO carry the tag — `main.js:359,361`
  `{ stationId: m.stationId, … }` — and are filtered consumer-side at `engine-rodio.ts:173,191`. **Levels
  is the one unscoped channel.**

## Q3 — was the fix incomplete by design? YES.
- `docs/vu-meter-signal-path-2026-07-07.md` §4: *"Fix 2 — station-scope the levels tap … this is the
  v4.5.0 re-key, Phase 1-2."*
- `docs/v2-progress.md` STANDING LAWS: *"Fix 2 — KNOWN + BOUNDED (on the v4.5.0 re-key track): the levels
  frame is not yet station-scoped (stationId dropped at electron/main.js:349) … until v4.5.0 Phase 1-2
  lands, channel meters can cross-talk between stations — display only, no audio impact."*
- 4.4.39's VU fix (`VUMeter.tsx`) removed the `isPlaying` gate only; it never touched `main.js:349` or
  added a station filter. So cross-talk was always outside its scope.

## Q4 — proposed correct fix (station-scoped, ON the re-key, not a spot-patch)
Do the **v4.5 levels-channel scoping** (Phase 1-2 for the levels channel), by **UUID**:
1. **`main.js:349` — stop reconstructing the frame** (honors the forward-whole-frames invariant Jeff
   set). Resolve the daemon's `m.stationId` → the station's **`uuid`** (cached `id→uuid` map from the
   `stations` table) and emit `{ stationUuid, a, b, c, master }`. (When the v5 daemon handle lands, the
   daemon emits `stationUuid` directly and this map drops out — so this is a first step of the re-key,
   not a detour.)
2. **Renderer — filter by the bound station's uuid.** `VUMeter` / `MasterOutput` / `ConsoleStrip` render
   a levels frame only when `stationUuid === activeStationUuid` (`useActiveStation` already exposes
   `stationUuid`). Same shape as deck/queue filtering today, but keyed by uuid.

**Why not the integer spot-patch** (carry `stationId` on levels + filter by integer id): it would work and
match deck/queue, BUT it **adds an integer-station emitter → the CI leak-guard ratchet (baseline 14) fails
by design**, and it moves *against* the uuid re-key. The uuid fix above satisfies the leak-guard (no new
integer boundary payload), honors forward-whole-frames, fixes the cross-talk, and **is** the re-key's
levels-channel slice.

**Scope/where it fits:** this is v4.5.0 Phase 1-2 applied to the levels channel first. It can ship as its
own fix (jensj-facing) ahead of the full deck/queue/spectrum re-key, since it's a strict subset moving in
the same direction. deck/queue follow in the same phase.

---

## Cross-confirmation from the live box (jensj handoff, 2026-07-08)

`P:\vu-meter-handoff-from-jensj.md` — read-only diagnosis from the **shipped `app.asar` binary**, reached
the same root cause independently. It resolves my open items and adds one gap:

- **Q1 CLOSED with receipts:** jensj `Ether.exe` ProductVersion **4.4.39.0**; install stamped 2026-07-07
  17:25; all 6 `Ether.exe` **restarted 2026-07-08 09:33 (after install)**. Not a stale daemon, not a
  not-relaunched artifact. My "any 4.4.39, restarted or not, shows this" confirmed.
- **Binary confirms source:** `ether-audiod.js:194` tags stationId; `main.js:349` rebuilds `{a,b,c}` +
  drops it → `:351` global send (`sendToAllWindows` def `main.js:4155` = blind `getAllWindows().forEach`);
  deck/queue/enginestate/playstart/stream all carry `stationId` (`main.js:359,361,366,368,377`). Verbatim.
- **jensj topology (kills a known rabbit hole):** on the live box there is **no `C:\openair` and no
  `ether-engine.exe`** — the daemon is a child of the restarted `Ether.exe` (`resources\app.asar.unpacked\
  audiod\`). My `cd /c/openair` receipts are **source-side, valid in the repo**, and simply don't exist on
  jensj. Do not chase `ether-engine.exe`/`C:\openair` on the live box.

### Updated fix plan — scope BOTH levels paths (uuid), plus the caveat resolved
1. **Daemon relay `main.js:349`** — stop rebuilding; resolve `m.stationId → uuid` (own cached
   `SELECT uuid FROM stations WHERE id=?`, NOT the sync getter) and emit `{ stationUuid, a, b, c, master }`
   (forward-whole-frames + uuid).
2. **In-process fallback `main.js:2029-2036`** — same defect (`audioGetLevels()` no station arg → global
   send). Tag it with the **active** station's uuid: `{ stationUuid: resolve(getActiveStationId()),
   ...levels }`. Dormant while `AUDIO_DAEMON` latches true (`:427`), but **required** — otherwise, once the
   renderer filters by uuid, fallback frames (untagged) are filtered out → **meters go dark if the daemon
   ever fails to connect.** Scope both or the fix is conditional.
3. **Renderer** (`VUMeter`/`MasterOutput`/`ConsoleStrip`) — render a frame only when
   `stationUuid === activeStationUuid` (`useActiveStation.stationUuid`, already in the 4.4.39 bundle).
4. **Not gated by `uuidIdentity`** — that flag scopes the SyncEngine, not the audio levels channel.
   Leak-guard stays green (uuid tags, zero new integer-station emitters); forward-whole-frames honored.

Both agents, both ends, same conclusion.

---

## IMPLEMENTED & VERIFIED (GO'd 2026-07-08) — HOLD for tag GO

**Code (two-path UUID levels-slice):**
- `electron/levels-scope.js` (new) — shared pure core: `scopeLevelsFrame` (relay transform) + `matchesStation` (renderer predicate). Single source of truth.
- `electron/main.js` — daemon relay (`:349`) → `scopeLevelsFrame(m, _stationUuidById)` (forwards whole frame, swaps integer id→uuid); in-process fallback (`:2046`) tags with the **active** station's uuid; cached `_stationUuidById` resolver (own query, NOT the sync getter, NOT gated by `uuidIdentity`).
- Renderer — `src/lib/levelsScope.ts` (mirror) + `matchesStation` filter in all four `onLevels` handlers: `VUMeter`, `MasterOutput` (MasterVU + master level), `ConsoleStrip`. Ref-based → station switch needs no re-subscribe.

**Receipts (all three required tests + guards):**
- **Test 1 — station scoping: PASS.** `scripts/test-levels-scope.js` — OV frame renders on OV meter, DROPPED on Halloween meter (and vice-versa). Cross-talk killed.
- **Test 2 — fallback renders (not dark): PASS.** Fallback frame tagged with active uuid → renders on the active meter; boot/untagged frames also render (never dark).
- **Test 3 — packaged smoke (4.4.37 rule): PASS.** Built `electron-builder --win --dir`; fix confirmed inside `resources/app.asar`; `ETHER_SMOKE=1 dist-electron/win-unpacked/Ether.exe` → `EXIT=0`, `[SMOKE] PASS react_mounted=true root_children=1 renderer_error=false` (ether-startup.log 2026-07-08T17:45:15Z).
- **Leak-guard: green** — `integer-station emit-calls: 14 (baseline 14)`; uuid fix adds no integer emitter.
- **Builds:** `vite build ✓ 12.30s`; `node --check` clean on `main.js` + `levels-scope.js`.

**Out of scope (flagged, not touched):** `ConsoleStrip.tsx:140` still gates its VU by `isPlaying` — the same "meters are taps" law violation Fix 1 removed from `VUMeter`. Separate follow-up.

**Committed locally, NOT pushed, NOT tagged. HOLD for the tag's own GO.**
