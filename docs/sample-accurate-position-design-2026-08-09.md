# Sample-Accurate Per-Deck Position — Implementation Plan (Audit Fix #5)
**Date:** 2026-08-09 · **Status:** ✅ APPLIED (local, uncommitted) — see §11 for three corrections found during application
**Supersedes:** the raw delegate output, which contained 6 defects corrected below.

---

## 0. What changed vs the original task spec

Two premises in the original spec were wrong against this tree, and one instruction I gave the delegate was wrong. All three are corrected here.

| Spec said | Reality | Correction |
|---|---|---|
| "Add a monotonic sample counter" | **Already exists** — `BusState.frames_consumed` (audio.rs:375, incremented :1245), surfaced as `AudioLevels.frames_total` (audio.rs:916), already read by the daemon (engine.js:171) and `electron/audio-health.js:86` | Reuse the pattern; add a **per-deck** counter alongside it |
| `positionSec = samples_output / sample_rate` | A single counter is **stream-global across all 7 slots** — identical for every deck, never resets between songs, wrong during crossfade | **Per-deck** `frames_played`, counted from frames actually pulled from that deck's source |
| *(my instruction)* "preserve `frames_played` across device failover so position doesn't jump to zero" | **Wrong.** `restore_decks_after_switch` (audio.rs:1046-1049) explicitly *"track restarts from beginning"* | **Reset to 0** on failover restore — see §4 |

---

## 1. Design

Add `frames_played: u64` to each `DeckSlot`. The mixer callback increments it by the frames **actually pulled** from that deck's source. Position is `frames_played / PROGRAM_RATE` — always in the 44100 domain, never the device rate.

**Why per-deck beats a global counter + start anchor:**
- advances only while that deck actually pulls samples → pause/resume needs no bookkeeping
- crossfades are independent per deck
- immune to device-rate changes
- resets naturally on Load

**Why count real iterations, not `prog_frames`:** `prog_frames` carries a `+2` rounding margin on non-44.1k devices (audio.rs:1096-1100), and the inner loop `break`s early on source exhaustion (audio.rs:1150). Adding `prog_frames` would over-count on both paths.

---

## 2. `native/src/audio.rs`

> Note: `DeckInfo`, `DeckMeta`, `DeckTel`, and `AudioLevels` all live in **audio.rs** (lines 52, 65, 105, 115) — *not* lib.rs. The delegate output filed these under lib.rs; that is wrong.

### 2a. `DeckSlot` struct (audio.rs:293-313) — add field

```rust
    pub muted:    bool,
+   /// v4.4.x: monotonic count of PROGRAM_RATE stereo frames actually pulled from THIS deck's
+   /// source. Written ONLY by mixer_callback under the lock it already holds (no new lock, no
+   /// atomic) — same discipline as bus.frames_consumed above. Read by GetLevel into
+   /// DeckTel.frames_played and used as the single position authority.
+   /// Counted from real loop iterations, never prog_frames (which carries a +2 rounding margin
+   /// and can break early on exhaustion). Reset on Load, Stop, and device-failover restore.
+   pub frames_played: u64,
}
```

### 2b. `DeckSlot::new()` (audio.rs:315-328)

```rust
            muted:   false,
+           frames_played: 0,
        }
```

### 2c. Mixer loop (audio.rs:1137-1153) — local accumulator

The delegate incremented `deck.frames_played` **inside** the per-frame `match`, while `src` holds a mutable borrow of `deck.source`. Disjoint-field borrows may permit it, but doing 44,100 increments/sec/deck on the audio thread when one add per buffer suffices is the wrong call regardless. Accumulate locally, commit once:

```rust
        let mut pk = 0.0f32;
+       let mut pulled = 0u64;   // frames actually taken from this deck's source this buffer
        for f in 0..prog_frames {
            // Source is always stereo (UniformSourceIterator built with 2 ch)
            match src.next() {
                Some(l) => {
                    let r = src.next().unwrap_or(0.0);
                    let lv = l * vol;
                    let rv = r * vol;
                    mix_l[f] += lv;
                    mix_r[f] += rv;
+                   pulled += 1;
                    let a = lv.abs().max(rv.abs());
                    if a > pk { pk = a; }
                }
                None => { exhausted[i] = true; break; }
            }
        }
+       // Commit once per buffer — the src borrow is dead here.
+       // A CUT channel (deck.muted) still advances: the source is advanced while cut
+       // (audio.rs:1127-1128), so position must advance too or a cut track's countdown lies.
+       deck.frames_played = deck.frames_played.wrapping_add(pulled);
        frame_peaks[i] = pk;
```

### 2d. Publish into `DeckTel` — GetLevel handler (audio.rs:901-935)

`DeckTel` (audio.rs:105) gains the field:

```rust
    pub gain_db: f32,          // per-deck trim in dB
+   /// Per-deck monotonic PROGRAM_RATE frame count → position = frames_played / 44100.
+   #[serde(default)]
+   pub frames_played: u64,
```

And in the GetLevel arm — **note the loop currently covers only A/B/C; CART (slot 6) must be added** or every jingle/cart reports position 0:

```rust
                                    let mut active = 0u32;
-                                   let mut dt = Vec::with_capacity(3);
-                                   for (i, id) in [(0usize, "A"), (1, "B"), (2, "C")] {
+                                   let mut dt = Vec::with_capacity(4);
+                                   // CART (slot 6) included: jingles/carts need a real position too.
+                                   for (i, id) in [(0usize, "A"), (1, "B"), (2, "C"), (6, "CART")] {
                                        let d = &bus.decks[i];
                                        let present = d.source.is_some();
                                        if d.active && !d.paused && present { active += 1; }
                                        dt.push(DeckTel {
                                            id: id.to_string(),
                                            ...
                                            gain_db: d.gain_db,
+                                           frames_played: d.frames_played,
                                        });
```

⚠️ `active_decks` currently counts only A/B/C. Adding CART to this loop changes that number, which `electron/audio-health.js` consumes. Either keep the `active` increment gated to `i < 3`, or accept the semantic change deliberately. **Recommend gating** to avoid perturbing an existing health signal.

### 2e. Resets — BOTH dispatch sites

There are **two** command dispatch blocks, not one:
- legacy `start_audio_thread`: Load :537, Play :564, Pause :573, Stop :579
- per-station `start_station_mixer`: Load :810, Play :835, Pause :872, Stop :878

The delegate patched only "around line 850". **Patch both**, or the legacy path silently keeps a stale counter.

In each `AudioCmd::Load` arm, alongside the other slot writes:
```rust
+   slot.frames_played = 0;   // new track → position restarts
```
In each `AudioCmd::Stop` arm:
```rust
+   slot.frames_played = 0;   // deck emptied → position clears
```
`Play` and `Pause`: **no reset** — resume must continue from where it stopped.

### 2f. Device failover — RESET, not preserve (corrects my instruction)

`restore_decks_after_switch` (audio.rs:1046-1072) rebuilds the decoder from the top of the file: *"Acceptable limitation: track restarts from beginning."*

Preserving `frames_played` would make the counter claim e.g. 2:30 while the listener hears 0:00. That is a lying state, and worse, the daemon derives `remaining = durationSec - positionSec` for segue firing (engine.js:1142) — a preserved counter would fire the crossfade immediately and cut the restarted track off. Reset it:

```rust
                if bus.decks[idx].source.is_none() && bus.decks[idx].active {
                    bus.decks[idx].source = Some(src);
+                   // The decoder restarts at the top of the file (see fn comment), so position
+                   // MUST restart with it. Preserving the count would report a position the
+                   // listener is not hearing, and would fire the segue early via
+                   // remaining = duration - position. Honest state over smooth state.
+                   bus.decks[idx].frames_played = 0;
                    let _ = gain_db;
                }
```

This makes the position jump visible on failover. That is correct: the jump is real, the audio really did restart.

---

## 3. Transport seam — use the LEVELS path, not `audio_get_state`

The delegate chose (a) `audio_get_state` + `DeckInfo.position_sec`, reading `audio.levels.lock()`. **That source is stale.** `audio_get_state` (lib.rs:182-211) sends **no** `GetLevel` command — it only reads `audio.deck_*` metadata and takes finished-flags. `audio.levels` holds whatever the last `audio_get_levels` call left there, at an unrelated cadence. The delegate's comment *"We previously sent AudioCmd::GetLevel (line above)"* is false.

**Use (b) the levels path instead.** It is already live, already locks the bus, already snapshots `frames_consumed` under that same lock (audio.rs:916), and **the daemon already polls it** — `engine.js:171-172` reads `lv.frames_total` today. Zero new IPC, zero staleness, no change to `audio_get_state` or `DeckInfo` at all.

---

## 4. `audiod/engine.js`

### 4a. Stash per-deck frames where levels are already read (~engine.js:171)

```js
      const df = Math.max(0, (lv.frames_total || 0) - (this._lastMixFrames || 0));
      this._lastMixFrames = lv.frames_total || 0;
+     // Per-deck sample clock — the position AUTHORITY. Stamped with arrival time so poll()
+     // can detect staleness and fall back honestly.
+     if (Array.isArray(lv.decks)) {
+       const f = {};
+       for (const d of lv.decks) if (d && d.id) f[d.id] = d.frames_played;
+       this._deckFrames = f;
+       this._deckFramesAt = Date.now();
+     }
```

### 4b. Module scope — the debug flag (corrects two defects)

The delegate declared `const POSITION_WALL_FORCE = false` *inside* `poll()` (re-created every 250 ms) and then **assigned to it** (`useSample = false` on a `const` → TypeError under `"use strict"`, which engine.js uses). It also claimed an env var the code never read.

```js
+ // Escape hatch: force the legacy wall-clock authority without a rebuild.
+ const POSITION_WALL_FORCE = process.env.ETHER_POSITION_WALL_FORCE === "1";
+ const PROGRAM_RATE        = 44100;
+ const FRAMES_STALE_MS     = 2000;   // levels older than this → not an authority
+ const DRIFT_LOG_MS        = 5000;   // per-deck throttle for drift lines
```

### 4c. Replace the wall-clock derivation (engine.js:375-377)

```js
-   const pos = {
-     A: this.stateA.status === "playing" ? Math.min(this.stateA.positionSec + elapsed, dur.A || 9999) : this.stateA.positionSec,
-     B: ... , C: ... ,
-   };
-   this.stateA = { ...makeState("A", s.deckA), durationSec: dur.A, positionSec: pos.A };
-   this.stateB = { ...makeState("B", s.deckB), durationSec: dur.B, positionSec: pos.B };
-   this.stateC = { ...makeState("C", s.deckC), durationSec: dur.C, positionSec: pos.C };
+   const framesFresh = this._deckFramesAt && (Date.now() - this._deckFramesAt) < FRAMES_STALE_MS;
+
+   const derive = (id, live, durSec) => {
+     const st   = this._deckState(id);              // exists: engine.js:302
+     const stat = (live && live.status) || st.status;
+     const wall = stat === "playing"
+       ? Math.min(st.positionSec + elapsed, durSec || 9999)
+       : st.positionSec;
+
+     const raw    = framesFresh && this._deckFrames ? this._deckFrames[id] : undefined;
+     const sample = typeof raw === "number" ? raw / PROGRAM_RATE : null;
+
+     // Fall back when: no fresh frames, OR the counter sits at 0 while the deck claims playing
+     // (a deck that just started legitimately reads ~0 for one tick — the durationSec guard
+     // below keeps that from flapping).
+     let useSample = sample !== null && !(sample === 0 && stat === "playing" && st.positionSec > 1);
+     if (POSITION_WALL_FORCE) useSample = false;
+
+     const driftMs = sample !== null ? (sample - wall) * 1000 : null;
+
+     // Authority flips are NEVER silent (project rule: observed state, honest degrade).
+     if (!this._posAuth) this._posAuth = {};
+     const prev = this._posAuth[id];
+     if (!prev || prev.useSample !== useSample) {
+       const reason = POSITION_WALL_FORCE ? "forced-wall-clock"
+                    : useSample            ? "sample-clock-restored"
+                    : !framesFresh         ? "levels-stale"
+                                           : "counter-zero-while-playing";
+       this.emit("health", { where: "position-authority", deck: id,
+                             authority: useSample ? "sample" : "wall", reason,
+                             sampleSec: sample, wallSec: wall, driftMs });
+       this._log(`position authority ${id} → ${useSample ? "SAMPLE" : "WALL"} (${reason})`);
+     }
+     this._posAuth[id] = { useSample };
+
+     if (driftMs !== null && Math.abs(driftMs) > 50) {
+       if (!this._driftAt) this._driftAt = {};
+       if (Date.now() - (this._driftAt[id] || 0) > DRIFT_LOG_MS) {
+         this._driftAt[id] = Date.now();
+         this._log(`position drift ${id}: sample=${sample.toFixed(3)}s wall=${wall.toFixed(3)}s Δ=${driftMs.toFixed(0)}ms`);
+       }
+     }
+
+     return { positionSec: useSample ? sample : wall,
+              positionSecWall: wall,
+              positionDriftMs: driftMs };
+   };
+
+   this.stateA = { ...makeState("A", s.deckA), durationSec: dur.A, ...derive("A", s.deckA, dur.A) };
+   this.stateB = { ...makeState("B", s.deckB), durationSec: dur.B, ...derive("B", s.deckB, dur.B) };
+   this.stateC = { ...makeState("C", s.deckC), durationSec: dur.C, ...derive("C", s.deckC, dur.C) };
```

⚠️ **Check before applying:** `stateChanged` (engine.js:593) compares `Math.floor(prev.positionSec) !== Math.floor(next.positionSec)`. Adding `positionSecWall`/`positionDriftMs` to the state object must not make it fire every tick — confirm those fields are not included in the comparison, or the deck event rate jumps from ~1 Hz to ~4 Hz.

---

## 5. `src/audio/engine-rodio.ts`

Guard the local extrapolation to in-process mode only. In daemon mode the `onDeck` stream is already authoritative:

```ts
+ // Daemon mode: the daemon owns position (sample clock). Local extrapolation here would
+ // overwrite the authority with an estimate — the exact duplication this change removes.
+ if (!this.daemonDriven) {
    const posA = (this.stateA.status === "playing") ? Math.min(this.stateA.positionSec + elapsed, durA || 9999) : this.stateA.positionSec;
    ... existing A/B/C rebuild + listener fire, unchanged ...
+ }
```

Additive, non-breaking interface fields:

```ts
  contentClass?: string | null;
+ /** Legacy wall-clock estimate — retained for the parallel-run window only. */
+ positionSecWall?: number;
+ /** sample − wall, in ms. Observability during validation. */
+ positionDriftMs?: number;
```

---

## 6. Validation — the delegate's criterion is unsound

It proposed: *"remove the wall-clock path when no drift > 50 ms is observed over 30 days."*

That is backwards. Sample and wall **must** diverge — wall-clock drift is the defect being fixed. Agreement between them would prove nothing about which is *correct*, and "no drift ever" is an impossible bar.

**Correct criterion — measure the sample clock against ground truth, not against the thing it replaces:**

1. **Absolute accuracy.** Play a file of exactly known duration (generate a 180.000 s tone). At the instant the deck's finished-flag fires, `positionSec` must read 180.000 ± 0.050 s. This is the real pass/fail — it tests the counter against the file itself.
2. **Rate accuracy.** Over a 30-minute run, `Δframes / Δt` must hold 44100 ± 50 ppm.
3. **Drift-vs-wall is observability, not a gate.** Log it, chart it, expect it to grow. It quantifies how wrong the old path was — that number is the justification for the change, not a blocker.
4. **Ship criterion:** delete the wall-clock path after **one release** in which (1) and (2) pass on OV and USPH and zero `position-authority → WALL` health events fire outside deliberate testing.

---

## 7. Edge cases

| Case | Behavior |
|---|---|
| Stream start | Counter starts at 0; position rises from 0 |
| Resume after pause | Continues — only Load/Stop/failover reset |
| Stop → Load new track | Reset to 0 at both arms, both dispatch sites |
| **Seek** | **Does not exist** — no seek anywhere in `native/src/*.rs`. Moot. |
| Device sample-rate change | Counter is in PROGRAM_RATE frames; unaffected |
| Device failover | **Resets to 0** — the decoder genuinely restarts (§2f) |
| `+2` prog_frames margin | Not used; real iterations counted |
| u64 wrap | 2⁶⁴/44100 ≈ 1.3 × 10⁷ years. `wrapping_add` is belt-and-braces. (The delegate said "4 million years" — wrong by ~3×, immaterial.) |
| CART slot 6 | Now reported. **Never index `DECK_LETTERS[6]`** — that caused a real panic → permanent dead air (docs/incident-jingle-cart-panic-2026-07-15.md). The loop above uses an explicit `"CART"` literal. |
| Deck active but muted | Position advances — the source is still pulled while cut (audio.rs:1127-1128). Correct: a cut track must still run out on schedule. |
| Deck D/E/F | Not in `AudioLevels`; report no position. Out of scope — flag as a known gap rather than defaulting them to a fake 0. |

---

## 8. Test plan

New smoke: **`audiod/smoke-deck-position.js`**, in the house style (`smoke-xfade-contract.js`: real `DaemonEngine`, no audio/no DB/no daemon, `exit 0 = pass`). Injects a fake levels stream, so it needs no sound card:

1. Fresh frames → `positionSec` derives from sample clock; `positionDriftMs` populated.
2. Levels go stale (> 2000 ms) → authority flips to wall **and** a `health` event fires with `reason: "levels-stale"`. Assert the event, not just the value.
3. Authority flip back emits `sample-clock-restored`.
4. `ETHER_POSITION_WALL_FORCE=1` → always wall, drift still computed.
5. Two decks with different frame counts → independent positions (the crossfade case a global counter would break).
6. Pause: frames stop advancing → position holds.

Plus one **on-hardware** test that the smoke cannot cover: the 180.000 s absolute-accuracy check in §6.1, run on a real output device.

---

## 9. Architecture compliance

- **No global statics.** All state per-station inside `BusState`/`DeckSlot`. `scripts/check-no-global-audio-statics.js` must still pass. (DESIGN-TRUTH §2; a global was tried and rejected 2026-08-06, audio.rs:356-361.)
- **No new lock on the audio thread.** `frames_played` is written under the lock the callback already holds — same discipline as `frames_consumed` (audio.rs:371-375). No allocation added to the callback.
- **Honest state.** Every authority flip emits a health event with a reason. No silent degrade.
- **Non-breaking.** Wall-clock path intact behind a flag; renderer interface additive; `audio_get_state` untouched.
- **Process boundary respected.** Rust → daemon → renderer. The renderer gains no direct Rust access.

---

## 11. Corrections found during application (2026-08-09)

Three things in §2–§4 above were wrong against the tree and were corrected while applying. Recorded here so the plan and the code agree.

**11.1 — §2e was wrong: only ONE dispatch site needs the resets.**
The plan said to patch Load/Stop in both `start_audio_thread` (:537) and `start_station_mixer` (:810). Reading them showed the legacy `start_audio_thread` path is a **completely different implementation** — it drives rodio `Sink`s via `sinks`/`loaded_files`/`playing_decks` and never touches `BusState.decks` at all. There is no `DeckSlot` there to reset and no `mixer_callback` to increment; its own `SetMuted` arm (:591) labels it "SUPERSEDED PATH". Only `start_station_mixer` was patched. Patching the legacy arms would not have compiled.

**11.2 — §4a was wrong: the heartbeat is the wrong place to stash frames.**
The plan piggybacked the frame stash on `_mixHeartbeat` (:165). That method runs on a **5-second cadence** and returns early when nothing is playing — frames would have been older than `FRAMES_STALE_MS` (2000) on nearly every tick, pinning the authority permanently to the wall-clock fallback it is meant to replace. Instead a new `_readLevels(now)` does one `audioGetLevels` per `poll()` tick and hands the parsed payload to `_mixHeartbeat`, so the heartbeat costs no extra NAPI call.

**11.3 — the `health` event name had no consumer.**
`emit("health", …)` was a brand-new event name; `electron/main.js` routes daemon events by explicit name and nothing forwarded it, so the "observability" would have died at the pipe boundary — decorative, exactly what BUILD THE SENSE forbids. Renamed to **`position-authority`** and added to the established loud-event list at `main.js:626`, which appends to `health-events.jsonl` alongside `logreader-floor` / `fill-starved` / `separation-relaxed`. No new plumbing; it rides a proven path.

### Verification run at apply time

| Gate | Result |
|---|---|
| `cargo check` (native) | ✅ exit 0 |
| `node --check` engine.js / main.js | ✅ both parse |
| `npx tsc --noEmit` | ✅ 2 pre-existing baseline errors (OnboardingFlow, PhoneDesk), **zero new** |
| `npm run check:audio-isolation` | ✅ no global scalar audio state |
| Existing daemon smokes (xfade-contract, seam-stop, autofit, nearest-anchor, manual-mode) | ✅ 5/5 PASS |
| New `audiod/smoke-deck-position.js` | ✅ 16/16 PASS |

**Not yet verified:** anything about the running product. No build was made, no app was launched, no audio was played. Every claim above is a claim about the tree and the benches — the on-air behaviour is UNVERIFIED until the runtime plan in §8 is run on a real device.

---

## 12. Resolved: the event-rate question

**Answered by Jeff, 2026-08-09: keep `Math.floor(positionSec)` only — do NOT include the new drift fields.** Applied as instructed.

The concern was that a sample-accurate position changing every tick could push deck events from ~1 Hz to ~4 Hz, on top of the event-herd load the audit already flagged (`ether-audiod.js` levels @100 ms).

It cannot, for two independent reasons:
1. `_changed` (engine.js:586, the daemon's gate) compares **named fields** — `filePath`, `title`, `status`, `Math.floor(positionSec)`, `durationSec`, `volume`. It is not a whole-object comparison, so `positionSecWall` and `positionDriftMs` are structurally incapable of triggering an emission. Neither was added to it.
2. `stateChanged` (engine-rodio.ts, the renderer's gate) is likewise floor-based on `positionSec`. This is also why removing the renderer's local position tick costs nothing visually: the UI only ever repainted on whole-second boundaries, and the daemon emits on that same boundary.
