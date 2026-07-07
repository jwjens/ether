# VU meters — signal-path integrity (2026-07-07)

Question (Jeff): a song is audible, MASTER OUT moves, but the channel VU is flat — which lie is being
told? READ-ONLY trace, receipts (file:line). No fix; fix condition stated at the end.

## Verdict
**The Rust audio path is honest — both meters have real taps and there is NO bypass.** The lie is
**renderer-side: the channel VU is not a pure tap — it is gated behind a UI `isPlaying` guess** that, when
wrong, forces the channel to 0 (and doesn't even subscribe to the real level). Master has no such gate.
A station-scope defect (already filed) compounds it.

## 1. The real Rust path — deck → fader → mix → EQ → master (no bypass)
`native/src/audio.rs` `mixer_callback` (fn at :839):
- Each deck's audio is taken through its fader and **summed into the program mix**, and its **post-fader
  peak** is measured in the same pass:
  - `:896-899` `let vol = deck.volume; … let lv = l * vol; let rv = r * vol; mix_l[f] += lv; mix_r[f] += rv;`
  - `:900-901` `let a = lv.abs().max(rv.abs()); if a > pk { pk = a; }` → `frame_peaks[i] = pk;` (**post-fader** per-deck peak).
- The summed mix is EQ'd to the program output; the **master peak is the fold-max of the post-EQ program**
  (`:955` `.fold(0.0f32, f32::max)` over `out_l/out_r`).
- Both are published with VU-release ballistics into shared state read by GetLevel:
  - `:968` `for i in 0..7 { bus.peaks[i] = frame_peaks[i].max(bus.peaks[i] * VU_RELEASE); }` (per-deck a/b/c…)
  - `:969` `bus.master_peak = peak.max(bus.master_peak * VU_RELEASE);` (master)
- **Every contributor to master is a metered deck slot.** `out = EQ(sum of bus.decks)`; there is no path
  that reaches master without passing through a deck slot whose post-fader peak is written to `bus.peaks`.
  The cart is deck slot 6 with its own peak. **So a channel that feeds master ALWAYS has a non-zero
  `bus.peaks[deck]` — at the Rust level, flat-channel-while-master-moves is impossible.**

Conclusion for (1): the engine tells the truth. `audioGetLevels` returns `{a,b,c,…,master}` = real
post-fader per-deck peaks + real post-EQ master peak, all taps on the true path.

## 2. What the channel VU actually measures — a real tap, GATED by a UI guess
`src/components/VUMeter.tsx`:
- `:214-219`:
  ```
  if (!isPlaying) {
    rawLevel.current = 0; levelL.current = 0; peakL.current = 0;
    return;                       // ← never subscribes to onLevels
  }
  const handle = ether.audio.onLevels((lvl) => {
    const raw = deckId === "A" ? lvl.a : deckId === "C" ? lvl.c : lvl.b;   // real tap
    rawLevel.current = Math.max(0, Math.min(1, raw || 0));
  });
  ```
- So the channel VU **is** wired to the real tap (`lvl.a/b/c` = `bus.peaks`), **but only if the component's
  `isPlaying` prop is true.** When `isPlaying` is false it **forces the level to 0 and returns without
  subscribing** — the real signal is suppressed by a UI-side boolean.
- `isPlaying` is a **renderer deck-state guess**, not the audio signal — it comes from the deck-state
  pipeline (daemon `deck` events → `engine-rodio.ts:191` filters by integer stationId → renderer state),
  which can be wrong/lagging (station-scope, resolver-loaded, unfocused deck).

Master, by contrast, is an **ungated** tap: `src/components/MasterOutput.tsx:63` subscribes to `onLevels`
and reads `lvl.master` with no `isPlaying` guard. That's why master moves while the channel is flat.

Conclusion for (2): master is a truthful tap; the channel is a truthful tap **wrapped in a UI-side gate**
— which is exactly "a UI-side approximation fed from somewhere else" overriding the real signal.

## 3. The observed case, precisely
Song audible on deck X of the focused station →
- Rust: `bus.peaks[X] > 0` (post-fader, `audio.rs:968`) and `bus.master_peak > 0` (`:969`) — real signal.
- Master VU: `MasterOutput.tsx:63` reads `lvl.master` (ungated) → **moves.** ✅ truthful.
- Channel VU: `VUMeter.tsx:216` sees `isPlaying === false` (deck-state guess disagrees with the audio) →
  forces `rawLevel = 0` and returns without subscribing → **flat.** ❌ the lie.
- **Compounding:** even with `isPlaying` true, the levels frame's `a/b/c` are **not station-scoped** — the
  tag is dropped at `electron/main.js:349` (`const lv = { a,b,c }` + master, no `stationId`) and delivered
  to a global `onLevels` (`preload.js:26`). See `vu-meter-station-scope-2026-07-07.md`. So the channel can
  also be reading a different station's (idle) decks.

## 4. Fix condition (NOT applied)
Every meter must be a truthful tap on real signal; a flat channel under a playing song must be impossible
by construction:
1. **Remove the `isPlaying` gate from the channel VU** (`VUMeter.tsx:214-219`). The channel must render the
   real per-deck peak (`lvl.a/b/c`) directly; the peak already falls to 0 on its own via `VU_RELEASE`
   (`audio.rs:967`) when the deck stops — no UI boolean is needed or allowed to suppress a real signal.
   (Keep the `externalLevel` path for mic-fed strips.)
2. **Station-scope the levels tap** so `a/b/c` are the focused station's decks: carry `stationUuid` on the
   levels frame (fixes `main.js:349`) and route/filter by it — this is the v4.5.0 re-key, Phase 1-2
   (levels channel), which also removes the last cross-station meter cross-talk.

With both, the channel VU = a truthful, station-correct tap on the real post-fader deck peak; whenever a
deck feeds master (`bus.peaks[deck] > 0`), its channel VU moves. Flat-under-playing becomes impossible.

**Read-only — no code changed.**
