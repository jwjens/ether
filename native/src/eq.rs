// native/src/eq.rs
// 10-band graphic EQ implemented as a chain of biquad peaking filters.
// Coefficients computed per the RBJ Audio EQ Cookbook.
//
// Shared across the audio engine via Arc<Mutex<EqChain>> so the JS-side
// slider changes propagate to all active audio sources in real time.

use std::sync::Arc;

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
// (Slice 8: no analyser here any more — the RTA is on the meter thread.)
pub struct EqChain {
    pub filters: [Biquad; 10],
    pub bands_db: [f32; 10],
    pub sample_rate: f32,
    /// Cached "active" flag — skip EQ processing entirely if all bands are zero
    pub active: bool,
    /// SLICE 4 — the master rack's GEQ slot is OUT (or removed): the filters are skipped exactly as they are
    /// for flat bands (`active == false`), so a bypassed GEQ is bit-identical to a flat one. The spectrum tap
    /// below still runs — it is a meter, not DSP. Default false (every non-rack user of EqChain unchanged).
    pub bypass: bool,

    // SLICE 8 — the spectrum analyser that lived here (a mono ring written every sample and a 2048-point FFT every
    // 1024 samples, ON THE AUDIO THREAD, in every instance — the room chain's result was never even read) is gone.
    // The RTA runs on the meter thread (rta.rs, docs/dsp-channel-rta.md); EqChain is the ten filters and nothing else.
}


impl EqChain {
    pub fn new(sample_rate: f32) -> Self {
        Self {
            filters: [Biquad::identity(); 10],
            bands_db: [0.0; 10],
            sample_rate,
            active: false,
            bypass: false,
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

    /// Process one stereo sample pair.
    #[inline]
    pub fn process_stereo(&mut self, l: f32, r: f32) -> (f32, f32) {
        let (out_l, out_r) = if self.active && !self.bypass {
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


        (out_l, out_r)
    }
}

pub type SharedEq = Arc<crate::rt::RtMutex<EqChain>>;

pub fn new_shared_eq(sample_rate: f32) -> SharedEq {
    Arc::new(crate::rt::RtMutex::new(EqChain::new(sample_rate)))
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
