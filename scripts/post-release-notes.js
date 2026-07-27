// One-shot poller: wait for CI to publish the v4.3.75 GitHub release, then
// PATCH operator-facing name + body. Deleted after use. Token via git credential.
const https = require("https");
const { execSync } = require("child_process");

const REPO = "jwjens/ether";
const TAG = "v4.4.41";
const NAME = "v4.4.41 — Critical: the audio engine now starts reliably in installed builds";
const BODY = [
  "**Critical stability fix.** Since ~4.4.37, packaged installs shipped with a missing runtime file that prevented the out-of-process audio engine from starting — so affected machines silently fell back to a limited single-station mode, which is the root cause of the recurring dead-air/stall reports on multi-station setups.",
  "",
  "This release makes the engine start reliably (the missing file now ships, and engine logging can never take the engine down), and adds a startup self-check so a build that can't start the engine can't pass release. **Install this on every machine.**",
  "",
  "_Note: on a fresh install the very first launch may briefly use the fallback while the engine stages; a second launch runs fully. Being tracked for a follow-up._",
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
  for (let i = 1; i <= 40; i++) {
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
