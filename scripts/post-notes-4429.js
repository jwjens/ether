// One-shot poller: wait for CI to publish the v4.4.29 GitHub release, then
// PATCH operator-facing name + body. Safe to delete after use. Token via git credential.
const https = require("https");
const { execSync } = require("child_process");

const REPO = "jwjens/ether";
const TAG = "v4.4.29";
const NAME = "v4.4.29 — Schedule spots at set times on the hour, with music around them";
const BODY = [
  "**Timed spot breaks now live on your clocks.** Each clock has a Timed Spot Breaks grid: set a break at any minute past the hour (:00, :20, :40 — whatever you choose), pick which spot category it pulls from, and how many spots it plays. Program it once per clock and every hour that clock runs airs those breaks.",
  "",
  "**Spots land on time, and music fills around them.** A break set at the top of the hour airs exactly at :00; breaks at other minutes drop at the closest song boundary to that time, so a song is never cut off mid-play. You no longer count songs to fill the hour — music fills the time between your breaks automatically.",
  "",
  "**Group your spots into categories.** In Spots & Promos you can organize commercials, promos and IDs into categories (for example Local Sponsors or Top-of-Hour IDs), assign spots to them, and point each break at the category it should pull from.",
  "",
  "**A clearer clock editor.** Adding spots to a clock is now a single, obvious step, and dragging elements to reorder is smoother, with a clear line showing where a segment will land.",
  "",
  "_Local-first as always: the studio machine runs the audio; the cloud is the sync hub. After updating, fully close and reopen Ether so the audio engine reloads._",
].join("\n");

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

(async () => {
  const tok = token();
  for (let i = 1; i <= 60; i++) {
    const r = await api("GET", `/repos/${REPO}/releases/tags/${TAG}`, tok);
    if (r.status === 200) {
      const id = JSON.parse(r.body).id;
      const p = await api("PATCH", `/repos/${REPO}/releases/${id}`, tok, { name: NAME, body: BODY, draft: false });
      console.log(p.status < 300 ? `OK posted to ${id} — https://github.com/${REPO}/releases/tag/${TAG}` : `PATCH failed ${p.status}: ${p.body}`);
      return;
    }
    console.log(`[try ${i}] ${TAG} not created yet; waiting…`);
    await new Promise(res => setTimeout(res, 30000));
  }
  console.log("gave up waiting for release");
})().catch(e => { console.error(e.message); process.exit(1); });
