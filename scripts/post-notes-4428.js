// One-shot poller: wait for CI to publish the v4.4.28 GitHub release, then
// PATCH operator-facing name + body. Safe to delete after use. Token via git credential.
const https = require("https");
const { execSync } = require("child_process");

const REPO = "jwjens/ether";
const TAG = "v4.4.28";
const NAME = "v4.4.28 — Station switching sticks, and each station's calendar shows only its own programming";
const BODY = [
  "**Switching stations sticks.** The station you switch to now stays the active one — background sync no longer quietly reverts you to a different station. Pick a station and it holds, on every machine.",
  "",
  "**The calendar follows the station you're on — live.** Each station's calendar now shows only that station's scheduled songs, with that station's show names and colors, and it updates the moment you switch stations. No more closing and reopening the calendar to make it catch up, and opening a day reflects the current station too.",
  "",
  "**No more cross-station bleed.** A station's calendar will no longer display songs that belong to another station's library — for example Christmas tracks showing up on a Halloween station — even after programming has been re-organized between stations.",
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
