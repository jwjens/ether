// REMOTE ACCESS & WEBSITE (Jeff, 2026-10-30, build C; docs/dead-controls-and-four-builds-proposal-2026-10-30.md §C).
// While Ether is open it serves, on this computer's network, port 4242:
//   GET  /now-playing.json  — title, artist, playing yes/no, station, time. Open to any page (CORS), read-only.
//   GET  /                  — the phone remote: now playing, Up Next, and Skip / Stop all / AUTO on / AUTO off
//                             (Jeff's answer 2a) — the same commands the web dashboard remote sends.
//   POST /api/cmd, GET /api/state — the phone page's calls; both need the 6-digit code shown in Settings, because
//                             anyone on the Wi-Fi could open the page.
// A public website on the internet can't reach this computer's local address — Settings says "on your network" and
// points public sites to the listener page and embed (Jeff's answer 3a).
const crypto = require("crypto");

const PORT = 4242;
const COMMANDS = new Set(["skip", "stop_all", "automation_on", "automation_off"]);
const MAX_BAD_CODES = 5;              // per address per minute, then refused until the minute is up
const BAD_CODE_WINDOW_MS = 60_000;

// /api/img-proxy (dead-controls item 17): the on-air deck's artist photos are drawn on a canvas, so they must come
// from a CORS-open address. Only for this computer (loopback), only https images from the two photo sources the deck
// uses (Wikipedia/Wikimedia, Apple's iTunes artwork), capped in size — never an open relay.
const IMG_HOSTS = [/(^|\.)wikimedia\.org$/i, /(^|\.)wikipedia\.org$/i, /(^|\.)mzstatic\.com$/i];
const IMG_MAX_BYTES = 15 * 1024 * 1024;
function imgProxyTarget(raw) {
  let u; try { u = new URL(String(raw || "")); } catch { return null; }
  if (u.protocol !== "https:" || !IMG_HOSTS.some(re => re.test(u.hostname))) return null;
  return u.toString();
}
const isLoopback = (addr) => /^(127\.|::1$|::ffff:127\.)/.test(String(addr || ""));

function newCode() { return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0"); }
function sameCode(a, b) {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || ""));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

/**
 * deps: { nowPlaying(): {station,title,artist,playing,updatedAt}|Promise, upNext(): [{title,artist}],
 *         runCmd(cmd): Promise<{ok,error}>, code(): string, now?: () => number }
 */
function createHandler(deps) {
  const now = deps.now || Date.now;
  const bad = new Map();   // address → { n, since }

  const send = (res, status, body, type = "application/json; charset=utf-8", extra = {}) => {
    res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", ...extra });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };
  const readJson = (req) => new Promise((resolve) => {
    let d = ""; req.on("data", c => { d += c; if (d.length > 10_000) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(d || "{}")); } catch { resolve({}); } });
    req.on("error", () => resolve({}));
  });
  const authed = (req, res) => {
    const addr = req.socket?.remoteAddress || "?";
    const b = bad.get(addr);
    if (b && now() - b.since < BAD_CODE_WINDOW_MS && b.n >= MAX_BAD_CODES) { send(res, 429, { ok: false, error: "too many wrong codes — wait a minute" }); return false; }
    if (sameCode(req.headers["x-ether-code"], deps.code())) { bad.delete(addr); return true; }
    const cur = b && now() - b.since < BAD_CODE_WINDOW_MS ? b : { n: 0, since: now() };
    cur.n++; bad.set(addr, cur);
    send(res, 401, { ok: false, error: "wrong code" });
    return false;
  };

  return async function handle(req, res) {
    const path = String(req.url || "/").split("?")[0];
    try {
      if (path === "/now-playing.json") {
        if (req.method === "OPTIONS") return send(res, 204, "", "text/plain", { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET" });
        return send(res, 200, await deps.nowPlaying(), undefined, { "Access-Control-Allow-Origin": "*" });
      }
      if (path === "/" && req.method === "GET") return send(res, 200, PHONE_PAGE, "text/html; charset=utf-8");
      if (path === "/api/img-proxy" && req.method === "GET") {
        if (!isLoopback(req.socket?.remoteAddress)) return send(res, 403, { ok: false, error: "this computer only" });
        const target = imgProxyTarget(new URL(req.url, "http://x").searchParams.get("url"));
        if (!target) return send(res, 400, { ok: false, error: "not an allowed image address" });
        const r = await (deps.fetchImpl || fetch)(target, { redirect: "follow" });
        const type = String(r.headers.get("content-type") || "");
        if (!r.ok || !/^image\//i.test(type)) return send(res, 502, { ok: false, error: `the photo source answered ${r.status}` });
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length > IMG_MAX_BYTES) return send(res, 502, { ok: false, error: "the photo is too large" });
        res.writeHead(200, { "Content-Type": type, "Access-Control-Allow-Origin": "*", "Cache-Control": "max-age=86400" });
        return res.end(buf);
      }
      if (path === "/api/state" && req.method === "GET") {
        if (!authed(req, res)) return;
        return send(res, 200, { ok: true, nowPlaying: await deps.nowPlaying(), upNext: (await deps.upNext()).slice(0, 5) });
      }
      if (path === "/api/cmd" && req.method === "POST") {
        if (!authed(req, res)) return;
        const { cmd } = await readJson(req);
        if (!COMMANDS.has(cmd)) return send(res, 400, { ok: false, error: "unknown command" });
        return send(res, 200, await deps.runCmd(cmd));
      }
      send(res, 404, { ok: false, error: "not found" });
    } catch (e) {
      send(res, 500, { ok: false, error: String(e?.message || e) });
    }
  };
}

/** Start serving on port 4242. Resolves { ok: true } or { ok: false, error } (e.g. the port is taken) — never throws. */
function startLocalRemote(deps, { http = require("http"), port = PORT, log = () => {} } = {}) {
  const server = http.createServer(createHandler(deps));
  return new Promise((resolve) => {
    server.once("error", (e) => { log(`[remote] port ${port} not available: ${e.message}`); resolve({ ok: false, error: e.message, server: null }); });
    server.listen(port, "0.0.0.0", () => { log(`[remote] serving on port ${port}`); resolve({ ok: true, server }); });
  });
}

// The phone remote page — one self-contained file (no outside requests; works on a LAN with no internet).
const PHONE_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ether Remote</title><style>
:root{color-scheme:dark}body{margin:0;font:16px system-ui,sans-serif;background:#07070b;color:#eee;padding:16px}
h1{font-size:14px;letter-spacing:.12em;color:#8868D8;margin:0 0 16px}.card{background:#14141c;border:1px solid #2a2a36;padding:14px;margin-bottom:12px}
.lbl{font-size:11px;letter-spacing:.1em;color:#888;text-transform:uppercase;margin-bottom:6px}.t{font-size:20px;font-weight:700}.a{color:#aaa;margin-top:2px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}button{font:inherit;font-weight:700;padding:16px;border:1px solid #2a2a36;background:#1c1c26;color:#eee}
button.on{background:#22c55e;color:#06140a;border:none}button.stop{background:#ef4444;border:none}input{font:inherit;font-size:24px;letter-spacing:.3em;width:100%;box-sizing:border-box;padding:12px;background:#1c1c26;color:#eee;border:1px solid #2a2a36;text-align:center}
#msg{min-height:20px;color:#fbbf24;font-size:13px;margin:8px 0}ol{margin:0;padding-left:20px;color:#ccc}li{margin:4px 0}
</style></head><body><h1>ETHER REMOTE</h1>
<div id="login" class="card" hidden><div class="lbl">Enter the 6-digit code</div><div style="font-size:13px;color:#aaa;margin-bottom:8px">Shown in Ether: Settings → Broadcast → Remote Access &amp; Website.</div>
<input id="code" inputmode="numeric" maxlength="6" autocomplete="one-time-code"><div id="lmsg" style="color:#fbbf24;font-size:13px;margin-top:8px"></div><button style="width:100%;margin-top:10px" onclick="login()">Connect</button></div>
<div id="main" hidden><div class="card"><div class="lbl" id="st">Now playing</div><div class="t" id="title">—</div><div class="a" id="artist"></div></div>
<div class="grid"><button onclick="cmd('skip')">⏭ Skip</button><button class="stop" onclick="cmd('stop_all')">⏹ Stop all</button>
<button class="on" onclick="cmd('automation_on')">AUTO on</button><button onclick="cmd('automation_off')">AUTO off</button></div>
<div id="msg"></div><div class="card"><div class="lbl">Up next</div><ol id="next"></ol></div></div>
<script>
let code=localStorage.getItem("ether_remote_code")||"";
const $=id=>document.getElementById(id);
async function api(p,o={}){const r=await fetch(p,{...o,headers:{...(o.headers||{}),"x-ether-code":code,"content-type":"application/json"}});const j=await r.json().catch(()=>({ok:false,error:"no answer"}));if(r.status===401){show(false);$("lmsg").textContent="That code is not right.";}return j;}
function show(ok){$("login").hidden=ok;$("main").hidden=!ok;}
async function login(){code=$("code").value.trim();localStorage.setItem("ether_remote_code",code);const j=await api("/api/state");if(j.ok){show(true);paint(j);}else if(j.error&&j.error!=="wrong code")$("lmsg").textContent=j.error;}
function paint(j){const n=j.nowPlaying||{};$("st").textContent=(n.station?n.station+" · ":"")+(n.playing?"Now playing":"Not playing");$("title").textContent=n.title||"—";$("artist").textContent=n.artist||"";
$("next").innerHTML="";(j.upNext||[]).forEach(s=>{const li=document.createElement("li");li.textContent=(s.artist?s.artist+" – ":"")+(s.title||"");$("next").appendChild(li);});if(!(j.upNext||[]).length)$("next").innerHTML="<li style='list-style:none;margin-left:-20px;color:#888'>Nothing queued</li>";}
async function cmd(c){$("msg").textContent="Sending…";const j=await api("/api/cmd",{method:"POST",body:JSON.stringify({cmd:c})});$("msg").textContent=j.ok?"Done.":"Not done: "+(j.error||"unknown");setTimeout(tick,600);}
async function tick(){if(!code){show(false);return;}const j=await api("/api/state");if(j.ok){show(true);paint(j);}}
tick();setInterval(tick,3000);
</script></body></html>`;

module.exports = { createHandler, startLocalRemote, newCode, sameCode, imgProxyTarget, COMMANDS, PORT, PHONE_PAGE };
