// native/src/rt.rs — SLICE 1 S3: how the audio callback talks to everything else without sharing a lock.
// docs/dsp-rt-callback.md §4.
//
// The callback owns the station's mixer state (BusState). Nothing else touches it while a stream is running.
// Everything crosses the boundary through lock-free SPSC channels:
//
//   dispatch thread ──RtCmd──────▶ callback     parameter blocks + deck transport (Load/Play/Pause/Stop)
//   aux thread      ──AuxCmd─────▶ callback     attach / detach the aux monitor ring
//   callback        ──Garbage────▶ dispatch     anything the callback replaced, to be FREED off the audio thread
//   callback        ──MeterFrame─▶ dispatch     meters + telemetry, via a triple buffer (latest wins, never blocks)
//   callback        ──RtShared───▶ dispatch     a few atomics: how many commands it has applied, which decks hold a source
//
// Rule of the file: nothing the callback touches here allocates, frees, locks, logs or reads a clock.

use std::cell::UnsafeCell;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use crate::audio::{SlotKind, SLOT_COUNT};

/// Commands one device-open can have in flight to the callback. The dispatch thread keeps an ordered
/// overflow queue of its own, so a full ring delays a command; it never drops one.
pub(crate) const RT_CMD_QUEUE: usize = 256;
/// The callback applies at most this many commands per buffer, so a burst cannot make one buffer late.
pub(crate) const RT_CMD_PER_BUFFER: usize = 64;
/// Objects waiting to be freed off the audio thread. Sized well past (RT_CMD_PER_BUFFER × buffers per 50 ms
/// drain). If it is ever full, the object is LEAKED and counted — never freed on the audio thread.
pub(crate) const RT_GARBAGE_QUEUE: usize = 1024;

/// Every operator-set value the callback reads — one immutable block. The dispatch thread owns the
/// authoritative copy, applies a command to it (with the same clamps as always), and sends a boxed copy.
/// The callback adopts the newest block at the TOP of a buffer and runs the whole buffer on it: a block that
/// arrives mid-buffer waits for the next buffer. It never reads a block that is being written.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Params {
    pub volume: [f32; SLOT_COUNT],
    pub muted: [bool; SLOT_COUNT],
    pub kind: [SlotKind; SLOT_COUNT],
    pub duck_enabled: [bool; SLOT_COUNT],
    pub duck_duckable: [bool; SLOT_COUNT],
    pub aux_monitor_gain: [f32; SLOT_COUNT],
    pub room_gain: [f32; SLOT_COUNT],
    pub monitor_vol: f32,
    pub master_vol: f32,
    pub master_monitor_vol: f32,
    pub proc_local: bool,
    pub proc_stream: bool,
    pub proc_target_lufs: f32,
    pub proc_ceiling_dbtp: f32,
    pub proc_release_ms: f32,
    pub proc_ride_rate: f32,
    pub proc_ride_clamp: f32,
    pub proc_ride_bypass: bool,
    pub proc_limiter_bypass: bool,
    pub proc_stream_target_lufs: f32,
    pub proc_stream_ceiling_dbtp: f32,
    pub proc_stream_release_ms: f32,
    pub proc_stream_ride_rate: f32,
    pub proc_stream_ride_clamp: f32,
    pub proc_stream_ride_bypass: bool,
    pub proc_stream_limiter_bypass: bool,
    pub duck_threshold: f32,
    pub duck_depth_db: f32,
    pub duck_attack_ms: f32,
    pub duck_hold_ms: f32,
    pub duck_release_ms: f32,
    /// Master GEQ band gains. Applied to both EQs (air + room) only when eq_version changes, exactly as
    /// SetEq applied them — set_bands recomputes coefficients and never touches filter state (eq.rs).
    pub eq_bands: [f32; 10],
    pub eq_version: u64,
}

/// A deck source — the decoder iterator the mixer pulls (S4 replaces it with a ring).
pub(crate) type DeckSource = Box<dyn Iterator<Item = f32> + Send>;

/// Dispatch thread → callback. Applied in order at the top of a buffer.
pub(crate) enum RtCmd {
    Params(Box<Params>),
    /// `src` None = the file would not open/decode: the deck is emptied, exactly as a failed Load always did.
    Load { slot: u8, src: Option<DeckSource>, gain_db: f32, gen: u64 },
    /// `reload` = a fresh decoder for a deck whose source had gone (Stop/natural end) but whose path is known.
    Play { slot: u8, reload: Option<DeckSource>, gen: u64 },
    Pause { slot: u8 },
    Stop { slot: u8 },
}

/// Aux thread → callback.
pub(crate) enum AuxCmd {
    Attach(ringbuf::HeapProd<f32>),
    Detach,
}

/// Callback → dispatch: things to FREE off the audio thread.
pub(crate) enum Garbage {
    Source(DeckSource),
    Params(Box<Params>),
    AuxProd(ringbuf::HeapProd<f32>),
}

/// Per-slot telemetry in a meter frame.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct DeckMeter {
    pub source_present: bool,
    pub active: bool,
    pub paused: bool,
    pub gain_db: f32,
    pub frames_played: u64,
}

/// One buffer's observed state, published by the callback at the end of every buffer. Everything GetLevel
/// used to read out of BusState under the lock — now read from here, without touching anything the
/// callback holds. `params` is the block the callback actually RAN, so the panel echoes the engine.
#[derive(Clone, Copy, Debug)]
pub(crate) struct MeterFrame {
    pub params: Params,
    pub peaks: [f32; SLOT_COUNT],
    pub master_peak: f32,
    pub room_peak: f32,
    pub aux_peak: f32,
    pub spectrum: [f32; 10],
    pub frames_consumed: u64,
    pub duck_gain: f32,
    pub aux_proc_in_lufs: f32, pub aux_proc_out_lufs: f32, pub aux_proc_gr_db: f32, pub aux_proc_ride_db: f32,
    pub proc_in_lufs: f32, pub proc_out_lufs: f32, pub proc_gr_db: f32, pub proc_ride_gain_db: f32,
    pub proc_in_peak: f32, pub proc_out_peak: f32,
    pub proc_stream_in_lufs: f32, pub proc_stream_out_lufs: f32, pub proc_stream_gr_db: f32,
    pub proc_stream_ride_gain_db: f32, pub proc_stream_in_peak: f32, pub proc_stream_out_peak: f32,
    pub decks: [DeckMeter; SLOT_COUNT],
}

/// Atomics the dispatch thread reads to answer "does deck N hold a source right now" without a lock.
pub(crate) struct RtShared {
    /// Commands applied by the callback since the station started (FIFO ⇒ command #k is applied iff this ≥ k).
    pub applied_seq: AtomicU64,
    /// Generation of the source each slot currently holds; 0 = none. Written by the callback (and by the
    /// device-switch path while no callback runs).
    pub src_gen: [AtomicU64; SLOT_COUNT],
}
impl RtShared {
    pub fn new() -> Arc<RtShared> {
        Arc::new(RtShared { applied_seq: AtomicU64::new(0), src_gen: std::array::from_fn(|_| AtomicU64::new(0)) })
    }
}

// ── Triple buffer: one writer (the callback), one reader (the dispatch thread) ─────────────────────────
// Three slots. The writer always owns one, the reader owns one, one is "shared". Publishing is one atomic
// swap of the writer's slot into the shared position (with a FRESH bit); reading swaps the reader's slot
// out if the shared one is fresh. Neither side ever waits for the other, and the reader always gets the
// newest complete frame. ~The standard algorithm; no crate.
const FRESH: u8 = 0b100;
struct TripleInner<T> {
    slots: [UnsafeCell<T>; 3],
    shared: AtomicU8,   // index of the shared slot | FRESH
}
// SAFETY: each slot is accessed by exactly one side at a time; ownership moves only through `shared`.
unsafe impl<T: Send> Sync for TripleInner<T> {}
unsafe impl<T: Send> Send for TripleInner<T> {}

pub(crate) struct TripleWriter<T> { inner: Arc<TripleInner<T>>, mine: u8 }
pub(crate) struct TripleReader<T> { inner: Arc<TripleInner<T>>, mine: u8 }

pub(crate) fn triple<T: Copy>(init: T) -> (TripleWriter<T>, TripleReader<T>) {
    let inner = Arc::new(TripleInner {
        slots: [UnsafeCell::new(init), UnsafeCell::new(init), UnsafeCell::new(init)],
        shared: AtomicU8::new(1),
    });
    (TripleWriter { inner: inner.clone(), mine: 0 }, TripleReader { inner, mine: 2 })
}
impl<T: Copy> TripleWriter<T> {
    /// The writer's private slot — fill it, then publish().
    pub fn slot(&mut self) -> &mut T {
        // SAFETY: slot `mine` is owned by the writer until publish() hands it over.
        unsafe { &mut *self.inner.slots[self.mine as usize].get() }
    }
    pub fn publish(&mut self) {
        let prev = self.inner.shared.swap(self.mine | FRESH, Ordering::AcqRel);
        self.mine = prev & 0b11;
    }
}
impl<T: Copy> TripleReader<T> {
    /// The newest published value (or the previous one again if nothing new was published).
    pub fn read(&mut self) -> T {
        if self.inner.shared.load(Ordering::Acquire) & FRESH != 0 {
            let prev = self.inner.shared.swap(self.mine, Ordering::AcqRel);
            self.mine = prev & 0b11;
        }
        // SAFETY: slot `mine` is owned by the reader until the next swap above.
        unsafe { *self.inner.slots[self.mine as usize].get() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn triple_buffer_reader_sees_newest_complete_value_and_never_a_torn_one() {
        // Writer publishes [n; 64] for n = 1..=200_000 on one thread; reader on another must only ever see
        // arrays whose 64 entries are all equal (no torn frame) and never go backwards.
        let (mut w, mut r) = triple([0u64; 64]);
        let t = std::thread::spawn(move || {
            for n in 1..=200_000u64 { *w.slot() = [n; 64]; w.publish(); }
        });
        let mut last = 0u64;
        let mut reads = 0u64;
        loop {
            let v = r.read();
            assert!(v.iter().all(|&x| x == v[0]), "torn frame: {:?}", &v[..4]);
            assert!(v[0] >= last, "went backwards {} -> {}", last, v[0]);
            last = v[0];
            reads += 1;
            if last == 200_000 { break; }
            if t.is_finished() && r.read()[0] == 200_000 { last = 200_000; break; }
        }
        t.join().unwrap();
        println!("[triple] {} reads, final value {}", reads, last);
        assert_eq!(last, 200_000);
    }
}
