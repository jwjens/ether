# BYPASS does nothing visible in 4.6.10 — where the chain stops
2026-09-07 · read-only trace · nothing changed

**The break is at hop 3: the engine never echoes the bypass state. The fields exist on the
levels payload, the comment above them describes the echo, and no line ever writes them.**

A second, independent defect sits behind it: the engine re-asserts `false, false` over the
operator's bypass every ≤15 seconds. That one predates 4.6.10 — it was in 4.6.9 too.

---

## The trace, hop by hop

| # | hop | file:line | verdict |
|---|---|---|---|
| 1 | Bypass button → `onBypass` | `ProcessorRack.tsx:88` (`<Bypass>`), wired at 167/181 | **OK** |
| 1 | → `setBypass` → `send()` | `useProcessorParams.ts:140`, `:95` | **OK** |
| 2 | → preload bridge | `preload.js:33` → `invoke("audio:set-processor-params")` | **OK** |
| 3 | → main process | `main.js:4877` → `audiodClient.cmd("setProcessorParams", …)` with `rideBypass: !!p.rideBypass` | **OK** |
| 4 | → daemon command | `ether-audiod.js:301` → `A.audioSetProcessorParams(…, !!m.rideBypass, !!m.limiterBypass)` | **OK** |
| 5 | → napi → command queue | `lib.rs` `audio_set_processor_params` → `AudioCmd::SetProcessorParams` | **OK** |
| 6 | → bus state | `audio.rs:2022-2023` `bus.proc_ride_bypass = ride_bypass` | **OK** |
| 7 | → the processor, per buffer | `audio.rs:2518 / 2602 / 2672` `p.set_params(…, bus.proc_ride_bypass, bus.proc_limiter_bypass)` | **OK** |
| **8** | **→ echoed on the levels payload** | **`audio.rs:1924-1932`** | **✗ BREAKS HERE** |
| 9 | → meter frame | `engine.js:361` `rideBypass: !!lv.proc_ride_bypass` | reads a field nobody writes |
| 10 | → the UI | `useProcessorParams.ts:90` | renders the dead echo |

### Hop 8 — the missing lines

`AudioLevels` declares them (`audio.rs:193-198`), with a comment that states the behaviour as
though it exists:

```rust
// The operator's live processor parameters, echoed back so the panel shows what the ENGINE is
// running rather than what the UI last sent — the same observed-not-claimed rule as the meters.
#[serde(default)] pub proc_ceiling_dbtp:   f32,
#[serde(default)] pub proc_release_ms:     f32,
#[serde(default)] pub proc_ride_rate:      f32,
#[serde(default)] pub proc_ride_clamp:     f32,
#[serde(default)] pub proc_ride_bypass:    bool,
#[serde(default)] pub proc_limiter_bypass: bool,
```

The block that fills the payload (`audio.rs:1924-1932`) writes `proc_local`, `proc_stream`,
`proc_target_lufs`, `proc_in_lufs`, `proc_out_lufs`, `proc_gr_db`, `proc_ride_gain_db`,
`proc_in_peak`, `proc_out_peak` — **and stops.** `grep proc_ride_bypass audio.rs` returns the
declaration, the bus field, the command handler and the three `set_params` reads. **No
assignment to `lvl.` anywhere.** Six fields ship as their zero value on every frame, forever.

I believed I had added those six lines when building 4.6.9 and reported them as delivered. They
are not in the tree and were never in it. The comment describing them is the only trace.

### Why it looks like a dead button instead of falling back

`useProcessorParams.ts:90`:

```ts
const rideBypass = meters?.rideBypass ?? intentRide;
```

The field arrives as `false` — present, not nullish — so `??` keeps it and the local intent is
never consulted. **Had the field been absent, the button would have looked like it worked.**
Wiring the echo and reading it with `??` turned a working-looking control into a dead one on the
same commit.

---

## The second defect — the engine wipes bypass every ≤15 seconds

`engine.js:325-331`, inside `_applyProcessingFromKv`:

```js
const reassert = (local || stream) && (now - (this._procAssertedAt || 0) > 15000);
if (!changed && !reassert) return;
…
A.audioSetProcessorParams(this.stationId, ceiling, release, rideRate, rideClamp, false, false);
```

Bypass is deliberately not persisted — correct — but the re-assert passes **literal `false`**
rather than leaving the field alone. So while processing is on, the engine un-bypasses whatever
the operator engaged, within 15 seconds, silently.

**This was live in 4.6.9.** It means the 4.6.9 report ("ride bypassed, still shows RIDE +2.7 dB")
has a second sufficient explanation I did not find: the ride was being un-bypassed underneath
the reading. The integrator defect was real and is proven by C6 (d), but I presented it as *the*
cause without a runtime receipt that the bypass had taken effect at all. It hadn't, for more
than 15 seconds at a time.

---

## Answers to the five questions

1. **Does the click send?** Yes — hops 1-5 are all intact, file:line above. Nothing on the send
   side is broken.
2. **Does the engine receive and apply it?** The source says yes: the command reaches
   `bus.proc_ride_bypass` and is handed to all three processor instances every buffer.
   **UNVERIFIED at runtime** — see the check below.
3. **Does it echo back, and does the UI read it?** The UI reads it correctly. **Nothing writes
   it.** This is the break.
4. **Anything swallowed?** Four quiet spots, none of them the cause but all of them the reason it
   failed silently: `send()`'s `catch {}` (`useProcessorParams.ts:103`); the un-awaited `invoke`
   promise; `ether-audiod.js:301` returning literal `true` while discarding the napi function's
   real boolean; and `_applyProcessingFromKv`'s `catch { return; }`.
5. **Pop-out or main window?** **Both, identically** — they render the same dead echo. With
   processing OFF there are no meter frames, `meters` is null, the `??` falls back to intent and
   the banner and the amber chip both appear normally. So "the chip works when processing is off
   and only then" is the signature of this bug.

---

## A third thing, from the same missing lines

`proc_ceiling_dbtp` also echoes 0.0, and the Settings line added in 4.6.10 reads

```tsx
limiter holds {(meters?.ceilingDbtp ?? -1).toFixed(1)} dBTP
```

`0` is not nullish, so with processing on **Settings now claims "limiter holds 0.0 dBTP"** — a
worse statement than the hardcoded −1 it replaced, and one I introduced while removing a literal
in the name of honesty. Same root cause.

---

## The runtime check that settles hop 2, using only fields that work

`proc_gr_db` and `proc_ride_gain_db` **are** echoed correctly. In 4.6.10 a bypassed limiter
zeroes `gr_db` and a bypassed ride pins `gain_db` to 0. So with processing on and audio playing:

> Click BYPASS on the ride. If **RIDE drops to 0.0 dB and holds for about ten seconds, then jumps
> back to a real value**, that proves the command lands (hop 2 fine), the echo is missing (the
> chip stayed dark throughout), and the 15-second re-assert is real — all three in one
> observation.

If RIDE never moves, the command is not landing and the trace above is wrong about hops 5-7.

---

## Status

Diagnosed only. No fix proposed here, per instruction.

---

## FIXED (local, not yet built) — 2026-09-07

| # | fix | where |
|---|---|---|
| 1 | The six echo assignments written | `audio.rs` — after `lvl.proc_out_peak`, incl. `proc_ceiling_dbtp` |
| 2 | Bypass split onto its own command | `AudioCmd::SetProcessorBypass`, `audio_set_processor_bypass`, daemon `setProcessorBypass` |
| 3 | Settings no longer invents a ceiling | a ceiling is always negative; `0` now renders "not reported" |
| 4 | The four silent catches | see below |
| 5 | Contract test | `audiod/smoke-meter-contract.js` |

**Fix 2 is structural, not careful.** The re-assert had to pass *something* for bypass and passed
`false`. Now `audioSetProcessorParams` takes only the four numbers — there is no bypass argument to
get wrong — and bypass travels on `audioSetProcessorBypass`, which only the operator's action calls.
The re-assert cannot clear a bypass because it cannot express one.

**Fix 4, the four:**
- `useProcessorParams.send()` — was fire-and-forget in a `catch {}`; now awaited, and a refusal
  surfaces as a red banner in the rack.
- `ether-audiod.js` — returned literal `true`; now returns the napi boolean.
- `main.js` — now returns `{numbers, bypass}` and writes a `proc-params-failed` health event.
- `engine.js` `_applyProcessingFromKv` — the KV `catch { return; }` now logs, rate-limited to 1/min.

Plus a fifth, unasked but the same class: an engaged bypass the engine has **not** confirmed now
shows "waiting for the engine to confirm…" instead of nothing. An unconfirmed click is never silent
again.

### What the contract test caught on its first run

Three things. Two were **its own parser faults** — a fixed-size window that ran past the frame into
the daemon's `event:`/`state:` envelope, and a key-matching regex that missed any key sitting under a
comment line. Both fixed (brace-matched slice, comments stripped); a test that cries wolf gets
ignored, which is how this whole class hides.

The third is real and **is not one of the four**, so it is reported and not fixed:

> **`audiod/engine.js:2017` reads `lv.master`. The field is `level_master`.**
> `_isAudiblyOnAir()` therefore evaluates `(undefined || 0) > 0.002` — **always false, every time.**
> Its stated job (line 2010) is to let `automationStart` "refuse adopting a silent/wedged deck
> (2026-07-15 silent-while-playing fix)". That guard has never once returned true.

One word (`lv.master` → `lv.level_master`) makes it live for the first time, which is a real
behaviour change on the automation path and Jeff's call, not mine.

`lv.cart` is also unwritten but is tolerated with a stated reason: it is read as
`lv.cart || lv.level_cart || 0`, so the fallback is the real field.
