# Jingle Polish + Routine Segue Crossfade — proposal (2026-07-15)

Read-only investigation done. **No edits made — this is the plan, awaiting GO + one answer.**
One release, three parts. Ear-test gate before ship.

---

## What I actually found (receipts)

### Indicator (fix 2)
In HEAD the **only** jingle indicator is the **ConsoleStrip fader chip** (top-right of the fader strip;
white = armed / yellow = firing, already class-aware JIN/SWP). `jingleOverlay` is wired to **nothing else** —
there is **no timer recolor** and **no override of the red :15 talk-up flash** anywhere in the codebase.

- The red `:15` / `:5` talk-up flash lives in `src/components/OnAirDeck.tsx` (standalone decks, `isEnding<15`
  / `isCritical<5` → accent-red blink). Untouched by jingles.
- The left-rail deck rows you're looking at are `src/components/UpNext.tsx` — they tint the time **amber at
  <10s** and have **zero jingle awareness**.

**So "restore the countdown colors" = nothing is actually broken there.** The real work is to **move the
indicator into the deck row** where you want it (under the duration) and drop the fader chip.

### Segue (fix 1 / the addition)
The daemon **never fades.** `audiod/engine.js → handleRotate` just starts the incoming deck and stops the
outgoing `crossfadeDuration + 0.5s` later — and it only triggers when the outgoing is within **0.3s of its
end** (`checkEnd`, `(dur - pos) < 0.3`). So the outgoing hard-ends into silence and the incoming starts at
full = the "no weave" ear report.

- **Good news:** `A.audioSetVolume(deck, vol, stationId)` **already exists** (`native/src/lib.rs:101`) — a true
  fade is a **pure daemon/JS change, no native rebuild.**
- Side note: the daemon's `crossfadeDuration` is stuck at the default `3` — the renderer's slider value never
  reaches the daemon in daemon mode. Delivery gets wired as part of this.

### Underlap ("next song starts late")
The seam bridge sets incoming start = `jingleEnd − underlap`. When a jingle is longer than
`lead_in + underlap` (7s), that lands **after** the outgoing's natural end → a music gap of
`jinDur − 7`. Transition 14 is **8.4s → ~1.4s of jingle-alone.** That's the "three events."

---

## Proposal — one release, three parts

### A · Routine Segue Crossfade (new setting + real fade)
- **Settings → Audio:** add **"Segue crossfade"** (0–10s, default 3, `0 = hard cut`) beside the existing
  slider. Relabel both so they can never be confused again:
  - existing → **"Manual crossfade (X key)"**
  - new → **"Segue crossfade (auto)"**
- Persist + deliver the value to the daemon (new config command, same rail the manual value should have used).
- **Daemon:** when the playing deck hits `remaining ≤ segueSec` and the next deck is ready, start the incoming
  at full and **ramp the outgoing `audioSetVolume` 1 → 0 over segueSec** (JS interval ~50ms), then stop it.
  `segueSec = 0` keeps today's hard cut. Guarded against double-trigger (a `segueTriggered` set, like
  `endTriggered`). The **manual X-key path stays exactly as-is** (its own `crossfadeDuration`).

### B · Jingle rides the same fade + gap fix
- On a jingle seam the outgoing fades by the **same** segue setting during the lead-in — **one fade policy
  everywhere** (this replaces fix-1's ad-hoc fade).
- Close the music gap so it's continuous (see the open question below for where the incoming enters).

### C · Indicator (per the screenshots)
- **Drop the ConsoleStrip fader chip.**
- Thread `jingleOverlay` into `UpNext`; in the **playing deck's row**, under the **duration line (the "3:02")**,
  add a **third line: the jingle's name + its time.**
  - **Solid white = ARMED**, **blinking yellow = FIRING.**
  - Class-aware (JIN / SWP). **Countdown colors untouched** — the name is the label, nothing shared with the
    countdown.

---

## One question before I build

Your line *"the next song doesn't start until after the jingle is done"* — which do you want?

- **(a) Continuous weave** — outgoing fades under the jingle, next song enters under the jingle's tail
  (fixes the gap; music never stops), **or**
- **(b) Jingle solo** — outgoing fades under the jingle, jingle plays alone to its end, *then* the next song
  starts.

The fade fixes the outgoing either way; this only decides where the **incoming** enters.

---

## Gates
- `npx tsc --noEmit` (zero new errors) · `npm run build` · `node --check` on the daemon files.
- **Segue fade proven OFF-AIR first** in the isolation harness (`scripts/`), with receipts: ramp observed on
  the outgoing deck, incoming enters, no music gap.
- **Ear-test gate:** Jeff signs off on how a **plain segue** AND a **jingle seam** sound before ship.
- Build the installer `--publish never`. **STOP before install.**

**Files in play:** `src/App.tsx` (settings + wiring + drop chip), `src/components/SettingsPanel` (the two
labeled sliders), `src/components/UpNext.tsx` (third-line indicator), `src/components/ConsoleStrip.tsx` (remove
chip), `audiod/engine.js` (early segue trigger + fade ramp + jingle fade + gap fix), `audiod/ether-audiod.js`
(config command), `src/audio/engine-rodio.ts` (deliver the setting). **No native rebuild.**

---

**Say (a) or (b) and GO.**
