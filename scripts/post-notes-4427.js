// One-shot poller: wait for CI to publish the v4.4.27 GitHub release, then
// PATCH operator-facing name + body. Safe to delete after use. Token via git credential.
const https = require("https");
const { execSync } = require("child_process");

const REPO = "jwjens/ether";
const TAG = "v4.4.27";
const NAME = "v4.4.27 — Sync survives a cloud restore, and your data files under the right license";
const BODY = [
  "**Sync keeps working through a cloud restore.** When Ether reopens or swaps its database connection — for example right after restoring your station from a cloud backup — sync operations now re-resolve the live connection every time instead of failing with “database connection is not open.” Your station keeps syncing across the swap, no restart required.",
  "",
  "**Your data syncs up under the right license.** When pushing to the cloud, Ether now pins the destination to your signed-in account’s license instead of picking the first license it happens to find. This prevents one account’s programming and library from being filed under a different owner.",
  "",
  "**Plan and tier surfaces updated.** Subscription and onboarding screens reflect your account’s plan, with cloud-backup handling updated to match.",
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
