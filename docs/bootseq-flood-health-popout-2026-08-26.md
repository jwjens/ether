# Runaway BOOTSEQ log flood — Station Health popout (2026-08-26)

**Status: FIXED AND VERIFIED LIVE (2026-08-26). Both fixes applied, `tsc --noEmit` clean, flood confirmed stopped in `ether-startup.log`.**

Reported: the Station Health popout logs
`[POPOUT: Station Health] [BOOTSEQ] ... PRE-AUTH · getEngine(1) PRE-AUTH (existing instance) ← useAudioEngine (AudioEngineContext.tsx:50)`
many times per second, unbounded, some tagged `renderer:error`.

---

## Cause — TWO independent defects stacked

### Defect 1 — the PRE-AUTH gate NEVER closes (this is why it logs at all)

`src/audio/engine-registry.ts:22-25`

```ts
} else if (!bootAuthDone()) {
  const site = bootCallSite();
  bootSeq(`getEngine(${stationId}) PRE-AUTH (existing instance) ← ${site}`);
}
```

`bootMarkAuthComplete()` has exactly ONE caller in the entire tree:

    src/App.tsx:1566   — inside handleWizardComplete()

That is the **onboarding wizard completion** path. It is NOT called on a normal
sign-in, and it is NOT called on a normal launch of an already-onboarded install.

Consequence:
- **Main window, normal launch:** `authDone` stays `false` **forever**. The
  "PRE-AUTH" branch is permanently armed. This is not an expired trace — it is a
  gate that was never wired to close.
- **Popout:** structurally impossible to ever close. `src/main.tsx:95` routes
  `#popout/*` to `<PopoutRenderer/>`; `<App/>` never mounts in that renderer, so
  the only `bootMarkAuthComplete()` call site is unreachable there.

Second half of the same defect: `useAudioEngine()` is a **plain call on every
render** — not memoized:

    src/audio/AudioEngineContext.tsx:35-38
      export function useAudioEngine(stationId?: number): AudioEngine {
        const activeStationId = useContext(AudioEngineContext);
        return getEngine(stationId ?? activeStationId);   // ← every render
      }

So `getEngine` — and therefore `bootSeq` — is on the **hot render path**, and it
is logging the boot-order trace on a steady-state repaint. Note the popout has no
`AudioEngineProvider` above it either, so the context falls to its default `1`;
that is why the line always reads `getEngine(1)`.

### Defect 2 — the Health Monitor re-renders its WHOLE tree at 15 Hz (the real bug)

`src/components/HealthMonitor.tsx:~933-945` — the `audio:proc-meters` subscriber:

```ts
const h = audio.onProcMeters((m: any) => {
  ...
  setProcMeters({ inLufs: m.inLufs, outLufs: m.outLufs, grDb: m.grDb, ... });
});
```

`procmeters` is emitted at **~15 Hz** while Audio Processing is ON:
- `audiod/engine.js:311` — "Dedicated processing-meters emit (~15Hz)"
- `electron/main.js:352` — "procmeters arrives at ~15Hz"
- `electron/main.js:861` — `sendToAllWindows("audio:proc-meters", ...)` → **every**
  window, popout included.

`setProcMeters` builds a **new object every frame**, so the reference always
changes and React always re-renders. That re-render is in `HealthMonitor` itself
(the panel root), so the entire panel tree repaints 15×/sec — including
`<HealthDashboard/>`, which is rebuilt as a fresh element on every render
(`HealthMonitor.tsx:~961`).

**This breaks a rule the codebase already wrote down**, one layer up.
`src/components/health/HealthMeters.tsx:5`:

> THE LEVELS CHANNEL NEVER TOUCHES REACT STATE. `audio:levels` runs ~90 frames/sec
> and main.js:670 …

The levels channel was deliberately made ref-driven for exactly this reason (and
is "implicated in a renderer OOM", per `electron/main.js:845`). The procmeters
subscriber went straight to `setState` on the panel root.

The same file already contains the correct precedent — `RefreshAgo`
(`HealthMonitor.tsx:74-89`), extracted into "its OWN component so the whole Health
Monitor does not re-render for it".

### The two defects multiply

Per procmeters frame (15/sec):
1. `HealthMonitor` re-renders → `useAudioEngine()` at **HealthMonitor.tsx:388** → 1 line
2. `HealthDashboard` re-renders → `useAudioEngine()` at **health/HealthDashboard.tsx:83** → 1 line

= **~30 BOOTSEQ lines/sec**, and it never stops, because the gate never closes and
the meters never stop while processing is on.

---

## Why it lands in the startup log, and why it says `renderer:error`

Amplification chain per line:

1. Popout renderer: `console.warn` (`boot-seq.ts:20`).
2. `electron/main.js:5769` — popout `console-message` hook: prints to the terminal
   **and** IPCs `debug:popout-log` to the main window.
3. `src/App.tsx:616` — main window's popout bridge **re-emits** it as a real
   `console.warn`/`console.error` in the MAIN renderer.
4. `electron/main.js:2581` — main window's `console-message` hook catches that at
   `level >= 2` and writes it to **ether-startup.log**.

So one popout render costs a terminal line, an IPC round-trip, a main-renderer
console call, and a **disk write**. ~30/sec ≈ **108,000 log lines/hour**, unbounded.

**The `renderer:error` tag is an off-by-one.** `electron/main.js:5771`:

    const lvl = ["log", "warn", "error"][level] || "log";

Electron's `console-message` levels are `0=verbose, 1=info, 2=warning, 3=error` —
which `electron/main.js:2582` states correctly ("2 = warning, 3 = error"). The
popout table is shifted: a **warning (2) maps to "error"**. The main-window bridge
then calls `console.error`, which arrives at main.js:2581 as level 3 → logged as
`[renderer:error]`. Jeff's observed tag is the receipt that confirms this.

**Incidental, not fixed:** that same path sets `_rendererSawError = true`
(`main.js:2583`), which is the **SMOKE-mode failure flag**. A popout warn flood can
therefore fail a packaged smoke run. Flagging only — no action without Jeff's ask.

---

## Proposed fix (NOT APPLIED)

**A. Stop the hot-path log — keep the sense.** In `engine-registry.ts`, dedupe the
PRE-AUTH trace to **once per `(stationId, callsite)`** via a module-level `Set`.
The trace exists to answer "what came up, in what order, and did any of it happen
before sign-in" (`boot-seq.ts:1-3`) — the FIRST occurrence of each call site is the
entire evidence; repeats add nothing. This fixes the main window and the popout
without having to reason about popout auth state. Per BUILD THE SENSE, NOT THE
SCAFFOLD, dedupe rather than delete.

Separately worth deciding (Jeff's call, not bundled): `bootMarkAuthComplete()` is
wired only to the onboarding wizard, so the PRE-AUTH/post-auth split in the boot
map is **meaningless on every already-onboarded launch**. Every line reads
"PRE-AUTH" whether or not anyone signed in. That makes the D1 evidence misleading,
which is a bigger problem than the noise.

**B. Confine the 15 Hz re-render.** Extract the `procmeters` subscription +
`procMeters` state out of `HealthMonitor` into its own leaf component (the
`RefreshAgo` shape already in this file), so a meter frame repaints one row instead
of the whole panel. Ref-driven (the `HealthMeters` shape) is the stronger version
if the row's DOM is simple enough; leaf-component is the smaller correct change.

**Deliberately NOT building:** no rewrite of the levels/meters rendering model, no
change to the popout log bridge's level table, no touching `_rendererSawError` or
SMOKE mode.

## Verification bar

Static analysis only so far. The runtime receipt that settles it: open the Station
Health popout with Audio Processing ON and count BOOTSEQ lines in
`ether-startup.log` over 10s (expect ~300 before, 0 new after). **UNVERIFIED** until
that count is taken.


---

# OUTCOME — both fixes applied and verified

## What changed

**A. `src/audio/engine-registry.ts`** — the PRE-AUTH existing-instance trace is now gated on a
module-level `Set<number>`, so it fires **once per engine instance**, never per call. The guard is
checked BEFORE `bootCallSite()`, which takes the `new Error().stack` build off the render path too.
The trace is not deleted — it still emits once, so the boot-order evidence stands.

**B. `src/components/HealthMonitor.tsx`** — the `audio:proc-meters` subscription, the `procOn` /
`procMeters` state and the whole Audio Processing panel moved into a new leaf component
`AudioProcessingPanel` (same shape as the existing `RefreshAgo`). A 15 Hz meter frame now repaints
that one panel instead of the whole Health Monitor tree.

`id` is passed to the wrapper AND forwarded to `HealthPanel`, because `PanelStack`
(`health/sectionChrome.tsx`) builds its order by reading `child.props.id` off its **direct**
children — without it the panel would have silently become "pinned" and lost its drag-order and
collapsed state.

## Before / after — measured in the live log

`%APPDATA%\Ether\ether-startup.log` (dev session, Audio Processing ON, Station Health popout open).

| | BEFORE (60 s: 16:09:00–16:10:00) | AFTER (16:12:10–16:14:06) |
|---|---|---|
| total log lines | **1,085** | **18** |
| of which BOOTSEQ | **1,076** (99.2%) | **0** |
| sustained rate | **18–20 lines/sec** | **0** |

Cumulative damage before the fix: **211,951** PRE-AUTH lines in a **341 MB / 1,259,357-line** log —
all byte-identical, all from one call site (`useAudioEngine`).

**Last PRE-AUTH line ever written: `2026-08-26T16:10:23.615Z`.** Vite HMR picked up fix A at
16:10:19 and the flood stopped four seconds later. Nothing since.

Fix B landed at 16:12:05 after one transient bad write (`[vite] Failed to reload
/src/components/HealthMonitor.tsx` at 16:11:48 — a JSX comment placed illegally as the first
expression in a `return (`). The popout's normal 30 s polls resume at 16:12:07 and 16:12:38, which is
the receipt that the panel renders correctly on the fixed version.

`npx tsc --noEmit` → **exit 0, zero errors**.

## NOT attributable to this change

The 31 `React will try to recreate this component tree … EtherErrorBoundary` lines and the
`Check the render method of PlayLog` line are **pre-existing**: they end at log line 1,185,665,
roughly 73,000 lines before the last BOOTSEQ line. They were initially caught by a bad `awk`
timestamp filter (they are untimestamped continuation lines that sort after a date string). Unrelated
to this work and not investigated further.

## Still open, NOT fixed (deliberately out of scope)

1. **`bootMarkAuthComplete()` is still wired only to the onboarding wizard** (`App.tsx:1566`), so on
   every already-onboarded launch the boot map reads "PRE-AUTH" for everything, in the main window
   and the popout alike. The flood is gone, but the PRE-AUTH/post-auth distinction is still not
   meaningful. Jeff's call whether to wire it to real sign-in.
2. **`main.js:5771` level table is off by one** (`["log","warn","error"][level]` vs Electron's
   `0=verbose,1=info,2=warning,3=error`), which is why popout warnings arrive as `[renderer:error]`
   and set `_rendererSawError = true` — the SMOKE-mode failure flag.
3. **`HealthMonitor` still re-renders once per second** from the §3.4 `setPlayoutMode` poll, which
   returns a fresh object every tick. 1 Hz, not 15 Hz — noted, not touched.
4. The **341 MB `ether-startup.log` is still on disk** and was not truncated.
