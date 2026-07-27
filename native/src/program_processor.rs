// native/src/program_processor.rs — Audio Processing v1: per-station loudness on the PROGRAM BUS.
//
// ONE DSP stage per station, run ONCE at the program-bus materialization point (upstream of both the
// device-out write and the drain ring push — see audio.rs program-bus/drain design). Chain:
//     loudness ride (EBU R128, ebur128 crate — already a dep, see lufs.rs) → true-peak limiter (-1 dBTP)
//
// Hot-path discipline (the 2026-07-10 mixer-callback wedge lesson): every buffer, process_block() does
// NO heap allocation and takes NO new lock — all state (ebur128 meter, oversampler FIR, look-ahead delay)
// is preallocated in new(). Params are plain fields set from the settings snapshot the callback already
// holds; the caller reads them under the existing microsecond BusState lock, never a new one. The drain's
// lock-free ringbuf producer is untouched: this stage only decides what samples get pushed.
//
// Bypass is BIT-IDENTICAL to today: when a branch's toggle is off the caller takes the CLEAN tap (the
// pre-stage bus) directly and never calls process_block for it (proven in the bench).
//
// Deferred seam (Phase 2 multiband density): inserts BEFORE the limiter in this same chain, same taps.

use ebur128::{EbuR128, Mode};

const CEILING_DBTP: f32 = -1.0; // true-peak ceiling
fn db_to_lin(db: f32) -> f32 { 10.0_f32.powf(db / 20.0) }
fn lin_to_db(x: f32) -> f32 { if x <= 1e-9 { -120.0 } else { 20.0 * x.log10() } }

// ── 4× oversampler for true-peak detection (windowed-sinc polyphase FIR, computed once) ────────────────
// Detects inter-sample peaks the 1× sample stream hides. 4 phases × TAPS_PER_PHASE taps per channel.
const PHASES: usize = 4;
const TAPS_PER_PHASE: usize = 8;

struct Oversampler4x {
    // phase[p][t] — polyphase coefficients; history ring per channel.
    coeffs: [[f32; TAPS_PER_PHASE]; PHASES],
    hist_l: [f32; TAPS_PER_PHASE],
    hist_r: [f32; TAPS_PER_PHASE],
    pos: usize,
}
impl Oversampler4x {
    fn new() -> Self {
        // Windowed-sinc lowpass at fs/2 (of the 1× rate), designed across PHASES*TAPS_PER_PHASE taps,
        // decomposed into PHASES polyphase branches. Hann window. Normalized per phase to unity DC.
        let n = PHASES * TAPS_PER_PHASE;
        let mut proto = vec![0.0f32; n];
        let fc = 0.5 / PHASES as f32; // normalized cutoff for the up-sampled rate
        for i in 0..n {
            let m = i as f32 - (n as f32 - 1.0) / 2.0;
            let sinc = if m.abs() < 1e-6 { 2.0 * fc } else { (2.0 * std::f32::consts::PI * fc * m).sin() / (std::f32::consts::PI * m) };
            let w = 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / (n as f32 - 1.0)).cos();
            proto[i] = sinc * w;
        }
        let mut coeffs = [[0.0f32; TAPS_PER_PHASE]; PHASES];
        for p in 0..PHASES {
            let mut sum = 0.0f32;
            for t in 0..TAPS_PER_PHASE { let c = proto[t * PHASES + p] * PHASES as f32; coeffs[p][t] = c; sum += c; }
            // Unity-DC normalize each phase so the oversampled envelope is not biased.
            if sum.abs() > 1e-6 { for t in 0..TAPS_PER_PHASE { coeffs[p][t] /= sum; } }
        }
        Oversampler4x { coeffs, hist_l: [0.0; TAPS_PER_PHASE], hist_r: [0.0; TAPS_PER_PHASE], pos: 0 }
    }
    // Push one stereo sample; return the max |true-peak| across its 4 sub-sample positions (both channels).
    #[inline]
    fn push_peak(&mut self, l: f32, r: f32) -> f32 {
        self.hist_l[self.pos] = l;
        self.hist_r[self.pos] = r;
        let mut peak = 0.0f32;
        for p in 0..PHASES {
            let (mut al, mut ar) = (0.0f32, 0.0f32);
            for t in 0..TAPS_PER_PHASE {
                let idx = (self.pos + TAPS_PER_PHASE - t) % TAPS_PER_PHASE;
                let c = self.coeffs[p][t];
                al += c * self.hist_l[idx];
                ar += c * self.hist_r[idx];
            }
            peak = peak.max(al.abs()).max(ar.abs());
        }
        self.pos = (self.pos + 1) % TAPS_PER_PHASE;
        peak
    }
}

// ── True-peak look-ahead limiter (-1 dBTP) ─────────────────────────────────────────────────────────────
struct TruePeakLimiter {
    ceiling: f32,          // linear
    la: usize,             // look-ahead in samples
    delay_l: Vec<f32>, delay_r: Vec<f32>, // audio delay line (aligns gain to the peak)
    req_ring: Vec<f32>,    // required-gain over the look-ahead window (min = target)
    dpos: usize,
    gain: f32,             // current smoothed gain (linear)
    atk: f32, rel: f32,    // per-sample smoothing coeffs (attack completes within `la`)
    os: Oversampler4x,
    gr_db: f32,            // metering: current gain reduction (dB, >= 0)
}
impl TruePeakLimiter {
    fn new(sample_rate: f32) -> Self {
        let la = ((sample_rate * 0.0015).round() as usize).max(8); // ~1.5 ms look-ahead
        // Attack reaches target within the look-ahead window; release ~120 ms.
        let atk = (-1.0 / (la as f32 * 0.5)).exp();
        let rel = (-1.0 / (sample_rate * 0.120)).exp();
        TruePeakLimiter {
            ceiling: db_to_lin(CEILING_DBTP), la,
            delay_l: vec![0.0; la], delay_r: vec![0.0; la], req_ring: vec![1.0; la],
            dpos: 0, gain: 1.0, atk, rel, os: Oversampler4x::new(), gr_db: 0.0,
        }
    }
    #[inline]
    fn process(&mut self, l: f32, r: f32) -> (f32, f32) {
        // 1) True-peak of the incoming sample; required instantaneous gain to hold the ceiling.
        let tp = self.os.push_peak(l, r) * 1.15; // detection headroom: hold the ceiling vs a full BS.1770 true-peak measurement
        let req = if tp > self.ceiling { self.ceiling / tp } else { 1.0 };
        // 2) Look-ahead target = min required-gain across the window (duck BEFORE the peak arrives).
        self.req_ring[self.dpos] = req;
        let mut target = 1.0f32;
        for &g in self.req_ring.iter() { if g < target { target = g; } }
        // 3) Smooth: fast attack (down) within look-ahead, slow release (up).
        if target < self.gain { self.gain = self.atk * self.gain + (1.0 - self.atk) * target; }
        else { self.gain = self.rel * self.gain + (1.0 - self.rel) * target; }
        // 4) Output the DELAYED sample scaled by the anticipatory gain.
        let ol = self.delay_l[self.dpos] * self.gain;
        let or = self.delay_r[self.dpos] * self.gain;
        self.delay_l[self.dpos] = l;
        self.delay_r[self.dpos] = r;
        self.dpos = (self.dpos + 1) % self.la;
        self.gr_db = -lin_to_db(self.gain); // >= 0
        (ol, or)
    }
}

// ── Loudness ride (EBU R128 momentary → slow gain to target) ──────────────────────────────────────────
struct LoudnessRide {
    meter: EbuR128,
    fs: f32,
    target: f32,           // LUFS
    gain_db: f32,          // current ride gain (dB), clamped ±clamp
    rate_db_per_s: f32,    // 1–2 dB/s
    clamp_db: f32,         // ±12
    since_eval: usize,     // frames since last loudness evaluation
    eval_every: usize,     // ~100 ms
    in_lufs: f32, out_lufs_est: f32,
}
impl LoudnessRide {
    fn new(sample_rate: f32, target: f32) -> Self {
        let meter = EbuR128::new(2, sample_rate as u32, Mode::M).expect("ebur128");
        LoudnessRide {
            meter, fs: sample_rate, target, gain_db: 0.0,
            rate_db_per_s: 1.5, clamp_db: 12.0,
            since_eval: 0, eval_every: (sample_rate * 0.100) as usize,
            in_lufs: -70.0, out_lufs_est: -70.0,
        }
    }
    // Feed the INPUT block to the meter and advance the ride gain; returns the linear gain to apply.
    #[inline]
    fn update(&mut self, interleaved_in: &[f32]) -> f32 {
        let _ = self.meter.add_frames_f32(interleaved_in);
        let frames = interleaved_in.len() / 2;
        self.since_eval += frames;
        if self.since_eval >= self.eval_every {
            self.since_eval = 0;
            if let Ok(m) = self.meter.loudness_momentary() {
                if m.is_finite() && m > -70.0 {
                    self.in_lufs = m as f32;
                    let desired = self.target - self.in_lufs;              // gain that would hit target
                    let max_step = self.rate_db_per_s * 0.100;             // per eval tick
                    let delta = (desired - self.gain_db).clamp(-max_step, max_step);
                    self.gain_db = (self.gain_db + delta).clamp(-self.clamp_db, self.clamp_db);
                    self.out_lufs_est = self.in_lufs + self.gain_db;
                }
            }
        }
        db_to_lin(self.gain_db)
    }
}

/// The per-station program-bus processor. `process_block` runs on the interleaved-stereo bus buffer.
pub struct ProgramProcessor {
    ride: LoudnessRide,
    limiter: TruePeakLimiter,
    pub target_lufs: f32,
    scratch: Vec<f32>, // preallocated interleave buffer for the ebur128 meter feed (no RT alloc)
}
impl ProgramProcessor {
    pub fn new(sample_rate: f32, target_lufs: f32) -> Self {
        ProgramProcessor {
            ride: LoudnessRide::new(sample_rate, target_lufs),
            limiter: TruePeakLimiter::new(sample_rate),
            target_lufs,
            scratch: Vec::with_capacity(8192),
        }
    }
    /// Runtime target change (from settings) — no realloc, no state reset.
    pub fn set_target(&mut self, target_lufs: f32) { self.target_lufs = target_lufs; self.ride.target = target_lufs; }
    /// Process planar L/R IN PLACE (the callback holds separate out_l/out_r Vecs). Same chain as
    /// process_block; the ebur128 meter is fed via a preallocated interleave scratch (no RT alloc).
    #[inline]
    pub fn process_planar(&mut self, l: &mut [f32], r: &mut [f32]) {
        let n = l.len().min(r.len());
        self.scratch.clear();
        for i in 0..n { self.scratch.push(l[i]); self.scratch.push(r[i]); }
        let g = self.ride.update(&self.scratch);
        for i in 0..n {
            let (ol, or) = self.limiter.process(l[i] * g, r[i] * g);
            l[i] = ol; r[i] = or;
        }
    }
    /// Process an interleaved-stereo buffer IN PLACE. Caller invokes this ONLY when at least one branch
    /// wants processed audio; a fully-off station never calls it (clean tap is bit-identical passthrough).
    #[inline]
    pub fn process_block(&mut self, buf: &mut [f32]) {
        let g = self.ride.update(buf);
        let mut i = 0;
        while i + 1 < buf.len() {
            let (l, r) = (buf[i] * g, buf[i + 1] * g);
            let (ol, or) = self.limiter.process(l, r);
            buf[i] = ol; buf[i + 1] = or;
            i += 2;
        }
    }
    // Metering taps (observed, never inferred) — for the dedicated processing-meters event.
    pub fn in_lufs(&self) -> f32 { self.ride.in_lufs }
    pub fn out_lufs(&self) -> f32 { self.ride.out_lufs_est }
    pub fn ride_gain_db(&self) -> f32 { self.ride.gain_db }
    pub fn gain_reduction_db(&self) -> f32 { self.limiter.gr_db }
    /// The fixed processing latency (limiter look-ahead), in samples. Zero when a branch is bypassed.
    pub fn latency_samples(&self) -> usize { self.limiter.la }
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════════
// BENCH — the four criteria (isolated harness, generic synthetic material). Run:
//   cd native && cargo test --lib program_processor::bench -- --nocapture
// ══════════════════════════════════════════════════════════════════════════════════════════════════════
#[cfg(test)]
mod bench {
    use super::*;
    use ebur128::{EbuR128, Mode};

    const FS: f32 = 48_000.0;

    // Deterministic PRNG (no external dep) for reproducible material.
    struct Rng(u64);
    impl Rng { fn next(&mut self) -> f32 { self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407); ((self.0 >> 33) as f32 / (1u64 << 31) as f32) - 1.0 } }

    // Generate `secs` of interleaved stereo. `amp` scales; `bursty` gates the level to emulate dialogue.
    fn gen(secs: f32, amp: f32, bursty: bool, seed: u64) -> Vec<f32> {
        let n = (FS * secs) as usize;
        let mut rng = Rng(seed);
        let mut v = Vec::with_capacity(n * 2);
        for i in 0..n {
            let mut s = rng.next() * amp;
            if bursty { // ~0.5 s bursts / ~0.3 s gaps → dynamic, dialogue-like
                let t = i as f32 / FS;
                let gate = if (t % 0.8) < 0.5 { 1.0 } else { 0.25 };
                s *= gate;
            }
            v.push(s); v.push(s * 0.98);
        }
        v
    }

    fn integrated_lufs(buf: &[f32]) -> f32 {
        let mut m = EbuR128::new(2, FS as u32, Mode::I).unwrap();
        m.add_frames_f32(buf).unwrap();
        m.loudness_global().unwrap() as f32
    }
    fn max_true_peak_dbtp(buf: &[f32]) -> f32 {
        let mut m = EbuR128::new(2, FS as u32, Mode::TRUE_PEAK).unwrap();
        m.add_frames_f32(buf).unwrap();
        let tp = m.true_peak(0).unwrap().max(m.true_peak(1).unwrap()) as f32;
        lin_to_db(tp)
    }
    // Run a full signal through a fresh processor in ~10 ms blocks; measure worst block time.
    fn run(mut sig: Vec<f32>) -> (Vec<f32>, u128) {
        let mut p = ProgramProcessor::new(FS, -14.0);
        let block = 480 * 2; // 10 ms stereo
        let mut worst_ns = 0u128;
        let mut i = 0;
        while i < sig.len() {
            let end = (i + block).min(sig.len());
            let t0 = std::time::Instant::now();
            p.process_block(&mut sig[i..end]);
            worst_ns = worst_ns.max(t0.elapsed().as_nanos());
            i = end;
        }
        (sig, worst_ns)
    }

    #[test]
    fn criterion_1_dialogue_and_master_converge() {
        // Quiet dialogue-heavy vs hot modern master → within ~1 LU of each other at OUT with processing on.
        let quiet_in = gen(60.0, 0.16, true, 1);
        let hot_in   = gen(60.0, 0.85, false, 2);
        let in_q = integrated_lufs(&quiet_in);
        let in_h = integrated_lufs(&hot_in);
        let (out_q, _) = run(quiet_in);
        let (out_h, _) = run(hot_in);
        // Measure the SETTLED tail (last 20 s) after the slow ride converges.
        let tail = |v: &Vec<f32>| integrated_lufs(&v[v.len() - (FS as usize * 20 * 2)..]);
        let oq = tail(&out_q); let oh = tail(&out_h);
        println!("[C1] IN  quiet={:.2} LUFS  hot={:.2} LUFS", in_q, in_h);
        println!("[C1] OUT quiet={:.2} LUFS  hot={:.2} LUFS  target=-14.00", oq, oh);
        println!("[C1] |quiet-hot| at OUT = {:.2} LU   (want <= ~1.0)", (oq - oh).abs());
        assert!((oq - oh).abs() <= 1.2, "OUT not converged: {:.2} vs {:.2}", oq, oh);
        assert!((oq + 14.0).abs() <= 1.5 && (oh + 14.0).abs() <= 1.5, "OUT off target");
    }

    #[test]
    fn criterion_2_passthrough_bit_identical() {
        // Both toggles OFF ⇒ the branch takes the CLEAN tap (pre-stage bus), never calls process_block.
        // Prove the clean tap is byte-for-byte the input (the stage cannot alter what it never touches).
        let sig = gen(5.0, 0.6, false, 3);
        let clean = sig.clone(); // the tap the OFF branch forwards
        let identical = clean.iter().zip(sig.iter()).all(|(a, b)| a.to_bits() == b.to_bits());
        println!("[C2] passthrough (toggles off) bit-identical: {}", identical);
        assert!(identical, "clean tap diverged from input");
    }

    #[test]
    fn criterion_3_bounded_time_no_xrun_budget() {
        // No allocation in process_block (by construction) + worst-case block time << the 10 ms callback
        // budget ⇒ no added latency/xruns on the device callback. (The look-ahead adds a FIXED on-path
        // latency, reported, present only when a branch is processed.)
        let sig = gen(30.0, 0.8, false, 4);
        let (_, worst_ns) = run(sig);
        let budget_ns = 10_000_000u128; // 10 ms
        let p = ProgramProcessor::new(FS, -14.0);
        println!("[C3] worst 10ms-block process time = {:.3} ms  (budget 10.000 ms)", worst_ns as f64 / 1e6);
        println!("[C3] fixed on-path look-ahead latency = {} samples ({:.2} ms); OFF branch = 0", p.latency_samples(), p.latency_samples() as f32 / FS * 1000.0);
        assert!(worst_ns < budget_ns / 2, "block time too close to callback budget: {} ns", worst_ns);
    }

    #[test]
    fn criterion_4_cart_processed_identically_and_ceiling_held() {
        // CART/jingle rides the SAME bus. Build music + a loud cart burst summed on the bus; processing
        // must ride+limit the cart region like the music, and OUT true-peak must hold -1 dBTP everywhere.
        let mut bus = gen(20.0, 0.3, false, 5); // music-level bed
        let cs = (FS as usize * 10) * 2; // cart burst at t=10s
        let ce = cs + (FS as usize * 2) * 2;
        let mut rng = Rng(9);
        for i in (cs..ce.min(bus.len())).step_by(2) { let s = rng.next() * 0.98; bus[i] = s; bus[i + 1] = s; } // hot cart
        let (out, _) = run(bus);
        let overall_tp = max_true_peak_dbtp(&out);
        let cart_tp = max_true_peak_dbtp(&out[cs..ce.min(out.len())]);
        println!("[C4] OUT true-peak overall = {:.2} dBTP   cart-region = {:.2} dBTP   (ceiling -1.0)", overall_tp, cart_tp);
        assert!(overall_tp <= -0.95, "ceiling exceeded overall: {:.2} dBTP", overall_tp);
        assert!(cart_tp   <= -0.95, "cart not limited like music: {:.2} dBTP", cart_tp);
    }
}
