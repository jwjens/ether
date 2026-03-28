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

fn chrono_simple_rfc2822(unix: u64) -> String {
    // Simple RFC 2822 formatter without chrono dependency
    let days = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
    let months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    let secs = unix as i64;
    let days_since_epoch = secs / 86400;
    let dow = ((days_since_epoch + 4) % 7) as usize; // 1970-01-01 was Thursday
    let mut y = 1970i32; let mut d = days_since_epoch as i32;
    loop {
        let dy = if y%4==0&&(y%100!=0||y%400==0){366}else{365};
        if d < dy { break; } d -= dy; y += 1;
    }
    let month_days = [31,if y%4==0&&(y%100!=0||y%400==0){29}else{28},31,30,31,30,31,31,30,31,30,31];
    let mut m = 0usize;
    while m < 11 && d >= month_days[m] { d -= month_days[m]; m += 1; }
    let h = (secs % 86400) / 3600;
    let min = (secs % 3600) / 60;
    let s = secs % 60;
    format!("{}, {:02} {} {} {:02}:{:02}:{:02} GMT", days[dow], d+1, months[m], y, h, min, s)
}

fn url_decode(s: &str) -> String {
    let mut result = String::new();
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '%' {
            let h1 = chars.next().unwrap_or('0');
            let h2 = chars.next().unwrap_or('0');
            if let Ok(byte) = u8::from_str_radix(&format!("{}{}", h1, h2), 16) {
                result.push(byte as char);
            }
        } else if c == '+' {
            result.push(' ');
        } else {
            result.push(c);
        }
    }
    result
}

fn fetch_image_sync(url: &str) -> Result<(Vec<u8>, String), Box<dyn std::error::Error>> {
        let response = ureq::get(url)
        .set("User-Agent", "Ether/1.5")
        .call()?;
    let content_type = response
        .header("Content-Type")
        .unwrap_or("image/jpeg")
        .to_string();
    let mut bytes = Vec::new();
    response.into_reader().read_to_end(&mut bytes)?;
    Ok((bytes, content_type))
}

// Episode storage — in-memory, persists as long as app runs
// In production replace with SQLite reads
fn episodes() -> &'static std::sync::Mutex<Vec<serde_json::Value>> {
    static E: std::sync::OnceLock<std::sync::Mutex<Vec<serde_json::Value>>> = std::sync::OnceLock::new();
    E.get_or_init(|| std::sync::Mutex::new(Vec::new()))
}

fn base_url() -> String {
    std::env::var("BASE_URL").unwrap_or_else(|_| "http://localhost:4242".into())
}
fn station_title()  -> String { std::env::var("PODCAST_TITLE").unwrap_or_else(|_| "My Podcast".into()) }
fn station_desc()   -> String { std::env::var("PODCAST_DESC").unwrap_or_else(|_| "Powered by Ether".into()) }
fn station_author() -> String { std::env::var("PODCAST_AUTHOR").unwrap_or_else(|_| "Ether Radio".into()) }
fn station_email()  -> String { std::env::var("PODCAST_EMAIL").unwrap_or_else(|_| "podcast@example.com".into()) }
fn station_artwork()-> String { std::env::var("PODCAST_ARTWORK").unwrap_or_else(|_| "https://example.com/artwork.jpg".into()) }

fn xml_escape(s: &str) -> String {
    s.replace('&',"&amp;").replace('<',"&lt;").replace('>',"&gt;").replace('"',"&quot;")
}

fn fmt_duration(secs: u64) -> String {
    let h=secs/3600; let m=(secs%3600)/60; let s=secs%60;
    if h>0 { format!("{}:{:02}:{:02}",h,m,s) } else { format!("{}:{:02}",m,s) }
}

fn build_rss() -> String {
    let eps = episodes().lock().unwrap().clone();
    let mut sorted = eps.clone();
    sorted.sort_by(|a,b| {
        let ta = a["publishedTs"].as_i64().unwrap_or(0);
        let tb = b["publishedTs"].as_i64().unwrap_or(0);
        tb.cmp(&ta)
    });
    let items: String = sorted.iter().map(|ep| {
        let title    = xml_escape(ep["title"].as_str().unwrap_or(""));
        let desc     = ep["description"].as_str().unwrap_or("").to_string();
        let file_url = ep["fileUrl"].as_str().unwrap_or("").to_string();
        let file_sz  = ep["fileSize"].as_u64().unwrap_or(0);
        let guid     = ep["guid"].as_str().unwrap_or("").to_string();
        let pub_date = ep["publishedAt"].as_str().unwrap_or("").to_string();
        let dur      = fmt_duration(ep["durationSecs"].as_u64().unwrap_or(0));
        let author   = xml_escape(ep["host"].as_str().unwrap_or(""));
        let mut item = String::new();
        item.push_str("    <item>\n");
        item.push_str(&format!("      <title>{}</title>\n", title));
        item.push_str(&format!("      <description><![CDATA[{}]]></description>\n", desc));
        item.push_str(&format!("      <enclosure url=\"{}\" length=\"{}\" type=\"audio/mpeg\"/>\n", file_url, file_sz));
        item.push_str(&format!("      <guid isPermaLink=\"false\">{}</guid>\n", guid));
        item.push_str(&format!("      <pubDate>{}</pubDate>\n", pub_date));
        item.push_str(&format!("      <itunes:duration>{}</itunes:duration>\n", dur));
        item.push_str(&format!("      <itunes:author>{}</itunes:author>\n", author));
        item.push_str("      <itunes:explicit>no</itunes:explicit>\n");
        item.push_str("    </item>");
        item
    }).collect::<Vec<_>>().join("\n");
    let mut rss = String::new();
    rss.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
    rss.push_str("<rss version=\"2.0\" xmlns:itunes=\"http://www.itunes.com/dtds/podcast-1.0.dtd\">\n");
    rss.push_str("  <channel>\n");
    rss.push_str(&format!("    <title>{}</title>\n", xml_escape(&station_title())));
    rss.push_str(&format!("    <description>{}</description>\n", xml_escape(&station_desc())));
    rss.push_str(&format!("    <link>{}</link>\n", base_url()));
    rss.push_str("    <language>en</language>\n");
    rss.push_str(&format!("    <itunes:author>{}</itunes:author>\n", xml_escape(&station_author())));
    rss.push_str(&format!("    <itunes:owner><itunes:name>{}</itunes:name><itunes:email>{}</itunes:email></itunes:owner>\n",
        xml_escape(&station_author()), xml_escape(&station_email())));
    rss.push_str(&format!("    <itunes:image href=\"{}\"/>\n", station_artwork()));
    rss.push_str("    <itunes:explicit>no</itunes:explicit>\n");
    rss.push_str(&items);
    rss.push_str("\n  </channel>\n</rss>");
    rss
}

pub fn start_dashboard_server(state: SharedAudioState, now_playing: SharedNowPlaying, port: u16) {
    std::thread::spawn(move || {
        let addr = format!("0.0.0.0:{}", port);
        let server = match Server::http(&addr) {
            Ok(s) => s,
            Err(e) => { eprintln!("Dashboard server failed to start: {}", e); return; }
        };
        println!("Ether dashboard running at http://0.0.0.0:{}", port);

        for mut request in server.incoming_requests() {
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
                ("POST", "/api/pause") | ("POST", "/api/pause-a") => {
                    if let Ok(mut audio) = state.lock() {
                        let _ = audio.sender.send(crate::audio::AudioCmd::Pause("A".to_string()));
                        audio.deck_a.status = "paused".to_string();
                    }
                    Response::from_string("ok")
                }
                ("POST", "/api/play-b") => {
                    if let Ok(audio) = state.lock() {
                        let _ = audio.sender.send(crate::audio::AudioCmd::Play("B".to_string()));
                    }
                    Response::from_string("ok")
                }
                ("POST", "/api/pause-b") => {
                    if let Ok(audio) = state.lock() {
                        let _ = audio.sender.send(crate::audio::AudioCmd::Pause("B".to_string()));
                    }
                    Response::from_string("ok")
                }
                ("POST", "/api/play-c") => {
                    if let Ok(audio) = state.lock() {
                        let _ = audio.sender.send(crate::audio::AudioCmd::Play("C".to_string()));
                    }
                    Response::from_string("ok")
                }
                ("POST", "/api/pause-c") => {
                    if let Ok(audio) = state.lock() {
                        let _ = audio.sender.send(crate::audio::AudioCmd::Pause("C".to_string()));
                    }
                    Response::from_string("ok")
                }
                ("POST", "/api/play-a") => {
                    if let Ok(audio) = state.lock() {
                        let _ = audio.sender.send(crate::audio::AudioCmd::Play("A".to_string()));
                    }
                    Response::from_string("ok")
                }
                ("POST", "/api/crossfade") => {
                    if let Ok(audio) = state.lock() {
                        let _ = audio.sender.send(crate::audio::AudioCmd::Play("B".to_string()));
                        let _ = audio.sender.send(crate::audio::AudioCmd::Stop("A".to_string()));
                    }
                    Response::from_string("ok")
                }
                ("GET", "/api/status") | ("GET", "/api/full-status") => {
                    let json = if let Ok(audio) = state.lock() {
                        serde_json::json!({
                            "deckA": audio.deck_a.info("A", false),
                            "deckB": audio.deck_b.info("B", false),
                        }).to_string()
                    } else { "{}".to_string() };
                    Response::from_string(json)
                        .with_header(Header::from_bytes("Content-Type", "application/json").unwrap())
                        .with_header(Header::from_bytes("Access-Control-Allow-Origin", "*").unwrap())
                }
                ("GET", path) if path.starts_with("/api/img-proxy") => {
                    // Image proxy — fetches external artist photos with CORS headers
                    // Enables canvas pixel access for silhouette effect in Ether
                    let url_param = path
                        .split("?url=")
                        .nth(1)
                        .map(|s| s.split('&').next().unwrap_or(s))
                        .unwrap_or("")
                        .to_string();

                    let decoded = url_decode(&url_param);

                    // Only allow known image domains
                    let allowed = [
                        "itunes.apple.com", "mzstatic.com", "coverartarchive.org",
                        "musicbrainz.org", "i.scdn.co", "lastfm.freetls.fastly.net",
                        "upload.wikimedia.org", "commons.wikimedia.org",
                        "api.deezer.com", "e-cdns-images.dzcdn.net",
                    ];
                    let is_allowed = allowed.iter().any(|d| decoded.contains(d));

                    if !is_allowed || decoded.is_empty() {
                        Response::from_string("Forbidden").with_status_code(403)
                    } else {
                        match fetch_image_sync(&decoded) {
                            Ok((bytes, content_type)) => {
                                Response::from_data(bytes)
                                    .with_header(Header::from_bytes("Content-Type", content_type).unwrap())
                                    .with_header(Header::from_bytes("Access-Control-Allow-Origin", "*").unwrap())
                                    .with_header(Header::from_bytes("Cache-Control", "public, max-age=86400").unwrap())
                            }
                            Err(_) => Response::from_string("Bad Gateway").with_status_code(502)
                        }
                    }
                }
                ("GET", "/feed.xml") | ("GET", "/feed") | ("GET", "/rss") => {
                    Response::from_string(build_rss())
                        .with_header(Header::from_bytes("Content-Type", "application/rss+xml; charset=utf-8").unwrap())
                        .with_header(Header::from_bytes("Access-Control-Allow-Origin", "*").unwrap())
                        .with_header(Header::from_bytes("Cache-Control", "public, max-age=300").unwrap())
                }
                ("GET", "/api/episodes") => {
                    let eps = episodes().lock().unwrap().clone();
                    let json = serde_json::to_string(&eps).unwrap_or_else(|_| "[]".into());
                    Response::from_string(json)
                        .with_header(Header::from_bytes("Content-Type", "application/json").unwrap())
                        .with_header(Header::from_bytes("Access-Control-Allow-Origin", "*").unwrap())
                }
                ("POST", "/api/episodes") => {
                    // Read body
                    let mut body = String::new();
                    let _ = request.as_reader().read_to_string(&mut body);
                    if let Ok(mut ep) = serde_json::from_str::<serde_json::Value>(&body) {
                        let mut eps = episodes().lock().unwrap();
                        let id = eps.len() as u64 + 1;
                        let now = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
                        ep["id"] = serde_json::json!(id);
                        ep["guid"] = serde_json::json!(format!("ether-ep-{}-{}", id, now));
                        ep["publishedTs"] = serde_json::json!(now as i64);
                        // RFC 2822 date
                        ep["publishedAt"] = serde_json::json!(
                            chrono_simple_rfc2822(now)
                        );
                        if ep["episodeNumber"].is_null() {
                            ep["episodeNumber"] = serde_json::json!(id);
                        }
                        eps.push(ep.clone());
                        let json = serde_json::to_string(&ep).unwrap_or_else(|_| "{}".into());
                        Response::from_string(json)
                            .with_header(Header::from_bytes("Content-Type", "application/json").unwrap())
                            .with_header(Header::from_bytes("Access-Control-Allow-Origin", "*").unwrap())
                    } else {
                        Response::from_string("{\"error\":\"bad request\"}").with_status_code(400)
                    }
                }
                _ => Response::from_string("Not found").with_status_code(404)
            };

            let _ = request.respond(response);
        }
    });
}
