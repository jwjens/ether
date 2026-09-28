// micin.rs — THE MIC AS AN ENGINE INPUT (docs/dsp-mic-in-engine.md; Jeff's GO rulings 1–8, 2026-09-26).
//
// A mic is a PATCH POINT on a generic source channel (ruling 1): a cpal INPUT stream on the operator's chosen
// device writes one input channel into a lock-free mono ring at the DEVICE rate; the source slot's deck feed is
// a *live* feed whose consumer (`LiveIn`, in the mixer callback) resamples it to PROGRAM_RATE through a
// polyphase windowed-sinc (ruling 2), absorbing the drift between the two device clocks by nudging the ratio
// at most ±0.3 % toward a target fill — no samples are ever dropped for drift. From there the slot is every
// other channel: pre-fader meter, channel rack, fader, cut, duck, aux (it is filled into the same `feed`).
//
// THREADS:
//   · the INPUT callback (cpal's capture thread) — `input_block`: converts, picks the channel, pushes the ring.
//     RtScope + FtzScope, no allocation, no lock. A full ring drops the INCOMING block (a producer cannot drop
//     the oldest) and counts an overrun.
//   · the MIXER callback — `LiveIn::pull`: preallocated history and table, no allocation, no lock.
//   · the DISPATCH thread — `MicInputs`: opens, closes and re-opens devices, watches for loss, publishes state.
//     It OWNS every cpal input Stream (built and dropped on this one thread).
//
// SENSES (built in, v1 — the standing rule): every counter below is an atomic the dispatch thread and
// audio_mic_state read: underruns (starvation EVENTS) and starved frames, overruns, stale flushes, device
// errors, losses, reopens, the run of exact digital zero (Windows mic privacy delivers zeros, not an error),
// the ring fill and the drift nudge.
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use ringbuf::traits::{Consumer, Observer, Producer, Split};
use ringbuf::{HeapCons, HeapProd, HeapRb};

use crate::audio::SLOT_COUNT;

/// Resampler taps (input samples in the window). 48 taps + Kaiser β 8: ~80 dB stopband; group delay 24 input
/// samples (0.5 ms at 48 kHz). Measured (spurs, cost) in the tests below, not assumed.
pub(crate) const TAPS: usize = 48;
/// Table phases; adjacent rows are interpolated linearly.
pub(crate) const PHASES: usize = 256;
const KAISER_BETA: f64 = 8.0;
/// The anti-alias cutoff as a fraction of the lower Nyquist.
const CUTOFF: f64 = 0.92;
/// Input gain range, dB (ruling 4). Applied inside the live feed, pre-meter, pre-rack.
pub(crate) const GAIN_DB_RANGE: (f32, f32) = (-10.0, 40.0);
/// Ring capacity, seconds of device-rate mono.
const RING_SECONDS: f64 = 0.5;
/// Drift correction: the ratio moves at most this far (0.3 %), well under the ~1 % where pitch is audible.
pub(crate) const NUDGE_MAX: f64 = 0.003;
/// Headroom above one pull + one input block.
const MARGIN_MS: f64 = 2.0;
/// The drift controller reads the ring fill through a one-pole average with this time constant. The fill
/// JITTERS at the beat between the input blocks and the output pulls (10 ms vs 10.9 ms → ~8 Hz); a fast average
/// passes that jitter into the ratio = frequency modulation of the voice (measured: spurs only 53 dB down at
/// α = 0.05/pull). Drift is slow; the correction can be slow too. 4 s leaves ~1 ppm of ripple.
const FILL_TAU_S: f64 = 4.0;
/// Fill beyond the target by more than this is STALE (the output stopped while the input kept writing):
/// discarded down to the target before playing. A mic never comes back late.
const STALE_MS: f64 = 100.0;
/// Exact digital zero for this long on an open input is its own state.
pub(crate) const ZERO_SECONDS: f64 = 5.0;
/// No input callback for this long on an open stream = the device is gone.
const STALL: Duration = Duration::from_millis(1500);
/// Re-open cadence for a device that is missing or lost.
const RETRY: Duration = Duration::from_secs(2);

const PROGRAM_RATE: u32 = 44_100;

fn f64_bits(v: f64) -> u64 { v.to_bits() }
fn bits_f64(v: u64) -> f64 { f64::from_bits(v) }
pub(crate) fn db_to_lin(db: f32) -> f32 { 10f32.powf(db.clamp(GAIN_DB_RANGE.0, GAIN_DB_RANGE.1) / 20.0) }

// ── shared per-slot state (atomics only) ───────────────────────────────────────────────────────────────
pub(crate) struct MicShared {
    /// Target input gain (linear f32 bits); the consumer ramps to it across one buffer.
    pub gain_bits: AtomicU32,
    // written by the input callback
    pub in_seq: AtomicU64,
    pub in_frames: AtomicU64,
    pub in_block_max: AtomicU64,
    pub overruns: AtomicU64,
    pub overrun_frames: AtomicU64,
    pub zero_run: AtomicU64,
    // written by the error callback
    pub dev_errors: AtomicU64,
    pub err_flag: AtomicBool,
    // written by the mixer callback (LiveIn)
    pub underruns: AtomicU64,
    pub starved_frames: AtomicU64,
    pub stale_flushes: AtomicU64,
    pub primed: AtomicBool,
    pub fill_bits: AtomicU64,
    pub target_bits: AtomicU64,
    pub nudge_bits: AtomicU64,
    // REMOTE LINK only (linknet.rs; zero and unread for a mic): what the link holds UPSTREAM of this ring, in
    // input-rate frames (f64 bits) — the jitter buffer + the decoded-but-not-pushed frames — and the TOTAL the
    // link is to hold (the operator's jitter buffer). The drift controller of a link steers on ring + upstream.
    pub extra_fill_bits: AtomicU64,
    pub extra_target_bits: AtomicU64,
}
impl Default for MicShared {
    fn default() -> Self {
        MicShared {
            gain_bits: AtomicU32::new(1.0f32.to_bits()),
            in_seq: AtomicU64::new(0), in_frames: AtomicU64::new(0), in_block_max: AtomicU64::new(0),
            overruns: AtomicU64::new(0), overrun_frames: AtomicU64::new(0), zero_run: AtomicU64::new(0),
            dev_errors: AtomicU64::new(0), err_flag: AtomicBool::new(false),
            underruns: AtomicU64::new(0), starved_frames: AtomicU64::new(0), stale_flushes: AtomicU64::new(0),
            primed: AtomicBool::new(false), fill_bits: AtomicU64::new(0), target_bits: AtomicU64::new(0),
            nudge_bits: AtomicU64::new(0),
            extra_fill_bits: AtomicU64::new(0), extra_target_bits: AtomicU64::new(0),
        }
    }
}

// ── the resampler table ────────────────────────────────────────────────────────────────────────────────
fn bessel_i0(x: f64) -> f64 {
    let (mut sum, mut term, mut k) = (1.0f64, 1.0f64, 1.0f64);
    loop {
        term *= (x / (2.0 * k)) * (x / (2.0 * k));
        sum += term;
        if term < sum * 1e-17 { return sum; }
        k += 1.0;
    }
}

/// (PHASES + 1) rows of TAPS coefficients. Row q is the filter for fractional position q / PHASES; each row
/// sums to exactly 1 (DC gain 1, so a level through the resampler is the level that went in).
pub(crate) struct SincTable { c: Box<[f32]> }
impl SincTable {
    pub(crate) fn new(in_rate: u32, out_rate: u32) -> SincTable {
        // cutoff in cycles per INPUT sample: the lower of the two Nyquists, times CUTOFF
        let fc = 0.5 * (out_rate as f64 / in_rate as f64).min(1.0) * CUTOFF;
        let half = TAPS as f64 / 2.0;
        let i0b = bessel_i0(KAISER_BETA);
        let mut c = vec![0f32; (PHASES + 1) * TAPS];
        for q in 0..=PHASES {
            let p = q as f64 / PHASES as f64;
            let mut row = [0f64; TAPS];
            for (j, r) in row.iter_mut().enumerate() {
                // tap j weights x[n-TAPS+1+j]; the output instant sits `half - 1 + p` after the window's oldest
                let t = (half - 1.0 - j as f64) + p;
                let x = t / half;
                let w = if x.abs() <= 1.0 { bessel_i0(KAISER_BETA * (1.0 - x * x).sqrt()) / i0b } else { 0.0 };
                let a = 2.0 * fc * t;
                let s = if a.abs() < 1e-12 { 1.0 } else { (std::f64::consts::PI * a).sin() / (std::f64::consts::PI * a) };
                *r = 2.0 * fc * s * w;
            }
            let sum: f64 = row.iter().sum();
            for (j, r) in row.iter().enumerate() { c[q * TAPS + j] = (r / sum) as f32; }
        }
        SincTable { c: c.into_boxed_slice() }
    }
    #[inline(always)]
    fn row(&self, q: usize) -> &[f32] { &self.c[q * TAPS..(q + 1) * TAPS] }
    /// One output sample from a TAPS-long window at fractional position `phase` (0 ≤ phase < 1) — the same
    /// arithmetic as `LiveIn::interp`, for the Remote Link's fixed-ratio sender resampler (link.rs).
    #[inline(always)]
    pub(crate) fn interp(&self, w: &[f32], phase: f64) -> f32 {
        let qf = phase * PHASES as f64;
        let q = (qf as usize).min(PHASES - 1);
        let a = (qf - q as f64) as f32;
        let (r0, r1) = (self.row(q), self.row(q + 1));
        let (mut y0, mut y1) = (0f32, 0f32);
        for j in 0..TAPS { y0 += w[j] * r0[j]; y1 += w[j] * r1[j]; }
        y0 + a * (y1 - y0)
    }
}

// ── the consumer (mixer callback) ──────────────────────────────────────────────────────────────────────
pub(crate) struct LiveIn {
    cons: HeapCons<f32>,
    table: SincTable,
    /// Doubled history: the window x[n-TAPS+1..=n] is always hist[hpos..hpos+TAPS], contiguous.
    hist: [f32; 2 * TAPS],
    hpos: usize,
    /// Fractional position between the newest two history samples, in input samples.
    phase: f64,
    base_step: f64,
    in_rate: f64,
    fill_avg: f64,
    primed: bool,
    gain: f32,
    last: f32,
    shared: Arc<MicShared>,
    /// REMOTE LINK — a STEREO live feed (interleaved L/R in the ring) whose drift controller steers on the
    /// link's total buffer (MicShared::extra_*). False for every mic: `pull` is the mic path, untouched.
    link: bool,
    hist_r: [f32; 2 * TAPS],
    last_r: f32,
}
impl LiveIn {
    /// Built on the dispatch thread (the table and history are allocated here, never in the callback).
    pub(crate) fn new(cons: HeapCons<f32>, in_rate: u32, shared: Arc<MicShared>) -> LiveIn {
        let g = f32::from_bits(shared.gain_bits.load(Ordering::Relaxed));
        LiveIn {
            cons, table: SincTable::new(in_rate, PROGRAM_RATE), hist: [0.0; 2 * TAPS], hpos: 0, phase: 0.0,
            base_step: in_rate as f64 / PROGRAM_RATE as f64, in_rate: in_rate as f64, fill_avg: 0.0,
            primed: false, gain: g, last: 0.0, shared, link: false, hist_r: [0.0; 2 * TAPS], last_r: 0.0,
        }
    }
    /// REMOTE LINK — the same consumer over a STEREO ring (linknet.rs decodes the link into it).
    pub(crate) fn new_link(cons: HeapCons<f32>, in_rate: u32, shared: Arc<MicShared>) -> LiveIn {
        let mut li = LiveIn::new(cons, in_rate, shared);
        li.link = true;
        li
    }
    #[inline(always)]
    fn push_hist(&mut self, x: f32) {
        self.hist[self.hpos] = x;
        self.hist[self.hpos + TAPS] = x;
        self.hpos += 1;
        if self.hpos == TAPS { self.hpos = 0; }
    }
    #[inline(always)]
    fn interp(&self) -> f32 {
        let qf = self.phase * PHASES as f64;
        let q = (qf as usize).min(PHASES - 1);
        let a = (qf - q as f64) as f32;
        let w = &self.hist[self.hpos..self.hpos + TAPS];
        let (r0, r1) = (self.table.row(q), self.table.row(q + 1));
        let (mut y0, mut y1) = (0f32, 0f32);
        for j in 0..TAPS { y0 += w[j] * r0[j]; y1 += w[j] * r1[j]; }
        y0 + a * (y1 - y0)
    }
    /// The ring's target fill for a pull of `frames`: one pull + the largest input block seen + a margin.
    fn target(&self, frames: usize) -> f64 {
        frames as f64 * self.base_step + self.shared.in_block_max.load(Ordering::Relaxed) as f64 + MARGIN_MS * self.in_rate / 1000.0
    }
    /// Fill `feed` (interleaved stereo, `frames` frames at PROGRAM_RATE). Always writes every frame: what the
    /// input could not supply is silence (a decay from the last sample, never a step), counted, never an end.
    pub(crate) fn pull(&mut self, feed: &mut [f32], frames: usize) {
        if self.link { return self.pull_link(feed, frames); }
        let target = self.target(frames);
        let mut fill = self.cons.occupied_len() as f64;
        // STALE: the output stopped while the input kept writing — throw away down to the target.
        if fill > target + STALE_MS * self.in_rate / 1000.0 {
            let n = (fill - target) as usize;
            self.cons.skip(n);
            fill -= n as f64;
            self.fill_avg = fill;
            self.shared.stale_flushes.fetch_add(1, Ordering::Relaxed);
        }
        if !self.primed {
            if fill >= target { self.primed = true; self.fill_avg = fill; self.shared.primed.store(true, Ordering::Relaxed); }
            else {
                self.fade_out(feed, 0, frames);
                self.shared.starved_frames.fetch_add(frames as u64, Ordering::Relaxed);
                self.publish(fill, target, 0.0);
                return;
            }
        }
        let alpha = (frames as f64 / PROGRAM_RATE as f64 / FILL_TAU_S).min(1.0);
        self.fill_avg += (fill - self.fill_avg) * alpha;
        let err = ((self.fill_avg - target) / target).clamp(-1.0, 1.0);
        let nudge = err * NUDGE_MAX;
        let step = self.base_step * (1.0 + nudge);
        let g1 = f32::from_bits(self.shared.gain_bits.load(Ordering::Relaxed));
        let (g0, dg) = (self.gain, (g1 - self.gain) / frames.max(1) as f32);
        for f in 0..frames {
            self.phase += step;
            while self.phase >= 1.0 {
                match self.cons.try_pop() {
                    Some(x) => { self.push_hist(x); self.phase -= 1.0; }
                    None => {
                        // STARVED mid-buffer: one EVENT, the rest of the buffer decays; re-prime before playing.
                        self.phase -= step;   // this frame was not produced
                        self.primed = false;
                        self.shared.primed.store(false, Ordering::Relaxed);
                        self.shared.underruns.fetch_add(1, Ordering::Relaxed);
                        self.shared.starved_frames.fetch_add((frames - f) as u64, Ordering::Relaxed);
                        self.gain = g1;
                        self.fade_out(feed, f, frames);
                        self.publish(fill, target, nudge);
                        return;
                    }
                }
            }
            let y = self.interp() * (g0 + dg * (f + 1) as f32);
            self.last = y;
            feed[2 * f] = y;
            feed[2 * f + 1] = y;
        }
        self.gain = g1;
        self.publish(fill, target, nudge);
    }
    fn fade_out(&mut self, feed: &mut [f32], from: usize, to: usize) {
        for f in from..to {
            self.last *= 0.5;
            if self.last.abs() < 1e-20 { self.last = 0.0; }
            feed[2 * f] = self.last;
            feed[2 * f + 1] = self.last;
        }
    }
    /// REMOTE LINK — `pull` for a stereo ring. Identical rules (prime at target, stale flush, starve = one EVENT
    /// then a decay, gain ramp, ±0.3 % drift nudge), with two differences:
    ///   · the ring holds interleaved L/R: fill and every skip are in FRAMES, each channel has its own history;
    ///   · the drift controller steers the link's TOTAL buffer (this ring + the jitter buffer upstream, published
    ///     by the link thread in MicShared::extra_fill_bits) to the operator's jitter target (extra_target_bits).
    ///     A remote clock that runs fast fills the jitter buffer; this consumes a hair faster. Nothing is dropped.
    fn pull_link(&mut self, feed: &mut [f32], frames: usize) {
        let target = self.target(frames);
        let mut fill = (self.cons.occupied_len() / 2) as f64;
        if fill > target + STALE_MS * self.in_rate / 1000.0 {
            let n = (fill - target) as usize;
            self.cons.skip(n * 2);
            fill -= n as f64;
            self.shared.stale_flushes.fetch_add(1, Ordering::Relaxed);
        }
        let extra = bits_f64(self.shared.extra_fill_bits.load(Ordering::Relaxed));
        let extra_target = bits_f64(self.shared.extra_target_bits.load(Ordering::Relaxed));
        let (total, total_target) = (fill + extra, if extra_target > 0.0 { extra_target } else { target });
        if !self.primed {
            if fill >= target { self.primed = true; self.fill_avg = total; self.shared.primed.store(true, Ordering::Relaxed); }
            else {
                self.fade_out_link(feed, 0, frames);
                self.shared.starved_frames.fetch_add(frames as u64, Ordering::Relaxed);
                self.publish(fill, target, 0.0);
                return;
            }
        }
        let alpha = (frames as f64 / PROGRAM_RATE as f64 / FILL_TAU_S).min(1.0);
        self.fill_avg += (total - self.fill_avg) * alpha;
        let err = ((self.fill_avg - total_target) / total_target).clamp(-1.0, 1.0);
        let nudge = err * NUDGE_MAX;
        let step = self.base_step * (1.0 + nudge);
        let g1 = f32::from_bits(self.shared.gain_bits.load(Ordering::Relaxed));
        let (g0, dg) = (self.gain, (g1 - self.gain) / frames.max(1) as f32);
        for f in 0..frames {
            self.phase += step;
            while self.phase >= 1.0 {
                if self.cons.occupied_len() < 2 {
                    self.phase -= step;
                    self.primed = false;
                    self.shared.primed.store(false, Ordering::Relaxed);
                    self.shared.underruns.fetch_add(1, Ordering::Relaxed);
                    self.shared.starved_frames.fetch_add((frames - f) as u64, Ordering::Relaxed);
                    self.gain = g1;
                    self.fade_out_link(feed, f, frames);
                    self.publish(fill, target, nudge);
                    return;
                }
                let l = self.cons.try_pop().unwrap_or(0.0);
                let r = self.cons.try_pop().unwrap_or(0.0);
                self.hist[self.hpos] = l; self.hist[self.hpos + TAPS] = l;
                self.hist_r[self.hpos] = r; self.hist_r[self.hpos + TAPS] = r;
                self.hpos += 1;
                if self.hpos == TAPS { self.hpos = 0; }
                self.phase -= 1.0;
            }
            let g = g0 + dg * (f + 1) as f32;
            let yl = self.table.interp(&self.hist[self.hpos..self.hpos + TAPS], self.phase) * g;
            let yr = self.table.interp(&self.hist_r[self.hpos..self.hpos + TAPS], self.phase) * g;
            self.last = yl;
            self.last_r = yr;
            feed[2 * f] = yl;
            feed[2 * f + 1] = yr;
        }
        self.gain = g1;
        self.publish(fill, target, nudge);
    }
    fn fade_out_link(&mut self, feed: &mut [f32], from: usize, to: usize) {
        for f in from..to {
            self.last *= 0.5;
            self.last_r *= 0.5;
            if self.last.abs() < 1e-20 { self.last = 0.0; }
            if self.last_r.abs() < 1e-20 { self.last_r = 0.0; }
            feed[2 * f] = self.last;
            feed[2 * f + 1] = self.last_r;
        }
    }
    fn publish(&self, fill: f64, target: f64, nudge: f64) {
        let sh = &self.shared;
        sh.fill_bits.store(f64_bits(fill), Ordering::Relaxed);
        sh.target_bits.store(f64_bits(target), Ordering::Relaxed);
        sh.nudge_bits.store(f64_bits(nudge), Ordering::Relaxed);
    }
}

// ── the producer (input callback body) ─────────────────────────────────────────────────────────────────
/// One input callback: `data` interleaved at `ch` channels; `sel` = the input channel carried (0-based).
/// No allocation, no lock. Called from the cpal closure, and directly by the tests (under the trap).
#[inline]
pub(crate) fn input_block<T: Copy>(data: &[T], ch: usize, sel: usize, prod: &mut HeapProd<f32>, sh: &MicShared, conv: impl Fn(T) -> f32) {
    let ch = ch.max(1);
    let frames = data.len() / ch;
    sh.in_seq.fetch_add(1, Ordering::Relaxed);
    sh.in_block_max.fetch_max(frames as u64, Ordering::Relaxed);
    let mut all_zero = true;
    for f in 0..frames { if conv(data[f * ch + sel]) != 0.0 { all_zero = false; break; } }
    if all_zero { sh.zero_run.fetch_add(frames as u64, Ordering::Relaxed); } else { sh.zero_run.store(0, Ordering::Relaxed); }
    if prod.vacant_len() < frames {
        sh.overruns.fetch_add(1, Ordering::Relaxed);
        sh.overrun_frames.fetch_add(frames as u64, Ordering::Relaxed);
        return;
    }
    prod.push_iter((0..frames).map(|f| conv(data[f * ch + sel])));
    sh.in_frames.fetch_add(frames as u64, Ordering::Relaxed);
}

/// A mic ring for a device rate: (the input side, the consumer side).
pub(crate) fn mic_ring(in_rate: u32) -> (HeapProd<f32>, HeapCons<f32>) {
    HeapRb::<f32>::new(((in_rate as f64 * RING_SECONDS) as usize).max(4096)).split()
}

// ── the per-station board (what audio_mic_state reads) ─────────────────────────────────────────────────
#[derive(Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MicStatus {
    pub slot: String,
    pub device: String,
    /// 1-based, as the operator sees it.
    pub channel: u32,
    pub gain_db: f32,
    /// off | opening | not_found | bad_channel | unsupported | open_failed | running | digital_silence | lost
    pub state: String,
    pub reason: String,
    pub rate: u32,
    pub channels: u32,
    pub losses: u64,
    pub reopens: u64,
}
pub(crate) struct MicBoard {
    pub shared: [Arc<MicShared>; SLOT_COUNT],
    pub status: Mutex<[MicStatus; SLOT_COUNT]>,
}
static BOARDS: OnceLock<Mutex<HashMap<u32, Arc<MicBoard>>>> = OnceLock::new();
/// The station's mic board (created on first use; lives as long as the process).
pub(crate) fn board(station_id: u32) -> Arc<MicBoard> {
    let m = BOARDS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut g = m.lock().unwrap_or_else(|e| e.into_inner());
    g.entry(station_id).or_insert_with(|| Arc::new(MicBoard {
        shared: std::array::from_fn(|_| Arc::new(MicShared::default())),
        status: Mutex::new(std::array::from_fn(|_| MicStatus { state: "off".into(), ..Default::default() })),
    })).clone()
}
const SLOT_NAMES: [&str; SLOT_COUNT] = ["A", "B", "C", "D", "E", "F", "CART", "S1", "S2", "S3", "S4", "S5"];

/// The station's mic state as JSON (audio_mic_state): the configured slots, their state, and every counter.
pub(crate) fn state_json(station_id: u32) -> serde_json::Value {
    let b = board(station_id);
    let st = b.status.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let rows: Vec<serde_json::Value> = st.iter().enumerate().filter(|(_, s)| !s.device.is_empty()).map(|(i, s)| {
        let sh = &b.shared[i];
        let ld = |a: &AtomicU64| a.load(Ordering::Relaxed);
        let rate = s.rate.max(1) as f64;
        let mut v = serde_json::to_value(s).unwrap_or_default();
        let o = v.as_object_mut().unwrap();
        o.insert("fillMs".into(), (bits_f64(ld(&sh.fill_bits)) / rate * 1000.0).into());
        o.insert("targetMs".into(), (bits_f64(ld(&sh.target_bits)) / rate * 1000.0).into());
        o.insert("driftPpm".into(), (bits_f64(ld(&sh.nudge_bits)) * 1e6).into());
        o.insert("primed".into(), sh.primed.load(Ordering::Relaxed).into());
        o.insert("underruns".into(), ld(&sh.underruns).into());
        o.insert("starvedMs".into(), (ld(&sh.starved_frames) as f64 / PROGRAM_RATE as f64 * 1000.0).into());
        o.insert("overruns".into(), ld(&sh.overruns).into());
        o.insert("staleFlushes".into(), ld(&sh.stale_flushes).into());
        o.insert("deviceErrors".into(), ld(&sh.dev_errors).into());
        o.insert("zeroSec".into(), (ld(&sh.zero_run) as f64 / rate).into());
        o.insert("inBlock".into(), ld(&sh.in_block_max).into());
        v
    }).collect();
    serde_json::json!({ "v": 1, "mics": rows })
}

/// Input devices on the default host (shared-mode WASAPI on Windows — ruling 7).
pub(crate) fn list_input_devices() -> serde_json::Value {
    use cpal::traits::{DeviceTrait, HostTrait};
    let host = cpal::default_host();
    let default_name = host.default_input_device().and_then(|d| d.name().ok());
    let mut out = Vec::new();
    if let Ok(devs) = host.input_devices() {
        for d in devs {
            let Ok(name) = d.name() else { continue };
            let cfg = d.default_input_config().ok();
            out.push(serde_json::json!({
                "name": name,
                "channels": cfg.as_ref().map(|c| c.channels()).unwrap_or(0),
                "rate": cfg.as_ref().map(|c| c.sample_rate().0).unwrap_or(0),
                "format": cfg.as_ref().map(|c| format!("{:?}", c.sample_format())).unwrap_or_default(),
                "isDefault": default_name.as_deref() == Some(name.as_str()),
            }));
        }
    }
    serde_json::Value::Array(out)
}

// ── the manager (dispatch thread) ──────────────────────────────────────────────────────────────────────
struct MicSlot {
    device: String,
    channel: u16,
    gain_db: f32,
    stream: Option<cpal::Stream>,
    was_open: bool,
    next_try: Instant,
    last_seq: u64,
    last_seq_at: Instant,
    zero_reported: bool,
    refusals_logged: bool,
}

/// What the manager asks the dispatch loop to do to a deck slot.
pub(crate) enum MicAction {
    /// Install (and activate) this live feed on the slot.
    Install(usize, crate::rt::DeckFeed),
    /// Empty the slot (the mic was unpatched).
    Release(usize),
}

pub(crate) struct MicInputs {
    station_id: u32,
    slots: [Option<MicSlot>; SLOT_COUNT],
    board: Arc<MicBoard>,
}
impl MicInputs {
    pub(crate) fn new(station_id: u32) -> MicInputs {
        MicInputs { station_id, slots: std::array::from_fn(|_| None), board: board(station_id) }
    }
    /// Does this slot carry a mic? (Deck commands aimed at it are refused: the patch owns the slot.)
    pub(crate) fn is_live(&self, idx: usize) -> bool { self.slots.get(idx).map_or(false, |s| s.is_some()) }
    /// A deck command arrived for a mic slot — say so once per patch, then quietly.
    pub(crate) fn refused(&mut self, idx: usize, what: &str) {
        if let Some(Some(s)) = self.slots.get_mut(idx) {
            if !s.refusals_logged {
                s.refusals_logged = true;
                eprintln!("[MIC] Station {} {}: `{}` ignored — this channel carries a live mic ({}). Unpatch it in Preferences → Audio I/O to load it.",
                          self.station_id, SLOT_NAMES[idx], what, s.device);
            }
        }
    }
    fn set_status(&self, idx: usize, f: impl FnOnce(&mut MicStatus)) {
        let mut st = self.board.status.lock().unwrap_or_else(|e| e.into_inner());
        f(&mut st[idx]);
    }
    /// Patch, re-patch or unpatch a slot. `device` empty = unpatch. `channel` 0-based. A gain-only change never
    /// re-opens the device.
    pub(crate) fn set(&mut self, idx: usize, device: String, channel: u16, gain_db: f32, now: Instant, out: &mut Vec<MicAction>) {
        if idx >= SLOT_COUNT { return; }
        let gain_db = gain_db.clamp(GAIN_DB_RANGE.0, GAIN_DB_RANGE.1);
        self.board.shared[idx].gain_bits.store(db_to_lin(gain_db).to_bits(), Ordering::Relaxed);
        if device.is_empty() {
            if self.slots[idx].take().is_some() {
                eprintln!("[MIC] Station {} {}: unpatched", self.station_id, SLOT_NAMES[idx]);
                out.push(MicAction::Release(idx));
            }
            self.set_status(idx, |s| *s = MicStatus { slot: SLOT_NAMES[idx].into(), state: "off".into(), ..Default::default() });
            return;
        }
        let same = matches!(&self.slots[idx], Some(s) if s.device == device && s.channel == channel);
        if same {
            if let Some(s) = self.slots[idx].as_mut() { s.gain_db = gain_db; }
            self.set_status(idx, |s| s.gain_db = gain_db);
            return;
        }
        self.slots[idx] = Some(MicSlot {
            device: device.clone(), channel, gain_db, stream: None, was_open: false, next_try: now,
            last_seq: 0, last_seq_at: now, zero_reported: false, refusals_logged: false,
        });
        self.set_status(idx, |s| {
            let (losses, reopens) = (s.losses, s.reopens);
            *s = MicStatus { slot: SLOT_NAMES[idx].into(), device, channel: channel as u32 + 1, gain_db,
                             state: "opening".into(), losses, reopens, ..Default::default() };
        });
        self.open(idx, now, out);
    }
    /// Every dispatch tick (≤ 50 ms): loss and stall detection, digital silence, and re-open.
    pub(crate) fn tick(&mut self, now: Instant, out: &mut Vec<MicAction>) {
        for idx in 0..SLOT_COUNT {
            let Some(s) = self.slots[idx].as_mut() else { continue };
            let sh = self.board.shared[idx].clone();
            if s.stream.is_some() {
                let mut lost: Option<String> = None;
                if sh.err_flag.swap(false, Ordering::Relaxed) { lost = Some("the device reported an error".into()); }
                let seq = sh.in_seq.load(Ordering::Relaxed);
                if seq != s.last_seq { s.last_seq = seq; s.last_seq_at = now; }
                else if now.duration_since(s.last_seq_at) > STALL { lost = Some(format!("no audio from the device for {} ms", STALL.as_millis())); }
                if let Some(why) = lost {
                    s.stream = None;   // dropped HERE, on the thread that built it
                    s.next_try = now + RETRY;
                    let dev = s.device.clone();
                    eprintln!("[MIC] Station {} {}: LOST {} — {} (the channel is silent, the programme continues; retrying every {} s)",
                              self.station_id, SLOT_NAMES[idx], dev, why, RETRY.as_secs());
                    self.set_status(idx, |st| { st.state = "lost".into(); st.reason = why; st.losses += 1; });
                    continue;
                }
                // digital silence (Windows microphone privacy delivers exact zeros, not an error)
                let rate = self.board.status.lock().map(|st| st[idx].rate).unwrap_or(0).max(1) as f64;
                let zs = sh.zero_run.load(Ordering::Relaxed) as f64 / rate;
                if zs >= ZERO_SECONDS && !s.zero_reported {
                    s.zero_reported = true;
                    eprintln!("[MIC] Station {} {}: {} delivers PURE DIGITAL SILENCE for {:.0} s — Windows microphone privacy (\"Let desktop apps access your microphone\"), or the input is muted",
                              self.station_id, SLOT_NAMES[idx], s.device, zs);
                    self.set_status(idx, |st| { st.state = "digital_silence".into();
                        st.reason = "exact zeros — Windows microphone privacy, or the input is muted".into(); });
                } else if zs < ZERO_SECONDS && s.zero_reported {
                    s.zero_reported = false;
                    eprintln!("[MIC] Station {} {}: audio from {} again", self.station_id, SLOT_NAMES[idx], s.device);
                    self.set_status(idx, |st| { st.state = "running".into(); st.reason.clear(); });
                }
            } else if now >= s.next_try {
                self.open(idx, now, out);
            }
        }
    }
    fn open(&mut self, idx: usize, now: Instant, out: &mut Vec<MicAction>) {
        use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
        use cpal::Sample;
        let station_id = self.station_id;
        let sh = self.board.shared[idx].clone();
        let Some(s) = self.slots[idx].as_mut() else { return };
        s.next_try = now + RETRY;
        let host = cpal::default_host();
        let dev = host.input_devices().ok().and_then(|mut it| it.find(|d| d.name().ok().as_deref() == Some(s.device.as_str())));
        let fail = |this: &MicInputs, state: &str, why: String, prev: &str| {
            if prev != state {
                eprintln!("[MIC] Station {} {}: {} — {}", station_id, SLOT_NAMES[idx], state, why);
            }
            this.set_status(idx, |st| { st.state = state.into(); st.reason = why; });
        };
        let prev_state = self.board.status.lock().map(|st| st[idx].state.clone()).unwrap_or_default();
        let s = self.slots[idx].as_mut().unwrap();
        let Some(dev) = dev else {
            // Never fall back to the default input: a wrong mic on air is worse than none.
            let why = format!("\"{}\" is not connected to this machine — the channel is silent (never the default input)", s.device);
            let _ = s;
            fail(self, "not_found", why, &prev_state);
            return;
        };
        let cfg = match dev.default_input_config() {
            Ok(c) => c,
            Err(e) => { let why = format!("{}", e); fail(self, "open_failed", why, &prev_state); return; }
        };
        let (rate, chans) = (cfg.sample_rate().0, cfg.channels());
        let s = self.slots[idx].as_mut().unwrap();
        if s.channel as u32 >= chans as u32 {
            let why = format!("input {} is not on this device (it has {})", s.channel + 1, chans);
            fail(self, "bad_channel", why, &prev_state);
            return;
        }
        let s = self.slots[idx].as_mut().unwrap();
        let (sel, ch) = (s.channel as usize, chans as usize);
        let stream_cfg = cpal::StreamConfig { channels: chans, sample_rate: cpal::SampleRate(rate), buffer_size: cpal::BufferSize::Default };
        sh.zero_run.store(0, Ordering::Relaxed);
        sh.in_block_max.store(0, Ordering::Relaxed);
        sh.err_flag.store(false, Ordering::Relaxed);
        let (mut prod, cons) = mic_ring(rate);
        let err_sh = sh.clone();
        let err_fn = move |_e: cpal::StreamError| {
            // Not the audio thread, but kept to atomics: the dispatch thread reports it.
            err_sh.dev_errors.fetch_add(1, Ordering::Relaxed);
            err_sh.err_flag.store(true, Ordering::Relaxed);
        };
        let in_sh = sh.clone();
        macro_rules! build {
            ($t:ty) => {
                dev.build_input_stream::<$t, _, _>(&stream_cfg, move |data: &[$t], _| {
                    let _rt = crate::rt::RtScope::enter();
                    let _ftz = crate::rt::FtzScope::enter();
                    input_block(data, ch, sel, &mut prod, &in_sh, |x: $t| x.to_sample::<f32>());
                }, err_fn, None)
            };
        }
        let built = match cfg.sample_format() {
            cpal::SampleFormat::F32 => build!(f32),
            cpal::SampleFormat::I16 => build!(i16),
            cpal::SampleFormat::I32 => build!(i32),
            cpal::SampleFormat::U16 => build!(u16),
            other => { let why = format!("the device's sample format {:?} is not supported", other); fail(self, "unsupported", why, &prev_state); return; }
        };
        let stream = match built {
            Ok(st) => st,
            Err(e) => { let why = format!("{}", e); fail(self, "open_failed", why, &prev_state); return; }
        };
        if let Err(e) = stream.play() { let why = format!("{}", e); fail(self, "open_failed", why, &prev_state); return; }
        let s = self.slots[idx].as_mut().unwrap();
        let reopen = s.was_open;
        s.was_open = true;
        s.stream = Some(stream);
        s.last_seq = sh.in_seq.load(Ordering::Relaxed);
        s.last_seq_at = now;
        s.zero_reported = false;
        let dev_name = s.device.clone();
        let live = LiveIn::new(cons, rate, sh.clone());
        out.push(MicAction::Install(idx, crate::rt::DeckFeed::live(Box::new(live))));
        eprintln!("[MIC] Station {} {}: {} {} ({} Hz, {} ch, input {}, {:?})", station_id, SLOT_NAMES[idx],
                  if reopen { "RE-OPENED" } else { "opened" }, dev_name, rate, chans, sel + 1, cfg.sample_format());
        self.set_status(idx, |st| {
            st.state = "running".into(); st.reason.clear(); st.rate = rate; st.channels = chans as u32;
            if reopen { st.reopens += 1; }
        });
    }
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════════
#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A test producer: a sine at `rate × (1 + ppm·1e-6)` samples per REAL second, pushed in blocks of `block`.
    pub(crate) struct Gen { pub(crate) rate: f64, pub(crate) freq: f64, pub(crate) amp: f64, pub(crate) n: u64 }
    impl Gen {
        pub(crate) fn block(&mut self, out: &mut Vec<f32>, frames: usize) {
            out.clear();
            for _ in 0..frames {
                out.push((self.amp * (2.0 * std::f64::consts::PI * self.freq * self.n as f64 / self.rate).sin()) as f32);
                self.n += 1;
            }
        }
    }

    /// Drive a producer at `in_rate·(1+ppm)` in `in_block`-frame blocks against a consumer pulling `out_block`
    /// frames at 44.1 kHz, event by event, for `seconds`. Returns the consumer output (mono) and the shared state.
    pub(crate) fn run(in_rate: u32, ppm: f64, in_block: usize, out_block: usize, seconds: f64, freq: f64, amp: f64, keep: bool)
        -> (Vec<f32>, Arc<MicShared>, Vec<f64>) {
        let sh = Arc::new(MicShared::default());
        let (mut prod, cons) = mic_ring(in_rate);
        let mut li = LiveIn::new(cons, in_rate, sh.clone());
        let true_rate = in_rate as f64 * (1.0 + ppm * 1e-6);
        let mut g = Gen { rate: in_rate as f64, freq, amp, n: 0 };
        let (in_dt, out_dt) = (in_block as f64 / true_rate, out_block as f64 / PROGRAM_RATE as f64);
        let (mut t_in, mut t_out) = (0.0f64, out_dt * 0.37);   // arbitrary phase between the clocks
        let mut blk = Vec::with_capacity(in_block);
        let mut feed = vec![0f32; out_block * 2];
        let mut out = Vec::new();
        let mut fills = Vec::new();
        while t_out < seconds {
            if t_in <= t_out {
                g.block(&mut blk, in_block);
                input_block(&blk, 1, 0, &mut prod, &sh, |x| x);
                t_in += in_dt;
            } else {
                li.pull(&mut feed, out_block);
                if keep { for f in 0..out_block { out.push(feed[2 * f]); } }
                fills.push(bits_f64(sh.fill_bits.load(Ordering::Relaxed)));
                t_out += out_dt;
            }
        }
        (out, sh, fills)
    }

    /// REMOTE LINK — the stereo live feed under a WRONG REMOTE CLOCK, for 10 simulated minutes. The sender makes a
    /// 20 ms frame every 20 ms of ITS clock (off by ±300 ppm); frames land in an upstream buffer (the jitter
    /// buffer); the link thread moves 480-frame blocks into the ring only while the ring is below LiveIn's target
    /// (linknet.rs RxStation::service); the mixer pulls at 44.1 kHz. After settling: no underrun, the link's
    /// TOTAL buffer (upstream + ring) held at the 120 ms target, the nudge equal to the clock error — and L and R
    /// still two different signals at the right level.
    #[test]
    fn link_stereo_feed_absorbs_a_wrong_remote_clock() {
        for &ppm in &[300.0f64, -300.0, 0.0] {
            let sh = Arc::new(MicShared::default());
            sh.in_block_max.store(480, Ordering::Relaxed);
            let (mut prod, cons) = HeapRb::<f32>::new(48_000).split();
            let mut li = LiveIn::new_link(cons, 48_000, sh.clone());
            let total_target = 6.0 * 960.0;                    // 120 ms at 48 kHz
            sh.extra_target_bits.store(f64_bits(total_target), Ordering::Relaxed);
            let (mut gl, mut gr) = (Gen { rate: 48_000.0, freq: 1000.0, amp: 0.1, n: 0 }, Gen { rate: 48_000.0, freq: 1500.0, amp: 0.05, n: 0 });
            let mut upstream: std::collections::VecDeque<f32> = std::collections::VecDeque::new();
            let (fr_dt, out_dt) = (960.0 / (48_000.0 * (1.0 + ppm * 1e-6)), 480.0 / PROGRAM_RATE as f64);
            let (mut t_fr, mut t_out) = (0.0f64, out_dt * 0.37);
            let (mut bl, mut br) = (Vec::new(), Vec::new());
            let mut feed = vec![0f32; 480 * 2];
            let (mut out_l, mut out_r) = (Vec::new(), Vec::new());
            let mut totals = Vec::new();
            let (mut jb_primed, mut jb_starves) = (false, 0u64);
            // prime: 6 frames upstream before the first pull (the jitter buffer primes at its target)
            let seconds = 600.0;
            while t_out < seconds {
                if t_fr <= t_out {
                    gl.block(&mut bl, 960); gr.block(&mut br, 960);
                    for i in 0..960 { upstream.push_back(bl[i]); upstream.push_back(br[i]); }
                    t_fr += fr_dt;
                } else {
                    // the link thread: top the ring up, demand-driven
                    let target = bits_f64(sh.target_bits.load(Ordering::Relaxed));
                    if !jb_primed && upstream.len() / 2 >= 6 * 960 { jb_primed = true; }
                    while jb_primed && target > 0.0 && ((prod.occupied_len() / 2) as f64) < target + 480.0 {
                        if upstream.len() / 2 < 480 { jb_primed = false; jb_starves += 1; break; }
                        let blk: Vec<f32> = upstream.drain(..960).collect();
                        prod.push_slice(&blk);
                    }
                    sh.extra_fill_bits.store(f64_bits((upstream.len() / 2) as f64), Ordering::Relaxed);
                    li.pull(&mut feed, 480);
                    if t_out > seconds - 4.0 { for f in 0..480 { out_l.push(feed[2 * f]); out_r.push(feed[2 * f + 1]); } }
                    totals.push((upstream.len() / 2) as f64 + (prod.occupied_len() / 2) as f64);
                    t_out += out_dt;
                }
            }
            let settle = (60.0 / out_dt) as usize;   // the 4 s controller needs ~a minute to settle a 300 ppm error
            let tail = &totals[settle..];
            let (lo, hi) = tail.iter().fold((f64::MAX, 0f64), |(a, b), &x| (a.min(x), b.max(x)));
            let mean = tail.iter().sum::<f64>() / tail.len() as f64;
            let nudge_ppm = bits_f64(sh.nudge_bits.load(Ordering::Relaxed)) * 1e6;
            let u = sh.underruns.load(Ordering::Relaxed);
            let (sl, lvl_l) = spur_db(&out_l, PROGRAM_RATE as f64, 1000.0);
            let (sr, lvl_r) = spur_db(&out_r, PROGRAM_RATE as f64, 1500.0);
            println!("[link-stereo] remote clock {:+.0} ppm, 10 min: underruns {} · total buffer {:.1}–{:.1} ms (mean {:.1}, target 120.0) · nudge {:+.0} ppm · L 1 kHz {:.2} dBFS spurs {:.1} dB · R 1.5 kHz {:.2} dBFS spurs {:.1} dB",
                     ppm, u, lo / 48.0, hi / 48.0, mean / 48.0, nudge_ppm, lvl_l, sl, lvl_r, sr);
            assert_eq!(u, 0, "underrun under a {} ppm remote clock", ppm);
            assert_eq!(jb_starves, 0, "the upstream buffer ran dry under a {} ppm remote clock", ppm);
            // A PROPORTIONAL controller (the mic's): to run at +300 ppm it must sit 300/3000 = 10 % above target, so
            // the settled buffer is 120 × (1 + ppm/3000) ms — ±12 ms at ±300 ppm, ±2 ms at a typical ±50 ppm. This
            // model samples just AFTER each pull (one 480-frame pull ≈ 11 ms lower than the controller sees).
            let expect = 120.0 * (1.0 + ppm / 3000.0) - 480.0 * (48_000.0 / 44_100.0) / 48.0;
            assert!((mean / 48.0 - expect).abs() < 5.0, "the total buffer settled at {:.1} ms (expected {:.1})", mean / 48.0, expect);
            assert!((nudge_ppm - ppm).abs() < 60.0, "the controller settled at {:+.0} ppm for {:+.0} ppm", nudge_ppm, ppm);
            assert!((lvl_l - (-20.0 - 3.0103)).abs() < 0.1 && (lvl_r - (-26.02 - 3.0103)).abs() < 0.1, "levels L {:.2} R {:.2}", lvl_l, lvl_r);
            assert!(sl < -60.0 && sr < -60.0, "a channel carries the other (or the resampler is dirty)");
        }
    }

    #[test]
    fn the_table_rows_sum_to_one() {
        let t = SincTable::new(48_000, 44_100);
        for q in 0..=PHASES { let s: f64 = t.row(q).iter().map(|&x| x as f64).sum(); assert!((s - 1.0).abs() < 1e-6, "row {} sums to {}", q, s); }
    }

    #[test]
    fn a_wrong_clock_is_absorbed_without_underruns() {
        // THE DRIFT TEST (ruling): the device clock deliberately wrong by ±300 ppm (and a 44.1 k device, and a
        // 16 k headset) for 10 simulated minutes. After 10 s of settling: no underrun, no overrun, the fill
        // bounded, and the controller's nudge equal to the clock error.
        for &(rate, ppm) in &[(48_000u32, 300.0), (48_000, -300.0), (44_100, 150.0), (16_000, -200.0)] {
            let (_o, sh, fills) = run(rate, ppm, 480 * rate as usize / 48_000, 480, 600.0, 1000.0, 0.1, false);
            let settle = (10.0 * PROGRAM_RATE as f64 / 480.0) as usize;
            let tail = &fills[settle..];
            let (lo, hi) = tail.iter().fold((f64::MAX, 0f64), |(a, b), &x| (a.min(x), b.max(x)));
            let target = bits_f64(sh.target_bits.load(Ordering::Relaxed));
            let nudge_ppm = bits_f64(sh.nudge_bits.load(Ordering::Relaxed)) * 1e6;
            let (u, o) = (sh.underruns.load(Ordering::Relaxed), sh.overruns.load(Ordering::Relaxed));
            println!("[mic-drift] {} Hz, clock {:+.0} ppm, 10 min: underruns {} · overruns {} · fill {:.1}–{:.1} ms (target {:.1} ms) · controller nudge {:+.0} ppm",
                     rate, ppm, u, o, lo / rate as f64 * 1e3, hi / rate as f64 * 1e3, target / rate as f64 * 1e3, nudge_ppm);
            assert_eq!(u, 0, "underrun under a {} ppm clock", ppm);
            assert_eq!(o, 0, "overrun under a {} ppm clock", ppm);
            assert!(hi < 3.0 * target && lo > 0.0, "the fill wandered: {:.0}..{:.0} for target {:.0}", lo, hi, target);
            assert!((nudge_ppm - ppm).abs() < 60.0, "the controller settled at {:+.0} ppm for a {:+.0} ppm clock", nudge_ppm, ppm);
        }
    }

    /// Spurs + noise relative to the tone: a Kaiser-windowed (β 20, sidelobes ~−150 dB, so the analysis is not
    /// the floor) FFT of the last 65 536 samples of `x`; everything except ±`guard` bins around the tone (and DC).
    /// Also returns the RMS level (dBFS) of those samples, unwindowed.
    pub(crate) fn spur_db(x: &[f32], fs: f64, freq: f64) -> (f64, f64) {
        use realfft::RealFftPlanner;
        let n = 1 << 16;
        let x = &x[x.len() - n..];
        let (beta, i0b) = (20.0f64, bessel_i0(20.0));
        let w = |i: usize| { let r = 2.0 * i as f64 / (n - 1) as f64 - 1.0; bessel_i0(beta * (1.0 - r * r).max(0.0).sqrt()) / i0b };
        let mut buf: Vec<f64> = (0..n).map(|i| x[i] as f64 * w(i)).collect();
        let fft = RealFftPlanner::<f64>::new().plan_fft_forward(n);
        let mut spec = fft.make_output_vec();
        fft.process(&mut buf, &mut spec).unwrap();
        let k0 = (freq / fs * n as f64).round() as usize;
        let guard = 24;
        let (mut tone, mut rest) = (0f64, 0f64);
        for (k, c) in spec.iter().enumerate() {
            let p = c.norm_sqr();
            if k + guard >= k0 && k <= k0 + guard { tone += p; } else if k > guard { rest += p; }
        }
        let rms = (x.iter().map(|&v| (v as f64) * (v as f64)).sum::<f64>() / n as f64).sqrt();
        (10.0 * (rest / tone).log10(), 20.0 * rms.log10())
    }

    #[test]
    fn the_level_is_exact_and_the_resampler_is_clean() {
        // −18 dBFS 1 kHz at 48 kHz (and 44.1 kHz, and 16 kHz) through the live feed → 44.1 kHz.
        let amp = 10f64.powf(-18.0 / 20.0);
        // THE MEASUREMENT FLOOR: an ideal −18 dBFS 1 kHz tone, made at 44.1 kHz in f64 and stored as f32 (as the
        // resampler's output is), through the same analysis.
        let ideal: Vec<f32> = (0..(1 << 17)).map(|i| (amp * (2.0 * std::f64::consts::PI * 1000.0 * i as f64 / 44_100.0).sin()) as f32).collect();
        let (floor, _) = spur_db(&ideal, PROGRAM_RATE as f64, 1000.0);
        println!("[mic-src] measurement floor (an ideal f32 tone, same analysis): {:.1} dB below the tone", -floor);
        for &rate in &[48_000u32, 44_100, 16_000] {
            let (out, sh, _) = run(rate, 0.0, 480 * rate as usize / 48_000, 480, 4.0, 1000.0, amp, true);
            let (spur, level) = spur_db(&out, PROGRAM_RATE as f64, 1000.0);
            let want = -18.0 - 3.0103;   // RMS of a sine at −18 dBFS peak
            println!("[mic-src] {} Hz → 44.1 kHz: 1 kHz −18 dBFS reads {:.3} dBFS RMS (a sine at −18 peak = {:.3}) · spurs + noise {:.1} dB below the tone · underruns {}",
                     rate, level, want, -spur, sh.underruns.load(Ordering::Relaxed));
            assert!((level - want).abs() < 0.05, "{} Hz: level {:.3} vs {:.3}", rate, level, want);
            assert!(spur < -90.0, "{} Hz: spurs + noise only {:.1} dB below the tone (bar 90)", rate, -spur);
        }
    }

    #[test]
    fn a_lost_device_is_one_event_silence_never_an_end_and_it_recovers() {
        let sh = Arc::new(MicShared::default());
        let (mut prod, cons) = mic_ring(48_000);
        let mut li = LiveIn::new(cons, 48_000, sh.clone());
        let mut g = Gen { rate: 48_000.0, freq: 1000.0, amp: 0.3, n: 0 };
        let (mut blk, mut feed) = (Vec::new(), vec![0f32; 960]);
        let mut feed_in = |k: usize, li: &mut LiveIn, prod: &mut HeapProd<f32>, g: &mut Gen, blk: &mut Vec<f32>, feed: &mut Vec<f32>, live: bool| -> f32 {
            let mut pk = 0f32;
            for _ in 0..k {
                if live { g.block(blk, 522); input_block(blk, 1, 0, prod, &sh, |x| x); }
                li.pull(feed, 480);
                pk = feed.iter().fold(0f32, |m, v| m.max(v.abs()));
            }
            pk
        };
        let pk_live = feed_in(200, &mut li, &mut prod, &mut g, &mut blk, &mut feed, true);
        let pk_gone = feed_in(300, &mut li, &mut prod, &mut g, &mut blk, &mut feed, false);   // unplugged: no input
        let u = sh.underruns.load(Ordering::Relaxed);
        let pk_back = feed_in(200, &mut li, &mut prod, &mut g, &mut blk, &mut feed, true);
        println!("[mic-loss] live peak {:.3} · after 300 buffers with no input: peak {:.1e}, {} underrun EVENT(s), starved {:.2} s · input back: peak {:.3}",
                 pk_live, pk_gone, u, sh.starved_frames.load(Ordering::Relaxed) as f64 / 44_100.0, pk_back);
        assert!(pk_live > 0.25);
        assert_eq!(pk_gone, 0.0, "silence while the device is gone");
        assert_eq!(u, 1, "a lost device is ONE starvation event, not one per buffer");
        assert!(pk_back > 0.25, "the feed recovers when input returns");
    }

    #[test]
    fn stale_audio_is_thrown_away_so_the_mic_never_comes_back_late() {
        let sh = Arc::new(MicShared::default());
        let (mut prod, cons) = mic_ring(48_000);
        let mut li = LiveIn::new(cons, 48_000, sh.clone());
        let mut g = Gen { rate: 48_000.0, freq: 1000.0, amp: 0.3, n: 0 };
        let (mut blk, mut feed) = (Vec::new(), vec![0f32; 960]);
        for _ in 0..50 { g.block(&mut blk, 522); input_block(&blk, 1, 0, &mut prod, &sh, |x| x); li.pull(&mut feed, 480); }
        // the output stops for 300 ms while the input keeps writing
        for _ in 0..30 { g.block(&mut blk, 480); input_block(&blk, 1, 0, &mut prod, &sh, |x| x); }
        let before = prod.occupied_len() as f64 / 48.0;
        li.pull(&mut feed, 480);
        let after = bits_f64(sh.fill_bits.load(Ordering::Relaxed)) / 48.0;
        println!("[mic-stale] output stalled 300 ms: ring held {:.0} ms → flushed to {:.1} ms (target {:.1} ms), {} flush",
                 before, after, bits_f64(sh.target_bits.load(Ordering::Relaxed)) / 48.0, sh.stale_flushes.load(Ordering::Relaxed));
        assert_eq!(sh.stale_flushes.load(Ordering::Relaxed), 1);
        assert!(after < 40.0, "latency not restored: {:.1} ms", after);
    }

    #[test]
    fn digital_zero_overrun_and_the_channel_pick() {
        let sh = MicShared::default();
        let (mut prod, mut cons) = HeapRb::<f32>::new(1000).split();
        // stereo device, input 2 carried
        let data: Vec<f32> = (0..400).map(|i| if i % 2 == 1 { 0.5 } else { 0.0 }).collect();
        input_block(&data, 2, 1, &mut prod, &sh, |x| x);
        assert_eq!(cons.try_pop(), Some(0.5), "input 2 carried");
        assert_eq!(sh.zero_run.load(Ordering::Relaxed), 0);
        input_block(&data, 2, 0, &mut prod, &sh, |x| x);            // input 1 is exact zeros
        assert_eq!(sh.zero_run.load(Ordering::Relaxed), 200, "exact zeros are counted");
        input_block(&vec![0.1f32; 4000], 1, 0, &mut prod, &sh, |x| x);   // does not fit
        assert_eq!(sh.overruns.load(Ordering::Relaxed), 1, "a block that does not fit is dropped and counted");
        assert_eq!(sh.zero_run.load(Ordering::Relaxed), 0, "a non-zero block resets the zero run");
        // i16 conversion
        use cpal::Sample;
        let (mut p2, mut c2) = HeapRb::<f32>::new(10).split();
        input_block(&[16384i16], 1, 0, &mut p2, &sh, |x: i16| x.to_sample::<f32>());
        assert!((c2.try_pop().unwrap() - 0.5).abs() < 1e-4);
    }

    #[test]
    fn a_gain_change_ramps_and_the_range_is_minus_10_to_plus_40() {
        assert!((db_to_lin(60.0) - 100.0).abs() < 1e-3, "+40 dB is the top");
        assert!((db_to_lin(-30.0) - 10f32.powf(-0.5)).abs() < 1e-6, "−10 dB is the bottom");
        let sh = Arc::new(MicShared::default());
        let (mut prod, cons) = mic_ring(44_100);
        let mut li = LiveIn::new(cons, 44_100, sh.clone());
        let (mut feed, dc) = (vec![0f32; 960], vec![0.01f32; 480]);
        for _ in 0..20 { input_block(&dc, 1, 0, &mut prod, &sh, |x| x); li.pull(&mut feed, 480); }
        sh.gain_bits.store(db_to_lin(20.0).to_bits(), Ordering::Relaxed);
        input_block(&dc, 1, 0, &mut prod, &sh, |x| x);
        li.pull(&mut feed, 480);
        let (first, last) = (feed[0], feed[2 * 479]);
        println!("[mic-gain] 0 → +20 dB across one buffer: first sample {:.5}, last {:.5} (0.01 → 0.1)", first, last);
        assert!(first < 0.0105 && (last - 0.1).abs() < 1e-3, "the gain step was not ramped across the buffer");
    }

    #[test]
    fn neither_callback_allocates() {
        // THE TRAP, both callbacks: the input body and the consumer pull, 2000 buffers each, inside RtScope.
        let sh = Arc::new(MicShared::default());
        let (mut prod, cons) = mic_ring(48_000);
        let mut li = LiveIn::new(cons, 48_000, sh.clone());
        let blk: Vec<f32> = (0..522).map(|i| (i as f32 * 0.13).sin() * 0.2).collect();
        let blk16: Vec<i16> = blk.iter().map(|&x| (x * 32767.0) as i16).collect();
        let mut feed = vec![0f32; 960];
        let a0 = crate::rt::tl_rt_allocs();
        {
            let _rt = crate::rt::RtScope::enter();
            use cpal::Sample;
            for k in 0..2000 {
                if k % 2 == 0 { input_block(&blk, 1, 0, &mut prod, &sh, |x| x); }
                else { input_block(&blk16, 1, 0, &mut prod, &sh, |x: i16| x.to_sample::<f32>()); }
                li.pull(&mut feed, 480);
            }
        }
        let n = crate::rt::tl_rt_allocs() - a0;
        println!("[trap] mic input callback body + live-feed pull × 2000 buffers inside RtScope: {} allocations", n);
        assert_eq!(n, 0);
    }
}
