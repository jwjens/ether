# Jukebox routing — the board did not govern the audio

**Date:** 2026-08-18 · **Report:** Jeff — the wall works (156 songs, plays, ON AIR lit), but audio
reaches MASTER while the Jukebox channel strip shows nothing, and the strip's ON button clicks without
lighting or gating anything. **Confirmed. The fault is entirely in the dashboard UI layer — the daemon
and Rust were wired correctly the whole time.**

**The ruling this implements:** the jukebox is audible ONLY when its assigned deck's channel is ON and
the fader is up. The board is the sole gate. The kiosk's AUTO chooses songs; the board chooses air.

---

## 1 · Which deck does the jukebox actually play on? — the right one

One play, traced end to end:

```
kiosk    routedDeck  <- SELECT slot FROM deck_configs WHERE type='jukebox' AND enabled=1
  -> ether.jukebox.play({ deck, filePath, … })
main     electron/main.js  jukebox:play   validates deck is one of D/E/F, resolves the local path
  -> audiodClient.cmd("jukebox:play", { stationId, deck, … })
daemon   audiod/ether-audiod.js  jukebox:play  ->  A.audioLoad(deck, …) ; A.audioPlay(deck, …)
rust     native/src/lib.rs audio_load/audio_play -> deck_index(deck) -> bus slot
```

`deck_index` (`native/src/audio.rs:447-457`) maps **D→3, E→4, F→5**. The deck letter that reaches Rust
is exactly the `deck_configs.slot` the dashboard strip is drawn from — both sides read the same row.
**Q1: correct, no mismatch.** The audio was always on the slot the strip claims to represent.

## 2 · The ON button — the defect

A jukebox deck has `type: "jukebox"`, and LivePanel's strip renderer switches on `deckType` with
branches for `music`, `mic`, `video`, `cart`, `desk`, `guest` — **and nothing for `jukebox`**. So it
fell through to the generic **fallback ConsoleStrip** (`src/App.tsx:4001-4019` pre-fix). That fallback:

```jsx
const deckMap: Record<string, any> = { A: deckA, B: deckB, C: deckC };   // App.tsx:3899
const deck = deckMap[slot as string];                                    // undefined for D/E/F
…
volume={deck?.volume ?? 1}
isPlaying={deck?.status === "playing"}      // always false  -> ON can never light
isOn={true}
onToggleOn={() => { if (deck?.status === "playing") …pause(); else …play(); }}
```

Two consequences, and they are exactly the two things Jeff saw:

- **`deckMap` has no D/E/F**, so `deck` is `undefined`: the strip renders no state at all. ON has
  nothing to light from, and the VU has nothing to show. *"The strip shows nothing."*
- **`onToggleOn` is transport, not a gate.** With `deck` undefined the ternary always takes the else
  branch and calls `engine.getDeck(slot)?.play()` — a raw re-play of the deck. It never cuts anything.
  *"Clicks but doesn't gate."*

The fader was the one control that did work: `onVolumeChange` → `engine.getDeck(slot)?.setVolume(v)` →
`audio_set_volume`, which the daemon passes straight through with no A/B/C gate.

**On the A/B/C gate hypothesis — checked, and it is NOT the cause here.** The daemon's gates at
`audiod/engine.js:1484`, `:1569`, `:1643` are real, but they sit on the *automation intents*
(`noteManualCue`, deck-cue, crossfade). Channel and fader do not go through them: the daemon's
`setVolume` / `setMuted` handlers call `A.audioSetVolume` / `A.audioSetMuted` directly with whatever
deck string they are given. Nothing was silently no-oping in the daemon — the UI simply never sent a
cut.

## 3 · Rust — fully wired for D/E/F, and innocent

| Receipt | What it shows |
|---|---|
| `native/src/audio.rs:447-457` | `deck_index` maps A–F → 0–5, CART → 6 |
| `native/src/audio.rs:915-926` | live mixer path: `SetVolume`/`SetMuted` write `bus.decks[idx].volume` / `.muted` via `deck_index` — per slot, no letter restriction |
| `native/src/audio.rs:1151` | the mixer sums **every** deck slot, applying channel cut (`deck.muted`), track trim and fader |
| `native/src/lib.rs` (`audio_set_muted` header) | the cut "deliberately survives `Load`", so a cut channel stays cut when the kiosk loads the next song |

**Q3: the wiring was always there.** No native change is needed. The UI had simply never sent
`setMuted` for a D/E/F slot.

## 4 · Fix

Modelled on the **JINGLES/CART strip** (`App.tsx`, `toggleCartChannel`), which already implements a
correct channel cut — the pattern existed; the jukebox just never used it.

| Piece | Behaviour |
|---|---|
| New `jukebox` branch in LivePanel's strip switch, **before** the fallback | Real `ConsoleStrip`: `isPlaying={jukeboxOn}` carries the ON lamp, `isOn={true}` keeps it off the greyed/disabled branch, fader rides `audio_set_volume` on that slot |
| `toggleJukeboxChannel` | Flips the channel and sends `setMuted(!on)` to **that slot** — a bus cut, not transport |
| Asserted on mount | Both the cut and the fader are pushed DOWN to the engine when the panel mounts, because Rust boots un-muted at its own level. The board states the operator's position rather than assuming it |
| **Default OFF** | Unlike carts, which default ON. A public kiosk must not become audible merely because a deck was assigned — it becomes audible when an operator presses ON. "ON dark = silence" is the spec |
| Stored in `station_config_kv` (`jukebox_channel_on`) | Not localStorage, so the **kiosk window can read the same truth**. It already polls that table every 4s |
| Kiosk honesty | `onAir` now requires **playing AND channel ON AND fader up**. A cut channel reports *"the channel is OFF on the board … press ON on that channel"* and the ON AIR lamp stays dark, however engaged the kiosk's own AUTO is |

The kiosk keeps choosing songs and keeps its queue in every case — a cut channel changes audibility,
never the queue.

## 5 · Known limitation, stated rather than discovered later

**The jukebox strip's VU will read zero even while audio plays.** Per-deck level telemetry covers only
A/B/C/CART (`native/src/audio.rs:962`), so D/E/F publish no levels. This is pre-existing and affects any
source on those decks; it is documented in `docs/jukebox-deck-source-design-2026-08-17.md` §10.2 with
the one-line Rust fix, which needs a native rebuild and is Jeff's call. The ON lamp and the fader are
truthful; only the meter is blind.

## 6 · Gates

`tsc --noEmit` → 0 errors · `npm run build` → clean. **Runtime UNVERIFIED.**

**Acceptance, on Jeff's board:** ON dark = silence · ON lit + fader up = jukebox audible · fader down =
silent — while the kiosk reports its own state honestly throughout.
