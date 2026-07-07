// READ-ONLY: confirm CI published a release for a tag and list its installer assets. No writes.
// Token via git credential (same one `git push` uses). Usage: node scripts/check-release.js [tag]
const https = require("https");
const { execSync } = require("child_process");

const REPO = "jwjens/ether";
const TAG = process.argv[2] || "v4.4.37";

function token() {
  const out = execSync("git credential fill", { input: "protocol=https\nhost=github.com\n\n" }).toString();
  const m = out.match(/password=(.+)/);
  if (!m) throw new Error("no token from git credential");
  return m[1].trim();
}
function api(method, path, tok) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: "api.github.com", path, method,
      headers: { "User-Agent": "ether-release", Authorization: `Bearer ${tok}`, Accept: "application/vnd.github+json" } },
      res => { let b = ""; res.on("data", c => b += c); res.on("end", () => resolve({ status: res.statusCode, body: b })); });
    req.on("error", reject); req.end();
  });
}
(async () => {
  const tok = token();
  const r = await api("GET", `/repos/${REPO}/releases/tags/${TAG}`, tok);
  if (r.status === 404) { console.log(`${TAG}: NO RELEASE YET — CI still building, or the build failed (no release published).`); return; }
  if (r.status >= 300) { console.log(`${TAG}: API ${r.status} — ${r.body.slice(0, 200)}`); return; }
  const rel = JSON.parse(r.body);
  const assets = rel.assets || [];
  console.log(`${TAG}: RELEASE EXISTS  id=${rel.id}  draft=${rel.draft}  prerelease=${rel.prerelease}`);
  console.log(`  name: ${JSON.stringify(rel.name)}`);
  console.log(`  body: ${rel.body ? rel.body.slice(0, 60).replace(/\n/g, " ") + "…" : "(EMPTY — needs operator notes)"}`);
  const installers = assets.filter(a => /\.(exe|dmg|AppImage|zip|blockmap|yml)$/i.test(a.name));
  console.log(`  assets (${assets.length}):`);
  for (const a of assets) console.log(`    ${a.name}  ${Math.round(a.size / 1048576)}MB  state=${a.state}  ${a.download_count}dl`);
  const hasInstaller = installers.some(a => /\.(exe|dmg|AppImage)$/i.test(a.name) && a.state === "uploaded");
  console.log(hasInstaller ? "  → INSTALLER PRESENT + uploaded ✅ downloadable" : "  → NO uploaded installer asset yet (build may still be uploading, or failed)");
})().catch(e => { console.error("ERR", e.message); process.exit(1); });
