// scripts/rta-screens/capture.js — render OLD vs NEW spectrum (entry.tsx) and save the screenshot for the doc.
//
//   1. cd native && ETHER_WRITE_RTA_SCREENS=<fixture.json> cargo test --release --lib write_the_rta_screens_fixture
//   2. npx electron scripts/rta-screens/capture.js <fixture.json> <out.png>
//
// Bundles entry.tsx with esbuild (the fixture inlined), loads it in an offscreen window with the app's own CSS
// (src/index.css, minus the Tailwind and font directives), and writes the capture. Diagnostic tooling: nothing here
// runs in the product.
"use strict";
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");

const [fixture, outPng] = process.argv.slice(2).filter(a => !a.startsWith("--"));
if (!fixture || !outPng) { console.error("usage: electron capture.js <fixture.json> <out.png>"); process.exit(2); }

app.whenReady().then(async () => {
  const root = path.join(__dirname, "..", "..");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rta-screens-"));
  await require("esbuild").build({
    entryPoints: [path.join(__dirname, "entry.tsx")], bundle: true, outfile: path.join(tmp, "page.js"),
    jsx: "automatic", format: "iife", loader: { ".tsx": "tsx", ".ts": "ts" }, logLevel: "error",
    define: { FIXTURE: fs.readFileSync(fixture, "utf8"), "process.env.NODE_ENV": '"production"',
              "import.meta.env": '{"DEV":false,"PROD":true,"MODE":"production"}' },
  });
  const css = fs.readFileSync(path.join(root, "src", "index.css"), "utf8").split("\n").filter(l => !/^@tailwind|^@import/.test(l)).join("\n");
  fs.writeFileSync(path.join(tmp, "index.html"),
    `<!doctype html><html><head><meta charset="utf-8"><style>${css}\nbody{margin:0;background:var(--bg-primary)}</style></head>` +
    `<body><div id="root"></div><script src="page.js"></script></body></html>`);
  const win = new BrowserWindow({ show: false, width: 1504, height: 1200, webPreferences: { offscreen: true } });
  win.webContents.on("console-message", (e) => { if (e.level === "error") console.error("[page]", e.message); });
  await win.loadFile(path.join(tmp, "index.html"));
  await new Promise(r => setTimeout(r, 1500));
  const h = await win.webContents.executeJavaScript("document.body.scrollHeight");
  win.setContentSize(1504, Math.min(4000, h + 4));
  await new Promise(r => setTimeout(r, 800));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(outPng, img.toPNG());
  console.log(`[rta-screens] ${outPng} (${img.getSize().width}×${img.getSize().height})`);
  app.quit();
}).catch(e => { console.error(e); process.exit(1); });
