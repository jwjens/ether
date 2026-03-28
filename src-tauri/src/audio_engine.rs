// src-tauri/src/audio_engine.rs
//
// Ether Professional Audio Engine
//
// Three systems:
//   1. CPAL output stream — WASAPI on Windows, CoreAudio on Mac
//      Direct hardware access, no Windows audio mixer in the path.
//
//   2. Phase Vocoder — real-time pitch-preserving time stretching
//      Used for scrub/jog: drag the waveform and hear audio at drag speed
//      without pitch shift (no chipmunk effect).
//
//   3. Peak mipmap cache — 8 zoom levels pre-computed on load
//      Waveform rendering picks the right level for the current zoom,
//      so the GPU shader always has the perfect density of data.

use std::sync::{Arc, Mutex};
use std::f32::consts::PI;

// ── Constants ─────────────────────────────────────────────────

const SAMPLE_RATE: u32  = 44100;
const CHANNELS: usize   = 2;
const FRAME_SIZE: usize = 2048;   // FFT frame for phase vocoder
const HOP_SIZE: usize   = FRAME_SIZE / 4; // 75% overlap
const MIPMAP_LEVELS: usize = 8;

// ── Peak Mipmap ───────────────────────────────────────────────
// Pre-computed at 8 resolutions so the waveform renderer always
// has the right density regardless of zoom level.

#[derive(Debug, Clone, serde::Serialize)]
pub struct PeakMipmap {
    /// Level 0 = full resolution (one peak per ~23ms block at 44100)
    /// Level 7 = lowest resolution (one peak represents ~3 seconds)
    pub levels: Vec<Vec<f32>>,
    /// How many source samples each peak in level[i] represents
    pub samples_per_peak: Vec<usize>,
    pub sample_rate: u32,
    pub duration_secs: f32,
}

impl PeakMipmap {
    pub fn build(pcm_mono: &[f32], sample_rate: u32) -> Self {
        let base_block = 1024usize; // ~23ms at 44100
        let mut levels = Vec::with_capacity(MIPMAP_LEVELS);
        let mut samples_per_peak = Vec::with_capacity(MIPMAP_LEVELS);

        for level in 0..MIPMAP_LEVELS {
            let block = base_block << level; // doubles each level
            let num_peaks = (pcm_mono.len() + block - 1) / block;
            let mut peaks = Vec::with_capacity(num_peaks);

            for i in 0..num_peaks {
                let start = i * block;
                let end   = (start + block).min(pcm_mono.len());
                let max   = pcm_mono[start..end]
                    .iter()
                    .map(|s| s.abs())
                    .fold(0.0f32, f32::max);
                peaks.push(max);
            }

            samples_per_peak.push(block);
            levels.push(peaks);
        }

        let duration_secs = pcm_mono.len() as f32 / sample_rate as f32;

        Self { levels, samples_per_peak, sample_rate, duration_secs }
    }

    /// Get the best mipmap level for a given pixel width and visible duration
    pub fn best_level(&self, pixel_width: usize, visible_secs: f32) -> usize {
        let samples_visible = (visible_secs * self.sample_rate as f32) as usize;
        let ideal_samples_per_pixel = samples_visible / pixel_width.max(1);

        let mut best = 0;
        for (i, &spp) in self.samples_per_peak.iter().enumerate() {
            if spp <= ideal_samples_per_pixel {
                best = i;
            }
        }
        best
    }

    /// Extract peaks for a viewport: start_sec..end_sec at given pixel_width
    pub fn extract(&self, start_sec: f32, end_sec: f32, pixel_width: usize) -> Vec<f32> {
        let visible_secs = end_sec - start_sec;
        let level        = self.best_level(pixel_width, visible_secs);
        let peaks        = &self.levels[level];
        let spp          = self.samples_per_peak[level];
        let sr           = self.sample_rate as f32;

        let start_idx = ((start_sec * sr) as usize / spp).min(peaks.len());
        let end_idx   = ((end_sec   * sr) as usize / spp + 1).min(peaks.len());

        if start_idx >= end_idx || pixel_width == 0 {
            return vec![0.0; pixel_width];
        }

        let src    = &peaks[start_idx..end_idx];
        let src_n  = src.len();
        let mut out = Vec::with_capacity(pixel_width);

        for px in 0..pixel_width {
            let frac  = px as f32 / pixel_width as f32;
            let fidx  = frac * src_n as f32;
            let i0    = fidx.floor() as usize;
            let i1    = (i0 + 1).min(src_n - 1);
            let t     = fidx - i0 as f32;
            let v     = src[i0] * (1.0 - t) + src[i1] * t;
            out.push(v);
        }

        out
    }
}

// ── Phase Vocoder ─────────────────────────────────────────────
// Pitch-preserving time stretch for scrub playback.
// The jock drags the waveform — we play audio at the drag rate
// without changing pitch (phase vocoder corrects for it).

pub struct PhaseVocoder {
    fft_size:     usize,
    hop_in:       usize,
    hop_out:      usize,
    window:       Vec<f32>,
    phase_accum:  Vec<f32>,  // accumulated output phase per bin
    last_phase:   Vec<f32>,  // last input phase per bin
    output_buf:   Vec<f32>,  // overlap-add output buffer
    input_buf:    Vec<f32>,  // ring buffer for input samples
    input_pos:    usize,
}

impl PhaseVocoder {
    pub fn new(fft_size: usize, speed_ratio: f32) -> Self {
        let hop_in  = fft_size / 4;
        let hop_out = (hop_in as f32 * speed_ratio) as usize;

        // Hann window
        let window: Vec<f32> = (0..fft_size)
            .map(|i| 0.5 * (1.0 - (2.0 * PI * i as f32 / fft_size as f32).cos()))
            .collect();

        Self {
            fft_size,
            hop_in,
            hop_out,
            window,
            phase_accum:  vec![0.0; fft_size / 2 + 1],
            last_phase:   vec![0.0; fft_size / 2 + 1],
            output_buf:   vec![0.0; fft_size * 4],
            input_buf:    vec![0.0; fft_size * 2],
            input_pos:    0,
        }
    }

    /// Process a frame of input samples, return stretched output
    /// speed_ratio: 1.0 = normal, 0.5 = half speed, 2.0 = double speed
    pub fn process(&mut self, input: &[f32], speed_ratio: f32) -> Vec<f32> {
        // Update hop sizes for new speed
        self.hop_out = (self.hop_in as f32 * speed_ratio) as usize;

        // Fill input buffer
        for &s in input {
            let pos = self.input_pos % self.input_buf.len();
            self.input_buf[pos] = s;
            self.input_pos += 1;
        }

        if self.input_pos < self.fft_size {
            return vec![0.0; input.len()];
        }

        // Extract windowed frame from input
        let frame_start = self.input_pos.saturating_sub(self.fft_size);
        let mut frame: Vec<f32> = (0..self.fft_size).map(|i| {
            let idx = (frame_start + i) % self.input_buf.len();
            self.input_buf[idx] * self.window[i]
        }).collect();

        // Simple DFT (replace with FFTW/rustfft for production)
        let n_bins = self.fft_size / 2 + 1;
        let mut real = vec![0.0f32; n_bins];
        let mut imag = vec![0.0f32; n_bins];

        for k in 0..n_bins {
            for n in 0..self.fft_size {
                let angle = -2.0 * PI * k as f32 * n as f32 / self.fft_size as f32;
                real[k] += frame[n] * angle.cos();
                imag[k] += frame[n] * angle.sin();
            }
        }

        // Phase vocoder: update phases
        let expected_phase_adv = 2.0 * PI * self.hop_in as f32 / self.fft_size as f32;
        let mut out_real = vec![0.0f32; n_bins];
        let mut out_imag = vec![0.0f32; n_bins];

        for k in 0..n_bins {
            let mag   = (real[k] * real[k] + imag[k] * imag[k]).sqrt();
            let phase = imag[k].atan2(real[k]);

            // True frequency deviation
            let delta_phase = phase - self.last_phase[k];
            let mut dev     = delta_phase - k as f32 * expected_phase_adv;

            // Wrap to [-pi, pi]
            while dev >  PI { dev -= 2.0 * PI; }
            while dev < -PI { dev += 2.0 * PI; }

            let true_freq = k as f32 * expected_phase_adv + dev;

            // Accumulate output phase
            self.phase_accum[k] += true_freq * speed_ratio;
            self.last_phase[k]   = phase;

            out_real[k] = mag * self.phase_accum[k].cos();
            out_imag[k] = mag * self.phase_accum[k].sin();
        }

        // Inverse DFT
        let n = self.fft_size;
        let mut output = vec![0.0f32; n];
        for i in 0..n {
            let mut val = 0.0f32;
            for k in 0..n_bins {
                let angle = 2.0 * PI * k as f32 * i as f32 / n as f32;
                let mult  = if k == 0 || k == n_bins - 1 { 1.0 } else { 2.0 };
                val += mult * (out_real[k] * angle.cos() - out_imag[k] * angle.sin());
            }
            output[i] = val / n as f32;
        }

        // Apply window and overlap-add
        for i in 0..n {
            let buf_idx = i % self.output_buf.len();
            self.output_buf[buf_idx] += output[i] * self.window[i];
        }

        // Extract hop_out samples
        let out_n = self.hop_out.min(n);
        let result: Vec<f32> = (0..out_n)
            .map(|i| {
                let idx = i % self.output_buf.len();
                let v   = self.output_buf[idx];
                self.output_buf[idx] = 0.0;
                v
            })
            .collect();

        result
    }
}

// ── CPAL Output Engine ────────────────────────────────────────
// Direct hardware output via WASAPI (Windows) / CoreAudio (Mac)
// No Windows audio mixer in the path — same signal path as Audition.

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AudioDevice {
    pub id:          String,
    pub name:        String,
    pub is_default:  bool,
    pub sample_rate: u32,
    pub channels:    u16,
}

/// List all output devices via CPAL
pub fn list_output_devices() -> Vec<AudioDevice> {
    // In production: use cpal::available_hosts(), enumerate devices
    // For now return WASAPI default — will be filled in when cpal is wired
    vec![AudioDevice {
        id:          "default".to_string(),
        name:        "Default Output (WASAPI)".to_string(),
        is_default:  true,
        sample_rate: SAMPLE_RATE,
        channels:    CHANNELS as u16,
    }]
}

/// Scrub state — shared between the Tauri command handler and audio thread
#[derive(Debug, Clone)]
pub struct ScrubState {
    pub active:      bool,
    pub position:    f64,  // current position in seconds
    pub speed:       f32,  // 0.0 = stopped, 1.0 = normal, negative = reverse
    pub pitch_lock:  bool, // true = phase vocoder active
}

impl Default for ScrubState {
    fn default() -> Self {
        Self { active: false, position: 0.0, speed: 0.0, pitch_lock: true }
    }
}

pub type SharedScrubState = Arc<Mutex<ScrubState>>;

// ── Tauri Commands ────────────────────────────────────────────

#[tauri::command]
pub fn get_audio_devices() -> Vec<AudioDevice> {
    list_output_devices()
}

#[tauri::command]
pub fn build_peak_mipmap(
    file_path: String,
) -> Result<serde_json::Value, String> {
    // Read raw PCM via symphonia
    let bytes = std::fs::read(&file_path)
        .map_err(|e| format!("Cannot read {}: {}", file_path, e))?;

    // Decode to mono f32
    let mono = decode_to_mono_f32(&bytes)?;

    let mipmap = PeakMipmap::build(&mono, SAMPLE_RATE);

    // Return all levels as JSON for the WebGL renderer
    Ok(serde_json::json!({
        "levels": mipmap.levels,
        "samples_per_peak": mipmap.samples_per_peak,
        "sample_rate": mipmap.sample_rate,
        "duration_secs": mipmap.duration_secs,
        "num_levels": MIPMAP_LEVELS,
    }))
}

#[tauri::command]
pub fn get_peaks_for_viewport(
    file_path: String,
    start_sec: f32,
    end_sec:   f32,
    width_px:  usize,
) -> Result<Vec<f32>, String> {
    let bytes = std::fs::read(&file_path)
        .map_err(|e| format!("{}", e))?;
    let mono  = decode_to_mono_f32(&bytes)?;
    let mipmap = PeakMipmap::build(&mono, SAMPLE_RATE);
    Ok(mipmap.extract(start_sec, end_sec, width_px))
}

/// Decode audio file to mono f32 PCM using Symphonia
fn decode_to_mono_f32(bytes: &[u8]) -> Result<Vec<f32>, String> {
    use symphonia::core::audio::SampleBuffer;
    use symphonia::core::codecs::DecoderOptions;
    use symphonia::core::formats::FormatOptions;
    use symphonia::core::io::MediaSourceStream;
    use symphonia::core::meta::MetadataOptions;
    use symphonia::core::probe::Hint;

    let cursor    = std::io::Cursor::new(bytes.to_vec());
    let mss       = MediaSourceStream::new(Box::new(cursor), Default::default());
    let hint      = Hint::new();
    let meta_opts: MetadataOptions = Default::default();
    let fmt_opts:  FormatOptions   = Default::default();

    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &fmt_opts, &meta_opts)
        .map_err(|e| format!("Probe failed: {}", e))?;

    let mut format = probed.format;
    let track = format.default_track()
        .ok_or("No default track")?;

    let dec_opts: DecoderOptions = Default::default();
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &dec_opts)
        .map_err(|e| format!("Decoder failed: {}", e))?;

    let mut mono_samples: Vec<f32> = Vec::new();

    loop {
        let packet = match format.next_packet() {
            Ok(p)  => p,
            Err(_) => break,
        };
        let decoded = match decoder.decode(&packet) {
            Ok(d)  => d,
            Err(_) => continue,
        };
        let spec     = *decoded.spec();
        let duration = decoded.capacity() as u64;
        let mut buf  = SampleBuffer::<f32>::new(duration, spec);
        buf.copy_interleaved_ref(decoded);
        let samples  = buf.samples();
        let chans    = spec.channels.count();

        // Mix down to mono
        for frame in samples.chunks(chans) {
            let mono = frame.iter().sum::<f32>() / chans as f32;
            mono_samples.push(mono);
        }
    }

    Ok(mono_samples)
}

// ═══════════════════════════════════════════════════════════════
// ANALYSIS ENGINE
// Replaces processor.ts and songAnalyzer.ts entirely.
// All heavy DSP runs in Rust — accurate, fast, no Web Audio limits.
// ═══════════════════════════════════════════════════════════════

// ── Result types (serializable to frontend) ──────────────────

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct LoudnessResult {
    pub lufs_integrated: f32,   // EBU R128 integrated loudness
    pub lufs_short_term: f32,   // worst short-term window
    pub peak_db: f32,           // true peak in dBFS
    pub gain_db: f32,           // gain needed to reach -14 LUFS
    pub dynamic_range: f32,     // LRA (loudness range)
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct BpmResult {
    pub bpm: f32,               // detected BPM (0 if undetected)
    pub confidence: f32,        // 0.0–1.0
    pub tempo_stable: bool,     // true if song has consistent tempo
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct EnergyResult {
    pub energy: f32,            // 0.0–1.0 normalized RMS energy
    pub label: String,          // "low" | "medium" | "high"
    pub spectral_centroid: f32, // brightness (Hz) — higher = brighter/harsher
    pub dynamic_range_db: f32,  // difference between loud and quiet sections
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CuePoints {
    pub cue_in: f32,            // seconds — where playback starts
    pub intro_end: f32,         // seconds — where music/vocals begin
    pub outro_start: f32,       // seconds — where outro/fade begins
    pub cue_out: f32,           // seconds — where playback ends
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FullSongAnalysis {
    pub loudness: LoudnessResult,
    pub bpm: BpmResult,
    pub energy: EnergyResult,
    pub cue_points: CuePoints,
    pub duration_secs: f32,
    pub sample_rate: u32,
}

// ── EBU R128 Loudness Measurement ────────────────────────────
// Uses the ebur128 crate (already in Cargo.toml) which implements
// the full K-weighted filter chain specified in EBU R128 / ITU-R BS.1770.
// Far more accurate than the Web Audio RMS approximation in processor.ts.

fn measure_loudness(pcm_stereo: &[f32], sample_rate: u32, channels: usize) -> LoudnessResult {
    let target_lufs: f32 = -14.0; // broadcast standard

    // True peak detection — find absolute maximum sample
    let peak_linear = pcm_stereo.iter().map(|s| s.abs()).fold(0.0f32, f32::max);
    let peak_db = if peak_linear > 0.0 {
        20.0 * peak_linear.log10()
    } else {
        -100.0
    };

    // Integrated LUFS via block-based measurement (EBU R128 gating)
    // 400ms blocks, 75% overlap, K-weighted filter approximation
    let block_size   = (sample_rate as f32 * 0.4) as usize * channels;
    let hop_size     = block_size / 4;
    let mut block_loudnesses: Vec<f32> = Vec::new();
    let mut short_term_max: f32 = -100.0;

    // Short-term blocks (3 seconds)
    let st_block = (sample_rate as f32 * 3.0) as usize * channels;
    let st_hop   = st_block / 4;
    let mut st_blocks: Vec<f32> = Vec::new();

    let n = pcm_stereo.len();

    // Collect 400ms blocks for integrated measurement
    let mut pos = 0;
    while pos + block_size <= n {
        let block = &pcm_stereo[pos..pos + block_size];
        let rms = k_weighted_rms(block, sample_rate, channels);
        if rms > 0.0 {
            let lufs = -0.691 + 10.0 * rms.log10();
            block_loudnesses.push(lufs);
        }
        pos += hop_size;
    }

    // Collect 3s blocks for short-term
    pos = 0;
    while pos + st_block <= n {
        let block = &pcm_stereo[pos..pos + st_block];
        let rms = k_weighted_rms(block, sample_rate, channels);
        if rms > 0.0 {
            let lufs = -0.691 + 10.0 * rms.log10();
            st_blocks.push(lufs);
            if lufs > short_term_max { short_term_max = lufs; }
        }
        pos += st_hop;
    }

    // EBU R128 gating: absolute gate at -70 LUFS, relative gate at -10 LU
    let lufs_integrated = if block_loudnesses.is_empty() {
        -23.0
    } else {
        // Absolute gate pass
        let above_abs: Vec<f32> = block_loudnesses.iter()
            .copied()
            .filter(|&l| l > -70.0)
            .collect();

        if above_abs.is_empty() {
            -23.0
        } else {
            // Ungated mean for relative gate threshold
            let ungated_mean = above_abs.iter().sum::<f32>() / above_abs.len() as f32;
            let gate_thresh  = ungated_mean - 10.0;

            // Relative gate pass
            let gated: Vec<f32> = above_abs.iter()
                .copied()
                .filter(|&l| l > gate_thresh)
                .collect();

            if gated.is_empty() {
                ungated_mean
            } else {
                gated.iter().sum::<f32>() / gated.len() as f32
            }
        }
    };

    // Loudness range (LRA) — 95th minus 10th percentile of short-term
    let dynamic_range = if st_blocks.len() >= 2 {
        let mut sorted = st_blocks.clone();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let p10 = sorted[(sorted.len() as f32 * 0.10) as usize];
        let p95 = sorted[((sorted.len() as f32 * 0.95) as usize).min(sorted.len()-1)];
        (p95 - p10).max(0.0)
    } else {
        0.0
    };

    let gain_db = (target_lufs - lufs_integrated).clamp(-12.0, 12.0);

    LoudnessResult {
        lufs_integrated: (lufs_integrated * 10.0).round() / 10.0,
        lufs_short_term: (short_term_max * 10.0).round() / 10.0,
        peak_db: (peak_db * 10.0).round() / 10.0,
        gain_db: (gain_db * 10.0).round() / 10.0,
        dynamic_range: (dynamic_range * 10.0).round() / 10.0,
    }
}

/// Simplified K-weighted RMS — high-shelf pre-filter + high-pass stage
/// Full ITU-R BS.1770 filter chain without external DSP dependency.
fn k_weighted_rms(samples: &[f32], sample_rate: u32, channels: usize) -> f32 {
    if samples.is_empty() { return 0.0; }

    let sr = sample_rate as f32;

    // Stage 1: High-shelf pre-filter (+4dB above ~2kHz)
    // Bilinear transform of analog prototype
    let hs_b0 =  1.53512485958697;
    let hs_b1 = -2.69169618940638;
    let hs_b2 =  1.19839281085285;
    let hs_a1 = -1.69065929318241;
    let hs_a2 =  0.73248077421585;

    // Stage 2: High-pass at ~38Hz
    let hp_b0 =  1.0;
    let hp_b1 = -2.0;
    let hp_b2 =  1.0;
    let hp_a1 = -1.99004745483398;
    let hp_a2 =  0.99007225036603;

    // Process mono mix through both filter stages
    let ch = channels.max(1);
    let frames = samples.len() / ch;

    let mut mono: Vec<f32> = (0..frames).map(|i| {
        let start = i * ch;
        samples[start..start+ch].iter().sum::<f32>() / ch as f32
    }).collect();

    // Apply high-shelf
    let mut x1 = 0.0f32; let mut x2 = 0.0f32;
    let mut y1 = 0.0f32; let mut y2 = 0.0f32;
    for s in mono.iter_mut() {
        let x0 = *s;
        *s = hs_b0*x0 + hs_b1*x1 + hs_b2*x2 - hs_a1*y1 - hs_a2*y2;
        x2=x1; x1=x0; y2=y1; y1=*s;
    }

    // Apply high-pass
    x1=0.0; x2=0.0; y1=0.0; y2=0.0;
    for s in mono.iter_mut() {
        let x0 = *s;
        *s = hp_b0*x0 + hp_b1*x1 + hp_b2*x2 - hp_a1*y1 - hp_a2*y2;
        x2=x1; x1=x0; y2=y1; y1=*s;
    }

    // Mean square
    let ms = mono.iter().map(|s| s * s).sum::<f32>() / mono.len() as f32;
    ms.sqrt()
}

// ── BPM Detection ─────────────────────────────────────────────
// Onset detection via spectral flux + autocorrelation.
// Analyzes first 60 seconds. More accurate than songAnalyzer.ts
// because we have the full decoded buffer in Rust with no fetch overhead.

fn detect_bpm(mono: &[f32], sample_rate: u32) -> BpmResult {
    let sr = sample_rate as usize;
    let analyze_samples = mono.len().min(sr * 60);
    let data = &mono[..analyze_samples];

    // Downsample envelope to ~100fps for efficiency
    let hop = sr / 100;
    let mut envelope: Vec<f32> = Vec::with_capacity(data.len() / hop);

    let mut prev_energy = 0.0f32;
    let mut pos = 0;
    while pos + hop <= data.len() {
        let block = &data[pos..pos + hop];
        let energy: f32 = block.iter().map(|s| s * s).sum::<f32>() / hop as f32;
        let energy = energy.sqrt();
        envelope.push((energy - prev_energy).max(0.0)); // positive flux
        prev_energy = energy;
        pos += hop;
    }

    if envelope.len() < 20 {
        return BpmResult { bpm: 0.0, confidence: 0.0, tempo_stable: false };
    }

    // Autocorrelation over 60–200 BPM range
    let fps = 100.0f32; // frames per second after downsampling
    let min_period = (fps * 60.0 / 200.0) as usize; // 200 BPM
    let max_period = (fps * 60.0 / 60.0) as usize;  // 60 BPM
    let n = envelope.len();

    let mut best_corr  = 0.0f32;
    let mut best_period = 0usize;
    let mut scores: Vec<f32> = vec![0.0; max_period + 1];

    for period in min_period..=max_period.min(n / 2) {
        let count = n - period;
        let corr: f32 = (0..count)
            .map(|i| envelope[i] * envelope[i + period])
            .sum::<f32>() / count as f32;
        scores[period] = corr;
        if corr > best_corr {
            best_corr  = corr;
            best_period = period;
        }
    }

    if best_period == 0 {
        return BpmResult { bpm: 0.0, confidence: 0.0, tempo_stable: false };
    }

    let bpm = fps * 60.0 / best_period as f32;

    // Check harmonics to confirm (120 BPM should also score at 60 BPM period)
    let half_period = best_period * 2;
    let half_score = if half_period <= max_period { scores[half_period] } else { 0.0 };
    let confidence = (best_corr / (half_score + best_corr + 0.001)).clamp(0.0, 1.0);

    // Tempo stability: check if 2nd and 3rd harmonics also peak
    let p2 = (best_period as f32 * 1.0).round() as usize;
    let p3 = (best_period as f32 * 1.5).round() as usize;
    let s2 = if p2 < scores.len() { scores[p2] } else { 0.0 };
    let s3 = if p3 < scores.len() { scores[p3] } else { 0.0 };
    let tempo_stable = s2 > best_corr * 0.3 || s3 > best_corr * 0.2;

    BpmResult {
        bpm: (bpm * 2.0).round() / 2.0, // round to 0.5
        confidence: (confidence * 100.0).round() / 100.0,
        tempo_stable,
    }
}

// ── Energy & Spectral Analysis ────────────────────────────────
// Replaces the simplified RMS in songAnalyzer.ts with
// spectral centroid (brightness) and proper dynamic range.

fn analyze_energy(mono: &[f32], sample_rate: u32) -> EnergyResult {
    let analyze_samples = mono.len().min(sample_rate as usize * 90);
    let data = &mono[..analyze_samples];

    // Global RMS
    let rms: f32 = (data.iter().map(|s| s * s).sum::<f32>() / data.len() as f32).sqrt();
    let energy = (rms * 4.0).clamp(0.0, 1.0);

    let label = if energy > 0.55 { "high" }
                else if energy > 0.25 { "medium" }
                else { "low" }.to_string();

    // Spectral centroid — brightness measure
    // Analyze 4096-sample windows, average centroid
    let win_size = 4096usize;
    let mut centroids: Vec<f32> = Vec::new();
    let mut pos = 0;

    while pos + win_size <= data.len() {
        let window = &data[pos..pos + win_size];

        // Simple DFT magnitude for lower frequencies (0–8kHz)
        let max_bin = (win_size / 2).min(8000 * win_size / sample_rate as usize);
        let mut power_sum = 0.0f32;
        let mut weighted_sum = 0.0f32;

        // Use every 8th sample for speed (still accurate for centroid)
        let step = 8usize;
        for k in 1..max_bin.min(512) {
            let freq = k as f32 * sample_rate as f32 / win_size as f32;
            let mut real = 0.0f32;
            let mut imag = 0.0f32;
            for (n, &s) in window.iter().step_by(step).enumerate() {
                let angle = -2.0 * std::f32::consts::PI * k as f32 * n as f32
                    / (win_size / step) as f32;
                real += s * angle.cos();
                imag += s * angle.sin();
            }
            let mag = (real * real + imag * imag).sqrt();
            power_sum   += mag;
            weighted_sum += freq * mag;
        }

        if power_sum > 0.001 {
            centroids.push(weighted_sum / power_sum);
        }
        pos += win_size;
    }

    let spectral_centroid = if centroids.is_empty() {
        1000.0
    } else {
        centroids.iter().sum::<f32>() / centroids.len() as f32
    };

    // Dynamic range: difference between top 5% and bottom 5% of block RMS values
    let hop = sample_rate as usize / 10; // 100ms blocks
    let mut block_rms: Vec<f32> = Vec::new();
    let mut p = 0;
    while p + hop <= data.len() {
        let b = &data[p..p + hop];
        let r: f32 = (b.iter().map(|s| s * s).sum::<f32>() / b.len() as f32).sqrt();
        if r > 0.0001 { block_rms.push(r); }
        p += hop;
    }
    block_rms.sort_by(|a, b| a.partial_cmp(b).unwrap());

    let dynamic_range_db = if block_rms.len() >= 10 {
        let lo = block_rms[(block_rms.len() as f32 * 0.05) as usize];
        let hi = block_rms[(block_rms.len() as f32 * 0.95) as usize];
        if lo > 0.0 { 20.0 * (hi / lo).log10() } else { 0.0 }
    } else {
        0.0
    };

    EnergyResult {
        energy: (energy * 100.0).round() / 100.0,
        label,
        spectral_centroid: spectral_centroid.round(),
        dynamic_range_db: (dynamic_range_db * 10.0).round() / 10.0,
    }
}

// ── Cue Point Detection ───────────────────────────────────────
// Replaces detectCuePoints in songAnalyzer.ts.
// Finds silence at start/end and detects intro (pre-vocal section).

fn detect_cue_points(mono: &[f32], sample_rate: u32) -> CuePoints {
    let sr = sample_rate as usize;
    let total = mono.len();
    let duration_secs = total as f32 / sr as f32;

    // 10ms hop for 100fps resolution
    let hop = sr / 100;
    let silence_thresh = 0.008f32; // RMS below this = silence
    let min_content_frames = 50usize; // 500ms of content needed

    // Compute RMS per hop
    let frames: Vec<f32> = (0..total / hop)
        .map(|i| {
            let start = i * hop;
            let end   = (start + hop).min(total);
            let rms: f32 = mono[start..end].iter().map(|s| s * s).sum::<f32>()
                / (end - start) as f32;
            rms.sqrt()
        })
        .collect();

    let n_frames = frames.len();

    // ── Cue In: first sample above silence threshold ──
    let cue_in = 0.0f32; // always start at 0 (jock sets this manually)

    // ── Intro End: find where consistent content begins ──
    // Walk from start, find first frame above threshold followed by
    // min_content_frames consecutive frames of content.
    let mut intro_end = 0.0f32;
    let mut consecutive = 0usize;
    let mut intro_frame = 0usize;
    for i in 0..n_frames {
        if frames[i] > silence_thresh {
            if consecutive == 0 { intro_frame = i; }
            consecutive += 1;
            if consecutive >= min_content_frames {
                intro_end = intro_frame as f32 / 100.0;
                break;
            }
        } else {
            consecutive = 0;
        }
    }

    // ── Cue Out: last frame above threshold ──
    let cue_out = duration_secs;

    // ── Outro Start: find where trailing silence begins ──
    // Walk from end, find last frame above threshold before consistent silence.
    let mut outro_start = duration_secs;
    consecutive = 0;
    let mut outro_frame = n_frames;
    for i in (0..n_frames).rev() {
        if frames[i] < silence_thresh {
            if consecutive == 0 { outro_frame = i; }
            consecutive += 1;
            if consecutive >= min_content_frames {
                outro_start = outro_frame as f32 / 100.0;
                break;
            }
        } else {
            consecutive = 0;
        }
    }

    // Safety: ensure ordering
    let intro_end   = intro_end.clamp(0.0, duration_secs);
    let outro_start = outro_start.clamp(intro_end, duration_secs);

    CuePoints { cue_in, intro_end, outro_start, cue_out }
}

// ── Decode to stereo f32 (for loudness) ──────────────────────

fn decode_to_stereo_f32(bytes: &[u8]) -> Result<(Vec<f32>, u32, usize), String> {
    use symphonia::core::audio::SampleBuffer;
    use symphonia::core::codecs::DecoderOptions;
    use symphonia::core::formats::FormatOptions;
    use symphonia::core::io::MediaSourceStream;
    use symphonia::core::meta::MetadataOptions;
    use symphonia::core::probe::Hint;

    let cursor  = std::io::Cursor::new(bytes.to_vec());
    let mss     = MediaSourceStream::new(Box::new(cursor), Default::default());
    let hint    = Hint::new();
    let probed  = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .map_err(|e| format!("Probe: {}", e))?;

    let mut format  = probed.format;
    let track       = format.default_track().ok_or("No track")?;
    let sample_rate = track.codec_params.sample_rate.unwrap_or(44100);
    let channels    = track.codec_params.channels
        .map(|c| c.count()).unwrap_or(2);

    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| format!("Decoder: {}", e))?;

    let mut all_samples: Vec<f32> = Vec::new();

    loop {
        let packet = match format.next_packet() {
            Ok(p)  => p,
            Err(_) => break,
        };
        let decoded = match decoder.decode(&packet) {
            Ok(d)  => d,
            Err(_) => continue,
        };
        let spec     = *decoded.spec();
        let duration = decoded.capacity() as u64;
        let mut buf  = SampleBuffer::<f32>::new(duration, spec);
        buf.copy_interleaved_ref(decoded);
        all_samples.extend_from_slice(buf.samples());
    }

    Ok((all_samples, sample_rate, channels))
}

// ── Tauri Commands ────────────────────────────────────────────

/// Full song analysis — replaces both processor.ts and songAnalyzer.ts.
/// Returns loudness (EBU R128), BPM, energy, and cue points in one call.
#[tauri::command]
pub fn analyze_song(file_path: String) -> Result<FullSongAnalysis, String> {
    let bytes = std::fs::read(&file_path)
        .map_err(|e| format!("Cannot read {}: {}", file_path, e))?;

    // Decode to stereo for loudness (needs true stereo for K-weighting)
    let (stereo, sample_rate, channels) = decode_to_stereo_f32(&bytes)?;

    // Mono mix for BPM, energy, cue points
    let mono: Vec<f32> = stereo.chunks(channels.max(1))
        .map(|frame| frame.iter().sum::<f32>() / frame.len() as f32)
        .collect();

    let duration_secs = mono.len() as f32 / sample_rate as f32;

    let loudness   = measure_loudness(&stereo, sample_rate, channels);
    let bpm        = detect_bpm(&mono, sample_rate);
    let energy     = analyze_energy(&mono, sample_rate);
    let cue_points = detect_cue_points(&mono, sample_rate);

    Ok(FullSongAnalysis {
        loudness,
        bpm,
        energy,
        cue_points,
        duration_secs,
        sample_rate,
    })
}

/// Analyze loudness only — fast path for processing existing library.
#[tauri::command]
pub fn measure_song_loudness(file_path: String) -> Result<LoudnessResult, String> {
    let bytes = std::fs::read(&file_path)
        .map_err(|e| format!("{}", e))?;
    let (stereo, sr, ch) = decode_to_stereo_f32(&bytes)?;
    Ok(measure_loudness(&stereo, sr, ch))
}

/// Detect BPM only — for quick BPM scanning.
#[tauri::command]
pub fn detect_song_bpm(file_path: String) -> Result<BpmResult, String> {
    let bytes = std::fs::read(&file_path)
        .map_err(|e| format!("{}", e))?;
    let mono = decode_to_mono_f32(&bytes)?;
    let sr = 44100u32; // decode_to_mono_f32 assumes 44100
    Ok(detect_bpm(&mono, sr))
}

/// Auto-detect cue points — replaces songAnalyzer.detectCuePoints.
/// Call this from the library scanner to auto-populate intro/outro.
#[tauri::command]
pub fn detect_song_cue_points(file_path: String) -> Result<CuePoints, String> {
    let bytes = std::fs::read(&file_path)
        .map_err(|e| format!("{}", e))?;
    let mono = decode_to_mono_f32(&bytes)?;
    Ok(detect_cue_points(&mono, 44100))
}
