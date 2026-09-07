# The RIDE meter lies while bypassed · and what a real PROCESSOR pop-out takes
2026-09-07 · v4.6.9 · read-only investigation, nothing changed

Two questions from Jeff after the 4.6.9 processor-controls build. Both answered from the
source; neither is fixed.

---

## 1. RIDE +2.7 dB with the ride BYPASSED

**Jeff's question:** stale from before bypass engaged, or showing what it *would* apply?

**Answer: the second, and it is LIVE, not stale.** It cannot be a leftover — the value is
zeroed at the instant bypass engages. It then climbs again from zero, while bypassed,
toward the correction the ride would be making. What is on screen is a real-time
"would apply" number sitting in the place the operator reads as "is applying".

### The receipt

`native/src/program_processor.rs`

| line | what it does |
|---|---|
| 291 | `if ride_bypass { self.ride.gain_db = 0.0; }` — engaging bypass **zeroes** the gain. So +2.7 is not stale. |
| 57–61 | `update()` integrates `gain_db` toward `desired = target − in_lufs` at `rate_db_per_s` **every buffer, with no bypass check**. So it climbs back. |
| 67 / 248 | `if self.bypass { return 1.0; }` — only the **applied** gain is forced to unity. |
| 335 | `pub fn ride_gain_db(&self) -> f32 { self.ride.gain_db }` — the meter reads the integrator, not the applied gain. |

→ `proc_ride_gain_db` (`audio.rs:206, 613`) → the rack's RIDE readout.

At ride rate 1.5 dB/s, +2.7 dB is roughly what the integrator reaches ~2 seconds after
bypass engages. The number is arithmetically correct and completely misplaced.

### A second lie from the same cause

`program_processor.rs:244` — `out_lufs_est = in_lufs + gain_db`.

While bypassed the output **is** the input, but OUT LUFS still reports the ridden
estimate. This one also shows in the Settings processing section, not only the rack.

### The asymmetry is the actual defect

The limiter does this correctly. `process()` at line 140:

```rust
if self.bypass { self.gr_db = 0.0; return (l, r); }
```

Bypassed limiter → GR reads 0.00, truthfully. Bypassed ride → RIDE reads +2.7, falsely.
**Two stages, two different honesty rules, in one rack.** The rule that survives is the
limiter's.

### Fix — recommended (not built)

Three small changes, no new plumbing:

1. **Rust — stop integrating while bypassed.** Hold `gain_db` at 0 rather than letting it
   climb. Mirrors the limiter exactly. Bonus: disengaging bypass then *ramps* the gain in
   at `rate_db_per_s` from zero instead of stepping instantly to +2.7 dB — no click on an
   A/B. (Keeping the integrator running would make un-bypass a discontinuity.)
2. **Rust — `out_lufs_est = in_lufs` while bypassed.** The output is the input; say so.
3. **UI — keep the "would ride" number, clearly labelled and greyed.** It is genuinely
   useful during an A/B: *"the ride would be pulling this song down 2.7 dB right now."*
   It needs **no new field** — the rack already has the target and `proc_in_lufs`, so it
   can compute `clamp(target − in_lufs, ±clamp)` itself.

Result: RIDE reads **0.0 dB applied** (true), with a greyed **would ride +2.7 dB**
(labelled as a projection). The meter stops claiming and starts observing, and the
information Jeff was actually reading is not lost — it is just no longer lying about
which one it is.

Note the loudness **meter** must keep running while bypassed — that is deliberate and
documented at line 210: `in_lufs` stays an observed number. Only the corrective gain and
anything derived from it are the problem.

---

## 2. A real PROCESSOR pop-out

**This is not new. Ether already has one pop-out system, and Master Output is already in
it.** Nothing here needs inventing — the processor should join the existing pattern.

### What exists

`electron/main.js`

| thing | line | note |
|---|---|---|
| `openPopoutWindow(panel)` | 6221 | **the ONE opener.** Dedupes by window title `popout:<panel>`; a second call focuses the existing window. |
| `POPOUT_SIZES` | 6096 | per-panel default size — `"master": 800×600` is already there. |
| `POPOUT_LABELS` | 6126 | human name for the debug-bridge log prefix; missing entry falls back to the key, never nameless. |
| `loadPopoutBounds` / `savePopoutBounds` | 6155 / 6158 | remembers size **and position** per panel in `popout-bounds.json`. |
| secondary-monitor default | 6234–6238 | with no saved bounds it opens on the **second display** at +60,+60. Exactly the behaviour Jeff is asking for, already built. |
| `ipcMain.handle("window:popout")` | 6302 | the renderer's door in. |
| native frame | ~6247 | `frame: true` deliberately — a frameless pop-out lost its minimize/maximize/close. |
| per-window DevTools | ~2820 | F12 inside a pop-out opens **that** window's DevTools. |

Renderer: `src/main.tsx:63` routes `#popout/<panel>`, `src/components/PopoutRenderer.tsx`
switches on the panel — `case "master"` at line 145 renders the whole
`<MasterOutput expanded />`. `src/App.tsx:891` has `openPopout(panel)` for the hamburger.

**So Master Output already pops out today** (hamburger → Windows → Master Output, or the
native Window menu at `main.js:2886`). The PROCESSOR rack currently opens as a
`FloatingWindow` *inside* whichever window hosts it — which is why it cannot leave.

### What it takes — five edits, all matching the existing pattern

1. `POPOUT_SIZES`: `"processor": { width: 520, height: 720 }` — the rack is tall and narrow.
2. `POPOUT_LABELS`: `"processor": "Processor"`.
3. `PopoutRenderer.tsx`: `case "processor"` rendering the rack.
4. Window menu + hamburger entry, beside Master Output.
5. The rack's OPEN button calls `window:popout` instead of toggling `procOpen`.

### The one real piece of work

The rack's state — the four KV numbers, the presets, `sendProc`, the meter subscription —
currently lives **inside `MasterOutput.tsx`**. A separate window is a separate renderer, so
it cannot reach that state. It needs extracting into a hook (`useProcessorParams(stationId)`)
that both the in-window rack and the pop-out call. That is a move, not a rewrite: the same
KV load, the same `sendProc`, the same meter subscription, lifted one level.

Worth doing anyway — it also means the bypass banner on the Master Out row and the rack in
another window read one source instead of two copies that can disagree.

### One hazard to decide before building

`PopoutRenderer.tsx:105` passes `stationId={stationId ?? 1}`. For a **processor** pop-out
that fallback is dangerous in a way it is not for a meter: an operator could be adjusting
station 1's ceiling while believing they are on the station they are listening to. The
pop-out must use the resolved active station and **render nothing rather than default to 1**
if it has not resolved yet. (This `?? 1` is a known open item in the command-path
station-scoping notes; the processor makes it sharper, not new.)

---

## Status — BUILT, v4.6.10 (commit 3274ba0)

Both items shipped as specified. Three things worth recording that the proposal did not cover:

1. **Bypass stopped being a UI flag.** With the rack in its own renderer, a local flag would let the
   pop-out and the Master Out row disagree. The engine now **echoes** the bypass state on the meter
   frame (`proc_ride_bypass` / `proc_limiter_bypass`) and every window renders the echo. Engaging
   bypass in the pop-out lights the amber chip in the main window.
2. **Settings was quoting a literal.** `"limiter holds −1 dBTP"` stopped being true the moment 4.6.9
   made the ceiling a control, and was already false under bypass. The ceiling now rides the meter
   frame too, so the line is observed rather than asserted. This was a regression introduced by the
   4.6.9 controls, found while fixing OUT.
3. **C6 (d)** pins the fix with a control: an acting ride winds to −8.33 dB and lands at exactly the
   −14.0 LUFS target on the same signal where the bypassed one holds 0.00 dB with out == in. Fed in
   real 480-frame blocks — one giant block grants a single 0.6 dB step and would prove nothing.
