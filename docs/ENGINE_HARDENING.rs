// ── ETHER AUDIO ENGINE HARDENING ─────────────────────────────
// This file documents the engineering standards for the
// Rust audio engine in src-tauri/src/
// 
// Key patterns every engineer will look for:

/*
═══════════════════════════════════════════════════════════════
1. THREAD MODEL — REAL-TIME SAFE
═══════════════════════════════════════════════════════════════

The audio callback runs on a dedicated OS audio thread.
NO allocations, NO locks, NO syscalls in the hot path.

Use crossbeam channels for audio ↔ UI communication:
  - Commands: UI → Audio (play, pause, load, volume)
  - Events:   Audio → UI (position, level, ended)

Arc<ArcSwap<Config>> for zero-cost config reads on audio thread.

WRONG:
  fn audio_callback(&mut self) {
      let track = self.db.query("SELECT...");  // syscall on audio thread!
      let buf = Vec::new();                    // allocation on audio thread!
      let guard = self.mutex.lock();           // potential block!
  }

RIGHT:
  fn audio_callback(&mut self) {
      // All data pre-loaded. Read-only. No allocations.
      if let Some(sample) = self.ring_buffer.pop() {
          output[i] = sample;
      }
  }


═══════════════════════════════════════════════════════════════
2. CROSSFADE — EQUAL-POWER CURVE
═══════════════════════════════════════════════════════════════

Linear crossfade sounds wrong. Equal-power (sine/cosine) sounds right.
This is broadcast standard. RCS, WideOrbit, and Zetta all use this.

WRONG (linear — sounds like a dip in the middle):
  let gain_a = 1.0 - t;
  let gain_b = t;

RIGHT (equal-power — perceptually constant loudness):
  use std::f32::consts::FRAC_PI_2;
  let gain_a = (t * FRAC_PI_2).cos();  // cos: 1.0 → 0.0
  let gain_b = (t * FRAC_PI_2).sin();  // sin: 0.0 → 1.0
  // gain_a² + gain_b² = 1.0 always (Pythagorean identity)


═══════════════════════════════════════════════════════════════
3. BUFFER MANAGEMENT — RINGBUFFER NOT VEC
═══════════════════════════════════════════════════════════════

Pre-allocate a ring buffer sized to ~200ms of audio at startup.
Never allocate during playback.

[dependencies]
ringbuf = "0.4"  # Lock-free SPSC ring buffer

let (mut producer, mut consumer) = ringbuf::HeapRb::<f32>::new(
    SAMPLE_RATE * CHANNELS * 2 / 5  // 200ms buffer
).split();


═══════════════════════════════════════════════════════════════
4. EBU R128 LOUDNESS — BROADCAST STANDARD
═══════════════════════════════════════════════════════════════

Radio stations must normalize to -23 LUFS (EBU R128) or
-24 LUFS (ATSC A/85 for US broadcast).
Already have ebur128 crate. Use it:

use ebur128::{EbuR128, Mode};
let mut meter = EbuR128::new(2, SAMPLE_RATE as u32, Mode::all())?;
meter.add_frames_f32(&samples)?;
let lufs = meter.loudness_global()?;
let gain_db = TARGET_LUFS - lufs;  // -23.0 - measured
let gain_linear = 10f64.powf(gain_db / 20.0) as f32;


═══════════════════════════════════════════════════════════════
5. WATCHDOG — DEAD AIR DETECTION
═══════════════════════════════════════════════════════════════

Run a separate thread that monitors audio output level.
If RMS drops below threshold for N seconds → fire event.
This is independent of the UI — survives React crashes.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

struct Watchdog {
    last_active_ms: Arc<AtomicU64>,
    threshold_ms: u64,
    running: Arc<AtomicBool>,
}

impl Watchdog {
    fn start(app_handle: tauri::AppHandle, threshold_sec: f64) -> Self {
        let last_active_ms = Arc::new(AtomicU64::new(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap().as_millis() as u64
        ));
        let running = Arc::new(AtomicBool::new(true));
        
        let lam = last_active_ms.clone();
        let run = running.clone();
        let threshold_ms = (threshold_sec * 1000.0) as u64;
        
        std::thread::spawn(move || {
            while run.load(Ordering::Relaxed) {
                std::thread::sleep(std::time::Duration::from_secs(1));
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap().as_millis() as u64;
                let last = lam.load(Ordering::Relaxed);
                if now - last > threshold_ms {
                    app_handle.emit("dead-air-detected", now - last).ok();
                }
            }
        });
        
        Self { last_active_ms, threshold_ms, running }
    }
    
    fn ping(&self) {
        // Called from audio callback when samples are non-silent
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap().as_millis() as u64;
        self.last_active_ms.store(now, Ordering::Relaxed);
    }
}


═══════════════════════════════════════════════════════════════
6. HTTP SERVER — AXUM NOT TINY_HTTP
═══════════════════════════════════════════════════════════════

tiny_http is synchronous and single-threaded.
Under load (mobile companion polling every 3s + streaming metadata
+ health checks) it will queue.

Replace with axum — async, multi-threaded, production grade:

use axum::{Router, routing::get, extract::State, Json};
use tower_http::cors::CorsLayer;
use std::sync::Arc;

#[derive(Clone)]
struct AppState {
    now_playing: Arc<ArcSwap<NowPlayingData>>,
}

async fn now_playing_handler(
    State(state): State<AppState>
) -> Json<NowPlayingData> {
    Json((*state.now_playing.load()).clone())
}

pub async fn start_api_server(state: AppState) {
    let app = Router::new()
        .route("/api/now-playing", get(now_playing_handler))
        .route("/api/health",      get(health_handler))
        .route("/api/queue",       get(queue_handler))
        .layer(CorsLayer::permissive()) // Required for mobile companion
        .with_state(state);

    let listener = tokio::net::TcpListener::bind("0.0.0.0:4242").await.unwrap();
    axum::serve(listener, app).await.unwrap();
}


═══════════════════════════════════════════════════════════════
7. ID3 TAG READING IN RUST — NOT JAVASCRIPT
═══════════════════════════════════════════════════════════════

Reading ID3 tags in JavaScript requires transferring the entire
file buffer across the IPC bridge. For a 10MB FLAC file that's
10MB of memcpy just to read 200 bytes of metadata.

Read ID3 tags in Rust and return only what's needed:

use id3::{Tag, TagLike};

#[tauri::command]
pub fn read_track_metadata(path: &str) -> Result<TrackMetadata, String> {
    let tag = Tag::read_from_path(path)
        .map_err(|e| e.to_string())?;
    
    Ok(TrackMetadata {
        title: tag.title().map(String::from),
        artist: tag.artist().map(String::from),
        album: tag.album().map(String::from),
        bpm: tag.get("TBPM")
            .and_then(|f| f.content().text())
            .and_then(|t| t.parse().ok()),
        intro_end: tag.get("TXXX:Intro")
            .and_then(|f| f.content().extended_text())
            .and_then(|t| parse_time(&t.value)),
        outro_start: tag.get("TXXX:Outro")
            .and_then(|f| f.content().extended_text())
            .and_then(|t| parse_time(&t.value)),
        artwork_data: tag.pictures().next()
            .map(|p| base64::encode(&p.data)),
        artwork_mime: tag.pictures().next()
            .map(|p| p.mime_type.clone()),
    })
}


═══════════════════════════════════════════════════════════════
8. PANIC HANDLING — GRACEFUL NOT CRASH
═══════════════════════════════════════════════════════════════

Set a custom panic hook that logs to file before aborting.
Broadcast engineers need to diagnose crashes after the fact.

std::panic::set_hook(Box::new(|info| {
    let msg = format!(
        "[PANIC] {} at {}",
        info.payload().downcast_ref::<&str>().unwrap_or(&"unknown"),
        info.location().map(|l| l.to_string()).unwrap_or_default()
    );
    eprintln!("{}", msg);
    // Write to log file
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true).append(true)
        .open(log_path())
    {
        use std::io::Write;
        writeln!(f, "{} {}", chrono::Local::now().format("%Y-%m-%d %H:%M:%S"), msg).ok();
    }
}));


═══════════════════════════════════════════════════════════════
9. SQLITE — WAL MODE MUST BE SET PER CONNECTION
═══════════════════════════════════════════════════════════════

tauri-plugin-sql opens SQLite but doesn't set WAL mode.
WAL (Write-Ahead Logging) allows concurrent reads during writes.
Without it, every write blocks all reads → audio metadata
queries stall during library imports.

Set it in the Tauri setup hook BEFORE any queries:

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            // WAL mode — must be set per connection, not persisted
            let db_path = app.path().app_data_dir()?.join("openair.db");
            let conn = rusqlite::Connection::open(&db_path)?;
            conn.execute_batch("
                PRAGMA journal_mode=WAL;
                PRAGMA synchronous=NORMAL;
                PRAGMA foreign_keys=ON;
                PRAGMA cache_size=-32000;
                PRAGMA temp_store=MEMORY;
            ")?;
            conn.close().ok();
            Ok(())
        })
}


═══════════════════════════════════════════════════════════════
10. GRACEFUL SHUTDOWN — FLUSH BEFORE EXIT
═══════════════════════════════════════════════════════════════

On window close: flush crash_recovery, close audio streams,
wait for any pending DB writes, then exit.

app.on_window_event(|window, event| {
    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        api.prevent_close();
        let app = window.app_handle().clone();
        tauri::async_runtime::spawn(async move {
            // Save session state
            save_crash_recovery(&app).await.ok();
            // Drain audio buffer
            stop_audio_engine(&app).await.ok();
            // Close DB connections  
            tokio::time::sleep(Duration::from_millis(100)).await;
            app.exit(0);
        });
    }
});
*/
