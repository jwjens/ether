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

---

## (B) Guided manual handoff — BUILT (the operator is the orchestrator)
Shipped as the safe interim: the dashboard walks the operator through the handoff; each step is explicit,
confirmed, and reflected against the live source attribution. No auto-orchestration, no rollback timer —
the safety is the human in the loop.
- New: `target_machine_id` on `stream:start`/`stream:stop` + a per-machine gate in `execCmd`
  (`commandTargetsThisMachine`, reusing `machineIdRef`) so a command hits exactly ONE machine.
- New: `GET /api/account/devices` (JWT) — the machine roster for the target picker.
- New: `HandoffModal` — pick target → "Take off air on <source>" (confirm) → watch the source clear →
  "Go on air on <target>" (confirm) → watch it go live → manual "Put <original> back on" if it doesn't.
- Honest UI: a clear ~1–3 s dead-air notice; targets marked "● online (on air)" only when currently
  sourcing a station, else "last seen … · may be offline" (no presence system is pretended).

## (A) Full auto-orchestrated takeover — FUTURE (not built; needs the infra below)
One-click "Take over" with no operator babysitting. Requires three new pieces + a test rig:

1. **Per-machine presence heartbeat.** Today there is NO live per-machine presence — `license_activations.
   last_seen` is set on activation/login (not continuous), and `now_playing` is per-station (only the
   current source's id, fresh). Need each machine to periodically post "online, running stations [X,Y],
   sourcing: …" so the backend can offer *verified-online, station-capable* takeover targets (incl. idle
   standby machines, which B can't see).
2. **Fast cross-machine ack.** The orchestrator must learn "new source went live / failed" in ~1–2 s to
   drive a rollback. The Slice-2 source attribution is too slow (≤20 s keepalive + dashboard poll). Need
   the grabbing machine to report stream live/failed immediately (an accelerated now-playing post on
   stream-live, or a dedicated takeover-status endpoint the orchestrator polls every ~1 s).
3. **Orchestrator + rollback timer.** Release old → retry-grab new (bounded retry-on-403 to absorb the
   release latency) → await the fast ack within a timeout → on failure, **re-grab old** (planned-handoff
   rollback; a dead old machine has nothing to roll back to — that's failover, not handoff). Never end
   with nobody sourcing while the old machine is alive.

**Test rig (mandatory before A ships):** two throwaway desktop instances (distinct `ETHER_DB_PATH` +
`ETHER_AUDIOD_PIPE` + station ids) pointed at a **throwaway Icecast** (never the live mounts), driven by
a mock/throwaway-license command source. The non-negotiable test: **force the new machine to fail the
grab and assert the orchestrator re-grabs the old** (station never left silent). Also measure the real
dead-air gap on the throwaway mount to confirm the ~1–3 s estimate.

**Reminder:** ~1–3 s of dead air is intrinsic to single-mount Icecast; only a server-side `<fallback-mount>`
/ relay (infrastructure) eliminates it — out of scope for both A and B.
