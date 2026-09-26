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
    /// Branch POWER — "Process local output" / "Process stream" (Settings). Not modules, and never part of
    /// a preset (Jeff's slice 4 ruling 2): recall never turns processing on or off.
    pub proc_local: bool,
    pub proc_stream: bool,
    /// SLICE 4 — THE MASTER RACK (rack.rs, docs/dsp-rack-framework.md §1.3): every module the master runs,
    /// in slot order, with its parameters and IN. It REPLACES the fourteen proc_* scalars, the two live-only
    /// bypasses per branch (now the ride/limiter slots' IN) and eq_bands/eq_version (now the GEQ slot and
    /// rack.eq_version). One typed block, one path: the legacy commands edit this same field.
    pub rack: crate::rack::MasterRack,
    /// SLICE 5 — one channel rack per fader (docs/dsp-channel-rack-eq.md): the rack (echo), its PLAN (the
    /// biquads it runs — coefficients computed on the dispatch thread, f64) and a version the callback adopts
    /// on change. Default: empty — nothing runs, today's exact arithmetic.
    pub ch_rack: [crate::rack::ChannelRackParams; SLOT_COUNT],
    pub duck_threshold: f32,
    pub duck_depth_db: f32,
    pub duck_attack_ms: f32,
    pub duck_hold_ms: f32,
    pub duck_release_ms: f32,
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

// ── SLICE 2 — THE METER BUS (docs/dsp-meter-bus.md) ─────────────────────────────────────────────────
// Raw numbers only: sample peak and Σ sample² per tap, accumulated over a READ WINDOW. No ballistics here —
// the renderer draws (src/components/meter/meterBallistics.ts).

/// Number of bus taps in a MeterBlock, in this order.
pub(crate) const METER_BUSES: usize = 6;
/// Bus tap indices: the clean programme (post-EQ, post-master, pre-processor), the LOCAL processed branch,
/// exactly what the stream ring receives, the device feed dl/dr (pre-monitor-gain, pre-resample), the room
/// chain output (aux deck live only), and the aux monitor feed.
pub(crate) const BUS_PGM: usize = 0;
pub(crate) const BUS_LOCAL: usize = 1;
pub(crate) const BUS_STREAM: usize = 2;
pub(crate) const BUS_MONITOR: usize = 3;
pub(crate) const BUS_ROOM: usize = 4;
pub(crate) const BUS_AUX: usize = 5;

/// One tap's window: the largest |sample| and the sum of squares, per side. RMS = sqrt(sumsq / frames).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct MeterTap {
    pub peak: [f32; 2],
    pub sumsq: [f64; 2],
}
impl MeterTap {
    /// Fold a buffer into the window. Reads only — the audio is not touched.
    #[inline]
    pub fn add(&mut self, l: &[f32], r: &[f32]) {
        let (mut pl, mut pr) = (self.peak[0], self.peak[1]);
        let (mut sl, mut sr) = (0.0f64, 0.0f64);
        for (&a, &b) in l.iter().zip(r.iter()) {
            pl = pl.max(a.abs());
            pr = pr.max(b.abs());
            sl += (a as f64) * (a as f64);
            sr += (b as f64) * (b as f64);
        }
        self.peak = [pl, pr];
        self.sumsq[0] += sl;
        self.sumsq[1] += sr;
    }
}

/// SLICE 3 — one branch's dynamics for a read window (docs/dsp-loudness-meter.md §3). Branch order is
/// loudness.rs's: LOCAL, STREAM, AUX.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct GrTap {
    /// The ride's applied gain at the end of the window, dB, SIGNED (a boost is +). 0 when it did not run.
    pub ride_db: f32,
    /// The limiter's LARGEST gain reduction during the window, dB (≥ 0) — not the last sample's.
    pub lim_max_db: f32,
    /// 1 = the branch's processor ran at some point in this window; 0 = the branch was clean (processing
    /// off, or its lock was missed every buffer).
    pub ran: u8,
    /// Which processor fed this branch: 0 clean, 1 its own, 2 the ROOM chain (LOCAL only — an aux deck is
    /// live and the device plays the room chain, not the LOCAL instance).
    pub src: u8,
    pub _pad: [u8; 2],
}
pub(crate) const GR_SRC_CLEAN: u8 = 0;
pub(crate) const GR_SRC_OWN: u8 = 1;
pub(crate) const GR_SRC_ROOM: u8 = 2;
impl GrTap {
    #[inline]
    pub fn fold(&mut self, ride_db: f32, lim_max_db: f32, src: u8) {
        self.ride_db = ride_db;
        self.lim_max_db = self.lim_max_db.max(lim_max_db);
        self.ran = 1;
        self.src = src;
    }
}

/// Every meter tap for one read window. `epoch` names the window; the reader acknowledges it through
/// RtShared::meter_ack and the callback then starts the next one — so each read covers exactly the audio
/// since the previous read, and no buffer's peak is lost between two ~30 Hz reads (a latest-wins buffer
/// alone would drop two of every three).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct MeterBlock {
    pub epoch: u64,
    /// Program-rate frames in this window — the RMS denominator for every tap.
    pub frames: u64,
    /// PER CHANNEL, PRE-FADER: post-trim, PRE-cut (it moves while the channel is OFF — Jeff's ruling 1),
    /// pre-rack. Frames a deck did not supply (inactive, paused, underrun) add nothing.
    pub ch: [MeterTap; SLOT_COUNT],
    pub bus: [MeterTap; METER_BUSES],
    /// Bit n set = bus n was actually fed during this window (LOCAL/STREAM/ROOM/AUX can be absent).
    pub bus_live: u8,
    /// SLICE 3 — ride and limiter per branch (LOCAL, STREAM, AUX).
    pub gr: [GrTap; 3],
    /// SLICE 5 — per channel, POST-RACK (after the channel's EQ, still pre-fader, pre-cut). Equal to `ch` when a
    /// channel's rack runs nothing. The strips keep `ch` (pre-rack, the spec); the rack view shows both.
    pub ch_post: [MeterTap; SLOT_COUNT],
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
    // No *_out_lufs here: slice 3 deleted the estimate; OUT is measured by loudness.rs and joined in GetLevel.
    pub aux_proc_in_lufs: f32, pub aux_proc_gr_db: f32, pub aux_proc_ride_db: f32,
    pub proc_in_lufs: f32, pub proc_gr_db: f32, pub proc_ride_gain_db: f32,
    pub proc_in_peak: f32, pub proc_out_peak: f32,
    pub proc_stream_in_lufs: f32, pub proc_stream_gr_db: f32,
    pub proc_stream_ride_gain_db: f32, pub proc_stream_in_peak: f32, pub proc_stream_out_peak: f32,
    pub decks: [DeckMeter; SLOT_COUNT],
    /// SLICE 2 — the meter bus: the current read window's taps.
    pub meters: MeterBlock,
}

/// Atomics the dispatch thread reads to answer "does deck N hold a source right now" without a lock.
pub(crate) struct RtShared {
    /// Commands applied by the callback since the station started (FIFO ⇒ command #k is applied iff this ≥ k).
    pub applied_seq: AtomicU64,
    /// Generation of the source each slot currently holds; 0 = none. Written by the callback (and by the
    /// device-switch path while no callback runs).
    pub src_gen: [AtomicU64; SLOT_COUNT],
    /// SLICE 2 — the meter window the reader has consumed. When this reaches the callback's current
    /// MeterBlock::epoch, the callback starts a fresh window at the top of its next buffer.
    pub meter_ack: AtomicU64,
}
impl RtShared {
    pub fn new() -> Arc<RtShared> {
        Arc::new(RtShared { applied_seq: AtomicU64::new(0), src_gen: std::array::from_fn(|_| AtomicU64::new(0)),
                            meter_ack: AtomicU64::new(0) })
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


// ── SLICE 1 S6 — the callback's health counters (docs/dsp-rt-callback.md §6) ────────────────────────────
// Per STATION (one Arc shared by that station's BusState and every Scratch it opens), so they survive a
// device reopen. Plain atomic adds on the audio thread; read by GetLevel → levels → the daemon heartbeat,
// the health ledger and the Health Monitor. Every one of them is "should be 0"; the point is to SEE it.
pub(crate) struct RtCounters {
    /// Callbacks run (the denominator for everything below).
    pub callbacks: AtomicU64,
    /// Per slot: buffers in which that deck's ring ran dry before EOF, and the silent frames that cost.
    pub underruns: [AtomicU64; SLOT_COUNT],
    pub underrun_frames: [AtomicU64; SLOT_COUNT],
    /// A try_lock the callback made and missed — the bus itself or an EQ/processor inside it. Only the
    /// callback locks any of them now (S3), so this is 0 BY CONSTRUCTION; counted so that is visible.
    pub lock_misses: AtomicU64,
    /// Callbacks that arrived late: gap since the previous callback > 1.5 × this buffer's duration, measured
    /// from the timestamps cpal hands the callback (no clock call on the audio thread).
    pub overruns: AtomicU64,
    /// Events the callback could not queue (queue full).
    pub events_dropped: AtomicU64,
    /// Buffers refused because the device asked for more than MAX_PROG_FRAMES.
    pub buffer_clamped: AtomicU64,
    /// Objects leaked (not freed) because the garbage queue was full.
    pub garbage_leaked: AtomicU64,
}
impl RtCounters {
    pub fn new() -> Arc<RtCounters> {
        Arc::new(RtCounters {
            callbacks: AtomicU64::new(0),
            underruns: std::array::from_fn(|_| AtomicU64::new(0)),
            underrun_frames: std::array::from_fn(|_| AtomicU64::new(0)),
            lock_misses: AtomicU64::new(0),
            overruns: AtomicU64::new(0),
            events_dropped: AtomicU64::new(0),
            buffer_clamped: AtomicU64::new(0),
            garbage_leaked: AtomicU64::new(0),
        })
    }
    #[inline] pub fn bump(c: &AtomicU64, n: u64) { c.fetch_add(n, Ordering::Relaxed); }
}

// ── SLICE 1 S6 — THE ALLOCATION TRAP ─────────────────────────────────────────────────────────────────────
// In tests and debug builds (never the shipped release — a trap must not be able to touch air), every
// allocation, reallocation and free is routed through this allocator. While a thread is inside the audio
// callback (RtScope), each one is COUNTED: globally (RT_ALLOCS, surfaced as `rt_allocs`) and per thread
// (so a test can attribute a count to the render it just ran). It counts rather than panics: unwinding
// out of an allocator is itself an allocation. The tests assert the count is zero.
#[cfg(any(test, debug_assertions))]
pub(crate) mod trap {
    use std::alloc::{GlobalAlloc, Layout, System};
    use std::cell::Cell;
    use std::sync::atomic::{AtomicU64, Ordering};
    thread_local! {
        pub(crate) static IN_RT: Cell<bool> = const { Cell::new(false) };
        pub(crate) static TL_ALLOCS: Cell<u64> = const { Cell::new(0) };
    }
    pub(crate) static RT_ALLOCS: AtomicU64 = AtomicU64::new(0);
    #[inline]
    fn note() {
        let _ = IN_RT.try_with(|f| {
            if f.get() {
                RT_ALLOCS.fetch_add(1, Ordering::Relaxed);
                let _ = TL_ALLOCS.try_with(|c| c.set(c.get() + 1));
            }
        });
    }
    pub(crate) struct Trap;
    unsafe impl GlobalAlloc for Trap {
        unsafe fn alloc(&self, l: Layout) -> *mut u8 { note(); unsafe { System.alloc(l) } }
        unsafe fn alloc_zeroed(&self, l: Layout) -> *mut u8 { note(); unsafe { System.alloc_zeroed(l) } }
        unsafe fn dealloc(&self, p: *mut u8, l: Layout) { note(); unsafe { System.dealloc(p, l) } }
        unsafe fn realloc(&self, p: *mut u8, l: Layout, n: usize) -> *mut u8 { note(); unsafe { System.realloc(p, l, n) } }
    }
    #[global_allocator]
    static ALLOC: Trap = Trap;
}

/// Marks "this thread is inside the audio callback" for the trap, for the lifetime of the value. A no-op
/// in the shipped release.
pub(crate) struct RtScope;
impl RtScope {
    #[inline]
    pub fn enter() -> RtScope {
        #[cfg(any(test, debug_assertions))]
        { let _ = trap::IN_RT.try_with(|f| f.set(true)); }
        RtScope
    }
}
impl Drop for RtScope {
    #[inline]
    fn drop(&mut self) {
        #[cfg(any(test, debug_assertions))]
        { let _ = trap::IN_RT.try_with(|f| f.set(false)); }
    }
}
/// Allocations made inside the callback since start — Some in debug/test builds, None in release (where
/// the trap does not exist; reported as null rather than a fabricated 0).
pub(crate) fn rt_allocs() -> Option<u64> {
    #[cfg(any(test, debug_assertions))]
    { return Some(trap::RT_ALLOCS.load(Ordering::Relaxed)); }
    #[cfg(not(any(test, debug_assertions)))]
    { None }
}
/// Allocations made inside the callback ON THIS THREAD (tests attribute a count to their own render).
#[cfg(test)]
pub(crate) fn tl_rt_allocs() -> u64 { trap::TL_ALLOCS.with(|c| c.get()) }

#[cfg(test)]
mod trap_tests {
    use super::*;
    #[test]
    fn the_trap_counts_an_allocation_inside_the_callback_scope_and_none_outside() {
        let before = tl_rt_allocs();
        let v: Vec<u8> = Vec::with_capacity(64);           // outside: not counted
        drop(v);
        assert_eq!(tl_rt_allocs(), before, "an allocation outside the callback was counted");
        {
            let _rt = RtScope::enter();
            let v: Vec<u8> = Vec::with_capacity(64);       // inside: alloc + dealloc = 2
            std::hint::black_box(&v);
            drop(v);
        }
        assert_eq!(tl_rt_allocs(), before + 2, "the trap did not see an allocation inside the callback — its zeros would mean nothing");
        println!("[trap] counts allocations inside RtScope (2 seen for one Vec), none outside");
    }
}

// ── SLICE 1 S7 — DENORMALS FLUSHED ON THE AUDIO THREAD (docs/dsp-rt-callback.md §5) ──────────────────
// Recursive state (the EQ biquads, the oversampler history, decay tails) can drift into subnormal floats
// near silence, and on x86 SSE each subnormal operation costs 10–100× a normal one. For the length of each
// callback this sets FTZ (flush results to zero) + DAZ (treat subnormal inputs as zero): MXCSR bits 15 and
// 6 on x86-64, FPCR.FZ (bit 24) on aarch64. The previous mode is RESTORED on exit, so nothing else that
// runs on the thread — in the offline harness, the synchronous pump's decoder — inherits it.
// Effect on audio: only values below 1.18e-38 (about −758 dBFS) change, to 0.
pub(crate) struct FtzScope {
    #[cfg(target_arch = "x86_64")]
    prev: u32,
    #[cfg(target_arch = "aarch64")]
    prev: u64,
}
impl FtzScope {
    #[inline]
    pub fn enter() -> FtzScope {
        #[cfg(target_arch = "x86_64")]
        #[allow(deprecated)]
        unsafe {
            use std::arch::x86_64::{_mm_getcsr, _mm_setcsr};
            let prev = _mm_getcsr();
            _mm_setcsr(prev | 0x8040);
            return FtzScope { prev };
        }
        #[cfg(target_arch = "aarch64")]
        unsafe {
            let prev: u64;
            std::arch::asm!("mrs {}, fpcr", out(reg) prev);
            std::arch::asm!("msr fpcr, {}", in(reg) prev | (1u64 << 24));
            return FtzScope { prev };
        }
        #[allow(unreachable_code)]
        FtzScope { #[cfg(any(target_arch = "x86_64", target_arch = "aarch64"))] prev: 0 }
    }
}
impl Drop for FtzScope {
    #[inline]
    fn drop(&mut self) {
        #[cfg(target_arch = "x86_64")]
        #[allow(deprecated)]
        unsafe { std::arch::x86_64::_mm_setcsr(self.prev); }
        #[cfg(target_arch = "aarch64")]
        unsafe { std::arch::asm!("msr fpcr, {}", in(reg) self.prev); }
    }
}

#[cfg(test)]
mod ftz_tests {
    use super::FtzScope;
    #[test]
    fn ftz_flushes_subnormals_inside_the_scope_and_restores_the_mode_after() {
        let tiny = f32::MIN_POSITIVE;                 // smallest NORMAL f32
        let x = std::hint::black_box(tiny);
        let outside = std::hint::black_box(x * 0.5);  // subnormal result
        assert!(outside > 0.0 && !outside.is_normal(), "without FTZ the product is a subnormal");
        {
            let _f = FtzScope::enter();
            let inside = std::hint::black_box(std::hint::black_box(x) * 0.5);
            assert_eq!(inside, 0.0, "FTZ did not flush a subnormal result inside the callback scope");
        }
        let after = std::hint::black_box(std::hint::black_box(x) * 0.5);
        assert!(after > 0.0, "the previous float mode was not restored when the scope ended");
        println!("[ftz] subnormal inside scope -> 0.0; outside and after -> {:e}", after);
    }
}

#[cfg(test)]
mod meter_layout_tests {
    use super::*;
    #[test]
    fn meter_block_layout_is_pinned() {
        // docs/dsp-meter-bus.md §1.3: 24-byte taps; 16 + 12×24 + 6×24 + 1 = 449.
        // SLICE 3 (docs/dsp-loudness-meter.md §3.2): + 3 × 12-byte GrTap at 4-byte alignment (452..488) = 488.
        // SLICE 5 (docs/dsp-channel-rack-eq.md §2): + 12 × 24-byte post-rack taps (488..776) = 776.
        assert_eq!(std::mem::size_of::<MeterTap>(), 24);
        assert_eq!(std::mem::size_of::<GrTap>(), 12);
        assert_eq!(std::mem::size_of::<MeterBlock>(), 776);
        println!("[meters] MeterTap {} B · MeterBlock {} B · MeterFrame {} B",
                 std::mem::size_of::<MeterTap>(), std::mem::size_of::<MeterBlock>(), std::mem::size_of::<MeterFrame>());
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
