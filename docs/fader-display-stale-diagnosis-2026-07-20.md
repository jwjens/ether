# Fader at 2/3 post-4.4.63 — diagnosis (2026-07-20)

**Symptom:** After installing 4.4.63 (fader exorcism), deck A's fader sits ~2/3 while B/C read
full (operator screenshot, 09:24). Question: display bug, or does something still write deck volumes?

**Verdict: DISPLAY / stale-state bug (branch 3). The native fader truth is unity — nothing is
writing deck faders post-exorcism.** The ~2/3 is a remembered `deck.volume` in the renderer that
nothing resyncs back to observed truth.

---

## Version gate (checked first)

Running build confirmed **4.4.63.0** — both `Ether.exe` and the `ether-engine` daemon started
09:19, *before* the 09:24 screenshot. This is the exorcised code running live, NOT the
daemon-no-reload trap. The bug reproduces on genuine 4.4.63.

```
Ether         4.4.63.0  StartTime 09:19
ether-engine  4.4.63.0  StartTime 09:19
```

---

## Receipts

### 1. Truth split — live `getState`, read-only (`scripts/probe-deck-volumes.js`)

```
deckA   vol=1.0000  status=playing   title="I'll Take You There"
deckB   vol=0.0000  status=idle      title="We Will Rock You..."
deckC   vol=0.0000  status=idle      title="Ain't No Mountain..."
levels: {"a":0.6604, "master":0.6604, ...}   <-- VU LEVEL, not a fader
```

- The **playing** deck reads **native volume exactly 1.0000**. No stuck native fader.
- Idle decks read 0.0 — the mixer muting a *cued* deck, normal; not an operator fader move.
- The only `0.66` in the system is `levels.a`, the **VU meter level**, which the fader UI does
  not read. (Coincidence: "I'll Take You There" peaks ~0.66; in the screenshot it was the *next*
  deck, not playing.)

### 2. Full audit of both playout paths — automation never writes a deck fader

- **Daemon `audiod/engine.js`:** `_segueTick` (L973) = overlap, *"no fade"*; `handleRotate`
  (L494–508) = play-incoming + deferred `_stop` on the outgoing, **zero `audioSetVolume`**;
  `intentCrossfade` -> `handleRotate` (no fade); jingle weave `_jingleBeginBridge` (L944) — the
  *"outgoing has already faded to 0"* comment is **stale/false**, the code does no fade. `_play`
  (L148) explicitly *"automation NEVER moves a deck fader."*
- **Renderer `src/audio/engine-rodio.ts`:** the only `audio_set_volume` callers are the explicit
  operator `setVolume`/`fadeTo`/`crossfade` and the **MIDI fader sync** (`ConsoleStrip.tsx:182`).
  The exorcism-removed Master-fader writer (`MasterOutput.tsx`) is gone.

### 3. Why the display drifts and never self-corrects

- The fader renders `deck.volume` (`App.tsx:3792`, `effVol = dragVol ?? volume`).
- The daemon's `deck` event always carries `volume:1` for A/B/C (JS state; set to 1 on load, never
  patched fractional).
- But `_maybeEmitDeck` (`engine.js:395`) only re-emits on **status / title / position change or a
  ready-flip — NOT on volume**. Once a deck goes idle and stops changing, the renderer stops
  getting corrections.
- The renderer's `setVolume`/`fadeTo` write native but **never write `stateX.volume` back**, and
  there is **no path that resyncs a deck fader to observed truth on connect/boot/load**. Any value
  that leaks into the displayed `deck.volume` sits there frozen.

---

## Open thread (could not close from the terminal)

Could not read the live **renderer** React state at the symptom moment (it lives in the Electron
renderer, not the daemon), so the exact line that seeded `0.66` into `stateA.volume` isn't pinned.
Two surviving candidates:

- **MIDI fader-sync** (`ConsoleStrip.tsx:182`) — a connected control surface with deck-A's fader
  parked low would continuously call `setVolume`. That would pull *native* down, which it isn't
  right now — so not a persistent write, but worth confirming a surface isn't attached.
- **In-process-fallback poll** seeding a transient native value (the cold-stage daemon race).

Native currently reads unity, which already rules out a *persistent* write. To nail the seed:
watch live `getState` across one real segue (read-only) and check for an attached MIDI surface.

---

## Minimal fix (honest-UI rule — display/state only, no audio path touched)

Make the A/B/C deck faders render observed truth and default to unity, so a stale value can never
freeze:

1. **Daemon:** add `volume` to `_changed` (`engine.js:387`) so a deck event re-emits when volume
   moves — the fader can never lag truth.
2. **Renderer:** on daemon deck event / on connect / on (re)load, the displayed deck volume
   resyncs to the reported value (already `volume:1`); stop trusting a remembered `stateX.volume`
   for A/B/C rotation decks.

Consistent with the exorcism thesis: *a deck sits at unity unless a human is dragging that fader.*

**Status:** diagnosis only. No code changed. If a MIDI surface is connected on the box, the seed is
likely branch 2 (a real native write) and the fix shifts accordingly — confirm before implementing.
