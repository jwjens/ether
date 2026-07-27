// Poller: for each release tag, wait until CI has published the GitHub release,
// then PATCH operator-facing name + body. v4.4.8 is already published (posts
// immediately); v4.4.9 is polled until its build finishes. Token via git credential.
//
// Run:  node scripts/post-notes-44x.js   (safe to run in the background)
const https = require("https");
const { execSync } = require("child_process");

const REPO = "jwjens/ether";

const RELEASES = [
  {
    tag: "v4.4.8",
    name: "v4.4.8 — Groundwork for multi-account operators (off by default)",
    body: [
      "**Groundwork only — nothing about your station changes.** This release lays the foundation for a program director who operates stations across more than one account from a single machine: a station they're given access to can be run as a full station, with its programming editing in **both directions** through the cloud.",
      "",
      "It ships behind a switch that is **off for everyone by default**, so there is no change to your current station. Multi-account operators: reach out before enabling.",
      "",
      "_Local-first as always: the studio machine runs the audio; the cloud is the sync hub._",
    ].join("\n"),
  },
  {
    tag: "v4.4.9",
    name: "v4.4.9 — Operate a station you're given access to, with its music",
    body: [
      "**Builds on v4.4.8.** A program director operating another account's station on their own machine can now **play that station's music library**, not just edit its programming — the audio streams down on demand under their membership.",
      "",
      "Still behind the same **default-off** switch, so there's no change to your station unless you're a multi-account operator who turns it on.",
      "",
      "_Local-first as always: the studio machine runs the audio; the cloud is the sync hub._",
    ].join("\n"),
  },
];

function token() {
  const out = execSync("git credential fill", { input: "protocol=https\nhost=github.com\n\n" }).toString();
  const m = out.match(/password=(.+)/);
  if (!m) throw new Error("no token from git credential");
  return m[1].trim();
}
function api(method, path, tok, payload) {
  return new Promise((resolve, reject) => {
    const data = payload ? JSON.stringify(payload) : null;
    const req = https.request(
      { hostname: "api.github.com", path, method,
        headers: { "User-Agent": "ether-release", Authorization: `Bearer ${tok}`,
          Accept: "application/vnd.github+json", ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}) } },
      res => { let b = ""; res.on("data", c => b += c); res.on("end", () => resolve({ status: res.statusCode, body: b })); }
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const tok = token();
  for (const rel of RELEASES) {
    let id = null;
    for (let i = 0; i < 60; i++) {   // up to ~30 min
      const r = await api("GET", `/repos/${REPO}/releases/tags/${rel.tag}`, tok);
      if (r.status === 200) { id = JSON.parse(r.body).id; break; }
      console.log(`[${rel.tag}] not published yet (HTTP ${r.status}) — waiting…`);
      await sleep(30000);
    }
    if (!id) { console.error(`[${rel.tag}] never appeared — skipping`); continue; }
    const patch = await api("PATCH", `/repos/${REPO}/releases/${id}`, tok, { name: rel.name, body: rel.body });
    console.log(`[${rel.tag}] PATCH ${patch.status} → ${patch.status === 200 ? "notes posted" : patch.body.slice(0, 200)}`);
  }
  console.log("done.");
})().catch(e => { console.error("poster error:", e.message); process.exitCode = 1; });
