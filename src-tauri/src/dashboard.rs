use crate::audio::SharedAudioState;
use tiny_http::{Server, Response, Header};
use std::sync::{Arc, Mutex};

#[derive(Clone, serde::Serialize, serde::Deserialize, Default)]
pub struct NowPlayingMeta {
    pub title: String,
    pub artist: String,
    pub is_playing: bool,
    pub updated_at: u64,
}

pub type SharedNowPlaying = Arc<Mutex<NowPlayingMeta>>;

const DASHBOARD_HTML: &str = r#"<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<title>Ether — Remote</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: #0a0a0a; color: #fff; font-family: -apple-system, sans-serif; min-height: 100vh; }
.header { background: #111; padding: 16px 20px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid #222; }
.logo { font-size: 22px; font-weight: 300; letter-spacing: -0.04em; }
.logo span { color: #60a5fa; }
.on-air { padding: 4px 10px; border-radius: 6px; font-size: 11px; font-weight: 700; letter-spacing: 0.1em; }
.on-air.live { background: #dc2626; animation: pulse 2s infinite; }
.on-air.off { background: #333; color: #666; }
@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.5} }
.now-playing { padding: 24px 20px; border-bottom: 1px solid #1a1a1a; }
.np-label { font-size: 11px; color: #555; letter-spacing: 0.15em; text-transform: uppercase; margin-bottom: 8px; }
.np-title { font-size: 26px; font-weight: 700; line-height: 1.2; margin-bottom: 6px; }
.np-artist { font-size: 16px; color: #aaa; margin-bottom: 16px; }
.progress-bar { height: 4px; background: #222; border-radius: 2px; overflow: hidden; margin-bottom: 8px; }
.progress-fill { height: 100%; background: #60a5fa; border-radius: 2px; transition: width 1s linear; }
.progress-time { display: flex; justify-content: space-between; font-size: 12px; font-family: monospace; color: #555; }
.controls { padding: 20px; display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.btn { padding: 16px; border-radius: 12px; border: none; font-size: 15px; font-weight: 600; cursor: pointer; transition: all 0.15s; }
.btn:active { transform: scale(0.96); }
.btn-skip { background: #3b82f6; color: #fff; }
.btn-stop { background: #dc2626; color: #fff; }
.btn-play { background: #22c55e; color: #fff; }
.btn-pause { background: #f59e0b; color: #fff; }
.deck-b { padding: 0 20px 20px; }
.deck-label { font-size: 11px; color: #444; letter-spacing: 0.1em; text-transform: uppercase; margin-bottom: 8px; }
.deck-b-info { background: #111; border-radius: 10px; padding: 12px 16px; }
.deck-b-title { font-size: 14px; color: #888; }
.status-bar { position: fixed; bottom: 0; left: 0; right: 0; padding: 12px 20px; background: #111; border-top: 1px solid #222; font-size: 11px; color: #444; text-align: center; }
</style>
</head>
<body>
<div class="header">
  <div class="logo"><span>Eth</span>er Remote</div>
  <div class="on-air off" id="onair">OFF AIR</div>
</div>
<div class="now-playing">
  <div class="np-label" id="np-label">Up Next</div>
  <div class="np-title" id="title">Loading...</div>
  <div class="np-artist" id="artist"></div>
  <div class="progress-bar"><div class="progress-fill" id="progress" style="width:0%"></div></div>
  <div class="progress-time"><span id="pos">0:00</span><span id="rem">0:00</span></div>
</div>
<div class="controls">
  <button class="btn btn-skip" onclick="cmd('skip')">⏭ Skip</button>
  <button class="btn btn-stop" onclick="cmd('stop')">⏹ Stop</button>
  <button class="btn btn-play" onclick="cmd('play')">▶ Play</button>
  <button class="btn btn-pause" onclick="cmd('pause')">⏸ Pause</button>
</div>
<div class="deck-b">
  <div class="deck-label">Deck B — Standby</div>
  <div class="deck-b-info"><div class="deck-b-title" id="deck-b-title">—</div></div>
</div>
<div class="status-bar" id="status">Connecting...</div>
<script>
function fmt(s) {
  if (!s || s < 0) return '0:00';
  return Math.floor(s/60) + ':' + String(Math.floor(s%60)).padStart(2,'0');
}
async function cmd(action) {
  try {
    await fetch('/api/' + action, { method: 'POST' });
  } catch(e) {}
}
async function poll() {
  try {
    const r = await fetch('/api/status');
    const d = await r.json();
    const a = d.deckA;
    const b = d.deckB;
    const playing = a.status === 'playing';
    document.getElementById('title').textContent = a.title || 'Ether Radio';
    document.getElementById('artist').textContent = a.artist || '';
    document.getElementById('np-label').textContent = playing ? 'Now Playing' : 'Loaded';
    document.getElementById('onair').textContent = playing ? 'ON AIR' : 'OFF AIR';
    document.getElementById('onair').className = 'on-air ' + (playing ? 'live' : 'off');
    document.getElementById('deck-b-title').textContent = b.title || '—';
    document.getElementById('status').textContent = 'Connected · ' + new Date().toLocaleTimeString();
  } catch(e) {
    document.getElementById('status').textContent = 'Reconnecting...';
  }
}
setInterval(poll, 2000);
poll();
</script>
</body>
</html>"#;

pub fn start_dashboard_server(state: SharedAudioState, now_playing: SharedNowPlaying, port: u16) {
    std::thread::spawn(move || {
        let addr = format!("0.0.0.0:{}", port);
        let server = match Server::http(&addr) {
            Ok(s) => s,
            Err(e) => { eprintln!("Dashboard server failed to start: {}", e); return; }
        };
        println!("Ether dashboard running at http://0.0.0.0:{}", port);

        for request in server.incoming_requests() {
            let url = request.url().to_string();
            let method = request.method().to_string();

            let response = match (method.as_str(), url.as_str()) {
                ("GET", "/") | ("GET", "/index.html") => {
                    Response::from_string(DASHBOARD_HTML)
                        .with_header(Header::from_bytes("Content-Type", "text/html").unwrap())
                }
                ("GET", "/now-playing.json") => {
                    let json = if let Ok(np) = now_playing.lock() {
                        serde_json::json!({
                            "title": np.title,
                            "artist": np.artist,
                            "is_playing": np.is_playing,
                            "updated_at": np.updated_at,
                        }).to_string()
                    } else { "{}".to_string() };
                    Response::from_string(json)
                        .with_header(Header::from_bytes("Content-Type", "application/json").unwrap())
                        .with_header(Header::from_bytes("Access-Control-Allow-Origin", "*").unwrap())
                }
                ("GET", "/api/status") => {
                    let json = if let Ok(audio) = state.lock() {
                        serde_json::json!({
                            "deckA": audio.deck_a.info("A"),
                            "deckB": audio.deck_b.info("B"),
                        }).to_string()
                    } else {
                        "{}".to_string()
                    };
                    Response::from_string(json)
                        .with_header(Header::from_bytes("Content-Type", "application/json").unwrap())
                        .with_header(Header::from_bytes("Access-Control-Allow-Origin", "*").unwrap())
                }
                ("POST", "/api/skip") => {
                    if let Ok(mut audio) = state.lock() {
                        let _ = audio.sender.send(crate::audio::AudioCmd::Stop("A".to_string()));
                        audio.deck_a.status = "idle".to_string();
                    }
                    Response::from_string("ok")
                }
                ("POST", "/api/stop") => {
                    if let Ok(mut audio) = state.lock() {
                        let _ = audio.sender.send(crate::audio::AudioCmd::Stop("A".to_string()));
                        let _ = audio.sender.send(crate::audio::AudioCmd::Stop("B".to_string()));
                        audio.deck_a.status = "idle".to_string();
                        audio.deck_b.status = "idle".to_string();
                    }
                    Response::from_string("ok")
                }
                ("POST", "/api/play") => {
                    if let Ok(mut audio) = state.lock() {
                        let _ = audio.sender.send(crate::audio::AudioCmd::Play("A".to_string()));
                        audio.deck_a.status = "playing".to_string();
                    }
                    Response::from_string("ok")
                }
                ("POST", "/api/pause") => {
                    if let Ok(mut audio) = state.lock() {
                        let _ = audio.sender.send(crate::audio::AudioCmd::Pause("A".to_string()));
                        audio.deck_a.status = "paused".to_string();
                    }
                    Response::from_string("ok")
                }
                _ => Response::from_string("Not found").with_status_code(404)
            };

            let _ = request.respond(response);
        }
    });
}
