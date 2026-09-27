// ── SLICE 3 — BS.1770 LOUDNESS PER BRANCH, MEASURED OFF THE AUDIO THREAD (docs/dsp-loudness-meter.md) ──
//
// What leaves each branch is measured: LOCAL at the device feed dl/dr (before the monitor knobs — Jeff's
// ruling 6, the harness's monitor tap), STREAM at exactly the samples the encoder ring gets, AUX at the
// aux monitor feed. Momentary, short-term, integrated (gated, BS.1770-4: −70 absolute / −10 relative),
// LRA (Tech 3342) and true peak (4× oversampled) — the `ebur128` crate the engine already links.
//
// WHY NOT IN THE CALLBACK (§1.3, measured before building): in HISTOGRAM mode the meter allocates nothing,
// but reading S/I/LRA costs ~0.2 ms median and up to 5 ms (loudness_shortterm re-sums a 3 s window), and the
// LRA step spikes an add to ~0.5 ms. So the callback does only a copy: each branch's samples go into a
// preallocated lock-free ring (LoudTaps::push — no allocation, never blocks, drops-and-counts when full),
// and a per-station METER THREAD owns the BS.1770 state (LoudnessMeters). It publishes a LoudnessFrame
// through a triple buffer, read by audio_get_meters beside the meter-bus frame — the same wire.
//
// QUEUE MODE, 24 h (Jeff's ruling 1): the exact integrator. Histogram mode's +0.064 LU bias (Tech 3341 #5
// read −22.936) is not acceptable for a compliance meter. The history is capped at 24 h; past that, I and
// LRA are a sliding 24 h and the frame says so (`capped`).
//
// ⚠ THE CRATE TRAP (ebur128 0.1.10): set_max_history() pads the queue with 0.0 energies
// (history.rs Queue::set_max_size → VecDeque::resize), which bypass the −70 absolute gate and inflate the
// block count behind the relative gate. Measured: Tech 3341 #3 read I −24.153 instead of −23.011, and
// Tech 3342 #4 read LRA 30 instead of 15. reset() clears the queue, so every capped meter is RESET
// IMMEDIATELY after the cap is set (new_meter). Pinned by the test `capped_history_is_reset_before_use`.

use std::sync::{Arc, atomic::{AtomicBool, AtomicU64, Ordering}};
use ebur128::{EbuR128, Mode};
use ringbuf::{HeapRb, HeapProd, HeapCons, traits::{Producer, Consumer, Observer, Split}};
use crate::rt::{triple, TripleWriter, TripleReader};

/// Branch indices, in wire order.
pub(crate) const LOUD_LOCAL: usize = 0;
pub(crate) const LOUD_STREAM: usize = 1;
pub(crate) const LOUD_AUX: usize = 2;
pub(crate) const LOUD_BRANCHES: usize = 3;

/// Ring capacity per lane (planar L and R), frames: 2 s at the program rate. The meter thread drains every
/// LOUD_TICK_MS, so this is 100× headroom; a full ring means the thread was starved, and is counted.
pub(crate) const LOUD_RING_FRAMES: usize = 44_100 * 2;
/// Integrated / LRA history cap (ruling 1).
pub(crate) const LOUD_HISTORY_MS: u32 = 24 * 60 * 60 * 1000;
/// Meter thread cadence: drain every 20 ms, publish every 100 ms.
pub(crate) const LOUD_TICK_MS: u64 = 20;
pub(crate) const LOUD_PUBLISH_MS: u64 = 100;
/// A branch that has received nothing for this many publishes is reported as not fed (the AUX feed exists
/// only while an aux deck plays). Its M/S are then withheld rather than frozen on the last value.
const UNFED_AFTER_PUBLISHES: u64 = 5;

/// What each branch measures. LOCAL and STREAM are the compliance meters: everything. AUX (ruling 4: its
/// OUT estimate is deleted and measured instead) is the monitor feed to the park speakers: M and TP.
fn mode_for(branch: usize) -> Mode {
    if branch == LOUD_AUX { Mode::M | Mode::TRUE_PEAK } else { Mode::I | Mode::S | Mode::LRA | Mode::TRUE_PEAK }
}

/// One BS.1770 meter for a branch, capped and — THE CRATE TRAP above — reset immediately after the cap.
fn new_meter(branch: usize, rate: u32) -> EbuR128 {
    let mode = mode_for(branch);
    let mut m = EbuR128::new(2, rate, mode).expect("ebur128");
    if mode.contains(Mode::I) {
        m.set_max_history(LOUD_HISTORY_MS).expect("ebur128 history");
        m.reset();
    }
    m
}

/// Shared between the callback end, the meter thread and the reset command (audio_loudness_reset).
pub(crate) struct LoudShared {
    /// Bumped by the reset command; the meter thread resets a branch when it sees a new value.
    pub reset_epoch: [AtomicU64; LOUD_BRANCHES],
    /// Frames the callback could not queue (ring full) — audio the meter never saw. Never reset; the meter
    /// reports the count since its own last reset.
    pub drop_frames: [AtomicU64; LOUD_BRANCHES],
    /// Set when the callback end is dropped (the station's state is gone): the meter thread exits.
    pub stop: AtomicBool,
}

/// THE CALLBACK END. Owned by BusState. push() is the only thing the audio thread does for loudness.
pub(crate) struct LoudTaps {
    l: [HeapProd<f32>; LOUD_BRANCHES],
    r: [HeapProd<f32>; LOUD_BRANCHES],
    pub(crate) shared: Arc<LoudShared>,
}
impl LoudTaps {
    /// Queue one buffer of a branch's output. All-or-nothing per buffer so L and R stay sample-aligned;
    /// a full ring drops the buffer and counts it. No allocation, no lock, no wait.
    #[inline]
    pub(crate) fn push(&mut self, branch: usize, l: &[f32], r: &[f32]) {
        let n = l.len().min(r.len());
        if self.l[branch].vacant_len() >= n && self.r[branch].vacant_len() >= n {
            self.l[branch].push_slice(&l[..n]);
            self.r[branch].push_slice(&r[..n]);
        } else {
            self.shared.drop_frames[branch].fetch_add(n as u64, Ordering::Relaxed);
        }
    }
}
impl Drop for LoudTaps {
    fn drop(&mut self) { self.shared.stop.store(true, Ordering::Release); }
}

/// THE METER-THREAD END of the rings, until a LoudnessMeters takes it.
pub(crate) struct LoudCons {
    l: [HeapCons<f32>; LOUD_BRANCHES],
    r: [HeapCons<f32>; LOUD_BRANCHES],
}

/// Build the rings. Called by BusState::new, so a state can never exist without its taps.
pub(crate) fn loud_channels() -> (LoudTaps, LoudCons, Arc<LoudShared>) {
    let shared = Arc::new(LoudShared {
        reset_epoch: std::array::from_fn(|_| AtomicU64::new(0)),
        drop_frames: std::array::from_fn(|_| AtomicU64::new(0)),
        stop: AtomicBool::new(false),
    });
    let mut lp = Vec::new(); let mut lc = Vec::new(); let mut rp = Vec::new(); let mut rc = Vec::new();
    for _ in 0..LOUD_BRANCHES {
        let (p, c) = HeapRb::<f32>::new(LOUD_RING_FRAMES).split(); lp.push(p); lc.push(c);
        let (p, c) = HeapRb::<f32>::new(LOUD_RING_FRAMES).split(); rp.push(p); rc.push(c);
    }
    fn arr<T>(v: Vec<T>) -> [T; LOUD_BRANCHES] { v.try_into().ok().expect("LOUD_BRANCHES rings") }
    (LoudTaps { l: arr(lp), r: arr(rp), shared: shared.clone() }, LoudCons { l: arr(lc), r: arr(rc) }, shared)
}

/// One branch's published loudness. LUFS / LU values are f64 with −∞ (or NaN) meaning "no reading" —
/// the wire emits those as null, never as −70 dressed up as a measurement.
#[derive(Clone, Copy, Debug)]
pub(crate) struct BranchLoud {
    pub m: f64,
    pub s: f64,
    pub i: f64,
    pub lra: f64,
    /// True peak since the previous publish, per channel, dBTP.
    pub tp: [f64; 2],
    /// True peak since the last reset, dBTP (max of both channels).
    pub tp_max: f64,
    /// Samples arrived recently (AUX is only fed while an aux deck plays).
    pub fed: bool,
    /// Wall-clock ms at the last reset (or when the meter started).
    pub since_ms: u64,
    /// The reset epoch this reading belongs to (echoes the command).
    pub epoch: u64,
    /// Frames dropped since the last reset (ring full): audio the integrated value does not include.
    pub drop_frames: u64,
    /// Frames measured since the last reset.
    pub measured_frames: u64,
    /// The 24 h history cap has been reached: I and LRA are now a sliding 24 h.
    pub capped: bool,
    /// This branch computes I / S / LRA (LOCAL, STREAM) — AUX is M + TP only.
    pub full: bool,
}
impl Default for BranchLoud {
    fn default() -> Self {
        BranchLoud { m: f64::NEG_INFINITY, s: f64::NEG_INFINITY, i: f64::NEG_INFINITY, lra: f64::NAN,
                     tp: [f64::NEG_INFINITY; 2], tp_max: f64::NEG_INFINITY, fed: false, since_ms: 0, epoch: 0,
                     drop_frames: 0, measured_frames: 0, capped: false, full: false }
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct LoudnessFrame {
    /// Publishes since the meter started (0 = nothing published yet).
    pub seq: u64,
    pub b: [BranchLoud; LOUD_BRANCHES],
}

pub(crate) type LoudReader = Arc<std::sync::Mutex<TripleReader<LoudnessFrame>>>;

fn lin_to_dbtp(x: f64) -> f64 { if x > 0.0 { 20.0 * x.log10() } else { f64::NEG_INFINITY } }
fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// THE METER. Plain state with drain() and publish(): the live engine runs it on its own thread
/// (spawn_meter_thread); the offline harness calls drain() inline after every callback, so it is the same
/// code, deterministic.
pub(crate) struct LoudnessMeters {
    cons: LoudCons,
    shared: Arc<LoudShared>,
    rate: u32,
    meters: [EbuR128; LOUD_BRANCHES],
    seen_epoch: [u64; LOUD_BRANCHES],
    drop_base: [u64; LOUD_BRANCHES],
    since_ms: [u64; LOUD_BRANCHES],
    measured: [u64; LOUD_BRANCHES],
    rx_since_publish: [u64; LOUD_BRANCHES],
    last_rx_seq: [u64; LOUD_BRANCHES],
    tp_win: [[f64; 2]; LOUD_BRANCHES],
    buf_l: Vec<f32>,
    buf_r: Vec<f32>,
    seq: u64,
    writer: TripleWriter<LoudnessFrame>,
}
impl LoudnessMeters {
    pub(crate) fn new(cons: LoudCons, shared: Arc<LoudShared>, rate: u32) -> (LoudnessMeters, LoudReader) {
        let (writer, reader) = triple(LoudnessFrame::default());
        let t = now_ms();
        let drop_base = std::array::from_fn(|b| shared.drop_frames[b].load(Ordering::Relaxed));
        let seen_epoch = std::array::from_fn(|b| shared.reset_epoch[b].load(Ordering::Acquire));
        (LoudnessMeters {
            cons, shared, rate,
            meters: std::array::from_fn(|b| new_meter(b, rate)),
            seen_epoch, drop_base,
            since_ms: [t; LOUD_BRANCHES],
            measured: [0; LOUD_BRANCHES],
            rx_since_publish: [0; LOUD_BRANCHES],
            last_rx_seq: [0; LOUD_BRANCHES],
            tp_win: [[0.0; 2]; LOUD_BRANCHES],
            buf_l: vec![0.0; 4096], buf_r: vec![0.0; 4096],
            seq: 0,
            writer,
        }, Arc::new(std::sync::Mutex::new(reader)))
    }

    /// Apply any pending reset, then feed everything queued to the meters.
    pub(crate) fn drain(&mut self) {
        for b in 0..LOUD_BRANCHES {
            let e = self.shared.reset_epoch[b].load(Ordering::Acquire);
            if e != self.seen_epoch[b] {
                self.seen_epoch[b] = e;
                self.meters[b].reset();   // 0 allocations (measured); the queue keeps its capacity
                self.drop_base[b] = self.shared.drop_frames[b].load(Ordering::Relaxed);
                self.since_ms[b] = now_ms();
                self.measured[b] = 0;
                self.tp_win[b] = [0.0; 2];
            }
            loop {
                let avail = self.cons.l[b].occupied_len().min(self.cons.r[b].occupied_len()).min(self.buf_l.len());
                if avail == 0 { break; }
                let nl = self.cons.l[b].pop_slice(&mut self.buf_l[..avail]);
                let nr = self.cons.r[b].pop_slice(&mut self.buf_r[..avail]);
                let n = nl.min(nr);
                let _ = self.meters[b].add_frames_planar_f32(&[&self.buf_l[..n], &self.buf_r[..n]]);
                for c in 0..2 {
                    if let Ok(p) = self.meters[b].prev_true_peak(c as u32) { self.tp_win[b][c] = self.tp_win[b][c].max(p); }
                }
                self.measured[b] += n as u64;
                self.rx_since_publish[b] += n as u64;
            }
        }
    }

    /// Read every branch's meter and publish the frame.
    pub(crate) fn publish(&mut self) {
        self.seq += 1;
        let cap_frames = LOUD_HISTORY_MS as u64 * self.rate as u64 / 1000;
        let mut f = LoudnessFrame { seq: self.seq, b: [BranchLoud::default(); LOUD_BRANCHES] };
        for b in 0..LOUD_BRANCHES {
            if self.rx_since_publish[b] > 0 { self.last_rx_seq[b] = self.seq; }
            self.rx_since_publish[b] = 0;
            let m = &self.meters[b];
            let mode = mode_for(b);
            let fed = self.last_rx_seq[b] > 0 && self.seq - self.last_rx_seq[b] < UNFED_AFTER_PUBLISHES;
            let tp_max = m.true_peak(0).unwrap_or(0.0).max(m.true_peak(1).unwrap_or(0.0));
            f.b[b] = BranchLoud {
                m: if fed { m.loudness_momentary().unwrap_or(f64::NEG_INFINITY) } else { f64::NEG_INFINITY },
                s: if fed && mode.contains(Mode::S) { m.loudness_shortterm().unwrap_or(f64::NEG_INFINITY) } else { f64::NEG_INFINITY },
                i: if mode.contains(Mode::I) { m.loudness_global().unwrap_or(f64::NEG_INFINITY) } else { f64::NEG_INFINITY },
                lra: if mode.contains(Mode::LRA) { m.loudness_range().unwrap_or(f64::NAN) } else { f64::NAN },
                tp: [lin_to_dbtp(self.tp_win[b][0]), lin_to_dbtp(self.tp_win[b][1])],
                tp_max: lin_to_dbtp(tp_max),
                fed,
                since_ms: self.since_ms[b],
                epoch: self.seen_epoch[b],
                drop_frames: self.shared.drop_frames[b].load(Ordering::Relaxed).saturating_sub(self.drop_base[b]),
                measured_frames: self.measured[b],
                capped: mode.contains(Mode::I) && self.measured[b] >= cap_frames,
                full: mode.contains(Mode::I),
            };
            self.tp_win[b] = [0.0; 2];
        }
        *self.writer.slot() = f;
        self.writer.publish();
    }
}

/// The live meter thread: drain every LOUD_TICK_MS, publish every LOUD_PUBLISH_MS, exit when the station's
/// state (and with it the callback end) is dropped.
pub(crate) fn spawn_meter_thread(station_id: u32, mut m: LoudnessMeters, mut rta: Option<crate::rta::RtaAnalyzer>) {
    let _ = std::thread::Builder::new()
        .name(format!("ether-loudness-{}", station_id))
        .spawn(move || {
            let mut last = std::time::Instant::now();
            while !m.shared.stop.load(Ordering::Acquire) {
                m.drain();
                // SLICE 8 — the RTA: whatever the callback pushed for the one target a rack view listens to.
                if let Some(r) = rta.as_mut() { r.drain(); }
                if last.elapsed() >= std::time::Duration::from_millis(LOUD_PUBLISH_MS) {
                    m.publish();
                    last = std::time::Instant::now();
                }
                std::thread::sleep(std::time::Duration::from_millis(LOUD_TICK_MS));
            }
        });
}

/// The reset command: bump a branch's epoch (the meter thread applies it on its next drain).
pub(crate) fn request_reset(shared: &LoudShared, branch: usize) {
    if branch < LOUD_BRANCHES { shared.reset_epoch[branch].fetch_add(1, Ordering::AcqRel); }
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════════
// VERIFICATION — EBU Tech 3341 (Nov 2023) Table 1 and EBU Tech 3342 (Nov 2023) Table 1, quoted in
// docs/dsp-loudness-meter.md §5. Tolerances: loudness ±0.1 LU; true peak +0.2/−0.4 dB; LRA ±1 LU. "The
// loudness meter shall be reset before each measurement." Signals are synthesized from the tables at the
// engine's program rate and fed through the CALLBACK END (LoudTaps::push) in the engine's buffer sizes.
// The EBU's own files (48 kHz) are run in `ebu_test_set_every_case`.
//   cd native && cargo test --release --lib loudness -- --nocapture --test-threads=2
// ══════════════════════════════════════════════════════════════════════════════════════════════════════
#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::f64::consts::PI;

    pub(crate) const FS: u32 = 44_100;

    pub(crate) fn db(x: f64) -> f64 { 10f64.powf(x / 20.0) }

    /// (seconds, dBFS per-channel peak) segments of a 1 kHz sine, in phase on both channels; −∞ = silence.
    pub(crate) fn tones(fs: u32, segs: &[(f64, f64)]) -> Vec<f32> {
        let mut v = Vec::new();
        let mut n = 0u64;
        for &(sec, dbfs) in segs {
            let a = if dbfs.is_finite() { db(dbfs) } else { 0.0 };
            for _ in 0..(sec * fs as f64).round() as u64 {
                v.push((a * (2.0 * PI * 1000.0 * n as f64 / fs as f64).sin()) as f32);
                n += 1;
            }
        }
        v
    }

    /// A test meter set: rings + meters, fed through the callback end.
    pub(crate) struct Rig { pub taps: LoudTaps, pub m: LoudnessMeters, pub r: LoudReader }
    pub(crate) fn rig(rate: u32) -> Rig {
        let (taps, cons, shared) = loud_channels();
        let (m, r) = LoudnessMeters::new(cons, shared, rate);
        Rig { taps, m, r }
    }
    impl Rig {
        /// Feed a mono-per-channel signal (same on L and R) to one branch in `buf`-frame buffers, draining and
        /// publishing after every buffer; `each` sees every published frame.
        pub(crate) fn feed(&mut self, branch: usize, l: &[f32], r: &[f32], buf: &[usize], mut each: impl FnMut(usize, &BranchLoud)) {
            let (mut k, mut bi) = (0usize, 0usize);
            while k < l.len() {
                let n = buf[bi % buf.len()].min(l.len() - k);
                self.taps.push(branch, &l[k..k + n], &r[k..k + n]);
                self.m.drain();
                self.m.publish();
                k += n; bi += 1;
                let f = self.r.lock().unwrap().read();
                each(k, &f.b[branch]);
            }
        }
        pub(crate) fn last(&self, branch: usize) -> BranchLoud { self.r.lock().unwrap().read().b[branch] }
    }

    fn within(got: f64, want: f64, tol: f64) -> bool { (got - want).abs() <= tol }
    fn tp_ok(got: f64, want: f64) -> bool { got <= want + 0.2 && got >= want - 0.4 }

    /// Tech 3341 fs/k sine at `amp` FFS with `phase` degrees, 10 ms tapers, 2 s.
    pub(crate) fn tp_sine(fs: u32, div: f64, amp: f64, phase_deg: f64) -> Vec<f32> {
        let n = fs as usize * 2;
        let fade = fs as usize / 100;
        (0..n).map(|i| {
            let g = if i < fade { i as f64 / fade as f64 } else if i >= n - fade { (n - i) as f64 / fade as f64 } else { 1.0 };
            (g * amp * (2.0 * PI * i as f64 / div + phase_deg.to_radians()).sin()) as f32
        }).collect()
    }

    /// Tech 3341 #20–23: an fs/6 sine at 0.50 FFS containing ONE period of an fs/4 sine at 1.00, continuous in
    /// phase at both sides, synthesized at 4·fs, low-pass (anti-alias) filtered and decimated to fs with a
    /// `offset`-sample offset at the 4·fs rate. The filter: 511-tap Blackman-windowed sinc, cutoff fs/2.
    pub(crate) fn tp_burst(fs: u32, offset: usize) -> Vec<f32> {
        let up = 4usize;
        let n = fs as usize * 2 * up;
        let fade = fs as usize / 100 * up;
        // The base fs/6 sine runs on its own phase clock; the burst is inserted at an upward zero crossing of
        // the base and the base resumes from that same phase after it — continuous at both sides.
        let base_period = 6 * up;            // samples at 4·fs
        let burst_len = 4 * up;              // one period of fs/4 at 4·fs
        let insert_at = (n / 2 / base_period) * base_period;   // an upward zero crossing of the base
        let mut x = vec![0f64; n];
        let mut base_n = 0usize;
        let mut i = 0usize;
        while i < n {
            if i >= insert_at && i < insert_at + burst_len {
                x[i] = (2.0 * PI * (i - insert_at) as f64 / burst_len as f64).sin();
            } else {
                x[i] = 0.5 * (2.0 * PI * base_n as f64 / base_period as f64).sin();
                base_n += 1;
            }
            i += 1;
        }
        for (i, s) in x.iter_mut().enumerate() {
            let g = if i < fade { i as f64 / fade as f64 } else if i >= n - fade { (n - i) as f64 / fade as f64 } else { 1.0 };
            *s *= g;
        }
        let taps = 511usize;
        let fc = 0.5 / up as f64;            // cycles per sample at 4·fs
        let h: Vec<f64> = (0..taps).map(|k| {
            let m = k as f64 - (taps - 1) as f64 / 2.0;
            let sinc = if m == 0.0 { 2.0 * fc } else { (2.0 * PI * fc * m).sin() / (PI * m) };
            let w = 0.42 - 0.5 * (2.0 * PI * k as f64 / (taps - 1) as f64).cos() + 0.08 * (4.0 * PI * k as f64 / (taps - 1) as f64).cos();
            sinc * w
        }).collect();
        let hs: f64 = h.iter().sum();
        let mut out = Vec::with_capacity(n / up);
        let mut j = offset;
        while j < n {
            let mut acc = 0.0;
            for (k, hk) in h.iter().enumerate() {
                let idx = j as isize + k as isize - (taps as isize - 1) / 2;
                if idx >= 0 && (idx as usize) < n { acc += hk * x[idx as usize]; }
            }
            out.push((acc / hs) as f32);
            j += up;
        }
        out
    }

    const BUFS: [&[usize]; 5] = [&[441], &[480], &[128], &[1024], &[441, 128, 1024, 480, 7, 2048]];

    #[test]
    fn capped_history_is_reset_before_use() {
        // THE CRATE TRAP: set_max_history without reset() pads the queue with zero energies. Our meter must
        // read exactly what an uncapped meter reads.
        let sig = tones(FS, &[(10.0, -36.0), (60.0, -23.0), (10.0, -36.0)]);
        let mut raw = EbuR128::new(2, FS, mode_for(LOUD_LOCAL)).unwrap();
        raw.add_frames_planar_f32(&[&sig, &sig]).unwrap();
        let mut ours = new_meter(LOUD_LOCAL, FS);
        ours.add_frames_planar_f32(&[&sig, &sig]).unwrap();
        let (a, b) = (raw.loudness_global().unwrap(), ours.loudness_global().unwrap());
        let (la, lb) = (raw.loudness_range().unwrap(), ours.loudness_range().unwrap());
        println!("[cap] uncapped I {:.6} LRA {:.6} · ours (capped 24 h + reset) I {:.6} LRA {:.6}", a, la, b, lb);
        assert_eq!(a.to_bits(), b.to_bits(), "capped meter's I differs from the uncapped reference");
        assert_eq!(la.to_bits(), lb.to_bits(), "capped meter's LRA differs from the uncapped reference");
        // and the trap is real: without the reset it is wrong
        let mut bad = EbuR128::new(2, FS, mode_for(LOUD_LOCAL)).unwrap();
        bad.set_max_history(LOUD_HISTORY_MS).unwrap();
        bad.add_frames_planar_f32(&[&sig, &sig]).unwrap();
        println!("[cap] (the trap, for the record) capped WITHOUT reset I {:.3}", bad.loudness_global().unwrap());
    }

    #[test]
    fn tech3341_loudness_cases() {
        let inf = f64::NEG_INFINITY;
        // (case, segments, which reading, expected)
        let cases: Vec<(&str, Vec<(f64, f64)>, &str, f64)> = vec![
            ("#1", vec![(20.0, -23.0)], "MSI", -23.0),
            ("#2", vec![(20.0, -33.0)], "MSI", -33.0),
            ("#3", vec![(10.0, -36.0), (60.0, -23.0), (10.0, -36.0)], "I", -23.0),
            ("#4", vec![(10.0, -72.0), (10.0, -36.0), (60.0, -23.0), (10.0, -36.0), (10.0, -72.0)], "I", -23.0),
            ("#5", vec![(20.0, -26.0), (20.1, -20.0), (20.0, -26.0)], "I", -23.0),
            ("#9", (0..5).flat_map(|_| vec![(1.34, -20.0), (1.66, -30.0)]).collect(), "S-const-after-3s", -23.0),
            ("#12", (0..25).flat_map(|_| vec![(0.18, -20.0), (0.22, -30.0)]).collect(), "M-const-after-1s", -23.0),
        ];
        let _ = inf;
        let mut fails = Vec::new();
        for (name, segs, what, want) in &cases {
            let sig = tones(FS, segs);
            for bufs in BUFS {
                let mut rg = rig(FS);
                let (mut s_min, mut s_max, mut m_min, mut m_max) = (f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY);
                rg.feed(LOUD_STREAM, &sig, &sig, bufs, |k, b| {
                    let t = k as f64 / FS as f64;
                    if t >= 3.0 { s_min = s_min.min(b.s); s_max = s_max.max(b.s); }
                    if t >= 1.0 { m_min = m_min.min(b.m); m_max = m_max.max(b.m); }
                });
                let b = rg.last(LOUD_STREAM);
                let ok = match *what {
                    "MSI" => within(b.m, *want, 0.1) && within(b.s, *want, 0.1) && within(b.i, *want, 0.1),
                    "I" => within(b.i, *want, 0.1),
                    "S-const-after-3s" => within(s_min, *want, 0.1) && within(s_max, *want, 0.1),
                    "M-const-after-1s" => within(m_min, *want, 0.1) && within(m_max, *want, 0.1),
                    _ => unreachable!(),
                };
                if bufs.len() == 1 && bufs[0] == 441 || !ok {
                    println!("[3341 {:3}] buf {:?}  M {:8.3}  S {:8.3}  I {:8.3}  (S after 3 s {:.3}..{:.3}, M after 1 s {:.3}..{:.3})  want {} = {:.1} ±0.1  {}",
                             name, bufs, b.m, b.s, b.i, s_min, s_max, m_min, m_max, what, want, if ok { "PASS" } else { "FAIL" });
                }
                if !ok { fails.push(format!("3341 {} buf {:?}", name, bufs)); }
            }
        }
        assert!(fails.is_empty(), "Tech 3341 loudness cases out of tolerance: {:?}", fails);
    }

    #[test]
    fn tech3341_live_short_term_and_momentary_series() {
        // #11 (live): 20 tones — (i·0.15 s silence; 3 s at −38+i dBFS; 3 − i·0.15 s silence). Max S per segment
        // must read −38 … −19 ±0.1. #14 (live): (i·20 ms silence; 400 ms at −38+i; 400 − i·20 ms silence) → max M.
        let mut fails = Vec::new();
        for (case, tone, seg, reading) in [("#11", 3.0, 6.0, "S"), ("#14", 0.4, 0.8, "M")] {
            let step = if case == "#11" { 0.15 } else { 0.02 };
            let segs: Vec<(f64, f64)> = (0..20).flat_map(|i| {
                let i = i as f64;
                vec![(i * step, f64::NEG_INFINITY), (tone, -38.0 + i), (tone - i * step, f64::NEG_INFINITY)]
            }).collect();
            let sig = tones(FS, &segs);
            let mut rg = rig(FS);
            let mut maxes = [f64::NEG_INFINITY; 20];
            // a fine buffer so the reading instant can land on the window's alignment with each tone
            rg.feed(LOUD_LOCAL, &sig, &sig, &[44], |k, b| {
                let t = k as f64 / FS as f64;
                let i = ((t / seg) as usize).min(19);
                let v = if reading == "S" { b.s } else { b.m };
                maxes[i] = maxes[i].max(v);
            });
            let got: Vec<String> = maxes.iter().map(|v| format!("{:.2}", v)).collect();
            println!("[3341 {}] max {} per segment: {}", case, reading, got.join(" "));
            for (i, v) in maxes.iter().enumerate() {
                if !within(*v, -38.0 + i as f64, 0.1) { fails.push(format!("{} segment {} read {:.3}", case, i, v)); }
            }
        }
        assert!(fails.is_empty(), "Tech 3341 live series out of tolerance: {:?}", fails);
    }

    #[test]
    fn tech3341_true_peak_cases() {
        let mut fails = Vec::new();
        let mut run = |name: &str, sig: Vec<f32>, want: f64| {
            let mut rg = rig(FS);
            rg.feed(LOUD_STREAM, &sig, &sig, &[441], |_, _| {});
            let tp = rg.last(LOUD_STREAM).tp_max;
            let ok = tp_ok(tp, want);
            println!("[3341 {:3}] max TP {:7.3} dBTP   want {:+.1} +0.2/−0.4   {}", name, tp, want, if ok { "PASS" } else { "FAIL" });
            if !ok { fails.push(name.to_string()); }
        };
        run("#15", tp_sine(FS, 4.0, 0.50, 0.0), -6.0);
        run("#16", tp_sine(FS, 4.0, 0.50, 45.0), -6.0);
        run("#17", tp_sine(FS, 6.0, 0.50, 60.0), -6.0);
        run("#18", tp_sine(FS, 8.0, 0.50, 67.5), -6.0);
        run("#19", tp_sine(FS, 4.0, 1.41, 45.0), 3.0);
        for off in 0..4 { run(&format!("#{}", 20 + off), tp_burst(FS, off), 0.0); }
        assert!(fails.is_empty(), "Tech 3341 true-peak cases out of tolerance: {:?}", fails);
    }

    #[test]
    fn tech3342_lra_cases() {
        let cases: Vec<(&str, Vec<(f64, f64)>, f64)> = vec![
            ("#1", vec![(20.0, -20.0), (20.0, -30.0)], 10.0),
            ("#2", vec![(20.0, -20.0), (20.0, -15.0)], 5.0),
            ("#3", vec![(20.0, -40.0), (20.0, -20.0)], 20.0),
            ("#4", vec![(20.0, -50.0), (20.0, -35.0), (20.0, -20.0), (20.0, -35.0), (20.0, -50.0)], 15.0),
        ];
        let mut fails = Vec::new();
        for (name, segs, want) in &cases {
            let sig = tones(FS, segs);
            let mut rg = rig(FS);
            rg.feed(LOUD_LOCAL, &sig, &sig, &[441], |_, _| {});
            let lra = rg.last(LOUD_LOCAL).lra;
            let ok = within(lra, *want, 1.0);
            println!("[3342 {}] LRA {:7.3} LU   want {:.0} ±1   {}", name, lra, want, if ok { "PASS" } else { "FAIL" });
            if !ok { fails.push(name.to_string()); }
        }
        assert!(fails.is_empty(), "Tech 3342 cases out of tolerance: {:?}", fails);
    }

    #[test]
    fn buffer_size_does_not_change_the_reading() {
        let sig = tones(FS, &[(10.0, -36.0), (60.0, -23.0), (10.0, -36.0)]);
        let mut is = Vec::new();
        for bufs in BUFS {
            let mut rg = rig(FS);
            rg.feed(LOUD_LOCAL, &sig, &sig, bufs, |_, _| {});
            is.push(rg.last(LOUD_LOCAL).i);
        }
        println!("[bufs] I per buffer plan {:?}", is);
        assert!(is.iter().all(|v| v.to_bits() == is[0].to_bits()), "integrated loudness depends on the buffer size: {:?}", is);
    }

    #[test]
    fn reset_restarts_integration_and_is_echoed() {
        let loud = tones(FS, &[(10.0, -20.0)]);
        let quiet = tones(FS, &[(10.0, -30.0)]);
        let mut rg = rig(FS);
        rg.feed(LOUD_LOCAL, &loud, &loud, &[441], |_, _| {});
        let before = rg.last(LOUD_LOCAL);
        request_reset(&rg.m.shared, LOUD_LOCAL);
        rg.feed(LOUD_LOCAL, &quiet, &quiet, &[441], |_, _| {});
        let after = rg.last(LOUD_LOCAL);
        println!("[reset] before I {:.3} (epoch {}) · after reset I {:.3} (epoch {}, {} frames)", before.i, before.epoch, after.i, after.epoch, after.measured_frames);
        // a −30 dBFS 1 kHz tone reads −30 LUFS (Tech 3341 #1's own relation); without the reset the −20 dB
        // history would have held I near −22.5.
        assert!(within(after.i, -30.0, 0.1), "reset did not restart integration: {}", after.i);
        assert_eq!(after.epoch, before.epoch + 1);
        assert_eq!(after.measured_frames, quiet.len() as u64);
    }

    #[test]
    fn a_full_ring_drops_and_counts_never_blocks() {
        let (mut taps, cons, shared) = loud_channels();
        let buf = vec![0.1f32; 441];
        // nobody drains: the ring fills, then every push is dropped and counted
        let pushes = LOUD_RING_FRAMES / 441 + 10;
        for _ in 0..pushes { taps.push(LOUD_STREAM, &buf, &buf); }
        let dropped = shared.drop_frames[LOUD_STREAM].load(Ordering::Relaxed);
        let (mut m, r) = LoudnessMeters::new(cons, shared.clone(), FS);
        m.drain(); m.publish();
        let f = r.lock().unwrap().read();
        println!("[drops] {} pushes of 441 into a {}-frame ring: {} frames dropped", pushes, LOUD_RING_FRAMES, dropped);
        assert!(dropped > 0 && dropped % 441 == 0);
        // the meter created afterwards starts its own count from here
        assert_eq!(f.b[LOUD_STREAM].drop_frames, 0);
    }

    #[test]
    fn aux_is_momentary_and_true_peak_only_and_unfed_is_not_frozen() {
        let sig = tones(FS, &[(5.0, -20.0)]);
        let mut rg = rig(FS);
        rg.feed(LOUD_AUX, &sig, &sig, &[441], |_, _| {});
        let fed = rg.last(LOUD_AUX);
        assert!(fed.fed && within(fed.m, -20.0, 0.1) && fed.i == f64::NEG_INFINITY && !fed.full);
        for _ in 0..UNFED_AFTER_PUBLISHES + 1 { rg.m.drain(); rg.m.publish(); }
        let unfed = rg.last(LOUD_AUX);
        println!("[aux] fed M {:.3} TPmax {:.3} · after {} empty publishes: fed={} M={}", fed.m, fed.tp_max, UNFED_AFTER_PUBLISHES + 1, unfed.fed, unfed.m);
        assert!(!unfed.fed && unfed.m == f64::NEG_INFINITY, "an unfed branch kept showing its last momentary value");
    }

    #[test]
    fn the_callback_end_never_allocates() {
        let (mut taps, cons, shared) = loud_channels();
        let (mut m, _r) = LoudnessMeters::new(cons, shared, FS);
        let buf = vec![0.25f32; 441];
        let a0 = crate::rt::tl_rt_allocs();
        for _ in 0..2000 {
            {
                let _rt = crate::rt::RtScope::enter();
                for b in 0..LOUD_BRANCHES { taps.push(b, &buf, &buf); }
            }
            m.drain();
        }
        let allocs = crate::rt::tl_rt_allocs() - a0;
        println!("[trap] LoudTaps::push × 3 branches × 2000 buffers inside RtScope: {} allocations", allocs);
        assert_eq!(allocs, 0);
    }

    // ── THE EBU'S OWN TEST SET (Jeff's ruling 7) ─────────────────────────────────────────────────────────
    // EBU loudness test set v5.0 (tech.ebu.ch, ebu-loudness-test-setv05.zip), unpacked into
    // native/goldens/inputs/ebu/ — gitignored; the bytes are pinned by native/goldens/manifest-loudness.json
    // (node scripts/make-loudness-corpus.js). Every Tech 3341 / 3342 case the set carries is run through the
    // meter at the file's own rate (48 kHz), against Table 1 of each document. Not applicable, and reported
    // as such: 3341 #6 (5.0-channel; the engine is stereo). 3341 #10/#13 are the file-based variants of the
    // live #11/#14 (each file one segment: its max S / max M must read the segment's value).

    /// A WAV as planar f32 (PCM 16/24/32-bit, IEEE float 32, and WAVE_FORMAT_EXTENSIBLE of either).
    pub(crate) fn read_wav(path: &std::path::Path) -> (u32, Vec<Vec<f32>>) {
        let b = std::fs::read(path).unwrap_or_else(|e| panic!("{}: {}", path.display(), e));
        assert!(&b[0..4] == b"RIFF" && &b[8..12] == b"WAVE", "{} is not a RIFF/WAVE file", path.display());
        let u16le = |o: usize| u16::from_le_bytes([b[o], b[o + 1]]);
        let u32le = |o: usize| u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]]);
        let (mut fmt, mut ch, mut rate, mut bits, mut data) = (0u16, 0usize, 0u32, 0u16, None);
        let mut o = 12;
        while o + 8 <= b.len() {
            let id = &b[o..o + 4];
            let len = u32le(o + 4) as usize;
            let body = o + 8;
            if id == b"fmt " {
                fmt = u16le(body); ch = u16le(body + 2) as usize; rate = u32le(body + 4); bits = u16le(body + 14);
                if fmt == 0xFFFE { fmt = u16le(body + 24); }   // extensible: the sub-format GUID's first two bytes
            } else if id == b"data" {
                data = Some((body, len.min(b.len() - body)));
            }
            o = body + len + (len & 1);
        }
        let (start, len) = data.expect("no data chunk");
        let bps = (bits / 8) as usize;
        let frames = len / (bps * ch);
        let mut out = vec![Vec::with_capacity(frames); ch];
        for f in 0..frames {
            for c in 0..ch {
                let at = start + (f * ch + c) * bps;
                let v = match (fmt, bits) {
                    (1, 16) => i16::from_le_bytes([b[at], b[at + 1]]) as f32 / 32768.0,
                    (1, 24) => (((b[at] as i32) << 8 | (b[at + 1] as i32) << 16 | (b[at + 2] as i32) << 24) >> 8) as f32 / 8_388_608.0,
                    (1, 32) => i32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]]) as f32 / 2_147_483_648.0,
                    (3, 32) => f32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]]),
                    _ => panic!("{}: unsupported WAV format {} / {} bits", path.display(), fmt, bits),
                };
                out[c].push(v);
            }
        }
        (rate, out)
    }

    /// The (document, case) pairs a file name carries, e.g. "seq-3341-7_seq-3342-5-24bit.wav" → [(3341, 7),
    /// (3342, 5)], "seq-3341-2011-8_…" → 3341 #8, and for the file-based segment files "seq-3341-10-3…" the
    /// segment index as well.
    pub(crate) fn ebu_cases(name: &str) -> Vec<(u32, u32, Option<u32>)> {
        let mut out = Vec::new();
        let lower = name.to_ascii_lowercase();
        for (i, _) in lower.match_indices("seq-") {
            let rest = &lower[i + 4..];
            let nums: Vec<&str> = rest.split(|c: char| !c.is_ascii_digit()).filter(|s| !s.is_empty()).take(4).collect();
            let Some(&doc) = nums.first() else { continue };
            let Ok(doc) = doc.parse::<u32>() else { continue };
            if doc != 3341 && doc != 3342 { continue; }
            let mut k = 1;
            if nums.get(1) == Some(&"2011") { k = 2; }   // the 2011 revision of a sequence
            let Some(case) = nums.get(k).and_then(|s| s.parse::<u32>().ok()) else { continue };
            // A segment index follows only for the file-based 3341 #10 and #13; a bit depth ("16bit", "24bit")
            // also parses as a number, so only those two cases take one, and only if it is 1..20.
            let seg = if doc == 3341 && (case == 10 || case == 13) {
                nums.get(k + 1).and_then(|s| s.parse::<u32>().ok()).filter(|v| (1..=20).contains(v))
            } else { None };
            out.push((doc, case, seg));
        }
        out
    }

    #[test]
    fn ebu_test_set_every_case() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("goldens").join("inputs").join("ebu");
        let man: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("goldens").join("manifest-loudness.json")).expect("manifest-loudness.json")).unwrap();
        let files = man["ebu"]["files"].as_object().unwrap_or_else(|| panic!(
            "the EBU test set is not in the corpus: unzip ebu-loudness-test-setv05.zip into {} and run node scripts/make-loudness-corpus.js", dir.display()));
        let fnv = |b: &[u8]| { let mut h = 1469598103934665603u64; for &x in b { h ^= x as u64; h = h.wrapping_mul(1099511628211); } format!("{:016x}", h) };
        let mut seen = std::collections::BTreeSet::new();
        let mut fails = Vec::new();
        let mut unmatched = Vec::new();
        for (name, meta) in files {
            let p = dir.join(name);
            let bytes = std::fs::read(&p).unwrap_or_else(|_| panic!("{} listed in the manifest but missing", p.display()));
            assert_eq!(fnv(&bytes), meta["fnv"].as_str().unwrap(), "{} is not the file the manifest pinned", name);
            let cases = ebu_cases(name);
            if cases.is_empty() { unmatched.push(name.clone()); continue; }
            let (rate, chans) = read_wav(&p);
            for (doc, case, seg) in cases {
                seen.insert((doc, case));
                if doc == 3341 && case == 6 { println!("[ebu] {:44} 3341 #6   N/A — 5.0-channel; the engine meters stereo branches", name); continue; }
                if chans.len() != 2 { println!("[ebu] {:44} {} #{}   skipped — {} channels", name, doc, case, chans.len()); continue; }
                let (l, r) = (&chans[0], &chans[1]);
                let mut rg = rig(rate);
                let mut max_s = f64::NEG_INFINITY; let mut max_m = f64::NEG_INFINITY;
                let (mut s_after3, mut m_after1) = ((f64::INFINITY, f64::NEG_INFINITY), (f64::INFINITY, f64::NEG_INFINITY));
                let mut seg_max_s = [f64::NEG_INFINITY; 20]; let mut seg_max_m = [f64::NEG_INFINITY; 20];
                // #14's 400 ms tones need fine reading instants; everything else reads at 480-frame buffers.
                let buf: &[usize] = if doc == 3341 && (case == 14 || case == 13 || case == 12) { &[48] } else { &[480] };
                rg.feed(LOUD_LOCAL, l, r, buf, |k, b| {
                    let t = k as f64 / rate as f64;
                    max_s = max_s.max(b.s); max_m = max_m.max(b.m);
                    if t >= 3.0 { s_after3.0 = s_after3.0.min(b.s); s_after3.1 = s_after3.1.max(b.s); }
                    if t >= 1.0 { m_after1.0 = m_after1.0.min(b.m); m_after1.1 = m_after1.1.max(b.m); }
                    if doc == 3341 && case == 11 { let i = ((t / 6.0) as usize).min(19); seg_max_s[i] = seg_max_s[i].max(b.s); }
                    if doc == 3341 && case == 14 { let i = ((t / 0.8) as usize).min(19); seg_max_m[i] = seg_max_m[i].max(b.m); }
                });
                let x = rg.last(LOUD_LOCAL);
                let (label, ok) = match (doc, case) {
                    (3341, 1) => (format!("M {:.3} S {:.3} I {:.3} want −23.0 ±0.1", x.m, x.s, x.i), within(x.m, -23.0, 0.1) && within(x.s, -23.0, 0.1) && within(x.i, -23.0, 0.1)),
                    (3341, 2) => (format!("M {:.3} S {:.3} I {:.3} want −33.0 ±0.1", x.m, x.s, x.i), within(x.m, -33.0, 0.1) && within(x.s, -33.0, 0.1) && within(x.i, -33.0, 0.1)),
                    (3341, 3..=5) | (3341, 7) | (3341, 8) => (format!("I {:.3} want −23.0 ±0.1", x.i), within(x.i, -23.0, 0.1)),
                    (3341, 9) => (format!("S after 3 s {:.3}..{:.3} want −23.0 ±0.1", s_after3.0, s_after3.1), within(s_after3.0, -23.0, 0.1) && within(s_after3.1, -23.0, 0.1)),
                    (3341, 10) => (format!("segment {:?} max S {:.3} want −23.0 ±0.1", seg, max_s), within(max_s, -23.0, 0.1)),
                    (3341, 11) => {
                        let bad: Vec<usize> = (0..20).filter(|&i| !within(seg_max_s[i], -38.0 + i as f64, 0.1)).collect();
                        (format!("max S per segment {:?} want −38…−19 ±0.1", seg_max_s.iter().map(|v| (v * 100.0).round() / 100.0).collect::<Vec<_>>()), bad.is_empty())
                    }
                    (3341, 12) => (format!("M after 1 s {:.3}..{:.3} want −23.0 ±0.1", m_after1.0, m_after1.1), within(m_after1.0, -23.0, 0.1) && within(m_after1.1, -23.0, 0.1)),
                    (3341, 13) => (format!("segment {:?} max M {:.3} want −23.0 ±0.1", seg, max_m), within(max_m, -23.0, 0.1)),
                    (3341, 14) => {
                        let bad: Vec<usize> = (0..20).filter(|&i| !within(seg_max_m[i], -38.0 + i as f64, 0.1)).collect();
                        (format!("max M per segment {:?} want −38…−19 ±0.1", seg_max_m.iter().map(|v| (v * 100.0).round() / 100.0).collect::<Vec<_>>()), bad.is_empty())
                    }
                    (3341, 15..=18) => (format!("TP {:.3} want −6.0 +0.2/−0.4", x.tp_max), tp_ok(x.tp_max, -6.0)),
                    (3341, 19) => (format!("TP {:.3} want +3.0 +0.2/−0.4", x.tp_max), tp_ok(x.tp_max, 3.0)),
                    (3341, 20..=23) => (format!("TP {:.3} want 0.0 +0.2/−0.4", x.tp_max), tp_ok(x.tp_max, 0.0)),
                    (3342, 1) => (format!("LRA {:.3} want 10 ±1", x.lra), within(x.lra, 10.0, 1.0)),
                    (3342, 2) => (format!("LRA {:.3} want 5 ±1", x.lra), within(x.lra, 5.0, 1.0)),
                    (3342, 3) => (format!("LRA {:.3} want 20 ±1", x.lra), within(x.lra, 20.0, 1.0)),
                    (3342, 4) => (format!("LRA {:.3} want 15 ±1", x.lra), within(x.lra, 15.0, 1.0)),
                    (3342, 5) => (format!("LRA {:.3} want 5 ±1", x.lra), within(x.lra, 5.0, 1.0)),
                    (3342, 6) => (format!("LRA {:.3} want 15 ±1", x.lra), within(x.lra, 15.0, 1.0)),
                    _ => (format!("no Table 1 entry for {} #{}", doc, case), false),
                };
                println!("[ebu] {:44} {} #{:<2} {} Hz  {}  {}", name, doc, case, rate, label, if ok { "PASS" } else { "FAIL" });
                if !ok { fails.push(format!("{} ({} #{})", name, doc, case)); }
            }
        }
        if !unmatched.is_empty() { println!("[ebu] files carrying no 3341/3342 case (other documents, e.g. 3343): {:?}", unmatched); }
        let want: Vec<(u32, u32)> = (1..=23).filter(|&c| c != 6).map(|c| (3341, c)).chain((1..=6).map(|c| (3342, c))).collect();
        let missing: Vec<_> = want.iter().filter(|w| !seen.contains(w)).collect();
        println!("[ebu] cases found: {} of {} applicable", want.len() - missing.len(), want.len());
        assert!(missing.is_empty(), "EBU cases not found in the set (file naming?): {:?}", missing);
        assert!(fails.is_empty(), "EBU test set out of tolerance: {:?}", fails);
    }
}
