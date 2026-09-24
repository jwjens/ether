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
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
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

/// A decoder — the iterator build_source returns (rodio Decoder → 2 ch / 44.1 kHz). S4: it lives on a
/// DECODE WORKER, never in the callback.
pub(crate) type DeckSource = Box<dyn Iterator<Item = f32> + Send>;

// ── SLICE 1 S4 — decode off the audio thread (docs/dsp-rt-callback.md §1) ────────────────────────────
//
// One worker thread per deck slot owns that deck's decoder and keeps a preallocated SPSC ring topped up.
// The callback only ever pops the ring. Three numbers, in one place (Jeff's ruling 1: 2 s per deck):

/// Ring capacity per deck: 2.0 s of 44.1 kHz stereo (176 400 f32 = 706 KB).
pub(crate) const DECK_RING_SAMPLES: usize = 44_100 * 2 * 2;
/// The worker refills when the ring holds less than this: 1.5 s.
pub(crate) const DECK_REFILL_BELOW: usize = 44_100 * 2 * 3 / 2;
/// How often an idle-but-loaded worker checks its ring.
pub(crate) const DECK_WORKER_TICK_MS: u64 = 20;
/// Samples decoded per push. EVEN, so the ring's fill is always a whole number of stereo frames.
const FEED_CHUNK: usize = 4096;

/// The callback's end of a deck: the ring it pops, and the worker's end-of-file flag.
pub(crate) struct DeckFeed {
    pub cons: ringbuf::HeapCons<f32>,
    /// Set by the worker AFTER it has pushed the last sample. Ring empty + eof = the track ended.
    /// Ring empty + !eof = an UNDERRUN: the worker is late. The two are never confused.
    pub eof: Arc<AtomicBool>,
    cancel: Arc<AtomicBool>,
}
impl Drop for DeckFeed {
    /// A replaced or stopped feed is dropped on the dispatch thread (it travels there as Garbage); this
    /// tells its worker to stop decoding and free the file.
    fn drop(&mut self) { self.cancel.store(true, Ordering::Release); }
}

/// The worker's end of a deck: the decoder and the ring's producer.
pub(crate) struct Feeder {
    src: DeckSource,
    prod: ringbuf::HeapProd<f32>,
    eof: Arc<AtomicBool>,
    cancel: Arc<AtomicBool>,
    pushed: u64,
    chunk: Vec<f32>,
}
impl Feeder {
    /// Decode until the ring holds at least `target` samples or the file ends. Returns true once at EOF.
    /// This is THE fill routine: the worker thread runs it, the dispatch thread runs it to prefill on Load,
    /// and the offline harness runs it inline before every buffer (the synchronous pump) — one code path.
    pub fn fill(&mut self, target: usize) -> bool {
        use ringbuf::traits::{Observer, Producer};
        if self.eof.load(Ordering::Relaxed) { return true; }
        let target = target.min(self.prod.capacity().get());
        while self.prod.occupied_len() < target {
            // Whole stereo frames only (room rounded down to even), and never past the target.
            let room = (self.prod.vacant_len().min(FEED_CHUNK).min(target - self.prod.occupied_len())) & !1;
            if room == 0 { break; }
            self.chunk.clear();
            let mut ended = false;
            while self.chunk.len() < room {
                match self.src.next() { Some(x) => self.chunk.push(x), None => { ended = true; break; } }
            }
            if ended && self.chunk.len() % 2 == 1 {
                // The old callback read r = src.next().unwrap_or(0.0): a lone final sample got a 0.0 partner.
                // Same here, so the last frame is bit-identical.
                self.chunk.push(0.0);
            }
            let n = self.prod.push_slice(&self.chunk);
            self.pushed += n as u64;
            debug_assert_eq!(n, self.chunk.len());
            if ended {
                // Release: every sample above is visible to a callback that Acquires this flag.
                self.eof.store(true, Ordering::Release);
                return true;
            }
        }
        false
    }
    pub fn cancelled(&self) -> bool { self.cancel.load(Ordering::Acquire) }
    pub fn at_eof(&self) -> bool { self.eof.load(Ordering::Relaxed) }
}

/// Wrap a decoder in a deck ring of `capacity` samples: (callback end, worker end).
pub(crate) fn deck_feed_with_capacity(src: DeckSource, capacity: usize) -> (DeckFeed, Feeder) {
    use ringbuf::traits::Split;
    let (prod, cons) = ringbuf::HeapRb::<f32>::new(capacity).split();
    let eof = Arc::new(AtomicBool::new(false));
    let cancel = Arc::new(AtomicBool::new(false));
    (DeckFeed { cons, eof: eof.clone(), cancel: cancel.clone() },
     Feeder { src, prod, eof, cancel, pushed: 0, chunk: Vec::with_capacity(FEED_CHUNK) })
}
/// A deck ring of the station size (DECK_RING_SAMPLES).
pub(crate) fn deck_feed(src: DeckSource) -> (DeckFeed, Feeder) { deck_feed_with_capacity(src, DECK_RING_SAMPLES) }

#[cfg(test)]
impl DeckFeed {
    /// TESTS ONLY: a feed whose ring is filled up front from `src` (capacity `samples`) — the product's own
    /// ring and pop path, with the whole test's audio already decoded. A finite source reaches EOF exactly as
    /// the worker would mark it; an infinite one simply never ends within the test.
    pub(crate) fn prefilled(src: impl Iterator<Item = f32> + Send + 'static, samples: usize) -> DeckFeed {
        let (feed, mut f) = deck_feed_with_capacity(Box::new(src), samples);
        f.fill(samples);
        feed
    }
}

/// One deck slot's decode worker. Parked on its channel while the slot is empty; while a feed is live it
/// tops the ring up every DECK_WORKER_TICK_MS once it drops below DECK_REFILL_BELOW, and drops the decoder
/// (freeing the file) at EOF or when the callback lets go of the feed. A new Feeder replaces the old one.
pub(crate) fn deck_worker(rx: std::sync::mpsc::Receiver<Feeder>) {
    use ringbuf::traits::Observer;
    let mut cur: Option<Feeder> = None;
    loop {
        let next = if cur.is_some() {
            match rx.recv_timeout(std::time::Duration::from_millis(DECK_WORKER_TICK_MS)) {
                Ok(f) => Some(f),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => None,
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return,
            }
        } else {
            match rx.recv() { Ok(f) => Some(f), Err(_) => return }
        };
        if let Some(f) = next { cur = Some(f); }   // the previous feeder (if any) is freed here, on this thread
        let done = match cur.as_mut() {
            Some(f) if f.cancelled() => true,
            Some(f) => {
                if f.prod.occupied_len() < DECK_REFILL_BELOW { f.fill(DECK_RING_SAMPLES); }
                f.at_eof()
            }
            None => false,
        };
        if done { cur = None; }
    }
}

/// Dispatch thread → callback. Applied in order at the top of a buffer.
pub(crate) enum RtCmd {
    Params(Box<Params>),
    /// `src` None = the file would not open/decode: the deck is emptied, exactly as a failed Load always did.
    Load { slot: u8, src: Option<DeckFeed>, gain_db: f32, gen: u64 },
    /// `reload` = a fresh decoder for a deck whose source had gone (Stop/natural end) but whose path is known.
    Play { slot: u8, reload: Option<DeckFeed>, gen: u64 },
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
    Source(DeckFeed),
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
