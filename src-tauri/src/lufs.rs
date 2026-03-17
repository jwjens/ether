use ebur128::{EbuR128, Mode};
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use std::fs::File;

const TARGET_LUFS: f64 = -14.0;

pub fn analyze_file(path: &str) -> Result<f64, String> {
    let file = File::open(path).map_err(|e| e.to_string())?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = std::path::Path::new(path).extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .map_err(|e| e.to_string())?;

    let mut format = probed.format;
    let track = format.default_track().ok_or("No default track")?;
    let track_id = track.id;
    let sample_rate = track.codec_params.sample_rate.ok_or("No sample rate")? as u32;
    let channels = track.codec_params.channels.ok_or("No channels")?.count() as u32;

    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| e.to_string())?;

    let mut ebu = EbuR128::new(channels, sample_rate, Mode::I).map_err(|e| e.to_string())?;
    let mut sample_buf: Option<SampleBuffer<f32>> = None;

    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(_) => break,
        };
        if packet.track_id() != track_id { continue; }

        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(_) => continue,
        };

        let spec = *decoded.spec();
        let duration = decoded.capacity() as u64;

        let sb = sample_buf.get_or_insert_with(|| SampleBuffer::new(duration, spec));
        sb.copy_interleaved_ref(decoded);

        let samples = sb.samples();
        // Convert to f64 for ebur128
        let samples_f64: Vec<f64> = samples.iter().map(|&s| s as f64).collect();

        // Add samples channel by channel
        if channels == 1 {
            ebu.add_frames_f64(&samples_f64).map_err(|e| e.to_string())?;
        } else {
            // Interleaved - ebur128 expects interleaved
            ebu.add_frames_f64(&samples_f64).map_err(|e| e.to_string())?;
        }
    }

    let loudness = ebu.loudness_global().map_err(|e| e.to_string())?;
    let gain_db = TARGET_LUFS - loudness;
    Ok(gain_db)
}
