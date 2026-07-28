# Seamless daemon update — no dead air on install (design, 2026-07-27)

**Status:** DESIGN ONLY — build nothing yet. Phase 1 (Stream Relay) is the only part worth
considering soon. **Phase 2 (shadow-daemon handoff) is PARKED INDEFINITELY** — it is too close to the
process-swap machinery that has broken the engine before, and it depends on the Log-Reader Flip reaching
Phase 3. This doc records the diagnosis and the target so the decision is written down, not re-derived.

A broadcast tool should never need silence to install a fix. Today it does — for one specific class of
update. This doc says exactly which class, why, and the surgical fix.

---

## The problem, precisely

**UI-only updates are ALREADY gapless.** The daemon is spawned `detached`+`unref`'d as a staged
`ether-engine.exe` in `%LOCALAPPDATA%\Ether\engine` (an update-proof location —
`audiod/stage-engine.js`), and `build-resources/installer.nsh:24` deliberately taskkills only
`Ether.exe` (the app + watchdog), **never** `ether-engine.exe`. `autoUpdater.quitAndInstall()`
(`electron/main.js:4097`) relaunches only the UI; `markHaExpectedRestart()` + `markKeepSession()` carry
state across; on reconnect `replayIntents` (`electron/daemon-auto-resume.js:15-42`) re-issues automation.
When an update touches **only renderer/main-process code, audio never stops.** That half of the Item 10
design works as intended (`docs/audio-daemon-phase0.md` Step 6).

**The dead air comes from exactly one thing: new *daemon* code.** A running native process image is
immutable for its lifetime — there is no in-place hot-swap. So when an update ships new `audiod/*.js` or a
new `native/ether-audio.node`, the only way to run it is `reloadDaemon()`
(`electron/audio-daemon-client.js:227-233`) → `shutdown` the old daemon → respawn a fresh, re-staged one.
That reload breaks two things:

| Continuity requirement | Where it lives today | Why the reload breaks it |
|---|---|---|
| **Icecast stream** (the product — what listeners hear) | ffmpeg + Icecast socket live **inside** the daemon (`audiod/stream.js`) | daemon shuts down → source disconnects → **the mount drops** |
| **Playhead** (which song, what position) | daemon in-memory queue/deck | a fresh daemon starts decks from zero, then `replayIntents` restarts automation ("audio back within seconds" — `docs/respawn-resume-fix-build-report-2026-07-15.md`) |
| Local monitor (studio output) | daemon-owned cpal device | device released on shutdown, re-acquired by the new daemon |

And because `fireDaemonReload` is guarded to **never kill a live engine** (`electron/main.js:340-354`),
in practice the reload frequently just **doesn't fire** — the old daemon code keeps running until someone
fully closes the app. That is the CLAUDE.md caveat ("the audio daemon does NOT reload on auto-update —
clients must fully close and reopen the app", `CLAUDE.md:71`), stated honestly.

So the real problem is **two independent continuity requirements**, and the stream is the one that faces
the customer. Solve them separately.

---

## Design principle

**Separate the listener relationship (the Icecast mount) from the swappable compute (the mixer daemon).**
The process that owns the customer-facing stream must be the *most stable, least-often-updated* thing in
the stack — and must outlive a mixer swap. The mixer, which is where the code churn actually happens,
becomes replaceable underneath it.

Two existing pieces of work are the enablers:

- **Stream Relay (new, tiny, long-lived) — owns ffmpeg + the Icecast socket.** It reads PCM from whichever
  mixer daemon is currently the producer over a stable local port. On a mixer swap the relay never
  disconnects from Icecast, so **the mount never drops.** A sub-second producer-switch underrun is absorbed
  by Icecast's burst buffer (raised to **256 KB** on the Lightsail box) plus a small silence/PLC fill in the
  relay. This is the load-bearing idea — without it, *any* daemon swap drops the stream.

- **Time-anchored playhead (Log-Reader Flip §2.7) — the resume primitive.** Once playout position is a pure
  function of wall-clock against `generated_schedule`, a freshly-spawned mixer can compute "what should be
  airing right now, at this offset" and **seek the deck to that position before it takes over** — so its
  first output buffer is a *continuation*, not a restart. This is what a shadow handoff (Phase 2) would need,
  and it is why Phase 2 cannot precede the flip.

### Target tiers
```
UI (Electron renderer / main)   ── updates & relaunches freely      [ALREADY GAPLESS]
        │ named pipe
Mixer daemon (ether-engine)     ── SWAPPABLE: staged handoff on daemon-code update   [Phase 2, parked]
        │ PCM producer → stable local port
Stream Relay (new, tiny)        ── LONG-LIVED: owns ffmpeg + the Icecast mount        [Phase 1]
        │
Icecast (Lightsail)             ── mount never drops
```

---

## Phase 1 — Stream Relay extraction (the only near-term candidate)

Move ffmpeg + the Icecast connection out of the mixer daemon into a separate long-lived relay process
that survives **both** app and daemon restarts. The relay:

1. Listens on a stable local port and accepts a **producer** connection from the current mixer daemon
   (the mixer feeds PCM off its program bus, exactly as ffmpeg reads it today —
   `scripts/spike-ffmpeg-from-programbus.js` proved encode-from-bus).
2. Runs the ffmpeg → Icecast encoder (a faithful lift of `audiod/stream.js` `StreamSupervisor` + its
   3×/10 s respawn/backoff) and **holds the Icecast source connection open** independent of any mixer's
   lifetime.
3. Supports a **producer swap**: when a new mixer connects and signals ready, the relay switches its PCM
   input old→new within one buffer; the Icecast socket is untouched. Underrun during the switch is covered
   by the burst buffer + a tiny relay-side silence/PLC fill.

**Immediate win, even with today's hard reload:** once the encoder no longer lives in the daemon, a daemon
shutdown/respawn **stops dropping the stream** — the relay keeps the mount up while the mixer bounces and
reconnects as producer. This kills the listener-facing dead air for the *entire* daemon-code-update class,
with no shadow-daemon machinery at all.

**Risk & rollback:** the relay is smaller and more stable than the daemon (read PCM → ffmpeg → Icecast,
plus producer-swap). If the relay can't be reached, fall back to today's in-daemon encoder path — worst
case is exactly current behavior. Ships behind a flag, proven off-air first, proven on OV before default-on
(same discipline as the daemon cutover).

**Observability (build the sense, not the scaffold):** relay emits `relay-producer-switch` start/complete
health events and **measures the actual listener-side underrun** at the switch (observed, not claimed);
surfaced in the Health Monitor.

---

## Phase 2 — Shadow-daemon handoff (PARKED INDEFINITELY)

Recorded for completeness; **not scheduled, not to be built.** Two hard reasons it is parked:

1. **It is close to what has broken the engine before.** Two mixer daemons, device release/acquire at a
   seam, a producer crossover — this is exactly the process-swap / device-contention surface that produced
   dead-thread and silent-daemon incidents (`docs/incident-two-stations-silent-2026-07-15.md`,
   `docs/incident-jingle-cart-panic-2026-07-15.md`). The blast radius is on-air audio. Not worth it for the
   marginal gain over Phase 1.
2. **It depends on the Log-Reader Flip reaching Phase 3** (the time-anchored playhead is the only clean way
   for a shadow mixer to resume mid-song at the correct position). Until that flip is live and burned in,
   there is no safe resume primitive.

Sketch, if it were ever revisited: stage new daemon → spawn it as a **shadow** on a different pipe (holds
neither the device nor the relay producer slot) → shadow warms up and **seeks the current song to the live
position** via the time-anchored playhead → at the next **song boundary**, the relay switches producer
old→new and the monitor device is released/acquired → retire the old daemon. Rollback: if the shadow fails
to warm within N seconds, keep the old daemon — worst case is today's behavior.

---

## Explicitly NOT proposed
- **In-place code hot-swap** of the daemon — impossible for a native process image; not a real option.
- **Two daemons co-owning one Icecast mount** — Icecast rejects a duplicate source. The relay is precisely
  why we never need this.
- **Changing the UI-update path** — already gapless; leave it alone.

## Sequencing summary
- Phase 1 (relay) is **independent** and would ship first for the immediate stream-continuity win.
- Phase 2 (shadow handoff) is **parked indefinitely** and, if ever revisited, sequences strictly **after**
  Log-Reader Flip Phase 3.
- **Build nothing yet.** This is the design of record.
