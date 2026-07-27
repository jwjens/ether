// Poller: post operator-facing notes for v4.4.10 + v4.4.11 once CI publishes them. Token via git credential.
const https = require("https");
const { execSync } = require("child_process");
const REPO = "jwjens/ether";
const RELEASES = [
  {
    tag: "v4.4.10",
    name: "v4.4.10 — Cloud restore no longer bounces you to sign-in",
    body: [
      "**Restoring a station from the cloud now keeps you signed in.** Previously, pulling your station down on a new machine could drop you back to the sign-in screen right after the sync — because the restore overwrote your session. Fixed: your account session is preserved across the restore, so you land straight in your station.",
      "",
      "_Local-first as always: the studio machine runs the audio; the cloud is the sync hub._",
    ].join("\n"),
  },
  {
    tag: "v4.4.11",
    name: "v4.4.11 — Your plan applies automatically",
    body: [
      "**The app now reads your plan from your account automatically.** A machine that restored its station from the cloud, or one that's been running a while, will pick up its correct plan tier (e.g. Network) on its own within seconds — no sign-out/in needed. If your account is paid, the paid features unlock on their own.",
      "",
      "_Local-first as always: the studio machine runs the audio; the cloud is the sync hub._",
    ].join("\n"),
  },
];
function token() {
  const out = execSync("git credential fill", { input: "protocol=https\nhost=github.com\n\n" }).toString();
  const m = out.match(/password=(.+)/); if (!m) throw new Error("no token"); return m[1].trim();
}
function api(method, path, tok, payload) {
  return new Promise((resolve, reject) => {
    const data = payload ? JSON.stringify(payload) : null;
    const req = https.request({ hostname: "api.github.com", path, method,
      headers: { "User-Agent": "ether-release", Authorization: `Bearer ${tok}`, Accept: "application/vnd.github+json",
        ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}) } },
      res => { let b = ""; res.on("data", c => b += c); res.on("end", () => resolve({ status: res.statusCode, body: b })); });
    req.on("error", reject); if (data) req.write(data); req.end();
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const tok = token();
  for (const rel of RELEASES) {
    let id = null;
    for (let i = 0; i < 60; i++) {
      const r = await api("GET", `/repos/${REPO}/releases/tags/${rel.tag}`, tok);
      if (r.status === 200) { id = JSON.parse(r.body).id; break; }
      console.log(`[${rel.tag}] not published yet (HTTP ${r.status}) — waiting…`); await sleep(30000);
    }
    if (!id) { console.error(`[${rel.tag}] never appeared — skipping`); continue; }
    const patch = await api("PATCH", `/repos/${REPO}/releases/${id}`, tok, { name: rel.name, body: rel.body });
    console.log(`[${rel.tag}] PATCH ${patch.status} → ${patch.status === 200 ? "notes posted" : patch.body.slice(0, 160)}`);
  }
  console.log("done.");
})().catch(e => { console.error("poster error:", e.message); process.exitCode = 1; });
