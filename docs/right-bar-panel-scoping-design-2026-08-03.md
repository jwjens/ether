# Right-bar panel scoping — station-scoped vs universal

**Date:** 2026-08-03 · **Status:** DESIGN OF RECORD (rewritten, trimmed). Read-only; nothing built.
**Jeff's principle:** state that must NOT change on station switch should not live in a component that
re-runs on station switch.

**SCOPE, corrected:** the first draft of this doc proposed restructuring the right bar and asked whether
station monitors should be four faders or one-plus-selector. **Both were wrong.** The right bar already
has the structure, as collapsible sections mounted once inside `MasterOutput`, and Station Monitors
already exists with four per-station faders (`src/components/StationMonitorMixer.tsx`, header :74,
sliders :111, device pickers :119, mounted at `MasterOutput.tsx:861`). I asked Jeff to decide something
already built. **The real content of this design is one sentence: group the station-scoped collapsibles
separately from the universal ones.**

---

## The classification (this is the design)

**STATION-SCOPED** — meaning is defined by which station is active; re-rendering on switch is correct:
NOW PLAYING · NEXT UP · SHOW PROGRESS · STATION (ON AIR / STREAM / UPTIME / NEXT BREAK) ·
AUTO/MANUAL pill · decks A/B/C and their faders · JINGLES overlay strip.

**UNIVERSAL** — install-wide or operator-wide; a station switch must not touch them:
MASTER OUT (master fader, VU, output device) · MASTER EQ / limiter · **STATION MONITORS** (all four,
operator-owned) · HEALTH MONITOR (shows every station by definition) · live console / activity terminal.

**The tell:** if the panel would show the same thing after a switch, it is universal. If switching
changes what it *means*, it is scoped.

**The change:** the two sets sit in their own groups in the bar, so what a switch affects is visible at
a glance. No component is rebuilt, no panel is replaced, no new control is added.

## What this does NOT fix — and it is the receipt that started it

**The monitor drop on station switch is NOT a panel-scoping bug and this design does not fix it.**

`StationMonitorMixer` already mounts once and is not keyed on the active station. The drop comes from
the ENGINE: `assertMonitorSilence()` runs inside `adoptFromDaemon()` on **every attach**, and a station
switch tears the engine down (`engine-rodio.ts:186` — poll cleared, listeners unsubscribed,
`daemonDetectStarted = false`), so switching back is a fresh attach:

```
22:32:12  monitor asserted to 0.00 at attach (station 2) — SILENT by default
22:32:23  monitor asserted to 0.00 at attach (station 1) — SILENT by default
22:32:48  monitor asserted to 0.00 at attach (station 2) — SILENT by default   ← station 2 AGAIN
```

That path is in the engine, not React, so no amount of re-parenting stops it.

**The actual fix, two parts, both small:**
1. **Wire the existing fader.** `noteOperatorMonitor()` — written in the D2 slice to remember a raised
   monitor across re-attach — has **zero callers**. It was never connected, so
   `monitorRaisedByOperator` is permanently false and every attach re-mutes. One line in
   `StationMonitorMixer.tsx:59` `setMonitor()`. **My omission.**
2. **First-attach-only assert.** A re-attach must restore the operator's level, never impose silence on
   a station they were already listening to.

**A correction to the first draft:** it claimed the UI and engine model monitors differently (one
install-wide value vs four engine gains). That was wrong — `StationMonitorMixer` already writes the
correct per-station engine gain AND persists to `station_config_kv.monitor_volume` (:61-62). The
install-wide `monitorVol` in `MasterOutput.tsx:514` is a different, unrelated fader. The defect is
narrower than that draft implied: the fader simply never tells the engine the operator raised it.

## Blast radius

Grouping only — no component moves out of `MasterOutput`, nothing is remounted differently, no data flow
changes. The one risk worth checking: any panel moved into the universal group that reads the active
station *implicitly* would keep working while showing stale data with no error. Check each on the way.

Daemon, playout and air are untouched; monitor gain is device-branch only (`audio.rs:1157`).

## Sequencing

1. **Monitor-drop fix** (the two parts above) — small, receipted, independent.
2. **AUTO flicker fix** — a command-in-flight window so a stale-but-honest `started=false` cannot
   overwrite a fresh press. Receipt: `_daemonStarted=false → returns=false` between press and
   confirmation.
3. **This grouping** last, as cosmetic-but-clarifying, once both bugs are confirmed fixed.
