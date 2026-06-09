# VU Meter / Level-Handling Diagnostic — 2026-05-31 (read-only)

No edits/builds/commits. Findings only.

## 1 — The VU meter component & how it consumes levels

Primary meter = `MasterVU` inside `src/components/MasterOutput.tsx` (the two-bar L/R canvas master meter). The reusable mapping helpers in `src/lib/vuMeter.ts` are **stateless** (level→dBFS→bar-height→color), with **no** smoothing/decay/hold:

```ts
// src/lib/vuMeter.ts
export function vuDb(level: number): number {
  return level > 0.0001 ? 20 * Math.log10(Math.min(1, level)) : -120;
}
export function vuHeight(level: number): number {            // dB-scaled bar height, no time-smoothing
  const db = vuDb(level);
  return Math.max(0, Math.min(1, (db - DB_FLOOR) / -DB_FLOOR));
}
```

`MasterVU` subscribes directly to the pipe-fed IPC and stashes the **latest raw value** in a ref (no smoothing on receipt):

```tsx
// MasterOutput.tsx:60
const h = ether.audio.onLevels((lvl) => {
  masterRef.current = lvl.master ?? Math.max(lvl.a || 0, lvl.b || 0, lvl.c || 0);
});
```

**The smoothing/interpolation IS present — in the requestAnimationFrame draw loop, not in receipt:**

```tsx
// MasterOutput.tsx:127  (runs every RAF, ~60fps)
const m = masterRef.current;
// synthetic L/R "wobble" off a single mono master value
const targetL = Math.max(0, Math.min(1, m + 0.04 * Math.sin(phaseL.current)));
const targetR = Math.max(0, Math.min(1, m + 0.04 * Math.sin(phaseR.current)));
// attack/decay: fast up (0.75), slow down (0.06)
levelL.current += (targetL - levelL.current) * (targetL > levelL.current ? 0.75 : 0.06);
levelR.current += (targetR - levelR.current) * (targetR > levelR.current ? 0.75 : 0.06);
```

```tsx
// MasterOutput.tsx:162  — peak-hold (PEAK_HOLD_MS = 1400) then slow fall (0.012/frame)
if (lv > peakRef.current) { peakRef.current = lv; peakAtRef.current = now; }
else if (now - peakAtRef.current > PEAK_HOLD_MS) { peakRef.current = Math.max(0, peakRef.current - 0.012); }
```

So `MasterVU` **does** smooth: per-frame asymmetric attack/decay (0.75 / 0.06), a 1400 ms peak-hold with a 0.012/frame fall, plus a cosmetic ±0.04 sine wobble to fake stereo from the mono master. It does **not** draw raw values.

Note: the per-channel `MixerChannelStrip.tsx` meters are mostly **synthetic** ("theater") — `Math.random()` targets with their own `smoothed += (target-smoothed)*0.15` and `peak*0.99x` decay; only the mic path uses a real `AnalyserNode`. These are not fed by the daemon level pipe.

## 2 — Where level frames arrive from the daemon & at what rate

Daemon emits on a fixed timer in `audiod/ether-audiod.js`:

```js
// ether-audiod.js:147  — "broadcast levels (~10 Hz)"
const eventTimer = setInterval(() => {
  if (clients.size === 0 || stations.size === 0) return;
  for (const sid of stations) {
    try { broadcast({ event: "levels", stationId: sid, ...JSON.parse(A.audioGetLevels(sid)) }); } catch {}
    ...
  }
}, 100);   // 100 ms → ~10 Hz
```

- **Rate:** ~10 Hz (100 ms interval).
- **Pre-smoothing:** none in the daemon. It passes through `A.audioGetLevels(sid)` verbatim — the **raw instantaneous linear peak** from the Rust addon (`vuMeter.ts` header: *"the engine now reports a true linear peak (0..1, where 1.0 = 0 dBFS)"*). No attack/decay/RMS averaging is applied daemon-side.

Main re-broadcasts the pipe frame straight to the renderer with no smoothing:

```js
// electron/main.js:238
if (m.event === "levels") {
  const lv = { a: m.a||0, b: m.b||0, c: m.c||0 };
  lv.master = typeof m.master === "number" ? m.master : Math.max(lv.a, lv.b, lv.c);
  sendToAllWindows("audio:levels", lv);
}
```
Renderer receives via `preload.js:24` `onLevels: (cb) => ipcRenderer.on("audio:levels", …)`.

## 3 — What changed across the Item-10 daemon migration (before/after)

**The renderer smoothing was NOT dropped.** `git blame` shows the `MasterVU` attack/decay + peak-hold block (lines 127–172) is from **`4eed457` (2026-04-09, "checkpoint: current state")** and is **unchanged** through the entire daemon migration. The `onLevels` subscription (lines 60–67) is from **`988c75a` (2026-05-06, "perf(audio-levels): isolate meter re-renders from app tree")**. No smoothing/decay function was deleted.

**What DID change is the level SOURCE and its update RATE** — this is the real before/after:

- **Before (in-process / `!AUDIO_DAEMON`)** — main pushed levels every **33 ms (~30 Hz)**:
  ```js
  // electron/main.js:1208  (legacy path, now guarded behind !AUDIO_DAEMON)
  if (!AUDIO_DAEMON) levelPushId = setInterval(() => {
    const levels = JSON.parse(audio.audioGetLevels());
    if (typeof levels.master !== "number") levels.master = Math.max(levels.a||0, levels.b||0, levels.c||0);
    sendToAllWindows("audio:levels", levels);
  }, 33);   // ← ~30 Hz
  ```
- **After (daemon / pipe)** — the daemon's `eventTimer` broadcasts at **100 ms (~10 Hz)** (`ether-audiod.js:160`), re-emitted by `main.js:238`. The local 30 Hz poll is explicitly skipped (`main.js:1204-1208`: *"the daemon broadcasts levels … so skip the local poll"*). The daemon's levels block was born at 100 ms in **`fa65b4f`** (scaffold) and the only later edit (**`c018e03`**, "move queue + advance + scheduler into the daemon") touched the *deck* cadence, **not** levels.

**Both** old and new paths emit the **same raw instantaneous addon peak with no pre-smoothing** — smoothing always lived only in the renderer RAF loop. So:

- No literal smoothing/decay step was removed.
- But the feed cadence to every meter dropped **3× (≈30 Hz → ≈10 Hz)**.
- `MasterVU` still looks smooth because its RAF attack/decay glides toward the latest held value each frame — though with a 100 ms target refresh it is effectively laggier/over-damped vs. its original 33 ms tuning.
- Any meter that draws the **raw** `onLevels` value without its own RAF smoothing (i.e. anything relying on the old frequent frames rather than interpolating) will now visibly **step at 10 Hz** instead of 30 Hz — choppier — even though no smoothing code was deleted. The attack/decay constants in `MasterVU` (0.75 / 0.06) were never retuned for the slower feed.

### Bottom line
- The meter (`MasterVU`) has real attack/decay + 1400 ms peak-hold, applied in its RAF draw loop, and **survived the migration untouched**.
- The daemon sends **raw instantaneous peaks at ~10 Hz, no pre-smoothing**.
- The migration's actual change to level-handling is a **source swap + 3× rate reduction (33 ms → 100 ms)**, not a dropped smoothing step. If meters look choppier post-Item-10, that rate drop (and the now-mistuned RAF constants), not a deleted decay, is why.
