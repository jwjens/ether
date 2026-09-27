// rta.rs — SLICE 8: the live RTA behind the rack's EQ curve (docs/dsp-channel-rta.md).
//
// THE AUDIO THREAD ONLY COPIES. One target at a time (a channel, or the master), chosen by `Params.rta`; with no
// target the callback does one branch and nothing else. With a target it pushes that target's PRE-rack and POST-rack
// lanes (both PRE-FADER — Jeff's ruling 5), mono (L+R)/2, into two preallocated SPSC rings in lockstep: a buffer goes
// into both or neither (counted as dropped, never blocking).
//
// THE METER THREAD DOES THE MATHS (the slice 3 thread, its 20 ms tick): a 4096-point Hann FFT every 2048 samples
// (ruling 1 — 21.5 frames/s), ISO third-octave bands 20 Hz–20 kHz (ruling 2, 31 bands), each the power sum of the
// bins inside its edges (a bin straddling an edge is split by overlap), in dBFS calibrated so a full-scale SINE reads
// 0 dB in its band (the Hann window's power gain is corrected). Instant attack, 300 ms release (exponential in power).
// Peak hold is the view's (ruling 3: off by default, a toggle) — it needs no engine state.
//
// THE FINE WAVE (2026-09-26, Jeff: "31 flat one-colour bars … is worse"): besides the 31 bands, every frame also carries
// RTA_FINE = 241 points log-spaced 20 Hz–20 kHz (24 per octave). Each is the power sum of the bins in a window 1/24
// octave wide — never narrower than 3 bins (a Hann main lobe), so a tone reads its level at the point nearest it at
// every frequency; below ~1.1 kHz that makes the window a constant 32 Hz (smoother there than 1/24 octave, and noise
// reads a little higher). Same calibration (a full-scale sine = 0 dB) and the same ballistics as the bands. The view
// draws these as the wave; the bands stay as the numeric readout.
//
// THE HONEST LIMIT: bins are 10.8 Hz wide. A band narrower than 3 bins cannot hold a Hann main lobe, so it reads low
// for a pure tone and is published as COARSE (`coarse_below_hz`) — the view hatches it rather than claim precision.

use std::sync::Arc;
use std::sync::atomic::{AtomicI32, AtomicU64, Ordering};
use ringbuf::{HeapRb, HeapProd, HeapCons, traits::{Producer, Consumer, Observer, Split}};
use crate::rt::{triple, TripleReader, TripleWriter};

pub(crate) const RTA_FFT: usize = 4096;
pub(crate) const RTA_HOP: usize = 2048;
pub(crate) const RTA_BANDS: usize = 31;
/// The fine wave: 241 points, 20 Hz × 1000^(k/240) — 24 per octave.
pub(crate) const RTA_FINE: usize = 241;
pub(crate) fn fine_freq(k: usize) -> f64 { 20.0 * 1000f64.powf(k as f64 / (RTA_FINE - 1) as f64) }
/// The fine point nearest a frequency.
pub(crate) fn fine_index(f: f64) -> usize { (((f / 20.0).ln() / 1000f64.ln()) * (RTA_FINE - 1) as f64).round().clamp(0.0, (RTA_FINE - 1) as f64) as usize }
pub(crate) const RTA_RING: usize = 16_384;
pub(crate) const RTA_RATE: f64 = 44_100.0;
pub(crate) const RTA_FLOOR_DB: f32 = -120.0;
pub(crate) const RTA_RELEASE_MS: f64 = 300.0;
/// Nominal ISO third-octave centres (the labels). The band EDGES come from the exact base-2 series.
pub(crate) const RTA_CENTRES: [f32; RTA_BANDS] = [
    20.0, 25.0, 31.5, 40.0, 50.0, 63.0, 80.0, 100.0, 125.0, 160.0, 200.0, 250.0, 315.0, 400.0, 500.0, 630.0,
    800.0, 1000.0, 1250.0, 1600.0, 2000.0, 2500.0, 3150.0, 4000.0, 5000.0, 6300.0, 8000.0, 10000.0, 12500.0, 16000.0, 20000.0,
];
/// A band must span at least this many bins to hold a Hann main lobe (±1.5 bins of a tone) — below it: COARSE.
const RTA_MIN_BINS: f64 = 3.0;

/// Exact band centre (base-2 series, 1 kHz = band 17) and edges.
pub(crate) fn band_centre(b: usize) -> f64 { 1000.0 * 2f64.powf((b as f64 - 17.0) / 3.0) }
pub(crate) fn band_edges(b: usize) -> (f64, f64) { let c = band_centre(b); (c * 2f64.powf(-1.0 / 6.0), c * 2f64.powf(1.0 / 6.0)) }
/// The lowest band that is NOT coarse at this FFT size.
pub(crate) fn coarse_below_hz() -> f32 {
    let df = RTA_RATE / RTA_FFT as f64;
    (0..RTA_BANDS).find(|&b| { let (lo, hi) = band_edges(b); (hi - lo) / df >= RTA_MIN_BINS }).map(|b| RTA_CENTRES[b]).unwrap_or(20000.0)
}

/// What the RTA listens to. Rides the Params block; `None` = the callback does nothing.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum RtaTarget { #[default] None, Channel(u8), Master }
impl RtaTarget {
    pub(crate) fn code(self) -> i32 { match self { RtaTarget::None => -1, RtaTarget::Channel(s) => s as i32, RtaTarget::Master => 12 } }
}

/// Counters both ends read. `target` is the target the CALLBACK is serving (it writes it when it changes).
pub(crate) struct RtaShared { pub pushed: AtomicU64, pub dropped: AtomicU64, pub target: AtomicI32 }

/// The callback end.
pub(crate) struct RtaTaps { pre: HeapProd<f32>, post: HeapProd<f32>, pub(crate) shared: Arc<RtaShared>, served: i32 }
/// The meter-thread end.
pub(crate) struct RtaCons { pre: HeapCons<f32>, post: HeapCons<f32> }

pub(crate) fn rta_channels() -> (RtaTaps, RtaCons, Arc<RtaShared>) {
    let (pp, pc) = HeapRb::<f32>::new(RTA_RING).split();
    let (qp, qc) = HeapRb::<f32>::new(RTA_RING).split();
    let shared = Arc::new(RtaShared { pushed: AtomicU64::new(0), dropped: AtomicU64::new(0), target: AtomicI32::new(-1) });
    (RtaTaps { pre: pp, post: qp, shared: shared.clone(), served: -1 }, RtaCons { pre: pc, post: qc }, shared)
}

impl RtaTaps {
    /// Once per buffer: publish which target is being served (a store only when it changes).
    #[inline]
    pub(crate) fn serve(&mut self, t: RtaTarget) {
        let c = t.code();
        if c != self.served { self.served = c; self.shared.target.store(c, Ordering::Release); }
    }
    /// Push `n` frames of both lanes, mono. `pre(f)` / `post(f)` give frame f's (L, R). Lockstep: both or neither.
    #[inline]
    pub(crate) fn push(&mut self, n: usize, pre: impl Fn(usize) -> (f32, f32), post: impl Fn(usize) -> (f32, f32)) {
        if self.pre.vacant_len() < n || self.post.vacant_len() < n {
            self.shared.dropped.fetch_add(n as u64, Ordering::Relaxed);
            return;
        }
        for f in 0..n {
            let (l, r) = pre(f);
            let _ = self.pre.try_push(0.5 * (l + r));
            let (l, r) = post(f);
            let _ = self.post.try_push(0.5 * (l + r));
        }
        self.shared.pushed.fetch_add(n as u64, Ordering::Relaxed);
    }
}

/// One published RTA frame (Copy — rides a triple buffer).
#[derive(Clone, Copy, Debug)]
pub(crate) struct RtaFrame {
    pub seq: u64,
    /// -1 none · 0..11 a channel (engine slot) · 12 the master.
    pub target: i32,
    /// A frame for this target arrived within the last 500 ms.
    pub fed: bool,
    pub pre: [f32; RTA_BANDS],
    pub post: [f32; RTA_BANDS],
    /// The fine wave (RTA_FINE points), pre and post.
    pub fine_pre: [f32; RTA_FINE],
    pub fine_post: [f32; RTA_FINE],
    pub pushed: u64,
    pub dropped: u64,
}
impl Default for RtaFrame {
    fn default() -> Self { RtaFrame { seq: 0, target: -1, fed: false, pre: [RTA_FLOOR_DB; RTA_BANDS], post: [RTA_FLOOR_DB; RTA_BANDS],
                                      fine_pre: [RTA_FLOOR_DB; RTA_FINE], fine_post: [RTA_FLOOR_DB; RTA_FINE], pushed: 0, dropped: 0 } }
}
pub(crate) type RtaReader = Arc<std::sync::Mutex<TripleReader<RtaFrame>>>;

/// The meter-thread analyser. Everything preallocated in `new`.
pub(crate) struct RtaAnalyzer {
    cons: RtaCons,
    pub(crate) shared: Arc<RtaShared>,
    hist: [Vec<f32>; 2],     // the last RTA_FFT samples per lane
    staged: [Vec<f32>; 2],   // one hop being gathered
    got: usize,
    fft: Arc<dyn rustfft::Fft<f32>>,
    buf: Vec<rustfft::num_complex::Complex<f32>>,
    work: Vec<rustfft::num_complex::Complex<f32>>,
    window: Vec<f32>,
    norm: f64,               // 2 / (N · Σw²): one-sided |X|² → mean-square
    /// Per band: the bins it touches and each bin's overlap weight (precomputed).
    band_bins: Vec<Vec<(usize, f64)>>,
    /// Per fine point: its window's bins and weights (precomputed).
    fine_bins: Vec<Vec<(usize, f64)>>,
    decay_db: f32,
    pub(crate) disp: [[f32; RTA_BANDS]; 2],
    /// The last frame's bands BEFORE the ballistics (dB) — what the tests average.
    pub(crate) raw: [[f32; RTA_BANDS]; 2],
    pub(crate) fine_disp: [[f32; RTA_FINE]; 2],
    pub(crate) fine_raw: [[f32; RTA_FINE]; 2],
    frames: u64,
    target: i32,
    last_frame: Option<std::time::Instant>,
    writer: TripleWriter<RtaFrame>,
}

impl RtaAnalyzer {
    pub(crate) fn new(cons: RtaCons, shared: Arc<RtaShared>) -> (RtaAnalyzer, RtaReader) {
        let mut planner = rustfft::FftPlanner::new();
        let fft = planner.plan_fft_forward(RTA_FFT);
        let work_len = fft.get_inplace_scratch_len();
        let window: Vec<f32> = (0..RTA_FFT).map(|i| (0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / RTA_FFT as f64).cos()) as f32).collect();
        let sum_w2: f64 = window.iter().map(|&w| (w as f64) * (w as f64)).sum();
        let df = RTA_RATE / RTA_FFT as f64;
        let band_bins = (0..RTA_BANDS).map(|b| {
            let (lo, hi) = band_edges(b);
            let mut v = Vec::new();
            let k0 = ((lo / df) - 0.5).floor().max(1.0) as usize;
            let k1 = (((hi / df) + 0.5).ceil() as usize).min(RTA_FFT / 2);
            for k in k0..=k1 {
                let (a, z) = ((k as f64 - 0.5) * df, (k as f64 + 0.5) * df);
                let ov = (z.min(hi) - a.max(lo)).max(0.0) / df;
                if ov > 0.0 { v.push((k, ov)); }
            }
            v
        }).collect();
        let fine_bins = (0..RTA_FINE).map(|k| {
            let f = fine_freq(k);
            let half = (f * (2f64.powf(1.0 / 48.0) - 2f64.powf(-1.0 / 48.0)) / 2.0).max(1.5 * df);   // ≥ 3 bins wide
            let (lo, hi) = (f - half, f + half);
            let mut v = Vec::new();
            let k0 = ((lo / df) - 0.5).floor().max(1.0) as usize;
            let k1 = (((hi / df) + 0.5).ceil() as usize).min(RTA_FFT / 2);
            for b in k0..=k1 {
                let (a, z) = ((b as f64 - 0.5) * df, (b as f64 + 0.5) * df);
                let ov = (z.min(hi) - a.max(lo)).max(0.0) / df;
                if ov > 0.0 { v.push((b, ov)); }
            }
            v
        }).collect();
        let hop_s = RTA_HOP as f64 / RTA_RATE;
        let (w, r) = triple(RtaFrame::default());
        (RtaAnalyzer {
            cons, shared,
            hist: [vec![0.0; RTA_FFT], vec![0.0; RTA_FFT]],
            staged: [vec![0.0; RTA_HOP], vec![0.0; RTA_HOP]],
            got: 0, fft,
            buf: vec![rustfft::num_complex::Complex::new(0.0, 0.0); RTA_FFT],
            work: vec![rustfft::num_complex::Complex::new(0.0, 0.0); work_len],
            window, norm: 2.0 / (RTA_FFT as f64 * sum_w2), band_bins, fine_bins,
            decay_db: (10.0 * std::f64::consts::LOG10_E * hop_s * 1000.0 / RTA_RELEASE_MS) as f32,
            disp: [[RTA_FLOOR_DB; RTA_BANDS]; 2], raw: [[RTA_FLOOR_DB; RTA_BANDS]; 2],
            fine_disp: [[RTA_FLOOR_DB; RTA_FINE]; 2], fine_raw: [[RTA_FLOOR_DB; RTA_FINE]; 2],
            frames: 0, target: -1, last_frame: None, writer: w,
        }, Arc::new(std::sync::Mutex::new(r)))
    }

    /// The meter thread's tick: take what the callback pushed, analyse every whole hop, publish. Returns the number
    /// of frames analysed.
    pub(crate) fn drain(&mut self) -> usize {
        let t = self.shared.target.load(Ordering::Acquire);
        if t != self.target {
            // A new target (or none): start clean — never show the old channel's spectrum as the new one's.
            self.target = t;
            for h in self.hist.iter_mut() { h.iter_mut().for_each(|x| *x = 0.0); }
            self.got = 0;
            self.disp = [[RTA_FLOOR_DB; RTA_BANDS]; 2];
            self.raw = [[RTA_FLOOR_DB; RTA_BANDS]; 2];
            self.fine_disp = [[RTA_FLOOR_DB; RTA_FINE]; 2];
            self.fine_raw = [[RTA_FLOOR_DB; RTA_FINE]; 2];
            self.last_frame = None;
            // What is already in the rings belongs to the old target: discard it.
            let mut tmp = [0f32; 256];
            while self.cons.pre.pop_slice(&mut tmp) > 0 {}
            while self.cons.post.pop_slice(&mut tmp) > 0 {}
        }
        let mut n = 0;
        loop {
            let want = RTA_HOP - self.got;
            let avail = self.cons.pre.occupied_len().min(self.cons.post.occupied_len());
            let take = want.min(avail);
            if take == 0 { break; }
            let g = self.got;
            self.cons.pre.pop_slice(&mut self.staged[0][g..g + take]);
            self.cons.post.pop_slice(&mut self.staged[1][g..g + take]);
            self.got += take;
            if self.got == RTA_HOP {
                self.got = 0;
                for lane in 0..2 {
                    self.hist[lane].copy_within(RTA_HOP.., 0);
                    let (h, s) = (&mut self.hist[lane], &self.staged[lane]);
                    h[RTA_FFT - RTA_HOP..].copy_from_slice(s);
                    self.analyse(lane);
                }
                self.frames += 1;
                self.last_frame = Some(std::time::Instant::now());
                n += 1;
            }
        }
        self.publish();
        n
    }

    fn analyse(&mut self, lane: usize) {
        use rustfft::num_complex::Complex;
        for i in 0..RTA_FFT { self.buf[i] = Complex::new(self.hist[lane][i] * self.window[i], 0.0); }
        self.fft.process_with_scratch(&mut self.buf, &mut self.work);
        for b in 0..RTA_BANDS {
            let mut p = 0.0f64;
            for &(k, w) in self.band_bins[b].iter() { p += self.buf[k].norm_sqr() as f64 * w; }
            let ms = p * self.norm;                       // the band's mean-square
            let db = if ms > 0.0 { (10.0 * (2.0 * ms).log10()) as f32 } else { RTA_FLOOR_DB };   // sine-peak dB
            let db = db.max(RTA_FLOOR_DB);
            self.raw[lane][b] = db;
            let d = &mut self.disp[lane][b];
            *d = if db >= *d { db } else { (*d - self.decay_db).max(db) };   // instant attack, 300 ms release
        }
        for k in 0..RTA_FINE {
            let mut p = 0.0f64;
            for &(b, w) in self.fine_bins[k].iter() { p += self.buf[b].norm_sqr() as f64 * w; }
            let ms = p * self.norm;
            let db = (if ms > 0.0 { (10.0 * (2.0 * ms).log10()) as f32 } else { RTA_FLOOR_DB }).max(RTA_FLOOR_DB);
            self.fine_raw[lane][k] = db;
            let d = &mut self.fine_disp[lane][k];
            *d = if db >= *d { db } else { (*d - self.decay_db).max(db) };
        }
    }

    fn publish(&mut self) {
        let fed = self.target >= 0 && self.last_frame.map(|t| t.elapsed() < std::time::Duration::from_millis(500)).unwrap_or(false);
        let f = self.writer.slot();
        f.seq = self.frames;
        f.target = self.target;
        f.fed = fed;
        f.pre = self.disp[0];
        f.post = self.disp[1];
        f.fine_pre = self.fine_disp[0];
        f.fine_post = self.fine_disp[1];
        f.pushed = self.shared.pushed.load(Ordering::Relaxed);
        f.dropped = self.shared.dropped.load(Ordering::Relaxed);
        self.writer.publish();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed(an: &mut RtaAnalyzer, taps: &mut RtaTaps, x: &[f32]) {
        for c in x.chunks(480) { taps.push(c.len(), |f| (c[f], c[f]), |f| (c[f], c[f])); an.drain(); }
    }

    #[test]
    fn a_full_scale_sine_reads_0_db_and_minus_18_reads_minus_18_in_its_band() {
        let (mut taps, cons, shared) = rta_channels();
        let (mut an, _r) = RtaAnalyzer::new(cons, shared);
        taps.serve(RtaTarget::Channel(7));
        for (amp_db, f) in [(0.0f64, 1000.0f64), (-18.0, 1000.0), (-18.0, 315.0), (-18.0, 8000.0)] {
            let a = 10f64.powf(amp_db / 20.0);
            let x: Vec<f32> = (0..44_100).map(|i| (a * (2.0 * std::f64::consts::PI * f * i as f64 / RTA_RATE).sin()) as f32).collect();
            feed(&mut an, &mut taps, &x);
            let b = RTA_CENTRES.iter().position(|&c| (c as f64 - f).abs() < 1.0).unwrap();
            let r = an.raw[0][b];
            println!("[rta-cal] {:.0} Hz sine at {:+.0} dBFS reads {:+.3} dB in its band ({} Hz)", f, amp_db, r, RTA_CENTRES[b]);
            assert!((r as f64 - amp_db).abs() < 0.2, "{f} Hz at {amp_db} read {r}");
        }
    }

    #[test]
    fn a_tone_peaks_at_its_own_fine_point_at_its_level() {
        let (mut taps, cons, shared) = rta_channels();
        let (mut an, _r) = RtaAnalyzer::new(cons, shared);
        taps.serve(RtaTarget::Channel(7));
        let mut worst = 0.0f64;
        let mut lines = Vec::new();
        for f in [60.0f64, 125.0, 440.0, 1000.0, 3150.0, 9000.0, 16000.0] {
            let a = 10f64.powf(-18.0 / 20.0);
            let x: Vec<f32> = (0..44_100).map(|i| (a * (2.0 * std::f64::consts::PI * f * i as f64 / RTA_RATE).sin()) as f32).collect();
            feed(&mut an, &mut taps, &x);
            let (k, v) = an.fine_raw[0].iter().enumerate().fold((0, f32::MIN), |m, (i, &v)| if v > m.1 { (i, v) } else { m });
            // Where it can land: within 1/24 octave, or within one FFT bin where a bin is wider than that (below ~1 kHz,
            // 1/24 octave is narrower than the 10.8 Hz bin — position there is resolved to a bin, no finer).
            let tol_hz = (f * (2f64.powf(1.0 / 24.0) - 1.0)).max(RTA_RATE / RTA_FFT as f64);
            lines.push(format!("{f:.0} Hz → peak at {:.1} Hz ({:+.1} Hz, tol {:.1}), {:+.2} dB", fine_freq(k), fine_freq(k) - f, tol_hz, v));
            assert!((fine_freq(k) - f).abs() <= tol_hz + 1e-9, "{f} Hz peaked at {} Hz", fine_freq(k));
            if (v as f64 + 18.0).abs() > worst.abs() { worst = v as f64 + 18.0; }
        }
        println!("[rta-fine] a −18 dBFS tone peaks at the fine point nearest it (within 1/24 octave, or one 10.8 Hz bin where that is wider) at −18 {:+.2} dB at worst: {}", worst, lines.join(" · "));
        assert!(worst.abs() < 0.5);
    }

    #[test]
    fn instant_attack_and_a_300_ms_release() {
        let (mut taps, cons, shared) = rta_channels();
        let (mut an, _r) = RtaAnalyzer::new(cons, shared);
        taps.serve(RtaTarget::Master);
        let x: Vec<f32> = (0..22_050).map(|i| (0.5 * (2.0 * std::f64::consts::PI * 1000.0 * i as f64 / RTA_RATE).sin()) as f32).collect();
        feed(&mut an, &mut taps, &x);
        let b = 17;
        let top = an.disp[0][b];
        feed(&mut an, &mut taps, &vec![0.0f32; 44_100 * 3 / 10]);   // 300 ms of silence
        let after = an.disp[0][b];
        let per_hop = an.decay_db;
        println!("[rta-ballistics] 1 kHz at -6 dBFS: display {:.2} dB; after 300 ms of silence {:.2} dB (release {:.3} dB per 46 ms hop = {:.1} dB/s; τ = 300 ms is 4.34 dB)", top, after, per_hop, per_hop as f64 * RTA_RATE / RTA_HOP as f64);
        assert!((top + 6.02).abs() < 0.2);
        let drop = top - after;
        assert!(drop > 3.0 && drop < 6.0, "released {drop} dB in 300 ms");
    }

    #[test]
    fn a_new_target_starts_clean() {
        let (mut taps, cons, shared) = rta_channels();
        let (mut an, r) = RtaAnalyzer::new(cons, shared);
        taps.serve(RtaTarget::Channel(1));
        let x: Vec<f32> = (0..22_050).map(|i| (0.5 * (2.0 * std::f64::consts::PI * 1000.0 * i as f64 / RTA_RATE).sin()) as f32).collect();
        feed(&mut an, &mut taps, &x);
        taps.serve(RtaTarget::Channel(2));
        an.drain();
        let f = r.lock().unwrap().read();
        assert_eq!(f.target, 2);
        assert!(!f.fed && f.pre.iter().all(|&v| v == RTA_FLOOR_DB), "the old channel's spectrum survived a target change");
    }

    #[test]
    fn the_coarse_limit_is_where_a_band_holds_three_bins() {
        let c = coarse_below_hz();
        println!("[rta-coarse] 4096 points at 44.1 kHz: bins {:.2} Hz wide; bands below {} Hz are narrower than {} bins and published as COARSE", RTA_RATE / RTA_FFT as f64, c, RTA_MIN_BINS);
        assert!(c > 100.0 && c < 250.0);
    }
}
