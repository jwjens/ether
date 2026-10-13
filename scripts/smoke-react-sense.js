// scripts/smoke-react-sense.js — the renderer sense names the component and the script behind a slow click (2026-10-12).
//
// docs/perf-pass-round2-2026-10-12.md §3. Bundles the REAL src/lib/perfSense.ts with the same two build settings as
// vite.config.ts (react-dom → react-dom/profiling, keepNames) around a known tree, opens it in Electron (Chromium), clicks
// a real button (OS-level input event), and reads the report the window would send to main.
// PASS = the slow commit is broken down with SlowList on top (~60 ms) and the memoised Static absent; the long frame
// is reported (length + render/layout split); the click's input timing is there.
//   npx electron scripts/smoke-react-sense.js
"use strict";
const { app, BrowserWindow } = require("electron");
const path = require("path"), fs = require("fs"), os = require("os");
const ROOT = path.join(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "react-sense-"));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  OK  ", m); } else { fail++; console.log("  FAIL", m); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

app.whenReady().then(async () => {
  try {
    const out = path.join(TMP, "page.js");
    // Exactly vite.config.ts's alias: the bare "react-dom" (which react-dom/client requires) → react-dom/profiling.
    const profiling = { name: "react-dom-profiling", setup(b) {
      b.onResolve({ filter: /^react-dom$/ }, () => ({ path: require.resolve("react-dom/profiling", { paths: [ROOT] }) }));
    } };
    await require(path.join(ROOT, "node_modules", "esbuild")).build({
      entryPoints: [path.join(__dirname, "react-sense", "entry.tsx")], bundle: true, format: "iife", platform: "browser",
      outfile: out, logLevel: "error", jsx: "automatic", nodePaths: [path.join(ROOT, "node_modules")],
      plugins: [profiling], keepNames: true, minify: true,
      define: { "process.env.NODE_ENV": '"production"' },
    });
    fs.writeFileSync(path.join(TMP, "page.html"), `<!doctype html><html><body style="margin:0"><div id="root"></div><script src="page.js"></script></body></html>`);
    const w = new BrowserWindow({ width: 400, height: 300, x: -4000, y: 0, show: false, focusable: false, skipTaskbar: true,
      // webSecurity:false as Ether's own windows (electron/main.js createWindow) — a file:// page is otherwise an opaque
      // origin and Chromium withholds the script attribution of its long frames.
      webPreferences: { contextIsolation: false, backgroundThrottling: false, webSecurity: false } });
    w.showInactive();
    await w.loadFile(path.join(TMP, "page.html"));
    await sleep(500);
    for (let i = 0; i < 2; i++) {
      for (const type of ["mouseDown", "mouseUp"]) w.webContents.sendInputEvent({ type, x: 100, y: 30, button: "left", clickCount: 1 });
      await sleep(400);
    }
    await sleep(5600);   // the sense reports every 5 s
    const reports = await w.webContents.executeJavaScript("window.__reports");
    w.destroy();
    const commits = reports.flatMap(r => r.commits || []), frames = reports.flatMap(r => r.frames || []), inputs = reports.flatMap(r => r.inputs || []);
    console.log("  ..   commits:", JSON.stringify(commits));
    console.log("  ..   frames:", JSON.stringify(frames.map(f => ({ ms: f.ms, scripts: f.scripts }))));
    const update = commits.find(c => c.phase === "update" && c.ms >= 50);
    ok(!!update, `the click's commit is reported as slow (${update && update.ms} ms)`);
    ok(update && update.top[0] && update.top[0].name === "SlowList" && update.top[0].ms >= 50, `…and broken down by component: ${update && update.top.map(t => `${t.name} ${t.ms} ms`).join(", ")}`);
    ok(update && !update.top.some(t => t.name === "Static"), "the memoised component that did not re-render is not blamed");
    // Script attribution of a long frame is WITHHELD by Chromium for file:// pages (measured 2026-10-12: the same page over
    // http names "BUTTON#b.onclick → onGo"; over file://, even with webSecurity:false, scripts is empty). Ether loads from
    // file://, so the React commit breakdown above is what names the work; the frame gives its length and its
    // style/layout/paint split.
    ok(frames.some(f => f.ms >= 50 && typeof f.renderMs === "number" && typeof f.layoutMs === "number"), `the long frame is reported with its render/layout split (${frames.map(f => `${f.ms} ms, render ${f.renderMs}, layout ${f.layoutMs}`).join("; ")})`);
    ok(inputs.some(x => /pointer|mouse|click/.test(x.type)), `the click's input timing is reported (${inputs.map(x => `${x.type} ${x.dur} ms`).join(", ")})`);
  } catch (e) { console.error(e); fail++; }
  console.log(`\n${fail ? "FAILED" : "ALL PASS"}  (${pass} passed, ${fail} failed)`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  app.exit(fail ? 1 : 0);
});
