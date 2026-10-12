// scripts/smoke-feed-no-jump.js — a new event never moves the screen (2026-10-12), in a real Chromium.
//
// docs/health-monitor-jump-and-freeze-2026-10-12.md. Jeff: "whenever something starts playing or is activated, the
// Health Monitor jumps to the bottom of the screen, so Jeff can't use the faders." Rule: "New events appear without
// changing its position or the operator's scroll position (if the operator is scrolled up, stay there; at most show a
// 'new events' badge)."
//
// Bundles the REAL Master Out console (src/components/MasterOutput.tsx LiveConsole) into a page laid out like Master Out —
// the faders at the top of a scrolling column, the console at its bottom — and opens it in an Electron window (Chromium).
// Then it logs deck events into it, as a track start does, and reads the scroll positions.
//   CURRENT: the column never moves (faders stay on screen); the console follows only while at its bottom; scrolled up,
//            it stays where the operator is reading and shows "N new events".
//   CONTROL: the same page built from the pre-fix MasterOutput.tsx (git HEAD~… — the commit before this fix) moves the
//            column, i.e. reproduces Jeff's report.
//   npx electron scripts/smoke-feed-no-jump.js [--control <git-rev>]
"use strict";
const { app, BrowserWindow } = require("electron");
const path = require("path"), fs = require("fs"), os = require("os"), cp = require("child_process");
const ROOT = path.join(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "feed-no-jump-"));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  OK  ", m); } else { fail++; console.log("  FAIL", m); } };

function build(tag, masterOutputPath) {
  const out = path.join(TMP, `${tag}.js`);
  require(path.join(ROOT, "node_modules", "esbuild")).buildSync({
    entryPoints: [path.join(__dirname, "feed-no-jump", "entry.tsx")], bundle: true, format: "iife", platform: "browser",
    outfile: out, logLevel: "error", jsx: "automatic", nodePaths: [path.join(ROOT, "node_modules")],
    alias: { "__MASTER_OUTPUT__": masterOutputPath },
    define: { "import.meta.env.DEV": "false", "import.meta.env": "{}", "process.env.NODE_ENV": '"production"' },
    loader: { ".css": "empty", ".png": "empty", ".svg": "empty", ".woff2": "empty" },
  });
  const html = path.join(TMP, `${tag}.html`);
  fs.writeFileSync(html, `<!doctype html><html><body style="margin:0;background:#111"><div id="root"></div><script src="${tag}.js"></script></body></html>`);
  return html;
}

async function run(tag, html) {
  // Painted (smooth scrolling needs real frames) but off every screen and never focused — it must not cover or take focus
  // from a live board on the machine running it.
  const w = new BrowserWindow({ width: 420, height: 700, x: -4000, y: 0, show: false, focusable: false, skipTaskbar: true,
    webPreferences: { contextIsolation: false, backgroundThrottling: false } });
  w.showInactive();
  // A second page load in the same run can report ERR_FAILED while the page is in fact up; the column check below decides.
  try { await w.loadFile(html); } catch (e) { console.log(`  ..   ${tag}: load reported ${e && e.code} — checking the page itself`); await new Promise(r => setTimeout(r, 800)); }
  const js = (code) => w.webContents.executeJavaScript(code);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  await sleep(300);
  const read = () => js(`(() => { const c = document.getElementById("column"); const f = [...c.querySelectorAll("div")].find(d => getComputedStyle(d).overflowY === "auto" && d !== c);
    const badge = [...document.querySelectorAll("button")].find(b => /new event/.test(b.textContent)); return { column: c.scrollTop, feed: f ? f.scrollTop : null, feedMax: f ? f.scrollHeight - f.clientHeight : null, badge: badge ? badge.textContent : null }; })()`);
  // 1 · events arrive (track starts) — the column must not move.
  await js(`__log(60)`); await sleep(600);
  const a = await read();
  // 2 · the operator scrolls the console up to read; more events arrive.
  await js(`(() => { const c = document.getElementById("column"); const f = [...c.querySelectorAll("div")].find(d => getComputedStyle(d).overflowY === "auto" && d !== c); f.scrollTop = 40; f.dispatchEvent(new Event("scroll")); })()`);
  await sleep(100);
  await js(`__log(5, "more")`); await sleep(600);
  const b = await read();
  w.destroy();
  return { a, b };
}

app.on("window-all-closed", () => { /* stay up between the two pages; app.exit() ends the run */ });
app.whenReady().then(async () => {
  try {
    const cur = await run("current", build("current", path.join(ROOT, "src", "components", "MasterOutput.tsx")));
    console.log("  ..   current:", JSON.stringify(cur));
    ok(cur.a.column === 0, `events never move the Master Out column (column scrollTop ${cur.a.column}) — the faders stay on screen`);
    ok(cur.a.feed != null && cur.a.feedMax != null && Math.abs(cur.a.feed - cur.a.feedMax) <= 2, `at its bottom, the console follows new lines in its OWN box (${cur.a.feed}/${cur.a.feedMax})`);
    ok(cur.b.feed === 40 && cur.b.column === 0, `scrolled up, the console stays where the operator is reading (feed ${cur.b.feed}, column ${cur.b.column})`);
    ok(/^5 new events/.test(cur.b.badge || ""), `…and says what arrived: "${cur.b.badge}"`);
    const ri = process.argv.indexOf("--control");
    if (ri > 0) {
      const rev = process.argv[ri + 1] || "HEAD";
      const ctlRoot = path.join(TMP, "control");
      fs.mkdirSync(ctlRoot);
      // The pre-fix tree's MasterOutput imports its siblings by relative path: check the whole src/ out at that revision.
      cp.execSync(`git archive ${rev} src | tar -x -C "${ctlRoot.replace(/\\/g, "/")}"`, { cwd: ROOT, shell: "bash" });
      const mo = path.join(ctlRoot, "src", "components", "MasterOutput.tsx");
      // The pre-fix file did not export its console; the harness exports it (nothing else in the copy is touched).
      fs.writeFileSync(mo, fs.readFileSync(mo, "utf8").replace(/^function LiveConsole\(/m, "export function LiveConsole("));
      const ctl = await run("control", build("control", mo));
      console.log("  ..   control:", JSON.stringify(ctl));
      ok(ctl.a.column > 0, `CONTROL (${rev}): the pre-fix console drags the whole column down (column scrollTop ${ctl.a.column}) — Jeff's report reproduced`);
    }
  } catch (e) { console.error(e); fail++; }
  console.log(`\n${fail ? "FAILED" : "ALL PASS"}  (${pass} passed, ${fail} failed)`);
  app.exit(fail ? 1 : 0);
});
