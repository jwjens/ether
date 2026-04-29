# Multi-Station Broadcast Architecture

**Status**: Design draft
**Author**: Jeff Jens (with Claude as scribe)
**Date**: April 28, 2026
**Phase**: Post-Phase-3.5 architectural planning

---

## Purpose

This document captures the architectural decisions for Ether's multi-station broadcast capability. It addresses how Ether handles multiple radio stations under one facility, how data and audio are kept consistent across machines, and how operators interact with stations they're authorized to manage.

The decisions here resolve a long-running architectural confusion (cloud-authoritative vs local-first) by formalizing **local-first with cloud sync** as the foundational model. All prior Phase 3.5 sync infrastructure work (UUIDs, mutations log, schema versions, typed handlers) is the correct foundation for this architecture.

---

## Foundational Principle (P0)

**There is exactly one engine per station, and it runs locally on a PC.**

The local Ether instance is the source of truth for what's playing on each of its stations. Icecast receives the local engine's audio output. Cloud infrastructure (Cloudflare R2, AWS Lightsail) acts as relay/CDN/sync hub. **The cloud does not make playback decisions.**

Any future architectural temptation to "have the cloud play music when local is offline" or "let the cloud make scheduling decisions" must be rejected. There is one engine per station. Everything else relays.

This principle resolves the week-long confusion that led to two parallel rotation engines (one local, one cloud) producing different audio on the same Icecast stream.

---

## Core Architecture: Local-First with Cloud Sync

### What this means in plain English

A facility (one Pro+ license / one company / one ownership group) operates as a single logical entity:

- ONE shared song library
- N stations
- M operators (each assigned to one or more stations)
- K Ether installations (PCs running Ether — could be 1 PC handling all stations, or N PCs each handling 1 station, or any mix)

Each PC running Ether stores a **local copy** of the facility's database in SQLite. Local copies stay coherent via cloud-mediated sync. The audio engine on each PC reads from its local copy at zero latency. Mutations made on any PC propagate to all other PCs in the same facility via cloud within seconds.

### Why local-first

Audio playback cannot tolerate network latency. The engine must read song metadata and file paths at sub-millisecond speed. A roundtrip to a cloud database would introduce 50-200ms per query — broken for broadcast playout.

### Why cloud sync

- **Multi-machine workflows**: Operator walks from Studio A to Studio D, logs in, sees the same data because Studio D's local copy has been syncing all along.
- **Disaster recovery**: If a PC dies, restore the local SQLite from cloud's copy.
- **Remote management**: The cloud admin web UI (future build) reads facility state via the sync layer and sends commands back.
- **Audio relay**: Local engine streams audio up to cloud Icecast, which re-broadcasts to global listeners.

### Why neither pure local nor pure cloud works

**Pure local** fails because operators can't move between studios without manually copying data. Cross-machine collaboration is impossible.

**Pure cloud** fails because internet outages stop broadcast. Latency on every query breaks live DJ workflows. Unacceptable for radio.

**Local-first with sync** gives both: zero-latency local playback plus seamless multi-machine workflows.

---

## Design Principles

### P1 — Engine ≠ Automation

Engines are the engineer's domain. Automation is the program director's domain.

- **Engine**: The audio playback machinery for a station. Always running once a station exists. Equivalent to a transmitter — never goes off "on purpose," only via maintenance or shutdown.
- **Automation**: The schedule feeding songs into the engine. Operator-controlled. Toggled via the existing "A" / Start Automation button.

A station can be in any combination:

| Engine | Automation | Icecast | State |
|---|---|---|---|
| Running | OFF | OFF | Station exists, dead-air locally, not streaming. (New station before content loaded.) |
| Running | ON | OFF | Producing audio internally, listeners can't hear it. (Operator testing.) |
| Running | ON | ON | **On the air.** Standard broadcast state. |
| Running | OFF | ON | Streaming silence to listeners. (Off-air maintenance, keeps the connection alive.) |

Engine never stops via UI action. Operator controls the other two toggles via Settings → Broadcast.

### P2 — Monitoring Independent from Viewing

The local soundcard output for monitoring is decoupled from which station's UI is currently visible. The operator can be viewing Station A's library while monitoring Station B's broadcast, or any combination.

### P3 — Monitoring Selection on Start My Shift

When the operator launches Ether and goes through the existing Start My Shift screen, they pick which station to monitor for the duration of their shift. The choice can be changed mid-shift via the Station Monitor panel.

For single-station operators (Free tier or Pro+ operator assigned to one station), there's no selection — monitoring defaults to ON for their station.

### P4 — Operator-Station Scoping

Operators are assigned to specific stations by an admin. PIN-based login enforces scoping:

- **Single-station assignment**: Operator goes straight to that station's dashboard after Start My Shift.
- **Multi-station assignment**: Station picker appears at Start My Shift. Operator chooses primary workspace.
- **No assignment**: Login shows an error directing operator to admin.
- **Admin role**: Bypasses scoping. Sees all stations in the facility.

The Start My Shift station picker, the Station Monitor panel, and the station switcher all show only stations the current user has access to.

### P5 — Action Ownership

Manual operator actions (deck control, cart fire, manual song load, hotkey/macro trigger) target the engine of the **currently-viewed** station. Hotkeys and macros are scoped to the viewed station — pressing a hotkey while viewing Station A fires A's macro, even if monitoring B.

Operators never trigger actions on stations they're not viewing.

### P6 — Existing Role Structure Preserved

Ether already has three user roles:

- **Administrator** — PIN required, full access, manages users and stations.
- **Music Director** — PIN required, programming and scheduling for assigned stations.
- **On-Air Jock** — PIN optional, operates automation and live shows for assigned stations.

This structure is preserved. Multi-station work adds:

- Verification that role permissions are actually enforced (currently likely cosmetic).
- New `operator_stations` table for many-to-many operator-to-station assignment.
- Station picker in login flow when operator has multi-station access.

### P7 — License Tier Gating

Multi-station broadcast is a **Pro+ tier** feature.

- **Free tier**: Single station, single engine, single Icecast stream, single operator implicitly owns the station. Station Monitor panel exists but shows only one station.
- **Pro+ tier**: Multiple stations, each with always-on engine and Icecast stream. Operator-to-station assignment. Multi-station Monitor panel.

The Rust backend should run multi-engine architecture internally regardless of tier. The renderer hides multi-station UI on Free tier. Simpler than two backend modes.

### P8 — Station Monitor Panel

Always present, role-aware, access-scoped. Shows:

- Each station the current user has access to
- Currently playing track per station (title, artist)
- Automation status (ON/OFF) per station
- Monitor selector (radio button — only one station can be the active monitor)
- Visual indicator showing which station is currently selected for monitoring

For single-station operators, the panel shows one row with a simple monitor on/off toggle. For multi-station operators, a selector. For admins, all stations in the facility.

### P9 — Per-Station Broadcast Configuration

Every station has its own complete broadcast config:

- Icecast endpoint URL + mount point + credentials
- Stream metadata output destinations (TuneIn AIR, Shoutcast, custom webhooks)
- "Go Live" status (engine streams to Icecast or doesn't)
- Audio output device for local monitoring
- Microphone device for voice tracking

Settings → Broadcast becomes station-scoped. Viewing a station's settings shows that station's config. Switching stations switches the settings page.

### P10 — Per-Station Audio Device Assignment

Each station has its own configured audio output device. This routes to physical speakers when that station is selected for monitoring.

- **Common case**: All stations use the same default output. Monitoring switches between them.
- **Advanced case**: Each station has a different physical output (Focusrite Out 1 for KROK, Out 2 for KJAZ). Useful for facility installs where each station has its own monitor speaker.

Microphone assignment is also per-station — different stations may have different studio mics in different physical rooms.

### P11 — Per-Station Stream Metadata Outputs

The existing "Stream Metadata Outputs" config (push now-playing to multiple destinations) is per-station. Each station can have multiple metadata destinations. When a station's now-playing changes, it pushes to all configured outputs for THAT station.

### P12 — Ether Runs Continuously as Background Process

The X button minimizes to the system tray. Engines stay alive in the tray-resident process. True shutdown requires explicit "Quit Ether" from tray menu OR force-kill via Task Manager / terminal.

This is intentional. Ether IS the playout server, not a session-based application. All N station engines run from launch until explicit shutdown.

The OS tray icon shows Ether is running with quick access to status and quit.

### P13 — Crash Recovery

On unexpected shutdown (crash, power loss), Ether's restart sequence:

1. Each station's engine spins up.
2. Each engine looks at the last entry in `play_log` to determine what was playing when it died.
3. Schedule advances from the next position (no replay of already-aired content).
4. Icecast streams reconnect.
5. Operators receive notification: "Station X crashed at HH:MM, resumed automation."

Best-effort restoration. A station that was dead-air resumes as dead-air. A station running automation resumes automation. No automatic intervention required.

### P14 — "Go Live" Controls Icecast, Not Engine

The existing "Go Live — Stream to Icecast" button controls whether the engine's audio is currently being pushed to Icecast. Engine is always running; Icecast streaming is operator-toggled.

This respects operator agency for maintenance scenarios where the stream connection should stay open but no content is pushed.

### P15 — Cloud as Relay/Backup, Not Decision-Maker

Cloudflare + AWS Lightsail provide:

1. **Icecast relay**: Cloud-hosted Icecast receives the local stream and re-broadcasts to listeners. Listeners connect to the cloud URL, not directly to local PCs.
2. **Failover**: If local Ether loses connection to cloud, the cloud serves the last-known audio (looped or short-buffered) to listeners until reconnect. Cloud does NOT generate new content.
3. **CDN**: Geographic distribution of streams.
4. **Now-playing endpoint backup**: Cloud serves now-playing JSON if local network is unreachable.
5. **Library sync target**: Library data syncs to cloud for backup and cross-machine sync.

The future cloud admin web UI is purely a remote control surface. It shows current state of local Ether instances and sends commands to them. It NEVER makes playback decisions.

### P16 — Local-First with Cloud Sync (formal statement)

Each Ether installation runs a local SQLite database that is authoritative for its own writes. The local audio engine plays from this local data — zero cloud dependency for broadcast continuity.

Mutations sync to cloud infrastructure for:
- Cross-machine sync within the same facility
- Disaster recovery
- Remote admin access via future cloud web UI
- Audio stream relay to global listeners

If cloud connectivity is lost, the local engine continues broadcasting; mutations queue locally and sync when connectivity returns.

### P17 — Multi-Machine Seamless Workflow

An operator with appropriate credentials can walk to any Ether installation in the facility, log in with their PIN, and access their assigned stations. The local SQLite on each machine syncs from cloud, so all data appears on whichever PC the operator is at.

The audio engine for a given station runs on whichever PC currently has it active. Typically, KROK runs on Studio A's PC under normal operations. If Studio A is unavailable (maintenance, hardware failure), the operator walks to Studio D, logs in, and starts KROK's engine on that PC.

**Engine ownership migration** (which PC is currently running a station's engine) is a future detail to be specified. For now, only one PC per facility runs a given station's engine at a time.

### P18 — Facility-Scoped Data, Station-Scoped Programming

A facility owns:
- ONE shared song library (`songs`, `artists`, `albums` — install-scoped)
- N stations (each with its own programming, schedule, config — station-scoped)
- M operators (assigned to specific stations)
- K Ether installations (PCs in the facility, all syncing the same data)

Same song row, different programming attributes per station — exactly the Phase 4 Direction C architecture already shipped. "Don't Stop Believin'" is one row in `songs` shared across the facility. Each station's `station_programming` row references that song with its own category, energy, BPM-relevance, etc.

The cloud sync hub is facility-scoped — propagates mutations between PCs in the same facility, isolates between different facilities.

### P19 — Facility Identity Tied to License

A facility is identified by a license key. One Pro+ subscription = one facility. Multiple PCs can install Ether and use the same license key to join that facility's sync group.

This ties multi-tenancy to billing naturally and supports memory line 8 item #5 ("multi-tenant Control Center"). Free tier installations are single-PC only with no facility concept (the install IS the facility, of one).

---

## Implementation Phases

This architecture is too large for a single session. Suggested phasing:

### Phase A — Multi-Engine Backend Foundation
- Refactor Rust audio engine to support N concurrent instances
- Each engine has isolated state (decks, queue, position)
- IPC channels gain station_id parameter
- Lifecycle management (start engines on app boot per existing stations, spin up on station create)
- Crash recovery per engine

### Phase B — Per-Station Icecast Streaming
- Each station has independent Icecast config
- Concurrent streams from one Ether instance
- Failover and reconnect logic per stream
- "Go Live" control per station

### Phase C — Station Monitor Panel
- Renderer UI for monitoring panel in the right-side dashboard area
- Monitor selector IPC: route engine N's audio to soundcard
- Per-station now-playing display
- Role-aware visibility (operator sees their stations, admin sees all)

### Phase D — Operator-Station Assignment
- New `operator_stations` table (many-to-many)
- Admin UI for assigning operators to stations
- Login flow updates: station picker for multi-station operators
- Role permission enforcement verification + fixes
- Station scoping enforcement across all UI

### Phase E — Facility / Multi-Tenancy
- Facility identity tied to license key
- Cloud sync facility scoping
- Joining an existing facility (onboarding flow for additional PCs)
- Tier gating (Free vs Pro+ feature flags)

### Phase F — Cloud Sync Engine
- Custom CRDT sync engine (memory line 8 item #3)
- Facility-scoped mutation distribution
- Conflict resolution
- Offline queueing and reconnect

### Phase G — Cloud Admin Web UI
- Web-based admin surface reading facility state via sync
- Remote command relay to local engines
- Multi-station overview (the "Cloud Control Center")

Phases A and B unblock multi-station broadcast. Phase C is the user-visible deliverable. Phase D enables real-world operator workflows. Phases E-G are the larger platform vision.

---

## Open Questions / Future Work

These questions need answers but don't block the design:

1. **Engine ownership migration between PCs**: When a station's engine needs to move from Studio A to Studio D (planned or due to failure), what's the handoff protocol? Manual operator action? Automatic on detected failure? Coordination needed between PCs to avoid two engines running the same station simultaneously.

2. **Conflict resolution edge cases**: Two operators in different studios edit the same song's metadata simultaneously. How does the sync engine reconcile? Memory line 8 references the planned CRDT engine — specific conflict policies need definition.

3. **Onboarding flow for new PCs**: Admin installs Ether on a new PC and wants to add it to an existing facility. What's the auth + initial sync flow? Probably: enter license key + admin credentials, sync facility data down, register PC as a sync peer.

4. **Free → Pro upgrade migration**: Existing Free-tier user upgrades to Pro. Their single station and library become "the first station and library of a new facility." Onboarding additional PCs and stations works from there. Specific migration steps need spec.

5. **Headphone preview / cue-up**: Real broadcast has cue audio for previewing songs before air. Not in current Ether scope, possible future addition.

6. **Multi-PC engine ownership for a single station**: Could two PCs ever simultaneously run the SAME station's engine for redundancy? Probably not Phase A, but worth flagging as an option for high-availability deployments.

---

## Reference Map: This Architecture vs Existing Memory

This document complements existing locked decisions:

- **Memory line 8** (Local-first CRDT sync, custom engine) — **Confirmed correct.** This document elaborates the multi-station scope.
- **Memory line 11** (Station switching stops playback) — **This architecture fixes this.** Engine never stops on station switch.
- **Memory line 12** (Switch-back desyncs UI) — **Resolved by this architecture's separation of viewing/monitoring/engine state.**
- **Memory line 22** (Phase 4 Direction C library) — **Foundation for facility-scoped library.** No conflict.
- **Phase 3.5 work** (typed handlers, mutations log, sync rules) — **Foundation for cloud sync engine in Phase F.** All work directly applicable.

---

## Acknowledgments

The clarifying conversation that produced this document corrected a multi-month architectural misunderstanding (cloud-authoritative vs local-first). Future Claude sessions should reference this document before making architectural changes that affect data location, engine count, or sync model.

The cost of getting this wrong was significant — a week of debugging two parallel rotation engines, plus latent confusion that delayed Phase 3.5 work. This document exists to prevent recurrence.
