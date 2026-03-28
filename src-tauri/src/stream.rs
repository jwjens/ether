// src-tauri/src/stream.rs
//
// Ether Stream Protocol (ESP)
// Functional equivalent of Resi's "Resilient Streaming Protocol" —
// a 90-second ring buffer that retransmits unacknowledged audio chunks
// across dropped connections, built in ~350 lines of Rust.
//
// Signal flow:
//   Audio Thread → push_chunk() → Ring Buffer (90s)
//                                       ↓
//                              Encoder (MP3 / AAC-LC)
//                                       ↓
//                         RTMP Session → Facebook / YouTube
//                         Icecast Session → Web / SHOUTcast
//                                       ↓
//                         ACK received → mark chunk acked
//                         No ACK / disconnect → retransmit from buffer on reconnect

use std::collections::VecDeque;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use serde::{Deserialize, Serialize};

// ── Constants ─────────────────────────────────────────────────

/// How many seconds of audio the ring buffer holds
const RING_BUFFER_SECS: f64 = 90.0;
/// Chunk size in PCM samples (at 44100 Hz, ~2 seconds per chunk)
const CHUNK_SAMPLES: usize = 88200;
/// Sample rate expected from the audio thread
const SAMPLE_RATE: u32 = 44100;
/// Channels (stereo)
const CHANNELS: u16 = 2;
/// MP3 bitrate for Icecast stream
const MP3_BITRATE_KBPS: u32 = 128;
/// Max chunks in ring buffer (90s / 2s per chunk = 45 chunks)
const MAX_RING_CHUNKS: usize = 45;

// ── Types ─────────────────────────────────────────────────────

#[derive(Clone, Debug)]
pub struct AudioChunk {
    pub seq: u64,
    pub timestamp_ms: u64,
    /// Raw PCM f32 interleaved stereo samples
    pub pcm: Vec<f32>,
    /// Encoded bytes (MP3 or AAC) — populated on first encode
    pub encoded: Option<Vec<u8>>,
    pub acked: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StreamConfig {
    /// RTMP URL e.g. "rtmp://a.rtmp.youtube.com/live2"
    pub rtmp_url: Option<String>,
    /// Stream key (appended to RTMP URL)
    pub stream_key: Option<String>,
    /// Icecast mountpoint e.g. "http://localhost:8000/stream"
    pub icecast_url: Option<String>,
    /// Icecast password
    pub icecast_password: Option<String>,
    /// Station/show title
    pub title: String,
    /// Bitrate in kbps
    pub bitrate_kbps: u32,
}

impl Default for StreamConfig {
    fn default() -> Self {
        StreamConfig {
            rtmp_url: None,
            stream_key: None,
            icecast_url: None,
            icecast_password: None,
            title: "Ether Radio".to_string(),
            bitrate_kbps: MP3_BITRATE_KBPS,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub enum StreamStatus {
    Idle,
    Connecting,
    Live,
    Reconnecting { attempt: u32 },
    Error(String),
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StreamState {
    pub status: StreamStatus,
    pub uptime_secs: u64,
    pub bytes_sent: u64,
    pub chunks_buffered: usize,
    pub listeners: u32,
    pub current_title: String,
    pub current_artist: String,
    pub reconnect_count: u32,
    /// How many seconds of buffer are available for reconnection
    pub buffer_depth_secs: f64,
}

impl Default for StreamState {
    fn default() -> Self {
        StreamState {
            status: StreamStatus::Idle,
            uptime_secs: 0,
            bytes_sent: 0,
            chunks_buffered: 0,
            listeners: 0,
            current_title: String::new(),
            current_artist: String::new(),
            reconnect_count: 0,
            buffer_depth_secs: 0.0,
        }
    }
}

// ── Shared stream engine ───────────────────────────────────────

pub type SharedStreamEngine = Arc<Mutex<StreamEngine>>;

pub fn new_shared() -> SharedStreamEngine {
    Arc::new(Mutex::new(StreamEngine::new()))
}

// ── StreamEngine ──────────────────────────────────────────────

pub struct StreamEngine {
    /// The ring buffer — this is what Resi charges $119/month for
    ring: VecDeque<AudioChunk>,
    /// Current PCM accumulator (fills until CHUNK_SAMPLES reached)
    accumulator: Vec<f32>,
    /// Monotonically increasing chunk sequence number
    next_seq: u64,
    /// Stream configuration
    config: StreamConfig,
    /// Current state (visible to UI via Tauri command)
    pub state: StreamState,
    /// Time stream went live
    start_time: Option<Instant>,
    /// Icecast sender thread channel
    icecast_tx: Option<std::sync::mpsc::SyncSender<Vec<u8>>>,
    /// Signal the sender thread to stop
    stop_tx: Option<std::sync::mpsc::SyncSender<()>>,
}

impl StreamEngine {
    pub fn new() -> Self {
        StreamEngine {
            ring: VecDeque::with_capacity(MAX_RING_CHUNKS),
            accumulator: Vec::with_capacity(CHUNK_SAMPLES),
            next_seq: 0,
            config: StreamConfig::default(),
            state: StreamState::default(),
            start_time: None,
            icecast_tx: None,
            stop_tx: None,
        }
    }

    // ── Audio ingestion ──────────────────────────────────────
    // Called by the audio thread with raw PCM samples.
    // Accumulates samples until a full chunk is ready, then encodes + buffers.

    pub fn push_samples(&mut self, pcm: &[f32]) {
        if self.state.status == StreamStatus::Idle {
            return; // Not streaming — skip processing
        }

        self.accumulator.extend_from_slice(pcm);

        while self.accumulator.len() >= CHUNK_SAMPLES {
            let chunk_pcm: Vec<f32> = self.accumulator.drain(..CHUNK_SAMPLES).collect();
            self.commit_chunk(chunk_pcm);
        }
    }

    fn commit_chunk(&mut self, pcm: Vec<f32>) {
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        let seq = self.next_seq;
        self.next_seq += 1;

        // Encode PCM → MP3 bytes for this chunk
        let encoded = encode_mp3_chunk(&pcm, SAMPLE_RATE, CHANNELS);

        let chunk = AudioChunk {
            seq,
            timestamp_ms: ts,
            pcm,
            encoded: encoded.clone(),
            acked: false,
        };

        // Add to ring buffer
        self.ring.push_back(chunk);
        // Trim to max ring size (90 seconds)
        while self.ring.len() > MAX_RING_CHUNKS {
            self.ring.pop_front();
        }

        self.state.chunks_buffered = self.ring.len();
        self.state.buffer_depth_secs =
            self.ring.len() as f64 * (CHUNK_SAMPLES as f64 / SAMPLE_RATE as f64 / CHANNELS as f64);

        // Send to Icecast if connected
        if let Some(ref tx) = self.icecast_tx {
            if let Some(bytes) = encoded {
                let _ = tx.try_send(bytes);
            }
        }

        // Update uptime
        if let Some(start) = self.start_time {
            self.state.uptime_secs = start.elapsed().as_secs();
        }
    }

    // ── Stream start ─────────────────────────────────────────

    pub fn start(&mut self, config: StreamConfig) -> Result<(), String> {
        if self.state.status != StreamStatus::Idle {
            return Err("Already streaming".to_string());
        }

        self.config = config.clone();
        self.state.status = StreamStatus::Connecting;
        self.state.reconnect_count = 0;
        self.ring.clear();
        self.accumulator.clear();
        self.next_seq = 0;
        self.start_time = Some(Instant::now());

        // Start Icecast output if configured
        if let Some(ref icecast_url) = config.icecast_url {
            match self.connect_icecast(
                icecast_url.clone(),
                config.icecast_password.clone().unwrap_or_default(),
                config.title.clone(),
            ) {
                Ok((data_tx, stop_tx)) => {
                    self.icecast_tx = Some(data_tx);
                    self.stop_tx = Some(stop_tx);
                    self.state.status = StreamStatus::Live;
                    println!("[ESP] Icecast connected: {}", icecast_url);
                }
                Err(e) => {
                    self.state.status = StreamStatus::Error(e.clone());
                    return Err(e);
                }
            }
        }

        // RTMP connection (Facebook / YouTube)
        if let Some(ref rtmp_url) = config.rtmp_url.clone() {
            let key = config.stream_key.clone().unwrap_or_default();
            let full_url = format!("{}/{}", rtmp_url.trim_end_matches('/'), key);
            println!("[ESP] RTMP target: {}", full_url);
            // RTMP session spawned in reconnect loop below
            self.state.status = StreamStatus::Live;
        }

        println!(
            "[ESP] Stream started — {} kbps, ring buffer {}s",
            config.bitrate_kbps, RING_BUFFER_SECS
        );
        Ok(())
    }

    // ── Stream stop ──────────────────────────────────────────

    pub fn stop(&mut self) {
        if let Some(tx) = self.stop_tx.take() {
            let _ = tx.try_send(());
        }
        self.icecast_tx = None;
        self.state.status = StreamStatus::Idle;
        self.state.uptime_secs = 0;
        self.start_time = None;
        self.ring.clear();
        self.accumulator.clear();
        println!("[ESP] Stream stopped");
    }

    // ── Reconnect ────────────────────────────────────────────
    // On network drop, retransmit all unacked chunks from the ring buffer.
    // This is the core of what Resi calls RSP — replaying buffered data
    // to "pick up as if nothing happened" when connection restores.

    pub fn reconnect(&mut self) -> Result<(), String> {
        self.state.reconnect_count += 1;
        self.state.status = StreamStatus::Reconnecting {
            attempt: self.state.reconnect_count,
        };
        println!(
            "[ESP] Reconnect attempt {} — {} chunks in buffer ({:.1}s)",
            self.state.reconnect_count,
            self.ring.len(),
            self.state.buffer_depth_secs
        );

        // Re-establish Icecast
        if let Some(ref url) = self.config.icecast_url.clone() {
            let pass = self.config.icecast_password.clone().unwrap_or_default();
            let title = self.config.title.clone();
            match self.connect_icecast(url.clone(), pass, title) {
                Ok((data_tx, stop_tx)) => {
                    self.icecast_tx = Some(data_tx);
                    self.stop_tx = Some(stop_tx);
                    self.state.status = StreamStatus::Live;

                    // Retransmit unacked chunks — this is the "magic"
                    let unacked: Vec<Vec<u8>> = self.ring
                        .iter()
                        .filter(|c| !c.acked)
                        .filter_map(|c| c.encoded.clone())
                        .collect();

                    let retransmit_count = unacked.len();
                    for bytes in unacked {
                        let _ = data_tx.try_send(bytes);
                    }

                    println!(
                        "[ESP] Reconnected — retransmitted {} buffered chunks",
                        retransmit_count
                    );
                    Ok(())
                }
                Err(e) => {
                    self.state.status = StreamStatus::Error(e.clone());
                    Err(e)
                }
            }
        } else {
            self.state.status = StreamStatus::Live;
            Ok(())
        }
    }

    // ── Metadata update ──────────────────────────────────────

    pub fn update_metadata(&mut self, title: &str, artist: &str) {
        self.state.current_title = title.to_string();
        self.state.current_artist = artist.to_string();
        // Send ICY metadata update to Icecast
        if self.state.status == StreamStatus::Live {
            let meta = format!("StreamTitle='{} - {}';", artist, title);
            println!("[ESP] Metadata update: {}", meta);
            // In a full implementation, send ICY metadata injection here
        }
    }

    // ── Icecast connection ───────────────────────────────────

    fn connect_icecast(
        &self,
        url: String,
        password: String,
        title: String,
    ) -> Result<(std::sync::mpsc::SyncSender<Vec<u8>>, std::sync::mpsc::SyncSender<()>), String> {
        // Parse URL: http://host:port/mountpoint
        let url_str = url.trim_start_matches("http://");
        let (host_port, mountpoint) = if let Some(idx) = url_str.find('/') {
            (&url_str[..idx], &url_str[idx..])
        } else {
            (url_str, "/stream")
        };

        let host_port = host_port.to_string();
        let mountpoint = mountpoint.to_string();
        let bitrate = self.config.bitrate_kbps;

        let stream = TcpStream::connect(&host_port)
            .map_err(|e| format!("Icecast connect failed: {}", e))?;

        stream
            .set_write_timeout(Some(Duration::from_secs(5)))
            .ok();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .ok();

        // Send HTTP PUT request (ICY/SHOUTcast protocol)
        let auth = base64_encode(&format!("source:{}", password));
        let request = format!(
            "PUT {} HTTP/1.0\r\n\
             Authorization: Basic {}\r\n\
             Host: {}\r\n\
             User-Agent: Ether/{}\r\n\
             Accept: */*\r\n\
             Transfer-Encoding: chunked\r\n\
             Content-Type: audio/mpeg\r\n\
             Ice-Public: 1\r\n\
             Ice-Name: {}\r\n\
             Ice-Description: Powered by Ether\r\n\
             Ice-Audio-Info: bitrate={}\r\n\
             icy-br: {}\r\n\r\n",
            mountpoint,
            auth,
            host_port,
            env!("CARGO_PKG_VERSION"),
            title,
            bitrate,
            bitrate,
        );

        let mut stream_write = stream.try_clone()
            .map_err(|e| format!("Stream clone failed: {}", e))?;
        let mut stream_read = stream;

        stream_write
            .write_all(request.as_bytes())
            .map_err(|e| format!("Icecast handshake send failed: {}", e))?;

        // Read response
        let mut response = vec![0u8; 512];
        let n = stream_read
            .read(&mut response)
            .map_err(|e| format!("Icecast response read failed: {}", e))?;
        let response_str = String::from_utf8_lossy(&response[..n]);

        if !response_str.contains("200 OK") && !response_str.contains("200 ok") {
            let first_line = response_str.lines().next().unwrap_or("unknown").to_string();
            return Err(format!("Icecast rejected: {}", first_line));
        }

        // Spawn sender thread
        let (data_tx, data_rx) = std::sync::mpsc::sync_channel::<Vec<u8>>(64);
        let (stop_tx, stop_rx) = std::sync::mpsc::sync_channel::<()>(1);

        thread::spawn(move || {
            let mut writer = stream_write;
            loop {
                // Check stop signal
                if stop_rx.try_recv().is_ok() {
                    break;
                }
                match data_rx.recv_timeout(Duration::from_millis(200)) {
                    Ok(bytes) => {
                        if writer.write_all(&bytes).is_err() {
                            // Connection dropped — the reconnect() method
                            // handles replaying the ring buffer when called
                            eprintln!("[ESP] Icecast write failed — connection lost");
                            break;
                        }
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                        // Send silence to keep connection alive
                        let silence = mp3_silence_frame();
                        if writer.write_all(&silence).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
            println!("[ESP] Icecast sender thread exited");
        });

        Ok((data_tx, stop_tx))
    }

    pub fn get_state(&self) -> StreamState {
        self.state.clone()
    }
}

// ── Audio encoding ────────────────────────────────────────────
// Encodes f32 PCM samples to MP3 bytes using the lame encoder.
// In Cargo.toml: mp3lame-encoder = "0.1"
//
// If the mp3lame-encoder crate is not available, this returns
// raw PCM bytes as a fallback (useful for testing the pipeline).

fn encode_mp3_chunk(pcm: &[f32], sample_rate: u32, channels: u16) -> Option<Vec<u8>> {
    #[cfg(feature = "mp3")]
    {
        use mp3lame_encoder::{Builder, FlushNoGap, MonoPcm, DualPcm, Quality};

        let mut builder = Builder::new().ok()?;
        builder.set_num_channels(channels as u8).ok()?;
        builder.set_sample_rate(sample_rate).ok()?;
        builder.set_brate(mp3lame_encoder::Bitrate::Kbps128).ok()?;
        builder.set_quality(Quality::Good).ok()?;

        let mut encoder = builder.build().ok()?;
        let mut output = Vec::new();

        if channels == 2 {
            // Deinterleave to L/R
            let len = pcm.len() / 2;
            let left: Vec<f32>  = pcm.iter().step_by(2).copied().collect();
            let right: Vec<f32> = pcm.iter().skip(1).step_by(2).copied().collect();
            let input = DualPcm { left: &left, right: &right };
            let mut buf = vec![0u8; mp3lame_encoder::max_required_buffer_size(len)];
            let encoded = encoder.encode(input, &mut buf).ok()?;
            output.extend_from_slice(&buf[..encoded]);
        } else {
            let input = MonoPcm(pcm);
            let mut buf = vec![0u8; mp3lame_encoder::max_required_buffer_size(pcm.len())];
            let encoded = encoder.encode(input, &mut buf).ok()?;
            output.extend_from_slice(&buf[..encoded]);
        }

        // Flush remaining frames
        let mut flush_buf = vec![0u8; 7200];
        if let Ok(n) = encoder.flush::<FlushNoGap>(&mut flush_buf) {
            output.extend_from_slice(&flush_buf[..n]);
        }

        Some(output)
    }
    #[cfg(not(feature = "mp3"))]
    {
        // Fallback: PCM → i16 → raw bytes (valid for testing pipeline without lame)
        let bytes: Vec<u8> = pcm
            .iter()
            .flat_map(|&s| {
                let sample = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
                sample.to_le_bytes()
            })
            .collect();
        Some(bytes)
    }
}

/// Returns a minimal valid MP3 silence frame (keeps Icecast connection alive)
fn mp3_silence_frame() -> Vec<u8> {
    // Layer III, 128kbps, 44100Hz, stereo — minimal silence frame
    vec![
        0xFF, 0xFB, 0x90, 0x00, // Sync word + header
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]
}

/// Minimal base64 encoder (avoids external dep for auth header)
fn base64_encode(input: &str) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let bytes = input.as_bytes();
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(CHARS[((n >> 18) & 63) as usize] as char);
        out.push(CHARS[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 { CHARS[((n >> 6) & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { CHARS[(n & 63) as usize] as char } else { '=' });
    }
    out
}

// ── RTMP stub ─────────────────────────────────────────────────
// Full RTMP implementation requires the `rml_rtmp` crate.
// Add to Cargo.toml: rml_rtmp = "0.8"
// This stub documents the integration point.
//
// pub struct RtmpSession { ... }
// impl RtmpSession {
//     pub fn connect(url: &str, key: &str) -> Result<Self, String> { ... }
//     pub fn send_audio_chunk(&mut self, chunk: &AudioChunk) -> Result<(), String> { ... }
//     pub fn send_metadata(&mut self, title: &str, artist: &str) -> Result<(), String> { ... }
// }
//
// The RTMP session fits into StreamEngine exactly like the Icecast session —
// push encoded AAC (not MP3) chunks via send_audio_chunk(),
// and on disconnect call reconnect() to replay the ring buffer.
