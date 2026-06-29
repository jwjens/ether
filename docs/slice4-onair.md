# Slice 4 — ON-AIR control + studio-to-studio takeover (handoff)

## Built now: simple ON-AIR (committed)
Start/stop a station as the Icecast source from the dashboard, reusing the desktop's existing lifecycle.

**Scope findings (read-only, confirmed against the code):**
- **Daemon lifecycle** (`audiod/stream.js` `StreamSupervisor`): `start(config)` spawns `ffmpeg` reading the
  station's program-bus TCP port → encodes mp3 → pushes to `icecast://source:<pw>@<server>:<port><mount>`.
  `config` = `{server, password, mount, bitrate, sampleRate, icecastPort}`.
- **Config source**: the **station row** — `icecast_server_url / icecast_password / icecast_mount /
  icecast_bitrate` (`stations` table; `main.js:5558-5562`). The desktop reads it and hands it to the daemon.
- **Clean release**: `stop()` sets `armed=false` and SIGTERM-kills the ffmpeg process. The Icecast source
  connection drops → Icecast frees the mount → another machine can then source it. **It is a real release,
  not a pause.**
- **403 already classified**: `parseLine` maps `403|Forbidden` → `errorMsg:"Forbidden (403)"` (emitted on the
  `stream` status event), which is exactly the "mount already sourced" case.
- **Local on-air path** (reused, not duplicated): `useStreaming().goLive(stationId)` →
  `invoke("stream:go-live", {stationId})` → `main.js` reads the row + `audiodClient.cmd("startStream", …)`.
  `stopLive` → `stream:stop-live` → `stopStream`.
- **On-air state is observable via Slice 2**: when this machine's stream goes live, its per-station
  `stream:status` event sets `streamStatusRef[stationId].live`, which makes the now-playing push send
  `source_machine_id = this machine` → backend → dashboard shows `ON AIR · <machine>`. Stop → live=false →
  `source_machine_id` clears on the next keepalive → dashboard shows `Go on-air`. No separate state machine.

**Wiring:**
- `stream:start` / `stream:stop` added to `isStationScopedCommand` → routed by the resolver (only the machine
  running the target station acts; others ignore).
- `execCmd`: `stream:start` → `invoke("stream:go-live", {stationId: targetId})`; `stream:stop` →
  `invoke("stream:stop-live", {stationId: targetId})` — the SAME lifecycle as the local button.
- Dashboard `StationControls`: ON-AIR button reflects `source_machine_name` (Slice 2). On air →
  `◉ ON AIR · <machine>` + confirm → `stream:stop`. Off air → `Go on-air` + confirm → `stream:start`,
  disabled when offline. **403 UX fix**: `goOnAir` pre-empts with "already on air from `<machine>`" when the
  mount is already sourced — instead of firing a command that 403s at the source machine.

## Deferred: studio-to-studio takeover (build next, as its own step)
Taking over a mount that **another** machine (M1) currently sources, from M2, with minimal dead air.

**Why it's separate / sensitive:** a single Icecast mount has a single source at a time. There is **no atomic
swap** — M1 must release before M2 can grab, so there is an inherent **dead-air gap** on the mount:
`M1 ffmpeg SIGTERM` → Icecast detects source-disconnect → `M2 ffmpeg connect` → Icecast accepts → first audio.
Expect ~1–5 s of silence to listeners; their players keep the connection (Icecast holds the client socket).

**What a safe takeover requires:**
1. **Orchestration** (dashboard-driven): `stream:stop` → M1 releases → **then** `stream:start` → M2 grabs.
   Do NOT start M2 first (it 403s while M1 holds the mount).
2. **Release confirmation / retry**: M2's start can still race the release (Icecast hasn't freed the mount
   yet) → 403. Needs a bounded **retry-on-403 with backoff** on M2's start (e.g. retry ~5×/500ms) so it
   grabs as soon as the mount frees — either in the dashboard orchestration or a daemon-side
   `startStream({retryOn403})`. Observing release via Slice 2 attribution is too slow (up to one ~20 s
   keepalive, or the 90 s stale window); prefer M1's synchronous `stop` ack + the retry.
3. **Explicit operator intent**: a distinct "Take over from `<machine>`" action (not the plain Go-on-air),
   with a confirm that names the dead-air cost ("brief silence on air during handoff").
4. **Failure recovery**: if M2 can't grab after retries, surface it and (optionally) offer to put M1 back on.

**Build shape (next step):** a `stream:takeover` orchestration in the dashboard (stop M1 → retry-start M2),
or a daemon `startStream` retry-on-403 flag, behind a "Take over" button gated on `source_machine_name`
being a *different* machine. Test on a throwaway 2-machine setup against a throwaway Icecast — never the
live mounts.
