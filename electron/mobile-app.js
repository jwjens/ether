// electron/mobile-app.js — Ether2Go mobile companion PWA + API.
//
// Self-contained mobile-friendly HTML page served at /m. DJs paired devices
// can:
//   1. Record voice tracks from their phone (intro/outro/breaks/promos)
//   2. Upload directly to the studio
//   3. See what's now playing
//   4. View their upload history
//
// No native app, no app store, no install — just open the URL on any phone
// and "Add to Home Screen" for an icon. All recording happens in-browser
// via MediaRecorder API. Audio uploads as multipart/form-data to
// /api/v2g/upload.
//
// Authentication: the studio shows a 6-digit code (Settings → Mobile App).
// Mobile enters it once, gets a long-lived bearer token stored in
// localStorage. Token can be revoked from the studio.
//
// Lives in main process so it stays running even when no renderer window
// is open.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

let getDb = () => null;   // resolves the LIVE connection (set in install); survives a reopen
let voiceTracksDir = null;

// ── Helpers ─────────────────────────────────────────────────
function genShortCode() {
  // 6-digit numeric, easy to type on a phone keypad
  return Math.floor(100000 + Math.random() * 900000).toString();
}
function genToken() {
  return crypto.randomBytes(32).toString("hex");
}
function getTokenFromReq(req) {
  const auth = req.headers["authorization"] || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7);
  // Also accept ?token= as a query param for browser drag-link convenience
  try {
    const u = new URL("http://x" + (req.url || "/"));
    return u.searchParams.get("token") || null;
  } catch {}
  return null;
}
function authPairing(req) {
  const token = getTokenFromReq(req);
  if (!token) return null;
  try {
    const row = getDb().prepare("SELECT * FROM mobile_pairings WHERE token = ? AND revoked = 0").get(token);
    if (!row) return null;
    getDb().prepare("UPDATE mobile_pairings SET last_seen = ? WHERE id = ?").run(Math.floor(Date.now()/1000), row.id);
    return row;
  } catch { return null; }
}
function readBody(req, maxBytes = 100 * 1024 * 1024) { // 100MB cap on uploads
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", c => {
      total += c.length;
      if (total > maxBytes) { req.destroy(); reject(new Error("body too large")); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
// Minimal multipart parser — only handles a single file part + a few text fields,
// which is all the mobile uploader needs. Avoids adding a multipart npm dep.
function parseMultipart(buf, contentType) {
  const m = /boundary=(.+)$/.exec(contentType || "");
  if (!m) return null;
  const boundary = "--" + m[1];
  const parts = [];
  let i = 0;
  while (i < buf.length) {
    const startIdx = buf.indexOf(boundary, i);
    if (startIdx === -1) break;
    const headerStart = startIdx + boundary.length + 2; // skip \r\n
    const headerEnd = buf.indexOf("\r\n\r\n", headerStart);
    if (headerEnd === -1) break;
    const headers = buf.slice(headerStart, headerEnd).toString("utf8");
    const bodyStart = headerEnd + 4;
    const nextBoundary = buf.indexOf(boundary, bodyStart);
    if (nextBoundary === -1) break;
    const body = buf.slice(bodyStart, nextBoundary - 2); // strip trailing \r\n

    const dispMatch = /Content-Disposition: form-data; name="([^"]+)"(?:; filename="([^"]*)")?/.exec(headers);
    const ctMatch   = /Content-Type: ([^\r\n]+)/.exec(headers);
    if (dispMatch) {
      parts.push({
        name: dispMatch[1],
        filename: dispMatch[2] || null,
        mime: ctMatch ? ctMatch[1].trim() : null,
        data: body,
      });
    }
    i = nextBoundary;
  }
  return parts;
}

// ── Static: the mobile PWA HTML ─────────────────────────────
const MOBILE_HTML = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="theme-color" content="#0a0a0f">
<title>Ether2Go</title>
<link rel="manifest" href="/m/manifest.json">
<style>
* { margin:0; padding:0; box-sizing:border-box; -webkit-tap-highlight-color:transparent }
html,body { background:#0a0a0f; color:#e8e8f0; font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif; min-height:100vh; min-height:100dvh; overscroll-behavior:none; -webkit-user-select:none; user-select:none }
body { display:flex; flex-direction:column }
button { font:inherit; color:inherit; cursor:pointer; -webkit-appearance:none }
input { font:inherit; color:inherit; -webkit-appearance:none }

.app { flex:1; display:flex; flex-direction:column; padding:env(safe-area-inset-top) 16px env(safe-area-inset-bottom) }
.header { padding:16px 0; display:flex; align-items:center; gap:10px; border-bottom:1px solid #1a1a22 }
.logo { font-weight:900; font-size:18px; letter-spacing:-.04em }
.logo span { color:#38bdf8 }
.subtitle { font-size:11px; color:#606070; letter-spacing:.06em; text-transform:uppercase; margin-top:2px }
.status-pill { margin-left:auto; padding:4px 10px; font-size:11px; font-weight:700; letter-spacing:.04em; background:#1e3a2c; color:#22c55e }
.status-pill.offline { background:#3a1e1e; color:#ef4444 }

/* Pair screen */
.pair { flex:1; display:flex; flex-direction:column; justify-content:center; gap:18px; padding:24px 8px; text-align:center }
.pair h1 { font-size:24px; font-weight:800; letter-spacing:-.04em }
.pair p { font-size:14px; color:#909098; line-height:1.5 }
.code-input { width:100%; max-width:280px; margin:8px auto; padding:18px; font-size:32px; font-weight:700; text-align:center; letter-spacing:.4em; font-family:'JetBrains Mono',monospace; background:#1a1a22; border:2px solid #2a2a35; color:#e8e8f0; outline:none }
.code-input:focus { border-color:#38bdf8 }
.btn { padding:14px 24px; font-size:14px; font-weight:700; letter-spacing:.04em; background:#38bdf8; color:#0a0a0f; border:none; min-height:48px; transition:transform .08s }
.btn:active { transform:scale(.97) }
.btn.secondary { background:#1a1a22; color:#909098; border:1px solid #2a2a35 }
.btn:disabled { opacity:.4; cursor:not-allowed }

/* Tabs */
.tabs { display:flex; padding:8px 0 12px; gap:4px; border-bottom:1px solid #1a1a22 }
.tab { flex:1; padding:10px; font-size:12px; font-weight:700; letter-spacing:.04em; background:transparent; color:#606070; border:none; border-bottom:2px solid transparent }
.tab.active { color:#38bdf8; border-bottom-color:#38bdf8 }

/* Recorder */
.recorder { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:24px; padding:32px 16px }
.timer { font-size:56px; font-weight:300; font-family:'JetBrains Mono',monospace; color:#e8e8f0; letter-spacing:-.02em }
.timer.recording { color:#ef4444; animation:pulse 1.5s ease-in-out infinite }
@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.5} }
.level-meter { width:100%; max-width:280px; height:6px; background:#1a1a22; overflow:hidden; position:relative }
.level-bar { height:100%; background:linear-gradient(90deg,#22c55e 0%,#22c55e 60%,#f59e0b 80%,#ef4444 100%); transform-origin:left; transform:scaleX(0); transition:transform .08s }
.rec-btn { width:100px; height:100px; border-radius:50%; background:#ef4444; border:6px solid #2a0606; transition:all .15s; display:flex; align-items:center; justify-content:center; box-shadow:0 6px 24px rgba(239,68,68,.3) }
.rec-btn:active { transform:scale(.95) }
.rec-btn.recording { border-radius:8px; width:80px; height:80px; background:#ef4444 }
.rec-btn-inner { width:24px; height:24px; border-radius:50%; background:#fff }
.rec-btn.recording .rec-btn-inner { width:24px; height:24px; border-radius:4px; background:#fff }
.rec-hint { font-size:13px; color:#606070; text-align:center }

/* Review screen (after recording) */
.review { flex:1; display:flex; flex-direction:column; padding:24px 8px; gap:16px }
.review h2 { font-size:18px; font-weight:800; letter-spacing:-.03em }
.review .info { font-size:13px; color:#909098 }
.review audio { width:100%; margin:8px 0 }
.label-input { padding:12px 14px; font-size:14px; background:#1a1a22; border:1px solid #2a2a35; color:#e8e8f0; outline:none }
.label-input:focus { border-color:#38bdf8 }
.btn-row { display:flex; gap:8px }
.btn-row .btn { flex:1 }

/* Tracks list */
.tracks { flex:1; display:flex; flex-direction:column; padding:12px 0; gap:6px; overflow-y:auto }
.track { padding:14px; background:#13131a; border:1px solid #1a1a22; display:flex; flex-direction:column; gap:6px }
.track-title { font-size:14px; font-weight:600 }
.track-meta { display:flex; gap:8px; font-size:11px; color:#606070; flex-wrap:wrap }
.track-status { padding:2px 6px; font-size:10px; font-weight:700; letter-spacing:.04em; text-transform:uppercase }
.track-status.uploaded { background:#1e2a3a; color:#38bdf8 }
.track-status.queued   { background:#2a2a1e; color:#f59e0b }
.track-status.played   { background:#1e2a1e; color:#22c55e }

/* Toast */
.toast { position:fixed; bottom:24px; left:16px; right:16px; padding:12px 16px; font-size:13px; background:#1a1a22; border:1px solid #2a2a35; text-align:center; z-index:100 }
.toast.ok { background:#1e3a2c; border-color:#22c55e44; color:#22c55e }
.toast.err { background:#3a1e1e; border-color:#ef444444; color:#ef4444 }
.empty { padding:48px 16px; text-align:center; color:#606070; font-size:13px }
</style>
</head><body>
<div class="app" id="app"></div>
<script>
const API = location.origin;
let token = localStorage.getItem("ether2go_token") || "";
let mediaRecorder = null;
let audioChunks = [];
let recordStartTime = 0;
let recordTimer = null;
let activeStream = null;
let audioCtx = null;
let analyser = null;
let levelRaf = 0;
let recordedBlob = null;
let recordedUrl = null;
let activeTab = "record";
let tracks = [];

const $ = s => document.querySelector(s);
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt) e.textContent = txt; return e; };
const toast = (msg, type = "ok") => {
  const existing = document.querySelector(".toast"); if (existing) existing.remove();
  const t = el("div", "toast " + type, msg);
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3500);
};
const fmtMs = ms => {
  const s = Math.floor(ms / 1000);
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
};
const fmtBytes = b => b > 1024*1024 ? (b/1024/1024).toFixed(1)+" MB" : (b/1024).toFixed(0)+" KB";
const fmtAgo = sec => {
  const d = Math.floor(Date.now()/1000) - sec;
  if (d < 60) return d + "s ago";
  if (d < 3600) return Math.floor(d/60) + "m ago";
  if (d < 86400) return Math.floor(d/3600) + "h ago";
  return Math.floor(d/86400) + "d ago";
};

// ── PAIRING ────────────────────────────────────────────────
function renderPair() {
  const root = $("#app"); root.innerHTML = "";
  const header = el("div", "header");
  const titleWrap = el("div");
  titleWrap.innerHTML = '<div class="logo">ETHER<span>2GO</span></div><div class="subtitle">Mobile Studio Companion</div>';
  header.appendChild(titleWrap);
  root.appendChild(header);

  const pair = el("div", "pair");
  pair.innerHTML = \`
    <h1>Pair this device</h1>
    <p>Open Ether on your studio computer.<br>Go to <b>Settings → Pair Mobile App</b><br>and enter the 6-digit code shown there.</p>
    <input class="code-input" id="codeInput" type="tel" inputmode="numeric" maxlength="6" placeholder="000000" autocomplete="off" />
    <button class="btn" id="pairBtn">Pair</button>
    <button class="btn secondary" id="labelBtn" style="margin-top:6px">Edit device name</button>
  \`;
  root.appendChild(pair);
  $("#codeInput").focus();
  $("#pairBtn").onclick = doPair;
  $("#labelBtn").onclick = () => {
    const lbl = prompt("Device name (e.g. \\"Jen's iPhone\\"):", localStorage.getItem("ether2go_label") || "");
    if (lbl !== null) localStorage.setItem("ether2go_label", lbl);
  };
  $("#codeInput").addEventListener("keypress", e => { if (e.key === "Enter") doPair(); });
}
async function doPair() {
  const code = $("#codeInput").value.trim();
  if (!/^\\d{6}$/.test(code)) { toast("Enter the 6-digit code", "err"); return; }
  $("#pairBtn").disabled = true; $("#pairBtn").textContent = "Pairing…";
  try {
    const r = await fetch(API + "/api/v2g/pair", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, deviceLabel: localStorage.getItem("ether2go_label") || (navigator.userAgent.includes("iPhone") ? "iPhone" : navigator.userAgent.includes("Android") ? "Android" : "Mobile") }),
    });
    const d = await r.json();
    if (!d.ok) throw new Error(d.error || "Pairing failed");
    token = d.token;
    localStorage.setItem("ether2go_token", token);
    toast("Paired successfully", "ok");
    setTimeout(renderApp, 600);
  } catch (e) {
    toast("Error: " + e.message, "err");
    $("#pairBtn").disabled = false; $("#pairBtn").textContent = "Pair";
  }
}

// ── MAIN APP (after pairing) ───────────────────────────────
function renderApp() {
  const root = $("#app"); root.innerHTML = "";
  const header = el("div", "header");
  const titleWrap = el("div");
  titleWrap.innerHTML = '<div class="logo">ETHER<span>2GO</span></div><div class="subtitle">Connected to studio</div>';
  header.appendChild(titleWrap);
  const pill = el("div", "status-pill", "ONLINE");
  header.appendChild(pill);
  root.appendChild(header);

  const tabs = el("div", "tabs");
  ["record","tracks","settings"].forEach(t => {
    const b = el("button", "tab" + (activeTab === t ? " active" : ""), t.toUpperCase());
    b.onclick = () => { activeTab = t; renderApp(); };
    tabs.appendChild(b);
  });
  root.appendChild(tabs);

  if (activeTab === "record")   renderRecord(root);
  if (activeTab === "tracks")   renderTracks(root);
  if (activeTab === "settings") renderSettings(root);
}

// ── Record tab ──
function renderRecord(root) {
  const wrap = el("div", "recorder");
  const timer = el("div", "timer", "0:00");
  timer.id = "timer";
  const level = el("div", "level-meter");
  const levelBar = el("div", "level-bar");
  levelBar.id = "levelBar";
  level.appendChild(levelBar);
  const btn = el("button", "rec-btn");
  btn.id = "recBtn";
  const inner = el("div", "rec-btn-inner");
  btn.appendChild(inner);
  btn.onclick = toggleRecord;
  const hint = el("div", "rec-hint", "Tap to record");
  hint.id = "recHint";

  wrap.appendChild(timer);
  wrap.appendChild(level);
  wrap.appendChild(btn);
  wrap.appendChild(hint);
  root.appendChild(wrap);
}

async function toggleRecord() {
  if (mediaRecorder && mediaRecorder.state === "recording") {
    mediaRecorder.stop();
    return;
  }
  try {
    activeStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false } });
    audioChunks = [];
    const mimes = ["audio/webm;codecs=opus","audio/webm","audio/mp4","audio/mpeg","audio/wav"];
    let mime = mimes.find(m => MediaRecorder.isTypeSupported(m)) || "";
    mediaRecorder = mime ? new MediaRecorder(activeStream, { mimeType: mime }) : new MediaRecorder(activeStream);
    mediaRecorder.ondataavailable = e => { if (e.data.size > 0) audioChunks.push(e.data); };
    mediaRecorder.onstop = onRecordStop;
    mediaRecorder.start(250);
    recordStartTime = Date.now();
    $("#recBtn").classList.add("recording");
    $("#timer").classList.add("recording");
    $("#recHint").textContent = "Tap to stop";
    recordTimer = setInterval(() => {
      $("#timer").textContent = fmtMs(Date.now() - recordStartTime);
    }, 100);
    setupLevelMeter();
  } catch (e) {
    toast("Mic access denied: " + e.message, "err");
  }
}
function setupLevelMeter() {
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const src = audioCtx.createMediaStreamSource(activeStream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 256;
  src.connect(analyser);
  const buf = new Uint8Array(analyser.frequencyBinCount);
  const tick = () => {
    if (!analyser) return;
    analyser.getByteFrequencyData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i];
    const lvl = Math.min(1, (sum / buf.length / 128) * 1.4);
    const bar = $("#levelBar"); if (bar) bar.style.transform = "scaleX(" + lvl + ")";
    levelRaf = requestAnimationFrame(tick);
  };
  tick();
}
function onRecordStop() {
  clearInterval(recordTimer);
  if (levelRaf) cancelAnimationFrame(levelRaf);
  if (audioCtx) { audioCtx.close().catch(()=>{}); audioCtx = null; analyser = null; }
  if (activeStream) { activeStream.getTracks().forEach(t => t.stop()); activeStream = null; }
  const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType || "audio/webm" });
  recordedBlob = blob;
  if (recordedUrl) URL.revokeObjectURL(recordedUrl);
  recordedUrl = URL.createObjectURL(blob);
  renderReview(blob.size);
}

function renderReview(sizeBytes) {
  const root = $("#app"); root.innerHTML = "";
  const header = el("div", "header");
  header.innerHTML = '<div><div class="logo">ETHER<span>2GO</span></div><div class="subtitle">Review &amp; upload</div></div>';
  root.appendChild(header);

  const review = el("div", "review");
  const dur = Date.now() - recordStartTime;
  review.innerHTML = \`
    <h2>Track ready</h2>
    <div class="info">\${fmtMs(dur)} · \${fmtBytes(sizeBytes)}</div>
    <audio controls src="\${recordedUrl}"></audio>
    <input class="label-input" id="trackTitle" placeholder="Title (optional, e.g. 'Morning intro')" />
    <input class="label-input" id="trackNotes" placeholder="Notes (optional)" />
    <div class="btn-row">
      <button class="btn secondary" id="discardBtn">Discard</button>
      <button class="btn" id="uploadBtn">Upload</button>
    </div>
  \`;
  root.appendChild(review);
  $("#discardBtn").onclick = () => { recordedBlob = null; recordedUrl = null; renderApp(); };
  $("#uploadBtn").onclick = () => uploadTrack(dur);
}
async function uploadTrack(durationMs) {
  if (!recordedBlob) return;
  const title = $("#trackTitle").value.trim();
  const notes = $("#trackNotes").value.trim();
  $("#uploadBtn").disabled = true; $("#uploadBtn").textContent = "Uploading…";
  try {
    const fd = new FormData();
    fd.append("title", title);
    fd.append("notes", notes);
    fd.append("duration_ms", String(durationMs));
    fd.append("audio", recordedBlob, "voicetrack-" + Date.now() + ".webm");
    const r = await fetch(API + "/api/v2g/upload", {
      method: "POST",
      headers: { "Authorization": "Bearer " + token },
      body: fd,
    });
    const d = await r.json();
    if (!d.ok) throw new Error(d.error || "Upload failed");
    toast("Uploaded — DJ can now see it in Voice Track Inbox", "ok");
    recordedBlob = null; recordedUrl = null;
    activeTab = "tracks";
    setTimeout(renderApp, 700);
  } catch (e) {
    toast("Error: " + e.message, "err");
    $("#uploadBtn").disabled = false; $("#uploadBtn").textContent = "Upload";
  }
}

// ── Tracks tab ──
async function renderTracks(root) {
  const wrap = el("div", "tracks");
  wrap.innerHTML = '<div class="empty">Loading…</div>';
  root.appendChild(wrap);
  try {
    const r = await fetch(API + "/api/v2g/tracks", { headers: { "Authorization": "Bearer " + token } });
    const d = await r.json();
    if (!d.ok) throw new Error(d.error);
    tracks = d.tracks || [];
    wrap.innerHTML = "";
    if (tracks.length === 0) { wrap.innerHTML = '<div class="empty">No tracks yet — record one!</div>'; return; }
    tracks.forEach(t => {
      const row = el("div", "track");
      row.innerHTML = \`
        <div class="track-title">\${t.title || "Untitled track #" + t.id}</div>
        <div class="track-meta">
          <span class="track-status \${t.status}">\${t.status}</span>
          <span>\${fmtMs(t.duration_ms || 0)}</span>
          <span>\${fmtBytes(t.size_bytes || 0)}</span>
          <span>\${fmtAgo(t.uploaded_at)}</span>
        </div>
      \`;
      wrap.appendChild(row);
    });
  } catch (e) {
    wrap.innerHTML = '<div class="empty">Error: ' + e.message + '</div>';
  }
}

// ── Settings tab ──
function renderSettings(root) {
  const wrap = el("div", "review");
  wrap.innerHTML = \`
    <h2>Settings</h2>
    <p style="font-size:13px; color:#909098; line-height:1.6">Device name: <b>\${localStorage.getItem("ether2go_label") || "(none)"}</b></p>
    <button class="btn secondary" id="renameBtn">Change device name</button>
    <p style="font-size:13px; color:#909098; line-height:1.6; margin-top:14px">Studio URL: <code style="font-size:11px">\${API}</code></p>
    <button class="btn secondary" id="unpairBtn" style="background:#3a1e1e; color:#ef4444; border-color:#ef444444">Unpair this device</button>
  \`;
  root.appendChild(wrap);
  $("#renameBtn").onclick = () => {
    const lbl = prompt("Device name:", localStorage.getItem("ether2go_label") || "");
    if (lbl !== null) { localStorage.setItem("ether2go_label", lbl); toast("Saved", "ok"); }
  };
  $("#unpairBtn").onclick = () => {
    if (!confirm("Unpair this device? You'll need to enter a new code to re-pair.")) return;
    localStorage.removeItem("ether2go_token");
    token = "";
    renderPair();
  };
}

// ── Boot ──
if (token) renderApp(); else renderPair();
</script>
</body></html>`;

const MOBILE_MANIFEST = JSON.stringify({
  name: "Ether2Go",
  short_name: "Ether2Go",
  start_url: "/m",
  display: "standalone",
  background_color: "#0a0a0f",
  theme_color: "#0a0a0f",
  orientation: "portrait",
  icons: [
    { src: "/m/icon-192.png", sizes: "192x192", type: "image/png" },
    { src: "/m/icon-512.png", sizes: "512x512", type: "image/png" },
  ],
});

// ── HTTP route handler — call this from main.js's HTTP server ──
// Returns true if it handled the request, false if main.js should try
// other routes / 404.
function handleMobileRequest(req, res) {
  const url = req.url?.split("?")[0] || "/";

  // Static — mobile PWA
  if (req.method === "GET" && (url === "/m" || url === "/m/" || url === "/m/index.html")) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.end(MOBILE_HTML);
    return true;
  }
  if (req.method === "GET" && url === "/m/manifest.json") {
    res.setHeader("Content-Type", "application/manifest+json");
    res.end(MOBILE_MANIFEST);
    return true;
  }

  // ── Pair: exchange short code for token ──
  if (req.method === "POST" && url === "/api/v2g/pair") {
    readBody(req, 4096).then(buf => {
      try {
        const { code, deviceLabel } = JSON.parse(buf.toString("utf8") || "{}");
        if (!code || !/^\d{6}$/.test(code)) {
          res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: "invalid code" })); return;
        }
        const now = Math.floor(Date.now() / 1000);
        const row = getDb().prepare("SELECT * FROM mobile_pairings WHERE short_code = ? AND short_code_expires > ? AND paired_at = 0").get(code, now);
        if (!row) {
          res.statusCode = 401; res.end(JSON.stringify({ ok: false, error: "code expired or invalid" })); return;
        }
        getDb().prepare("UPDATE mobile_pairings SET paired_at = ?, last_seen = ?, device_label = ?, short_code = NULL, short_code_expires = 0 WHERE id = ?")
          .run(now, now, deviceLabel || "", row.id);
        res.end(JSON.stringify({ ok: true, token: row.token, deviceLabel }));
      } catch (e) {
        res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    }).catch(e => { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: e.message })); });
    return true;
  }

  // ── Upload audio ──
  if (req.method === "POST" && url === "/api/v2g/upload") {
    const pairing = authPairing(req);
    if (!pairing) { res.statusCode = 401; res.end(JSON.stringify({ ok: false, error: "unauthorized" })); return true; }
    readBody(req).then(buf => {
      try {
        const parts = parseMultipart(buf, req.headers["content-type"] || "");
        if (!parts) { res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: "bad multipart" })); return; }
        const audioPart = parts.find(p => p.name === "audio");
        if (!audioPart || !audioPart.data?.length) {
          res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: "missing audio" })); return;
        }
        const titlePart    = parts.find(p => p.name === "title");
        const notesPart    = parts.find(p => p.name === "notes");
        const durationPart = parts.find(p => p.name === "duration_ms");
        const title    = titlePart    ? titlePart.data.toString("utf8") : "";
        const notes    = notesPart    ? notesPart.data.toString("utf8") : "";
        const duration = durationPart ? parseInt(durationPart.data.toString("utf8") || "0", 10) : 0;
        const ext = (audioPart.mime || "audio/webm").includes("mp4") ? "mp4"
                  : (audioPart.mime || "").includes("mpeg") ? "mp3"
                  : (audioPart.mime || "").includes("wav") ? "wav"
                  : "webm";
        // Make sure the storage dir exists
        if (!fs.existsSync(voiceTracksDir)) fs.mkdirSync(voiceTracksDir, { recursive: true });
        const filename = `vt-${pairing.id}-${Date.now()}.${ext}`;
        const filePath = path.join(voiceTracksDir, filename);
        fs.writeFileSync(filePath, audioPart.data);
        const stat = fs.statSync(filePath);
        const result = getDb().prepare(
          "INSERT INTO mobile_voice_tracks (pairing_id, file_path, mime_type, duration_ms, size_bytes, title, notes) VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).run(pairing.id, filePath, audioPart.mime || "audio/webm", duration, stat.size, title, notes);
        res.end(JSON.stringify({ ok: true, id: result.lastInsertRowid, size: stat.size }));
      } catch (e) {
        res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    }).catch(e => { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: e.message })); });
    return true;
  }

  // ── List my tracks (mobile-side; only shows this device's tracks) ──
  if (req.method === "GET" && url === "/api/v2g/tracks") {
    const pairing = authPairing(req);
    if (!pairing) { res.statusCode = 401; res.end(JSON.stringify({ ok: false, error: "unauthorized" })); return true; }
    try {
      const rows = getDb().prepare("SELECT id, title, notes, duration_ms, size_bytes, status, uploaded_at, played_at FROM mobile_voice_tracks WHERE pairing_id = ? ORDER BY uploaded_at DESC LIMIT 50").all(pairing.id);
      res.end(JSON.stringify({ ok: true, tracks: rows }));
    } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: e.message })); }
    return true;
  }

  return false;
}

// ── IPC for the studio side (Settings → Pair Mobile App) ────────
function installMobileApp(ipcMain, database, opts = {}) {
  getDb = (typeof database === "function") ? database : () => database;
  voiceTracksDir = opts.voiceTracksDir || path.join(opts.userDataPath || ".", "voice-tracks");

  // Create a new pending pairing — returns the 6-digit code to display
  ipcMain.handle("v2g:create-pair-code", () => {
    try {
      const code = genShortCode();
      const token = genToken();
      const expires = Math.floor(Date.now() / 1000) + 600; // 10 min
      getDb().prepare("INSERT INTO mobile_pairings (token, short_code, short_code_expires) VALUES (?, ?, ?)")
        .run(token, code, expires);
      return { ok: true, code, expiresIn: 600 };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  // List paired devices for the studio side
  ipcMain.handle("v2g:list-devices", () => {
    try {
      const rows = getDb().prepare("SELECT id, device_label, operator_name, paired_at, last_seen, revoked FROM mobile_pairings WHERE paired_at > 0 ORDER BY paired_at DESC").all();
      return rows;
    } catch { return []; }
  });

  // Revoke a pairing
  ipcMain.handle("v2g:revoke", (_, { id }) => {
    try {
      getDb().prepare("UPDATE mobile_pairings SET revoked = 1 WHERE id = ?").run(id);
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  // List uploaded voice tracks (studio inbox)
  ipcMain.handle("v2g:list-tracks", ({ status } = {}) => {
    try {
      const sql = status
        ? "SELECT vt.*, mp.device_label, mp.operator_name FROM mobile_voice_tracks vt LEFT JOIN mobile_pairings mp ON mp.id = vt.pairing_id WHERE vt.status = ? ORDER BY vt.uploaded_at DESC LIMIT 200"
        : "SELECT vt.*, mp.device_label, mp.operator_name FROM mobile_voice_tracks vt LEFT JOIN mobile_pairings mp ON mp.id = vt.pairing_id ORDER BY vt.uploaded_at DESC LIMIT 200";
      return status ? getDb().prepare(sql).all(status) : getDb().prepare(sql).all();
    } catch { return []; }
  });

  // Update track status (queued / played / archived)
  ipcMain.handle("v2g:update-track", (_, { id, status, title, notes }) => {
    try {
      if (status) getDb().prepare("UPDATE mobile_voice_tracks SET status = ?, played_at = CASE WHEN ? = 'played' THEN unixepoch() ELSE played_at END WHERE id = ?").run(status, status, id);
      if (title !== undefined) getDb().prepare("UPDATE mobile_voice_tracks SET title = ? WHERE id = ?").run(title, id);
      if (notes !== undefined) getDb().prepare("UPDATE mobile_voice_tracks SET notes = ? WHERE id = ?").run(notes, id);
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  // Delete an uploaded voice track (file + row)
  ipcMain.handle("v2g:delete-track", (_, { id }) => {
    try {
      const row = getDb().prepare("SELECT file_path FROM mobile_voice_tracks WHERE id = ?").get(id);
      if (row?.file_path && fs.existsSync(row.file_path)) {
        try { fs.unlinkSync(row.file_path); } catch {}
      }
      getDb().prepare("DELETE FROM mobile_voice_tracks WHERE id = ?").run(id);
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  // Get audio file path (renderer needs this to load the file via file:// URL)
  ipcMain.handle("v2g:get-track-path", (_, { id }) => {
    try {
      const row = getDb().prepare("SELECT file_path FROM mobile_voice_tracks WHERE id = ?").get(id);
      return { ok: true, path: row?.file_path || null };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  console.log("[V2G] Ether2Go mobile app installed — voice tracks dir:", voiceTracksDir);
}

module.exports = { installMobileApp, handleMobileRequest };
