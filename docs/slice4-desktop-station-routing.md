# Slice 4 — Desktop station-routing fix (handoff)

**Status:** scoped + the pure resolver is built/tested/committed (`e4c3864`). The `execCmd` wiring is
**NOT done** — it changes the LIVE playout command handler and must be validated on a throwaway
desktop (never the three live stations: OV, HalloVeen, Magical Forest). This doc is the build + test
plan for the next session.

## Why (the two coupled bugs)
The command bus is **per-license**: `POST /api/cmd` → SSE `/api/cmd-stream` fans the command to EVERY
desktop on the license. Today in `src/App.tsx`:

1. **`execCmd` (~line 1006) ignores `data.station_uuid`** — it acts on the captured `engine`, so each
   machine runs the command against its own station. In the 3-station setup a "skip The Drop" also
   skips KOVA and Magical Forest. This is the off-air hazard.
2. **The SSE effect (~985–1164) is `[]`-deps** — it mounts once and pins `const engine =
   getEngine(stationId)` (App.tsx:502, a *per-station* instance from `engine-registry.ts:9`) to the
   **mount-time** station. Switching stations never updates the closure.

## What's already built (use it, don't re-derive)
`src/audio/cmd-routing.ts` (pure, unit-tested in `cmd-routing.test.ts`, 9 cases):
- `resolveCommandTarget(station_uuid, activeStationId, localStations)` →
  `{kind:"active",stationId}` (no uuid) | `{kind:"target",stationId}` (uuid runs here) |
  `{kind:"ignore"}` (uuid not on this machine → drop).
- `isStationScopedCommand(cmd)` → station-scoped (route by uuid) vs license-scoped (never gated).

## execCmd wiring plan (App.tsx)

### 1. Kill the stale closure with fresh refs
Near the other refs (~line 539):
```ts
const activeStationIdRef = useRef(stationId);
useEffect(() => { activeStationIdRef.current = stationId; }, [stationId]);
```
`execCmd` must read `activeStationIdRef.current`, never the closure `stationId`/`engine`.

### 2. The local station list (uuid→id source)
`resolveCommandTarget` needs `localStations: {id, uuid}[]`. Two options:
- **Per-command DB lookup** (authoritative; matches the existing `resolveSong` pattern):
  `await queryOne<{id:number}>("SELECT id FROM stations WHERE uuid = ?", [data.station_uuid])`.
  Then `target = row ? {kind:"target",stationId:row.id} : {kind:"ignore"}` (or `active` when no uuid).
- **Cached list** via `window.ether.stations.list()` (already used by `AudioEngineContext.tsx:14`),
  kept in a ref refreshed on `station-switched`. Lower latency; fine because the resolver is pure.

Either is acceptable; the DB lookup is simplest and has no cache-staleness risk.

### 3. Route at the top of execCmd
```ts
// license-scoped commands (db:apply, library:*) apply install-wide — never gate them
if (isStationScopedCommand(cmd)) {
  const target = resolveCommandTarget(data?.station_uuid, activeStationIdRef.current, localStations);
  if (target.kind === "ignore") { console.log(`[RemoteCmd] ${cmd} ignored — not run here`); return; }
  const targetId = target.stationId;
  // ...act on targetId (see §4); update UI state only if targetId === activeStationIdRef.current
}
```

### 4. Act on the TARGET, not the closure engine
**Recommended: route station commands DAEMON-DIRECT by `stationId`.** The daemon (`ether-audiod.js`)
is already per-station, and a non-active station's *renderer* engine is created by
`initializeRegistry` but **never `.init()`-ed**, so its `daemonDriven` is `false` (engine-rodio.ts:147)
— calling `getEngine(targetId).skip()/startDaemonAutomation()` would no-op or wrongly run a local
advance. Going straight to the daemon avoids that entirely:

| execCmd command | daemon-direct call |
|---|---|
| `automation_on`  | `audio.daemon("automationStart", { stationId: targetId })` |
| `automation_off` | `audio.daemon("automationStop",  { stationId: targetId })` |
| `skip`           | `audio.daemon("skip",            { stationId: targetId })` |
| `play` / `pause` | `audio.daemon("play"/"pause",    { deck:"A", stationId: targetId })` |
| `stop_all`       | three `audio.daemon("stop", { deck, stationId: targetId })` for A/B/C, **or** add a small `stopAll` handler in `ether-audiod.js` (cleaner; build it in the daemon, not blind) |
| `deck:load`      | resolve song (existing `resolveSong`), then `audio.daemon("deck:cue", { stationId: targetId, ... })` |

Gate on the app-level daemon flag (`audio.daemonEnabled()`), and **in-process fallback** (no daemon):
`const e = getEngine(targetId); e.init(); await e.awaitDaemonReady(); e.skip()` etc. In-process multi-
station is the degraded path; the active station already works as today.

### 5. Decouple UI state from the action
`setAutoAdv(...)`, `setShuffle(...)`, etc. mutate the **active** station's React UI. Call them only when
`targetId === activeStationIdRef.current`. Always `writeAutoAdv(targetId, …)` (per-station localStorage)
so the target's mode is correct when the operator next switches to it.

## Regression safety — must hold
- **License-scoped untouched:** `db:apply`, `library:addSong`, `library:syncDownload` skip the routing
  branch entirely (`isStationScopedCommand` → false). Never gated by `station_uuid`.
- **No-uuid commands unchanged:** resolver returns `{active}` → behaves exactly as today (companion app,
  any legacy caller).
- **uuid == active:** identical to current behavior.
- **Only behavior change:** uuid != active no longer hits the active station — it routes correctly or is
  ignored (the bugfix, not a regression).
- Keep the `default:` unknown-command path as-is (logs + no-op).

## Safe test procedure (throwaway desktop — NEVER prod, NEVER the 3 live stations)
Isolation is mandatory on all three axes:
1. **DB:** `ETHER_DB_PATH=<throwaway.db>` — a temp/empty DB, NOT `%LOCALAPPDATA%\Ether\com.ether.radio\
   openair.db`. Seed two test stations, e.g. A (`uuid-testA`) and B (`uuid-testB`).
2. **Daemon/pipe:** `ETHER_AUDIOD_PIPE=\\.\pipe\ether-audiod-test` so it uses a SEPARATE daemon, never
   the live one. Run on a box not driving live audio, or start no stream (command routing is observable
   from daemon logs without audio output).
3. **Command source:** a **local/mock backend or a throwaway license** for `/api/cmd-stream` — **never
   the production `/api/cmd`** (the real license's live installs would receive it). Or dispatch the SSE
   `cmd` event directly in a dev build.

**Assertions** (from daemon logs — no audio needed):
- `station_uuid=uuid-testA` → only A's `automationStart`/`skip` fires; B untouched.
- `station_uuid=uuid-testB` → only B reacts.
- `station_uuid=<unknown>` → nothing happens (ignored).
- no `station_uuid` → the active station reacts (back-compat).
- Switch the active station in the UI, resend → confirms the fresh-ref fix (no longer pinned to mount).

**Regression checks:** a no-uuid `skip` still advances the active station; `db:apply`/`library:*` still
apply install-wide; `queue:reorder` with `station_uuid==active` behaves as before.

## Build order for the next session
1. (done) pure resolver + test — `e4c3864`.
2. Daemon `stopAll` handler (optional, for clean `stop_all`) — small, testable in isolation.
3. `execCmd` wiring per §1–§5, behind the throwaway-desktop test harness above.
4. Run the assertions + regression checks on the test desktop, THEN propose shipping.
   Only after that is Slice 4 safe to deploy to the live stations.
