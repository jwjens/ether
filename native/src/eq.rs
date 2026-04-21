// native/src/eq.rs
// 10-band graphic EQ implemented as a chain of biquad peaking filters.
// Coefficients computed per the RBJ Audio EQ Cookbook.
//
// Shared across the audio engine via Arc<Mutex<EqChain>> so the JS-side
// slider changes propagate to all active audio sources in real time.

use std::sync::{Arc, Mutex};

// Standard 10-band graphic EQ frequency centers (Hz)
pub const EQ_FREQS: [f32; 10] = [
    31.0, 63.0, 125.0, 250.0, 500.0,
    1000.0, 2000.0, 4000.0, 8000.0, 16000.0,
];

// Quality factor — wider Q = broader band. 1.0 gives ~1 octave bandwidth,
// which is standard for graphic EQ use.
const DEFAULT_Q: f32 = 1.0;

// ── Single biquad peaking filter (one band, per channel) ────────
// Direct Form I: y[n] = b0*x[n] + b1*x[n-1] + b2*x[n-2] - a1*y[n-1] - a2*y[n-2]
#[derive(Clone, Copy, Default)]
struct BiquadState {
    x1: f32, x2: f32,
    y1: f32, y2: f32,
}

#[derive(Clone, Copy)]
pub struct Biquad {
    // Coefficients (a0 already normalized out)
    b0: f32, b1: f32, b2: f32,
    a1: f32, a2: f32,
    // Per-channel state (stereo)
    state_l: BiquadState,
    state_r: BiquadState,
}

impl Biquad {
    /// Identity filter (passes signal unchanged)
    pub fn identity() -> Self {
        Self {
            b0: 1.0, b1: 0.0, b2: 0.0,
            a1: 0.0, a2: 0.0,
            state_l: BiquadState::default(),
            state_r: BiquadState::default(),
        }
    }

    /// Compute peaking EQ coefficients at center freq f0 with Q and gain_db.
    /// Formulas per RBJ Audio EQ Cookbook (peakingEQ).
    pub fn set_peaking(&mut self, f0: f32, fs: f32, q: f32, gain_db: f32) {
        if gain_db.abs() < 0.05 {
            // Essentially zero — use identity to avoid wasted math
            self.b0 = 1.0; self.b1 = 0.0; self.b2 = 0.0;
            self.a1 = 0.0; self.a2 = 0.0;
            return;
        }
        let a    = 10f32.powf(gain_db / 40.0);
        let w0   = 2.0 * std::f32::consts::PI * f0 / fs;
        let cos_w0 = w0.cos();
        let alpha  = w0.sin() / (2.0 * q);

        let b0 = 1.0 + alpha * a;
        let b1 = -2.0 * cos_w0;
        let b2 = 1.0 - alpha * a;
        let a0 =  1.0 + alpha / a;
        let a1 = -2.0 * cos_w0;
        let a2 =  1.0 - alpha / a;

        self.b0 = b0 / a0;
        self.b1 = b1 / a0;
        self.b2 = b2 / a0;
        self.a1 = a1 / a0;
        self.a2 = a2 / a0;
    }

    #[inline]
    pub fn process_left(&mut self, x: f32) -> f32 {
        let y = self.b0 * x + self.b1 * self.state_l.x1 + self.b2 * self.state_l.x2
              - self.a1 * self.state_l.y1 - self.a2 * self.state_l.y2;
        self.state_l.x2 = self.state_l.x1;
        self.state_l.x1 = x;
        self.state_l.y2 = self.state_l.y1;
        self.state_l.y1 = y;
        y
    }

    #[inline]
    pub fn process_right(&mut self, x: f32) -> f32 {
        let y = self.b0 * x + self.b1 * self.state_r.x1 + self.b2 * self.state_r.x2
              - self.a1 * self.state_r.y1 - self.a2 * self.state_r.y2;
        self.state_r.x2 = self.state_r.x1;
        self.state_r.x1 = x;
        self.state_r.y2 = self.state_r.y1;
        self.state_r.y1 = y;
        y
    }
}

// ── EQ Chain (10 bands) ─────────────────────────────────────────
//
// Also maintains a ring buffer of the post-EQ mono signal + an FFT-based
// spectrum analyzer output. Spectrum bins are in 0..1 normalized magnitude
// at the 10 EQ band center frequencies, with an attack/release envelope
// follower so the UI bars look musical rather than jittery.
pub struct EqChain {
    pub filters: [Biquad; 10],
    pub bands_db: [f32; 10],
    pub sample_rate: f32,
    /// Cached "active" flag — skip EQ processing entirely if all bands are zero
    pub active: bool,

    // ── Spectrum analyzer ──
    ring:       Vec<f32>,       // Mono downmix ring buffer
    ring_pos:   usize,           // Write index
    fft_plan:   std::sync::Arc<dyn rustfft::Fft<f32>>,
    fft_scratch: Vec<rustfft::num_complex::Complex<f32>>, // Pre-allocated to avoid audio-thread allocation
    window:     Vec<f32>,        // Hann window (precomputed)
    spectrum:   [f32; 10],       // Smoothed band magnitudes (0..1+)
    peak:       f32,             // Running peak for normalization
    samples_since_fft: usize,
}

const FFT_SIZE: usize = 2048;       // ~46ms window at 44.1kHz
const FFT_INTERVAL: usize = 1024;   // Run FFT every ~23ms (≈43fps)

impl EqChain {
    pub fn new(sample_rate: f32) -> Self {
        let mut planner = rustfft::FftPlanner::new();
        let fft_plan = planner.plan_fft_forward(FFT_SIZE);
        // Precompute Hann window
        let window: Vec<f32> = (0..FFT_SIZE)
            .map(|n| {
                let x = (n as f32) / (FFT_SIZE as f32 - 1.0);
                0.5 - 0.5 * (2.0 * std::f32::consts::PI * x).cos()
            })
            .collect();
        Self {
            filters: [Biquad::identity(); 10],
            bands_db: [0.0; 10],
            sample_rate,
            active: false,
            ring: vec![0.0; FFT_SIZE],
            ring_pos: 0,
            fft_plan,
            fft_scratch: vec![rustfft::num_complex::Complex::new(0.0, 0.0); FFT_SIZE],
            window,
            spectrum: [0.0; 10],
            peak: 0.05,
            samples_since_fft: 0,
        }
    }

    /// Read the current smoothed spectrum bins (0..~1 range).
    pub fn spectrum(&self) -> [f32; 10] { self.spectrum }

    /// FFT the ring buffer, bin magnitudes into the 10 EQ bands,
    /// apply attack/release smoothing to the output. Called internally
    /// every FFT_INTERVAL samples.
    fn update_spectrum(&mut self) {
        use rustfft::num_complex::Complex;
        // Copy ring into pre-allocated scratch buffer (oldest sample first)
        for i in 0..FFT_SIZE {
            let idx = (self.ring_pos + i) % FFT_SIZE;
            self.fft_scratch[i] = Complex::new(self.ring[idx] * self.window[i], 0.0);
        }
        self.fft_plan.process(&mut self.fft_scratch);

        let half = FFT_SIZE / 2;
        let bin_hz = self.sample_rate / FFT_SIZE as f32;

        // Pre-compute all bin magnitudes into a local array so we can
        // drop the borrow on self.fft_scratch before mutating self.peak/spectrum.
        // half == 1024 which fits comfortably on the stack as a Vec alloc once.
        let mut mags = [0.0f32; FFT_SIZE / 2];
        let mut frame_peak = 0.0f32;
        for i in 0..half {
            let c = self.fft_scratch[i];
            let m = (c.re * c.re + c.im * c.im).sqrt();
            mags[i] = m;
            if m > frame_peak { frame_peak = m; }
        }
        // Running peak for normalization (slow release)
        self.peak = (self.peak * 0.995).max(frame_peak * 0.7).max(0.05);

        // Bin magnitudes into the 10 EQ center-frequency bands (1-octave window),
        // convert to log scale, apply envelope follower for musical ballistics.
        for (band_idx, &f0) in EQ_FREQS.iter().enumerate() {
            let low  = f0 / std::f32::consts::SQRT_2;   // -0.5 octave
            let high = f0 * std::f32::consts::SQRT_2;   // +0.5 octave
            let bin_lo = ((low  / bin_hz) as usize).max(1);
            let bin_hi = ((high / bin_hz) as usize).min(half - 1).max(bin_lo);

            let mut sum = 0.0f32;
            let mut count = 0usize;
            for bi in bin_lo..=bin_hi {
                sum += mags[bi];
                count += 1;
            }
            let avg = if count > 0 { sum / count as f32 } else { 0.0 };
            let norm = (avg / self.peak).clamp(0.0, 4.0);
            let db = 20.0 * (norm + 1e-6).log10();
            let level = ((db + 60.0) / 60.0).clamp(0.0, 1.2);

            // Classic VU ballistics: fast attack, slower release
            let prev = self.spectrum[band_idx];
            let coeff = if level > prev { 0.6 } else { 0.15 };
            self.spectrum[band_idx] = prev + (level - prev) * coeff;
        }
    }

    /// Update all 10 band gains. Pass-through array of 10 values in dB.
    /// Extra values are ignored, missing ones default to 0.
    pub fn set_bands(&mut self, bands: &[f32]) {
        for i in 0..10 {
            let db = bands.get(i).copied().unwrap_or(0.0);
            self.bands_db[i] = db;
            self.filters[i].set_peaking(EQ_FREQS[i], self.sample_rate, DEFAULT_Q, db);
        }
        self.active = self.bands_db.iter().any(|&g| g.abs() > 0.05);
    }

    pub fn set_sample_rate(&mut self, fs: f32) {
        if (self.sample_rate - fs).abs() < 0.01 { return; }
        self.sample_rate = fs;
        let bands = self.bands_db;
        self.set_bands(&bands);
    }

    /// Process one stereo sample pair in-place. Also feeds the
    /// post-EQ mono downmix into the spectrum analyzer ring buffer.
    #[inline]
    pub fn process_stereo(&mut self, l: f32, r: f32) -> (f32, f32) {
        let (out_l, out_r) = if self.active {
            let mut lo = l;
            let mut ro = r;
            for f in self.filters.iter_mut() {
                lo = f.process_left(lo);
                ro = f.process_right(ro);
            }
            // Mild soft clipping — bands at max boost can push above 1.0
            (lo.clamp(-1.5, 1.5), ro.clamp(-1.5, 1.5))
        } else {
            (l, r)
        };

        // Feed into spectrum ring buffer (mono downmix)
        let mono = 0.5 * (out_l + out_r);
        self.ring[self.ring_pos] = mono;
        self.ring_pos = (self.ring_pos + 1) % FFT_SIZE;
        self.samples_since_fft += 1;
        if self.samples_since_fft >= FFT_INTERVAL {
            self.samples_since_fft = 0;
            self.update_spectrum();
        }

        (out_l, out_r)
    }
}

pub type SharedEq = Arc<Mutex<EqChain>>;

pub fn new_shared_eq(sample_rate: f32) -> SharedEq {
    Arc::new(Mutex::new(EqChain::new(sample_rate)))
}

// ── Rodio Source adapter ───────────────────────────────────────
// Wraps any f32 stereo Source and runs each stereo pair through
// the shared EQ chain. When the UI sends new band values, the
// shared state updates, and ALL active wrappers pick it up on
// their next sample — zero coordination needed.

use rodio::Source;
use std::time::Duration;

pub struct EqSource<S: Source<Item = f32>> {
    inner: S,
    eq:    SharedEq,
    /// Per-sample channel alternation: expect stereo. For mono, each sample
    /// is processed as both L and R.
    next_is_left: bool,
    /// Pending right-channel sample (one frame lookahead for proper stereo)
    pending_right: Option<f32>,
    cached_channels: u16,
    cached_sample_rate: u32,
}

impl<S: Source<Item = f32>> EqSource<S> {
    pub fn new(inner: S, eq: SharedEq) -> Self {
        let channels = inner.channels();
        let sample_rate = inner.sample_rate();
        // Make sure the EQ chain matches this source's sample rate
        if let Ok(mut e) = eq.lock() {
            e.set_sample_rate(sample_rate as f32);
        }
        Self {
            inner,
            eq,
            next_is_left: true,
            pending_right: None,
            cached_channels: channels,
            cached_sample_rate: sample_rate,
        }
    }
}

impl<S: Source<Item = f32>> Iterator for EqSource<S> {
    type Item = f32;

    fn next(&mut self) -> Option<f32> {
        // If we buffered a filtered right sample last iteration, emit it now
        if let Some(r) = self.pending_right.take() {
            self.next_is_left = true;
            return Some(r);
        }

        let l = self.inner.next()?;

        match self.cached_channels {
            2 => {
                // Stereo — pair up L + R, filter both, emit L, stash R
                let r = self.inner.next().unwrap_or(l);
                if let Ok(mut e) = self.eq.lock() {
                    let (fl, fr) = e.process_stereo(l, r);
                    self.pending_right = Some(fr);
                    Some(fl)
                } else {
                    self.pending_right = Some(r);
                    Some(l)
                }
            }
            _ => {
                // Mono or other — process each sample as mono (L channel)
                if let Ok(mut e) = self.eq.lock() {
                    let (fl, _) = e.process_stereo(l, l);
                    Some(fl)
                } else {
                    Some(l)
                }
            }
        }
    }
}

impl<S: Source<Item = f32>> Source for EqSource<S> {
    fn current_frame_len(&self) -> Option<usize> { self.inner.current_frame_len() }
    fn channels(&self) -> u16                    { self.cached_channels }
    fn sample_rate(&self) -> u32                 { self.cached_sample_rate }
    fn total_duration(&self) -> Option<Duration> { self.inner.total_duration() }
}
