# Slice 1 — real-time-safe audio callback: PROPOSAL

**Date:** 2026-09-24 · **Branch:** `log-reader-flip` @ `290be25` · **Status:** BUILT 2026-09-24 (S0–S8) — see §10; soak awaiting GO (§11).
**Governs:** `docs/strata-to-ethercast-build-spec.md` §4 slice 1 (as amended: harness = slice 0, this = slice 1)
and the Bencina rules quoted there: *no (de)allocation, no mutex locks, no disk I/O, no calls that may
block; preallocate; talk to the callback through lock-free FIFOs.* The source list is
`docs/dsp-inventory.md` §6. The proof is `docs/dsp-parity-harness.md`: goldens at `6bd33e6`, and the
manifest committed in `290be25`.

Line numbers below are at `290be25`. `audio.rs` differs from `b72b8ef` only by the three `pub(crate)`
words, so the inventory's line numbers still hold.

---

## 0 · The shape of the change, in one paragraph

Today the callback shares one `Arc<Mutex<BusState>>` with the command thread, the aux thread and the
10 Hz level poll (`audio.rs:1567-1570`, `:1594`, `:1768`). Every one of them locks it. The callback
`try_lock`s and, on a miss, **outputs silence and pushes nothing to the stream** (`:2279-2282`).

After this slice:
- **The callback owns its state.** An `RtState` holds the decks' ring consumers, the processors, the
  EQs, the duck envelope and the scratch buffers. Nobody else touches it while a stream is running.
- **Everything reaches the callback through lock-free SPSC queues and nothing else.** Commands and
  parameter blocks come in on one queue. Meters and events go out on others. Objects the callback must
  get rid of (an old ring consumer, an old parameter block, an old aux producer) go back on a garbage
  queue and are dropped off-thread.
- **Decoding moves to one worker per deck.** Each worker fills that deck's preallocated ring.

The callback's arithmetic (the sum, the duck, the EQ, the master fader, both processors, the room and aux
chains, the taps) is **moved, not rewritten**. That is what lets the harness hold it to the goldens.

---

## 1 · Decode and file I/O off the audio thread

### Today (receipts)
| What | Where |
|---|---|
| The decoder is a lazy `Box<dyn Iterator<Item=f32>>` (rodio `Decoder` → `UniformSourceIterator` to 2 ch / 44.1k) built from a `BufReader<File>` | `audio.rs:2212-2228` |
| **It is pulled inside the callback**: `src.next()` twice per frame, so symphonia decodes and the BufReader refills from disk on the audio thread | `audio.rs:2394-2396` |
| On natural end the callback **drops the Box** (decoder free + file-handle close) | `audio.rs:2445` |
| `DeckSlot.source` is the storage | `audio.rs:409` |

### Proposed
- **One decode worker per deck slot**, 12 per station (`SLOT_COUNT`, `audio.rs:1034`). Each is a
  `std::thread` parked on a channel while its slot is empty. It owns that slot's decoder, which is
  **the same `build_source`**, so the samples are the same samples in the same order. It writes into an
  SPSC `HeapRb<f32>`, whose producer it holds; the callback holds the consumer. `ringbuf` is already a
  dependency and already carries the program bus (`audio.rs:5`, `:1554`).
  - *Why per deck, not one feeder per station:* a stalled read (a sleeping USB disk, an antivirus scan
    on OV's McAfee box, a large FLAC seek) must starve only its own deck. With one feeder it would
    starve every deck on the station. The price is 12 threads per station, parked on a blocking
    `recv` when idle.
- **Ring size: 2.0 s per deck.** That is 176,400 f32 = 706 KB. × 12 slots = 8.5 MB per station, all
  allocated once when the station's mixer starts, never in the callback.
  - *"Largest buffer plus headroom":* at the program rate, `prog_frames` is at most ~8,822 frames for a
    200 ms WASAPI buffer (`audio.rs:2287-2291`). That is 17,644 samples, so 2 s is ~10× the worst
    single callback.
  - The rest of the ring is the stall budget for the worker. The worker refills when the ring drops
    below 1.5 s and sleeps 20 ms between fills.
  - **All three numbers are surfaced as constants in one place and named in the Health Monitor help.**
    They don't affect how anything sounds, but they are still decisions and should not be hidden.
- **Prefill on Load, off the audio thread.** `Load` already opens and probes the file synchronously on
  the command thread (`audio.rs:1806-1809`). The command thread will also fill the new ring to its
  refill mark (1.5 s) **before** handing the consumer to the callback. So a `Play` that follows a
  `Load` never starts on an empty ring. This costs a few ms of decode on the command thread per load;
  measured in the build.
- **EOF is signalled, not guessed.** When the decoder returns `None`, the worker sets the slot's
  `Arc<AtomicBool> eof` **after** pushing its last sample. The callback treats a deck as finished only
  when *ring empty AND eof*. That is exactly the moment today's `src.next() == None` fires
  (`audio.rs:2430`), so `frames_played` and the finished flag land on the same frame as before.
- **Load / Stop replace a consumer; they never destroy it in the callback.** The command thread sends
  `DeckLoad{slot, consumer, eof, gen}` on the command queue. The callback swaps it in at the top of
  a buffer and pushes the **old** consumer onto the garbage queue. The command thread drops it there,
  and the worker sees its producer's peer gone and parks.
  - The same path replaces the drop at `:2445`: an exhausted consumer goes to the garbage queue, not
    to `drop`.

### Underrun: counted and reported, never silent
A ring can run dry with no `eof`: the worker was starved or the disk stalled. The callback then:
1. **Outputs silence for the missing frames of that deck only.** Every other deck, the duck and the
   processors run normally.
2. **Does not advance `frames_played`** for frames it didn't get (same rule as today, "counted from REAL
   loop iterations", `audio.rs:427-441`). So the position and the daemon's segue maths stay truthful.
3. **Does not raise the finished flag.** An underrun is not an end. Treating it as one would rotate the
   station away from a song that is still playing.
4. **Increments `underruns[slot]` and `underrun_frames[slot]`** (plain counters in `RtState`) and pushes
   `Event::Underrun{slot, frames}` onto the event queue. §3 covers how events reach the log, §6 how the
   counters reach the Health Monitor.

Today the same fault has no signal at all. A slow read simply makes the callback late for the whole
station, and nothing counts it.

---

## 2 · Every allocation in the callback removed

All scratch lives in `RtState`, sized once at station start for `MAX_PROG_FRAMES`. That is the largest
`prog_frames` accepted: a 200 ms device buffer at 8 kHz is the pathological upper bound. Rounded up, it
is **16,384 frames**, a fixed-size `[f32; 16384]` per lane. A callback asking for more is **clamped and
counted** (`Event::BufferTooLarge`), never grown. The table rows are the inventory §6.1 list, re-verified
at `290be25`:

| Line (`audio.rs`) | Today | Becomes |
|---|---|---|
| `2293-2294` | `vec![0; prog_frames]` × 2 (mix) | `rt.mix_l/r[..n].fill(0.0)` |
| `2305-2312` | × 8 (room, imm_room, core, aux) | preallocated lanes, `fill(0.0)` |
| `2322-2323` | × 2 (src) | same |
| `2328-2331` | × 4 (imm, det) | same (16 lanes total) |
| `2578-2579` | `Vec::with_capacity` × 2 + `push` (EQ out) | write into `rt.out_l/r[..n]` |
| `2589` | `mix_*.clone()` on EQ lock miss | gone. The EQ is owned by `RtState`, so there is no lock to miss (§4) |
| `2606-2607` | `.collect()` × 2 when master ≠ 1 | in-place multiply on `out_l/r` (identical arithmetic: `s * master_vol`) |
| `2645-2646` | `out_*.clone()` × 2 per processed branch | `copy_from_slice` into `rt.loc_l/r`, `rt.str_l/r` |
| `2740-2741`, `2750-2751` | room-EQ Vecs × 2 | `rt.room_out_l/r` |
| `2792-2793` | clean-tap clamp `.collect()` × 2 | clamp into `rt.dev_l/r` |
| `2046-2068` | `Vec::with_capacity(SLOT_COUNT)` + 12 `id.to_string()` in `GetLevel` | not the callback, but it holds the lock the callback needs. Moves off the lock entirely (§4) |
| `program_processor.rs:335-336` | `scratch.clear()` + `push` × 2n, capacity 8192 → **grows past 4096 frames** | `ride.update` takes the planar slices directly via `ebur128::add_frames_planar_f32(&[&l, &r])` (the method exists: `ebur128-0.1.10/src/ebur128.rs:698`); the scratch is deleted. **Needs the harness**, see §8. |
| `audio.rs:2445` | `source = None` drops the decoder | consumer → garbage queue (§1) |

**No `Box`, `String`, `format!`, `to_string`, `Vec::push`, `collect` or `clone` of a heap type is left
in `mixer_callback` or anything it calls.** The debug trap in §6 enforces this rather than trusting it.

Third-party code on the path, checked by reading:
- **ebur128 `Mode::M`:** block-energy history only grows under `Mode::I` / `Mode::LRA` (`ebur128.rs:597`,
  `:607`); the processor uses `Mode::M` only (`program_processor.rs:218`).
  - ⚠ **For slice 3:** in `Mode::I` without `HISTOGRAM` that history is a `VecDeque` with max
    `usize::MAX` (`ebur128.rs:300`, `:315`; `history.rs:159-178`). **An integrated meter must not run
    in the callback in that mode**: it would allocate for ever. Noted here so slice 3 doesn't walk into it.
- **rustfft `process` in the EQ analyser** (`eq.rs:166`) uses a preallocated plan and scratch
  (`eq.rs:117`, `:146`). The trap will confirm it.

---

## 3 · No logging, no clock, no `eprintln` in the callback

| Line | Today | Becomes |
|---|---|---|
| `audio.rs:2454` | `eprintln!("[RUST] Deck {} finished …")` | `Event::DeckFinished{slot}` on the event queue. The finished **flag** stays an atomic store (`fin.set`, `:2453`, already lock-free) |
| `audio.rs:1778` → `:20-25` | `SystemTime::now()` stamped every callback for HA liveness | the callback increments an `AtomicU64 callback_seq`. The **command thread** (it already wakes every 50 ms, `:1803`) sees the sequence advance and stamps `SystemTime` there. `audio_last_callback_ms` keeps its meaning, at 50 ms resolution. |
| `audio.rs:2925` | `playing.try_lock()` | `AtomicBool` store |
| cpal error closures `:1780`, `:1693` | `eprintln!` | not the data path; left as they are |

**The event queue** is an SPSC `HeapRb<Event>` of 256 `Copy` events, allocated once. The callback
`try_push`es. If the queue is full, the callback bumps `events_dropped`, itself a reported counter:
losing an event is counted, not silent. The command thread drains it every 50 ms and does the
`eprintln!` there, so the log text stays byte-for-byte what `[RUST] Deck X finished (source exhausted)`
says today. `audiod/daemon-log.js` and anything grepping that line keep working.

---

## 4 · The lock: the callback never contends

### Today
One `SharedBusState` (`audio.rs:753`) is locked by:
- the **callback**, with `try_lock` (`:2279`), where a miss means a **silent buffer and a stream gap**;
- the **command thread** on every command (`:1810-2149`: about 25 sites);
- the **10 Hz `GetLevel`**, which holds it **together with the levels lock** while it allocates 12
  `DeckTel` (`:1971-2071`);
- the **aux thread** installing or removing its producer (`:1612`, `:1626-1628`, `:1700`, `:1709`);
- **device switch** (`:1754-1757`, `:2230-2263`).

Inside that lock the processors, EQs and eq_room have **their own** mutexes, also `try_lock`ed
(`:2577`, `:2648`, `:2739`, `:2759`, `:2829`).

### Proposed: four channels, no shared mutable state

**① Parameters: an immutable block, swapped at the buffer boundary.**
`Params` is a plain `Copy` struct holding every operator-set value the callback reads today:
- per slot: `volume`, `muted`, `kind`, `duck_enabled`, `duck_duckable`, `aux_monitor_gain`,
  `room_gain`, `gain_db`;
- `proc_local/stream`, both branches' target/ceiling/release/rate/clamp/bypass;
- the duck params, `master_vol`, `monitor_vol`, `master_monitor_vol`;
- the 10 EQ band gains.

It is about 1 KB. The command thread keeps the authoritative copy, applies a command to it (with the
same clamps as today, `:1942-1946`, `:2098-2147`), and sends a **`Box<Params>`** on the command queue.
The Box is allocated on the command thread. The callback:
1. at the **top** of a buffer, drains the command queue (bounded at 64 messages per buffer) and keeps
   only the newest `Params`;
2. **runs the whole buffer on that one block**;
3. pushes every superseded Box onto the garbage queue.

**A parameter that arrives mid-buffer waits in the queue and takes effect on the next buffer.** The
callback never reads a half-written block, because it never reads a block that is being written.

Two side effects of adopting a new block, both at the buffer boundary:
- **EQ gains changed:** the callback calls `set_bands` on its own EQs. That is RBJ coefficient maths
  (`eq.rs:214-221`, `:49-60`): trig, no allocation. The same happens today inside the locked `SetEq`.
- **Processor params:** applied by `set_params`/`set_target` every buffer, as today (`:2649-2650`).
  Those are scalar writes (`program_processor.rs:294-316`).

**② Structural changes: messages, not locks.**
`DeckLoad` / `DeckStop` (ring consumer + eof flag), `AuxAttach(HeapProd)` / `AuxDetach`, and
`DeviceRateChanged` travel the same command queue. Whatever they replace goes to the garbage queue.
- The aux thread no longer locks the bus. It sends `AuxAttach` and waits for the old producer to come
  back on garbage.
- The `Play` preconditions that read the bus today (`:1838-1850`: "source is None and path empty") are
  answered from the **command thread's own shadow** of what it loaded, which it has to keep for
  `DeckLoad` anyway.

**③ Meters and telemetry: a lock-free triple buffer, one writer and one reader.**
The callback writes a fixed-size `MeterFrame` at the end of every buffer. It holds:
- today's `peaks[12]`, `master_peak`, `room_peak`, `aux_peak`, `spectrum[10]`, all `proc_*` and
  `proc_stream_*` meters, `aux_proc_*`, `duck_gain`, `frames_consumed`;
- per slot: `frames_played`, `active`, `paused`, `source_present`;
- the §6 counters.

The frame is `Copy`, about 600 bytes. It goes into a triple buffer (three frames plus an atomic index;
~40 lines, no crate), and the callback publishes it with one atomic swap. `GetLevel` reads the latest
frame **without touching anything the callback holds**. It then builds `AudioLevels`, and the
`DeckTel` strings, on its own thread. The 10 Hz poll can no longer delay a buffer.

**④ Ownership through a device switch.**
The `RtState` lives in `Arc<Mutex<RtState>>`, and **only two parties ever lock it**:
- the **running callback**, with `try_lock`;
- the **device-switch path, after the stream has been dropped** (`:2076`, `:2082`: `break` drops
  `stream`, `:2160`), so no callback can be running.

So the mutex is uncontended by construction. It exists so state survives a device switch without
`unsafe`. The callback's `try_lock` keeps its miss branch, which now **counts** `lock_misses` instead of
going silent-and-uncounted. That counter should read 0 for ever, and §6 makes it visible so "should"
is checked.
- Inner mutexes (`processor`, `processor_stream`, `processor_room`, `processor_aux`, `eq`, `eq_room`)
  become plain fields of `RtState`, and their five `try_lock` sites disappear.

**What the harness does with this:** it holds the same `Arc<Mutex<RtState>>`, pushes commands the
same way, and calls the same callback function, single-threaded as now (§7).

---

## 5 · Denormals: FTZ/DAZ on the audio thread

**None is set anywhere today** (inventory §6.5: grep finds no `denormal`/`MXCSR`/`flush_to_zero` in
`native/src`). At the top of every callback, before any float work:
- **x86-64** (OV, and every Windows box): `_mm_setcsr(_mm_getcsr() | 0x8040)` (FTZ bit 15 + DAZ bit 6)
  via `core::arch::x86_64`. The intrinsics are deprecated in favour of inline asm, but they are sound
  and are one line.
- **aarch64** (USPH's Mac if it is Apple Silicon: **unverified which it is**): set FPCR.FZ (bit 24) via
  `core::arch::asm!("msr fpcr, …")`.
- Other targets: no-op.

It is set on **every** callback, not once, because MXCSR is per thread and a device reopen gives cpal a
new thread (`audio.rs:1743-1799`). The cost is two register moves. The **aux callback** (`:1650`) gets
the same line; its underrun decay `cur * 0.5` (`:1678`) is a textbook denormal generator.

**This is the one change that is expected not to be bit-exact** (§8).

---

## 6 · Debug allocation trap + health counters

**The trap.** Behind a Cargo feature `rt_trap`, on in `cargo test` and in debug builds, **off in the
shipped release** so a trap can never take a station off air:
- a `#[global_allocator]` wrapper around `System`;
- a `thread_local! IN_RT: Cell<bool>` that the callback sets on entry and clears on exit;
- any `alloc`/`dealloc`/`realloc` while it is set increments `RT_ALLOCS` (an atomic) and, under
  `cfg(test)`, **panics** with a backtrace.

So every harness render and every golden test becomes an allocation test of the real callback. A Vec
that creeps back in fails `npm run test:rust` on the first buffer.
- ⚠ A `#[global_allocator]` in a `cdylib` covers only this crate's own allocations. That is exactly
  the scope we want; Node's heap is untouched.

**The counters**, per station, in `RtState`, published in every `MeterFrame`:

| Counter | Meaning | Expected |
|---|---|---|
| `underruns` / `underrun_frames` (per slot) | ring dry with no EOF (§1) | 0 on a healthy disk |
| `lock_misses` | the callback's `try_lock` on its own state missed (§4 ④) | **0 by construction** |
| `overruns` | the gap between consecutive callbacks was more than 1.5× the buffer duration | 0 on a healthy box |
| `events_dropped` | the event queue was full (§3) | 0 |
| `buffer_clamped` | the device asked for more than `MAX_PROG_FRAMES` (§2) | 0 |
| `rt_allocs` | debug trap count (debug builds only; the field reads `null` in release rather than a fake 0) | 0 |

**Overrun without a clock call.** cpal passes `OutputCallbackInfo` into the callback, carrying an
`OutputStreamTimestamp { callback, playback }` (`cpal-0.15.3/src/lib.rs:354`, `:496`). The closure
ignores it today (`audio.rs:1775`, `|data, _|`). Comparing consecutive `callback` instants against
`device_frames / sr` detects a late callback. cpal already made that clock read; we call nothing.

**How they reach the Health Monitor: the "sense" ships with the slice.**
1. `AudioLevels` gains the counters; `lib.rs`'s hand-built `json!` names every one of them.
   `audiod/smoke-meter-contract.js` fails the build if one is missing. That smoke exists because this
   exact omission happened twice (`lib.rs` comment at `audio_get_levels`).
2. The daemon's `[mix sN]` heartbeat (`audiod/engine.js:192-205`) appends
   `rt: ur=… ov=… lm=… ev=…` **as deltas**. A **health event** goes to the ledger when any delta is
   non-zero, the same pattern as the processing records
   (`docs/processing-meters-and-records-2026-08-19.md:75-96`).
3. **Health Monitor: one row, "Audio engine".** It shows underruns, overruns and lock misses since
   start, and turns amber on a non-zero delta. There is a line in `docs/help-health-monitor.md`.
   **This is a UI change and the one place this slice leaves `native/`.** §9 Q4 asks whether it ships
   in slice 1 or as slice 1b.

---

## 7 · Blast radius

| File | Change | Covered by |
|---|---|---|
| `native/src/audio.rs` | **Large.** `BusState` splits into `RtState` (callback-owned) + `Params` + the command-thread shadow. `mixer_callback` reads lanes/params/rings instead of `bus.*`; commands become queue sends; `GetLevel` reads the triple buffer; the aux thread sends messages; `restore_decks_after_switch` re-seeds workers; FTZ; the liveness stamp moves | harness + the 3 mixer goldens + `duck_regression` |
| `native/src/rt/` (new) | `ring_deck.rs` (worker + ring + eof), `triple.rs` (meter triple buffer), `queue.rs` (command/event/garbage message types), `trap.rs` (allocator + counters), `fpu.rs` (FTZ/DAZ) | their own unit tests (below) |
| `native/src/program_processor.rs` | `process_planar` feeds ebur128 planar; the `scratch` field goes | harness (+ C1–C7) |
| `native/src/eq.rs` | none expected. `EqChain` is already allocation-free per sample; ownership moves, the code doesn't | harness EQ config |
| `native/src/offline_render.rs` | drives the new API; a **synchronous pump** (below) | itself |
| `native/src/lib.rs` | `json!` gains the counters; `audio_last_callback_ms` reads the command-thread stamp | `smoke-meter-contract` |
| `audiod/engine.js` | `[mix]` heartbeat deltas + health event | `smoke-meter-contract`, a new small smoke |
| Health Monitor UI + `docs/help-health-monitor.md` | one row (Q4) | tsc + a screenshot receipt |

**Monitor, stream and aux: all three change**, because all three are fed from the same callback and its
state moves. The DSP code on each path is moved, not rewritten.

| Path | Covered today by | Gap |
|---|---|---|
| Air → stream tap | harness (74 taps) | — |
| Air → monitor tap (dl/dr, 44.1k device) | harness | — |
| Monitor **resample** to a non-44.1k device (`:2903-2923`) | **nothing** | harness always runs the device at 44.1k |
| Monitor `mvol` stage | **nothing** | harness pins mvol = 1 |
| Room chain (aux deck live) | `GOLDEN_ROOM` (synthetic PRNG, 8 buffers) | no real audio, no processing on |
| Aux monitor ring | `GOLDEN_AUX_SINGLE_PASS` (synthetic, 50 buffers) | no real audio |
| Ducker | `duck_regression` (constant tones) | no real audio |
| Block-size dependence | **nothing** | harness is fixed at 480 frames; real WASAPI buffers vary |

**So Step 0 of the build extends the goldens at the CURRENT code, before any refactor**, and commits
them. The harness is the proof only for paths it has captured. New renders at `290be25` code:
- **`device_rate: 48000`**, taking the device buffer post-resample, with `monitor_vol = 0.7` so `mvol`
  is exercised: music + sweep, LINKED.
- **`block_frames: 1024` and `441`** (odd, and not a divisor): music, LINKED. The ride evaluates per
  `update` call, so results depend on block size, and each size gets its own golden.
- **An aux deck (D) playing `speech` over `music` on A, with the duck armed and processing on**:
  captures room, aux ring, duck and ride-hold on real audio.

That adds about 8 renders.

**The ring and the decode worker need their own test,** because the harness is single-threaded (the
brief's point):
1. **The harness uses a synchronous pump.** Before each callback, `render_offline` calls the worker's
   own `fill_until(high_mark)` inline, the same function the thread runs. The ring can never be dry
   when read, so the render stays deterministic and still goes *through the ring*.
2. **`ring_delivers_the_direct_decode`, threaded.** A real worker thread decodes `music.wav` into a
   2 s ring, while a consumer thread drains it in random-sized chunks (seeded PRNG, 1–9,000 frames) with
   random sleeps. The concatenated output must be **bit-identical** to draining `build_source` directly,
   and underruns must be 0 when the consumer is paced at realtime. Run 20×.
3. **`underrun_is_counted_not_silent`.** A source that blocks for 500 ms mid-file. The callback must
   emit silence for exactly that deck, increment `underruns`, not advance `frames_played`, not raise
   finished, and resume where it left off.
4. **`eof_lands_on_the_same_frame`.** For each corpus file, the frame on which the finished flag rises
   equals today's frame (it is recorded in the Step 0 goldens as `frames`).
5. **`param_swap_is_buffer_atomic`.** A `Params` sent between two callbacks takes effect on exactly the
   next buffer and never partway through one. The test sends 1,000 alternating master-fader blocks and
   checks every output buffer is scaled uniformly.

---

## 8 · Identical by construction vs needs the harness

**Identical by construction**, where the argument is the code itself, and the harness still confirms it:
- **Decode off-thread.** Same `build_source`, same iterator, same sample order. The ring is a FIFO of
  the exact f32s the callback used to pull. (Harness + test 2 above.)
- **Scratch instead of `vec!`.** Same values in, same operations in the same order. A zeroed
  preallocated lane is bit-identical to a fresh `vec![0.0; n]`.
- **In-place master multiply** (`:2606`): `s * master_vol` either way.
- **Removing `eprintln`/`SystemTime`/`playing.try_lock`:** no sample touches them.
- **The lock redesign.** In a single-threaded render there are no misses today, so the callback's
  arithmetic is unchanged. The runtime difference, no more silent buffers on contention, **cannot be
  seen by the harness at all.** It is seen by the `lock_misses` counter at 0 and by the soak.

**Needs the harness to prove it** (it could move bits):
1. **FTZ/DAZ.** It flushes subnormals, values below 1.18e-38, to zero. Any golden sample that passed
   through a subnormal intermediate (EQ biquad tails, limiter delay-line decay, the oversampler history
   near silence) can change **in the last bits**. **Expect bit-exactness to break, and the 1e-6 null bar
   (−120 dBFS) to hold with ~30 orders of magnitude to spare.** It ships as **its own commit**, with
   the harness report showing exactly which taps stopped being bit-exact.
   ⚠ Jeff's call (Q3): after FTZ, **re-capture** the goldens as the new bit-exact baseline, or keep
   `6bd33e6` and live with "≤ 1e-6" from here on.
2. **Planar ebur128 feed.** `add_frames_planar_f32` vs interleaved `add_frames_f32` should do the same
   arithmetic per channel. That is **not verified**. If the harness shows any difference, the scratch
   stays, preallocated to `MAX_PROG_FRAMES` instead of growing.
3. **Any reorder of float operations** made while moving code into lanes. The rule for the build is
   **no reorder**, and the harness enforces it bit-exactly.

**Needs a runtime receipt; neither the harness nor any static argument can give it:**
- underruns, overruns and lock misses at 0 on a real device;
- device failover still restores;
- the spec's **8 h soak at the smallest buffer size, while loading tracks and moving sliders: zero
  xruns, no clicks.**
  - cpal is opened with `BufferSize::Default` today (`audio.rs:1765`); there is no way to ask for the
    smallest buffer. §9 Q5.

### Build order (each step is its own commit and must null before the next)
- **S0.** Extend goldens at current code (§7). Commit.
- **S1.** Scratch lanes + `MAX_PROG_FRAMES` (§2) → **bit-exact**
- **S2.** Events + liveness counter + atomics (§3) → **bit-exact**
- **S3.** `RtState` ownership, `Params` block, command/garbage queues, triple-buffer meters (§4) → **bit-exact**
- **S4.** Decode workers + rings + synchronous pump; tests 2–5 (§1, §7) → **bit-exact**
- **S5.** Planar ebur128 (§2) → **bit-exact, or revert to a preallocated scratch**
- **S6.** Allocation trap + counters + `json!` + daemon heartbeat (§6) → **bit-exact**; trap = 0 allocations across all renders
- **S7.** FTZ/DAZ (§5) → **≤ 1e-6; report which taps lost bit-exactness**
- **S8.** Health Monitor row + help (if Q4 = in slice)
- Then rebuild the `.node`, run the NAPI determinism run, smokes, vitest and tsc. **Stop. No install.**
  The soak is a separate, off-air step (Q5).

---

## 9 · Decisions for Jeff

1. **Ring size:** 2.0 s per deck, refill below 1.5 s, worker cadence 20 ms. That is 8.5 MB per
   station. OK, or another number?
2. **Worker model:** per deck (isolation, 12 parked threads per station) as briefed, or one feeder per
   station (fewer threads, one slow file stalls every deck)? I recommend per deck.
3. **After FTZ:** re-capture the goldens as the new bit-exact baseline, or keep `6bd33e6` and hold
   ≤ 1e-6 from then on? I recommend re-capture, with the S7 report as the receipt for why.
4. **Health Monitor row:** in this slice (S8), or slice 1b? The house rule says the sense ships with the
   feature. I recommend S8.
5. **The 8 h soak:** it needs a way to open the smallest device buffer, and cpal only uses
   `BufferSize::Default` today (`audio.rs:1765`). Options:
   - a dev-only env var like the existing `ETHER_POSITION_WALL_FORCE` (`audiod/engine.js:56`);
   - an operator setting.

   Also: which box runs it, off air? This box isn't a station, but it isn't OV either.

## What this slice deliberately does NOT do
- No DSP change: no new meter, no rack, no change to the ride or limiter maths.
- No change to what the daemon *decides* (segues, jingles, the log reader). Only the heartbeat text
  gains counters.
- The drain thread (`audio.rs:2929-3111`), which is not the audio callback, is untouched. Its
  allocation-free passthrough and its delay FIFO are separate work. So is the per-station
  **device-switch restarts the track** behaviour (`audio.rs:2230-2263`), which is kept exactly as it is.

---

## 10 · Build report (2026-09-24) — S0–S8 built, soak NOT run (awaiting Jeff's GO)

**Status:** BUILT. Local commits on `log-reader-flip`; no push, no tag, no installer.

| Step | Commit(s) | Receipt |
|---|---|---|
| S0 goldens extended at current code | `b2c8b6d`, `9c7d3a8` | +6 renders: 1024/441-frame blocks, 48 kHz device + monitor 0.7, aux deck D (speech) + duck over music, processing on/off; aux ring as a 3rd tap. Two commits because capture refuses a dirty `native/src`. |
| S1 scratch lanes | `0e8614d` | 43/43 bit-exact |
| S2 events + liveness counter | `99d0f2c` | 43/43 bit-exact |
| S3 callback owns state; Params / RtCmd / garbage / triple buffer | `e45f077` | 43/43 bit-exact; `commands_through_the_queue_reproduce_the_slice1_golden`; `a_param_block_never_changes_mid_buffer` (1 000 buffers uniform under a 20 000-block barrage); `triple_buffer_…never_a_torn_one` |
| proposal doc | `32d5479` | — |
| S4 decode workers + 2 s rings | `9069c9c` | 43/43 bit-exact **incl. frame counts** (EOF lands on the same frame); `threaded_ring_delivers_the_direct_decode` (real worker thread, 20 runs × 14 376 028 samples, bit-identical); `underrun_is_silence_counted_and_reported_and_never_an_ending`; `eof_is_an_ending_and_is_not_counted_as_an_underrun` |
| S5 planar ebur128 feed | `61b63dc` | 43/43 bit-exact |
| S6 trap + counters + wire + heartbeat + ledger | `e2cd53b` | **0 allocations inside the callback across all 43 renders**; trap proven live (2 counted for one Vec inside scope, 0 outside); contract smoke ALL PASS (54 keys) |
| S7 FTZ/DAZ | `7896e92`, goldens `cd8862d` | FTZ proven (subnormal → 0 inside, restored after). **Ruling 3 report: ZERO taps changed** — 43/43 still bit-exact, max Δ 0. Re-captured at `7896e92`; the old manifest is kept as `native/goldens/manifest-6bd33e6.json`; 88/88 taps identical between them. |
| S8 Health Monitor row + help | `a3917cd` | tsc 0 errors. **Rendered row UNVERIFIED** — check: open the Health Monitor, look for "audio engine · underruns 0 · overruns 0 · lock misses 0" under each station. |
| soak switch | `c99baef` | `ETHER_SOAK_BUFFER_FRAMES` (dev-only, ruling 5) |

### The underrun receipt (Jeff's condition)
- **Silence for that deck only, counted, reported:** `underrun_is_silence_counted_and_reported_and_never_an_ending`
  asserts 280 silent frames on the starved deck, `underruns = 1`, `underrun_frames = 280`, and one
  `RtEvent::Underrun { slot: 0, frames: 280 }`. The dispatch thread logs it as
  "UNDERRUN … position held, track NOT ended". The Health Monitor line turns amber, and an `audio-rt` line
  goes to the ledger.
- **No advance:** `frames_played` stays at 200 (the real frames), and playback resumes at the next sample
  (400 × 1e-6) when the worker catches up.
- **No state change:** the finished flag is not raised, the source is kept, the deck stays active and
  unpaused, and `src_gen` is unchanged. The published meter frame says the same.
- **No play_log row, and nothing reads it as an ending** (static; the soak is the runtime check):
  - the daemon treats a track as ended only on `status === "ended"` (`audiod/engine.js:609-611`);
  - that status comes only from the finished flag (`native/src/lib.rs:281-294`);
  - `play_log` rows are written only in `_fireStart`, i.e. when a deck goes live (`audiod/engine.js:1728`);
  - the daemon's position stays on the sample clock unless it reads exactly 0 past 1 s (`engine.js:259`),
    and an underrun freezes `frames_played` at its last non-zero value, so no early segue is triggered.
- **A real end of file is not an underrun:** `eof_is_an_ending_and_is_not_counted_as_an_underrun`.

### Deviations from the proposal, stated
- **The inner EQ/processor mutexes stay** (§4 had proposed plain fields). Since S3 only the callback locks
  them, so they are uncontended by construction, and every miss branch now counts into `lock_misses`
  (expected 0). This means less churn in the arithmetic S1–S5 had to keep bit-exact.
- **`npm run test:rust` changed twice:**
  - the processor timing benches run in a separate single-threaded pass (C3 failed once only under
    parallel harness load);
  - the harness pass runs with `--test-threads=2` (a fully parallel run was reaped for low memory).
- **An allocation the inventory did not list:** `rustfft`'s `process()` allocates its scratch on every call
  (`rustfft-6/src/lib.rs:196`), every 1024 samples, in the EQ analyser. S6 fixed it. The count before the
  fix was never measured; the zero after it was.
- **`MAX_PROG_FRAMES` is 32 768 frames** (743 ms at 44.1 kHz), not the proposed 16 384, so there is no
  doubt for large device periods. It costs 26 lanes × 128 KB ≈ 3.4 MB per opened device. A larger request
  is counted in `buffer_clamped` only; the proposed `Event::BufferTooLarge` was not built, because the
  counter already reaches the Health Monitor.
- **A test bug of mine, fixed in S5:** the parameter-barrage test could leave its sender spinning on a full
  queue once the render loop stopped, which hung the first S5 run.

### Gates at `c99baef`
| Gate | Result |
|---|---|
| `npm run test:rust` | 25 + 7 passed, 0 failed (1 ignored = explicit capture) |
| No-audio smokes (19) + `smoke-logreader-anchor` | 18/19 + 18 pass. **`smoke-topofhour` FAILS — pre-existing** (it fails identically on `b72b8ef`; nothing it reads changed). ⚠ `smoke-orphan`, `smoke-shutdown` and `accept-fallback` spawn the daemon with the **tracked** `native/ether-audio.node`, so they exercised the old engine, not this one. |
| vitest | 32 files, 430 tests passed |
| `check:audio-isolation` | passed |
| `tsc --noEmit` | 0 errors |
| NAPI determinism on the rebuilt `.node` | two fresh processes, **43/43 bit-exact** each |

**Rebuilt `.node`:** `native/target/release/ether-audio.node`, SHA-256
`6738e4f8b6135255bcbf366e0a2253cb4a5b520173dac1dd465d9650ef6b38b1`, 4 503 040 bytes, built
2026-09-24 12:11:42 −0700 from `c99baef`. The **tracked** `native/ether-audio.node` is untouched
(`4876be7964cd7a8239c8c845cf7fd6981515ad656878702e6a5c896f66f4aa8c`).

### Architecture compliance
- **Spec §4 rule 1 (no new DSP until the callback is safe):** no DSP was added. The only arithmetic-adjacent
  change is FTZ, which changed zero samples.
- **Rule 2 (every change proven against a golden):** every step nulled against the goldens, bit-exact.
- **Bencina rules:**
  - no allocation in the callback (trap: 0);
  - no contended lock (all channels are lock-free; the remaining try_locks are uncontended and counted);
  - no disk I/O (decode on workers);
  - no logging and no clock reads (events queue; cpal timestamps).
- **BUILD THE SENSE:** the counters flow to the heartbeat, the ledger and the Health Monitor in this slice.
  No temporary watcher was created. The soak script is a manual, one-shot test tool, not persistence.

## 11 · Soak instructions (NOT started — Jeff's GO)

The soak runs the slice-1 engine in an **isolated daemon** against a copy of the DB. It uses AUTO with the
station's own catalogue, so tracks load continuously, and it moves the GEQ and deck C's fader the whole
time. It **plays through this machine's output device** (monitor at 0.01).

1. **Close any running Ether** on this box, and make sure no daemon is running.
2. **Swap the slice-1 addon in** (the daemon loads `native/ether-audio.node`, `audiod/ether-audiod.js:140`).
   This is a working-tree change to a tracked file, for the duration of the soak only:
   ```
   cd C:\openair\native
   copy ether-audio.node ether-audio.node.bak-pre-slice1-soak
   copy target\release\ether-audio.node ether-audio.node
   ```
3. **Run** (1 hour at the smallest buffer; `--minutes 480` for the 8 h Jeff may call later):
   ```
   cd C:\openair
   node scripts/soak-rt-callback.js --minutes 60 --buffer min --station 1
   ```
   - It prints the counters every minute, then a RESULT block. PASS means zero underruns, zero overruns
     and zero lock misses, with tracks loaded.
   - It refuses to run if the engine doesn't report `rt_callbacks`, i.e. the swap didn't happen.
   - ⚠ UNVERIFIED: whether WASAPI shared mode accepts a fixed buffer. The daemon log prints
     `SOAK: fixed device buffer N frames`. If it prints `build_output_stream … retrying` instead, rerun
     with `--buffer 480` (or the device default by omitting the env var) and record which size ran.
4. **Restore the tracked addon and verify:**
   ```
   cd C:\openair\native
   copy ether-audio.node.bak-pre-slice1-soak ether-audio.node
   certutil -hashfile ether-audio.node SHA256     (must print 4876be79…4aa8c)
   del ether-audio.node.bak-pre-slice1-soak
   ```
5. The daemon log path is printed at the start. Its `[mix sN] … | rt ur=+Δ ov=+Δ lm=+Δ ev=+Δ` lines and any
   `UNDERRUN` lines are the per-5-second record.
