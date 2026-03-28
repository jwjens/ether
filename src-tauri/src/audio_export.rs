// src-tauri/src/audio_export.rs
//
// Post-production processing pipeline for podcast/show exports.
//
// Pipeline:
//   Read file → Decode PCM → Trim silence → Measure LUFS → Normalize gain → Encode → Write
//
// Exposes three Tauri commands:
//   analyze_loudness(path)           → LoudnessResult
//   trim_silence(path, out, opts)    → TrimResult  
//   export_episode(opts)             → ExportResult  (normalize + trim + encode)

use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use ebur128::{EbuR128, Mode};

// ── Types ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoudnessResult {
    pub lufs_integrated: f64,
    pub lufs_short_term: f64,
    pub true_peak_db:    f64,
    pub duration_secs:   f64,
    pub suggested_gain_db: f64,
    pub target_lufs:     f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrimOptions {
    pub silence_threshold_db: f64,  // default -50dB
    pub min_silence_ms:       u64,  // default 500ms — shorter silences kept
    pub pad_start_ms:         u64,  // leave this much silence at start
    pub pad_end_ms:           u64,  // leave this much silence at end
}

impl Default for TrimOptions {
    fn default() -> Self {
        Self {
            silence_threshold_db: -50.0,
            min_silence_ms:       500,
            pad_start_ms:         200,
            pad_end_ms:           500,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrimResult {
    pub original_duration_secs: f64,
    pub trimmed_duration_secs:  f64,
    pub seconds_removed:        f64,
    pub silence_segments:       u32,
    pub output_path:            String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOptions {
    pub input_path:    String,
    pub output_path:   String,
    pub format:        String,     // "mp3" | "wav"
    pub bitrate_kbps:  u32,        // for mp3: 128, 192, 320
    pub target_lufs:   f64,        // -14.0 for podcast, -23.0 for broadcast
    pub normalize:     bool,
    pub trim_silence:  bool,
    pub trim_opts:     Option<TrimOptions>,
    pub title:         Option<String>,
    pub artist:        Option<String>,
    pub episode_num:   Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub output_path:          String,
    pub duration_secs:        f64,
    pub original_lufs:        f64,
    pub final_lufs:           f64,
    pub gain_applied_db:      f64,
    pub silence_removed_secs: f64,
    pub file_size_bytes:      u64,
}

// Progress callback type — sent via Tauri emit
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportProgress {
    pub stage:   String,
    pub pct:     u8,
    pub message: String,
}

// ── PCM decoding (reusable) ───────────────────────────────────

struct DecodedAudio {
    samples:     Vec<f32>,   // interleaved
    sample_rate: u32,
    channels:    u32,
    duration:    f64,
}

fn decode_file(path: &Path) -> Result<DecodedAudio, String> {
    let file = std::fs::File::open(path)
        .map_err(|e| format!("Cannot open '{}': {}", path.display(), e))?;

    let mss  = MediaSourceStream::new(Box::new(file), Default::default());
    let hint = Hint::new();
    let meta = MetadataOptions::default();
    let fmt  = FormatOptions::default();

    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &fmt, &meta)
        .map_err(|e| format!("Probe failed: {e}"))?;

    let mut format = probed.format;
    let track = format.tracks().iter()
        .find(|t| t.codec_params.codec != symphonia::core::codecs::CODEC_TYPE_NULL)
        .ok_or("No audio track found")?;

    let track_id   = track.id;
    let sample_rate = track.codec_params.sample_rate.unwrap_or(44100);
    let channels    = track.codec_params.channels.map(|c| c.count() as u32).unwrap_or(2);

    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| format!("Decoder error: {e}"))?;

    let mut all_samples: Vec<f32> = Vec::new();

    loop {
        let packet = match format.next_packet() {
            Ok(p)  => p,
            Err(_) => break,
        };
        if packet.track_id() != track_id { continue; }

        let decoded = match decoder.decode(&packet) {
            Ok(d)  => d,
            Err(_) => continue,
        };

        let spec   = *decoded.spec();
        let frames = decoded.frames();
        let mut sb = SampleBuffer::<f32>::new(frames as u64, spec);
        sb.copy_interleaved_ref(decoded);
        all_samples.extend_from_slice(sb.samples());
    }

    let duration = all_samples.len() as f64 / (sample_rate as f64 * channels as f64);

    Ok(DecodedAudio { samples: all_samples, sample_rate, channels, duration })
}

// ── LUFS measurement ─────────────────────────────────────────

fn measure_lufs(audio: &DecodedAudio, target: f64) -> Result<LoudnessResult, String> {
    let mut meter = EbuR128::new(audio.channels, audio.sample_rate, Mode::all())
        .map_err(|e| format!("EBU R128 init: {e}"))?;

    // Feed in chunks of 100ms
    let chunk_frames = (audio.sample_rate as usize / 10) * audio.channels as usize;
    for chunk in audio.samples.chunks(chunk_frames) {
        meter.add_frames_f32(chunk).map_err(|e| format!("EBU feed: {e}"))?;
    }

    let lufs_integrated = meter.loudness_global().map_err(|e| e.to_string())?;
    let lufs_short_term = meter.loudness_shortterm().unwrap_or(lufs_integrated);
    let true_peak_db    = (0..audio.channels)
        .filter_map(|c| meter.true_peak(c).ok())
        .fold(f64::NEG_INFINITY, f64::max);
    let true_peak_db_fs = if true_peak_db > 0.0 { 20.0 * true_peak_db.log10() } else { -144.0 };

    let suggested_gain = target - lufs_integrated;

    Ok(LoudnessResult {
        lufs_integrated,
        lufs_short_term,
        true_peak_db: true_peak_db_fs,
        duration_secs: audio.duration,
        suggested_gain_db: suggested_gain,
        target_lufs: target,
    })
}

// ── Silence trimming ─────────────────────────────────────────

fn trim_silence_from_samples(audio: &DecodedAudio, opts: &TrimOptions) -> (Vec<f32>, f64) {
    let threshold_linear = 10f32.powf(opts.silence_threshold_db as f32 / 20.0);
    let min_silence_frames = (opts.min_silence_ms as f64 / 1000.0 * audio.sample_rate as f64) as usize;
    let pad_start_frames   = (opts.pad_start_ms   as f64 / 1000.0 * audio.sample_rate as f64) as usize;
    let pad_end_frames     = (opts.pad_end_ms     as f64 / 1000.0 * audio.sample_rate as f64) as usize;
    let ch = audio.channels as usize;

    // Compute per-frame RMS (mono mix for analysis)
    let total_frames = audio.samples.len() / ch;
    let mut rms: Vec<f32> = Vec::with_capacity(total_frames);
    for i in 0..total_frames {
        let sum: f32 = (0..ch).map(|c| {
            let s = audio.samples[i * ch + c];
            s * s
        }).sum::<f32>() / ch as f32;
        rms.push(sum.sqrt());
    }

    // Mark each frame: true = loud, false = silent
    let loud: Vec<bool> = rms.iter().map(|&r| r > threshold_linear).collect();

    // Find contiguous silent regions longer than min_silence_ms — remove them
    let mut keep: Vec<bool> = vec![true; total_frames];
    let mut i = 0;
    let mut removed_frames: usize = 0;

    while i < total_frames {
        if !loud[i] {
            // Find end of this silent region
            let start = i;
            while i < total_frames && !loud[i] { i += 1; }
            let end = i;
            let len = end - start;

            if len > min_silence_frames {
                // Mark for removal, but keep pad_start + pad_end around voiced audio
                let keep_start = start + pad_start_frames.min(len / 2);
                let keep_end   = end.saturating_sub(pad_end_frames.min(len / 2));
                for j in keep_start..keep_end {
                    if j < total_frames { keep[j] = false; }
                }
                removed_frames += keep_end.saturating_sub(keep_start);
            }
        } else {
            i += 1;
        }
    }

    // Reconstruct samples from kept frames
    let mut output: Vec<f32> = Vec::with_capacity((total_frames - removed_frames) * ch);
    for (frame_idx, &k) in keep.iter().enumerate() {
        if k {
            for c in 0..ch {
                output.push(audio.samples[frame_idx * ch + c]);
            }
        }
    }

    let removed_secs = removed_frames as f64 / audio.sample_rate as f64;
    (output, removed_secs)
}

// ── WAV writing ───────────────────────────────────────────────

fn write_wav(path: &Path, samples: &[f32], sample_rate: u32, channels: u32) -> Result<u64, String> {
    use std::io::{Write, BufWriter};

    let file   = std::fs::File::create(path).map_err(|e| e.to_string())?;
    let mut w  = BufWriter::new(file);
    let data_len = (samples.len() * 2) as u32; // 16-bit

    // RIFF header
    w.write_all(b"RIFF").map_err(|e| e.to_string())?;
    w.write_all(&(36 + data_len).to_le_bytes()).map_err(|e| e.to_string())?;
    w.write_all(b"WAVE").map_err(|e| e.to_string())?;

    // fmt chunk
    w.write_all(b"fmt ").map_err(|e| e.to_string())?;
    w.write_all(&16u32.to_le_bytes()).map_err(|e| e.to_string())?;
    w.write_all(&1u16.to_le_bytes()).map_err(|e| e.to_string())?; // PCM
    w.write_all(&(channels as u16).to_le_bytes()).map_err(|e| e.to_string())?;
    w.write_all(&sample_rate.to_le_bytes()).map_err(|e| e.to_string())?;
    w.write_all(&(sample_rate * channels * 2).to_le_bytes()).map_err(|e| e.to_string())?;
    w.write_all(&(channels as u16 * 2).to_le_bytes()).map_err(|e| e.to_string())?;
    w.write_all(&16u16.to_le_bytes()).map_err(|e| e.to_string())?;

    // data chunk
    w.write_all(b"data").map_err(|e| e.to_string())?;
    w.write_all(&data_len.to_le_bytes()).map_err(|e| e.to_string())?;
    for &s in samples {
        let pcm = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
        w.write_all(&pcm.to_le_bytes()).map_err(|e| e.to_string())?;
    }
    w.flush().map_err(|e| e.to_string())?;

    Ok(std::fs::metadata(path).map(|m| m.len()).unwrap_or(0))
}

// ── MP3 writing ───────────────────────────────────────────────

fn write_mp3(
    path: &Path, samples: &[f32], sample_rate: u32,
    channels: u32, bitrate_kbps: u32,
    title: Option<&str>, artist: Option<&str>,
) -> Result<u64, String> {
    use std::io::{Write, BufWriter};
    use mp3lame_encoder::{Builder, FlushNoGap, MonoPcm, DualPcm};

    let mut b = Builder::new().map_err(|e| format!("{:?}", e))?;
    b.set_num_channels(channels as u8).map_err(|e| format!("{:?}", e))?;
    b.set_sample_rate(sample_rate).map_err(|e| format!("{:?}", e))?;
    b.set_brate(bitrate_kbps as _).map_err(|e| format!("{:?}", e))?;
    b.set_quality(2).map_err(|e| format!("{:?}", e))?; // high quality

    // ID3 tags
    if let Some(t) = title  { b.set_title(t).ok(); }
    if let Some(a) = artist { b.set_artist(a).ok(); }

    let mut enc = b.build().map_err(|e| format!("{:?}", e))?;

    let file = std::fs::File::create(path).map_err(|e| e.to_string())?;
    let mut w = BufWriter::new(file);

    // Convert f32 → i16 and encode in chunks
    let ch = channels as usize;
    let frame_size = 1152; // MPEG1 layer3 frame size in samples

    let samples_per_ch = samples.len() / ch;
    let mut offset = 0;

    while offset < samples_per_ch {
        let end = (offset + frame_size).min(samples_per_ch);

        let mp3 = if ch == 1 {
            let mono: Vec<i16> = (offset..end)
                .map(|i| (samples[i].clamp(-1.0, 1.0) * 32767.0) as i16)
                .collect();
            enc.encode(&MonoPcm(&mono)).map_err(|e| format!("{:?}", e))?
        } else {
            let left: Vec<i16>  = (offset..end).map(|i| (samples[i*ch].clamp(-1.0,1.0)*32767.0) as i16).collect();
            let right: Vec<i16> = (offset..end).map(|i| (samples[i*ch+1].clamp(-1.0,1.0)*32767.0) as i16).collect();
            enc.encode(&DualPcm { left: &left, right: &right }).map_err(|e| format!("{:?}", e))?
        };

        if !mp3.is_empty() { w.write_all(&mp3).map_err(|e| e.to_string())?; }
        offset = end;
    }

    let tail = enc.flush::<FlushNoGap>().map_err(|e| format!("{:?}", e))?;
    w.write_all(&tail).map_err(|e| e.to_string())?;
    w.flush().map_err(|e| e.to_string())?;

    Ok(std::fs::metadata(path).map(|m| m.len()).unwrap_or(0))
}

// ── Tauri commands ────────────────────────────────────────────

#[tauri::command]
pub fn analyze_loudness(path: String, target_lufs: Option<f64>) -> Result<LoudnessResult, String> {
    let audio = decode_file(Path::new(&path))?;
    measure_lufs(&audio, target_lufs.unwrap_or(-14.0))
}

#[tauri::command]
pub fn trim_silence_file(
    input_path: String,
    output_path: String,
    opts: Option<TrimOptions>,
) -> Result<TrimResult, String> {
    let opts  = opts.unwrap_or_default();
    let audio = decode_file(Path::new(&input_path))?;
    let original_duration = audio.duration;

    let (trimmed, removed_secs) = trim_silence_from_samples(&audio, &opts);
    let trimmed_duration = original_duration - removed_secs;

    // Count silence segments removed (approximate)
    let segments = (removed_secs / (opts.min_silence_ms as f64 / 1000.0)) as u32;

    // Write output as WAV (lossless intermediate)
    let out_path = PathBuf::from(&output_path);
    write_wav(&out_path, &trimmed, audio.sample_rate, audio.channels)?;

    Ok(TrimResult {
        original_duration_secs: original_duration,
        trimmed_duration_secs:  trimmed_duration,
        seconds_removed:        removed_secs,
        silence_segments:       segments,
        output_path,
    })
}

#[tauri::command]
pub async fn export_episode(
    opts: ExportOptions,
    window: tauri::Window,
) -> Result<ExportResult, String> {
    let emit = |stage: &str, pct: u8, msg: &str| {
        let _ = window.emit("export-progress", ExportProgress {
            stage:   stage.to_string(),
            pct,
            message: msg.to_string(),
        });
    };

    emit("decode", 5, "Reading audio file...");
    let mut audio = decode_file(Path::new(&opts.input_path))?;
    let original_duration = audio.duration;

    // ── Step 1: Trim silence ──────────────────────────────────
    let mut silence_removed = 0.0f64;
    if opts.trim_silence {
        emit("trim", 20, "Removing silence...");
        let trim_opts = opts.trim_opts.clone().unwrap_or_default();
        let (trimmed, removed) = trim_silence_from_samples(&audio, &trim_opts);
        audio.samples = trimmed;
        audio.duration = audio.duration - removed;
        silence_removed = removed;
        emit("trim", 35, &format!("Removed {:.1}s of silence", removed));
    }

    // ── Step 2: Measure LUFS ──────────────────────────────────
    emit("analyze", 40, "Measuring loudness...");
    let loudness = measure_lufs(&audio, opts.target_lufs)?;
    let original_lufs = loudness.lufs_integrated;
    let mut gain_applied = 0.0f64;

    // ── Step 3: Apply gain normalization ─────────────────────
    if opts.normalize && original_lufs.is_finite() {
        emit("normalize", 55, &format!(
            "Normalizing {:.1} LUFS → {:.1} LUFS",
            original_lufs, opts.target_lufs
        ));

        let gain_db   = loudness.suggested_gain_db;
        // Cap gain to prevent clipping — never boost more than headroom allows
        let safe_gain = gain_db.min(0.0 - loudness.true_peak_db - 1.0);
        let gain_lin  = 10f32.powf(safe_gain as f32 / 20.0);

        for s in &mut audio.samples {
            *s = (*s * gain_lin).clamp(-1.0, 1.0);
        }
        gain_applied = safe_gain;
    }

    // ── Step 4: Measure final LUFS ────────────────────────────
    emit("verify", 70, "Verifying levels...");
    let final_loudness = measure_lufs(&audio, opts.target_lufs)?;

    // ── Step 5: Encode and write ──────────────────────────────
    emit("encode", 80, &format!("Encoding {}...", opts.format.to_uppercase()));
    let out_path = PathBuf::from(&opts.output_path);
    let file_size = match opts.format.to_lowercase().as_str() {
        "mp3" => write_mp3(
            &out_path, &audio.samples,
            audio.sample_rate, audio.channels,
            opts.bitrate_kbps,
            opts.title.as_deref(), opts.artist.as_deref(),
        )?,
        "wav" | _ => write_wav(&out_path, &audio.samples, audio.sample_rate, audio.channels)?,
    };

    emit("done", 100, "Export complete!");

    Ok(ExportResult {
        output_path:          opts.output_path,
        duration_secs:        audio.duration,
        original_lufs,
        final_lufs:           final_loudness.lufs_integrated,
        gain_applied_db:      gain_applied,
        silence_removed_secs: silence_removed,
        file_size_bytes:      file_size,
    })
}
