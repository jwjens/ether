// Program Log slice 3 — the pop-out path, as shipped in electron/main.js, with a fake BrowserWindow.
// Run:  node scripts/smoke-programlog-popout.js   (exit 0 = pass; plain node is fine — no sqlite here)
//
// openPopoutWindow / loadPopoutBounds / savePopoutBounds / boundsOnScreen are read OUT OF main.js
// (brace-matched) and evaluated with: an in-memory fs (the bounds file), a fake electron.screen (one
// or two displays), a fake BrowserWindow that records its constructor options and replays
// moved/resized. Proves: the Program Log opens through this path with POPOUT_SIZES.programlog, a
// second open REUSES the window (show+focus, no second BrowserWindow), a move/resize is persisted
// under "programlog", the next open restores those bounds, and off-screen bounds are ignored.
"use strict";
const path = require("path");
const fs = require("fs");
const root = path.join(__dirname, "..");

let pass = 0, fail = 0;
function check(name, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}` + (cond ? "" : `  — ${detail || ""}`));
  cond ? pass++ : fail++;
}

const main = fs.readFileSync(path.join(root, "electron", "main.js"), "utf8");
function braceBlock(startNeedle) {
  const i = main.indexOf(startNeedle);
  if (i < 0) throw new Error("not found in main.js: " + startNeedle);
  const eol = main.indexOf("\n", i), arrow = main.indexOf("=>", i);
  let depth = 0, j = main.indexOf("{", arrow > -1 && arrow < eol ? arrow : i);
  for (; j < main.length; j++) {
    const c = main[j];
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) break; }
  }
  let end = j + 1;
  if (main.startsWith(");", end)) end += 2;
  return main.slice(i, end);
}
const sizesM = main.match(/const POPOUT_SIZES = \{[\s\S]*?\n\};/);
check("main.js: POPOUT_SIZES found and carries programlog", !!sizesM && /"programlog":\s*\{ width: \d+, height: \d+ \}/.test(sizesM[0]));
check("main.js: the Schedule menu's Program Log entry goes through menuNav(\"nav:programlog\", \"programlog\")", /label: "Program Log",\s*click: \(\) => menuNav\("nav:programlog", "programlog"\)/.test(main));
const appTsx = fs.readFileSync(path.join(root, "src", "App.tsx"), "utf8");
check("App.tsx: nav:programlog opens the pop-out (not the Schedule Manager pane)", /if \(cmd === "nav:programlog"\) \{ openPopout\("programlog"\); return; \}/.test(appTsx) && !/nav:programlog[\s\S]{0,400}setPanel\("schedulehub"\)/.test(appTsx));
check("App.tsx: the hamburger's Program Log entry opens pop-out panel programlog", /label: "Program Log",\s*panel: "programlog"/.test(appTsx));
check("App.tsx: PROGRAM LOG is a dock tab and the dock renders <ProgramLog embedded>", /label: "PROGRAM LOG"/.test(appTsx) && /progPanel === "programlog"\s*\?\s*<ProgramLog embedded onClose=\{onCloseDock\} \/>/.test(appTsx));
const popTsx = fs.readFileSync(path.join(root, "src", "components", "PopoutRenderer.tsx"), "utf8");
check("PopoutRenderer.tsx: case programlog mounts <ProgramLog onClose={window.close}> (+ the progress bar since slice 5)", /case "programlog":[\s\S]{0,400}content = <><ProgramLog onClose=\{\(\) => window\.close\(\)\} \/><GenerateProgressBar \/><\/>;/.test(popTsx));

// ── sandbox ──
const src = [
  sizesM[0],
  'const POPOUT_BOUNDS_FILE = path.join(app.getPath("userData"), "popout-bounds.json");',
  braceBlock("function loadPopoutBounds("),
  braceBlock("function savePopoutBounds("),
  braceBlock("function boundsOnScreen("),
  braceBlock("function openPopoutWindow("),
  "return { openPopoutWindow, loadPopoutBounds, savePopoutBounds, boundsOnScreen, POPOUT_SIZES };",
].join("\n");

const files = {};
const fakeFs = {
  readFileSync: (p) => { if (!(p in files)) { const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; } return files[p]; },
  writeFileSync: (p, data) => { files[p] = String(data); },
};
let displays = [{ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }];
const fakeElectron = { screen: { getPrimaryDisplay: () => displays[0], getAllDisplays: () => displays } };
const windows = [];
class FakeBrowserWindow {
  constructor(opts) {
    this.opts = opts; this.title = opts.title; this.bounds = { x: opts.x, y: opts.y, width: opts.width, height: opts.height };
    this.handlers = {}; this.shown = 0; this.focused = 0; this.loaded = null; this.destroyed = false;
    this.webContents = { on: () => {}, send: () => {}, isDestroyed: () => false, id: windows.length + 1 };
    windows.push(this);
  }
  static getAllWindows() { return windows.filter(w => !w.destroyed); }
  getTitle() { return this.title; }
  show() { this.shown++; } focus() { this.focused++; }
  on(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); }
  once(ev, fn) { this.on(ev, fn); }
  getBounds() { return { ...this.bounds }; }
  isDestroyed() { return this.destroyed; }
  loadURL(u) { this.loaded = u; } loadFile(f, o) { this.loaded = f + "#" + (o && o.hash); }
  // test helpers
  moveTo(x, y, w, h) { this.bounds = { x, y, width: w, height: h }; (this.handlers.moved || []).forEach(f => f()); (this.handlers.resized || []).forEach(f => f()); }
  close() { this.destroyed = true; }
}
const api = new Function("path", "app", "require", "BrowserWindow", "attachPopoutDebugBridge", "isDev", "VITE_DEV_URL", "__dirname", src)(
  path, { getPath: () => "C:/fake/userData" },
  (m) => (m === "fs" ? fakeFs : m === "electron" ? fakeElectron : require(m)),
  FakeBrowserWindow, () => {}, true, "http://127.0.0.1:1420/", path.join(root, "electron")
);

// (1) first open: POPOUT_SIZES.programlog, dev URL hash, title tag
const w1 = api.openPopoutWindow("programlog");
const size = api.POPOUT_SIZES["programlog"];
check("1 · first open creates ONE BrowserWindow titled popout:programlog", windows.length === 1 && w1.title === "popout:programlog");
check("1 · sized from POPOUT_SIZES.programlog (clamped to the single work area)", w1.opts.width === Math.min(size.width, Math.max(560, Math.round(1920 * 0.58))) && w1.opts.height === Math.min(size.height, Math.max(420, 1040 - 64 - 40)), JSON.stringify(w1.opts));
check("1 · one monitor: placed right of centre, below the header strip (the live screen stays visible)", w1.opts.x + w1.opts.width <= 1920 && w1.opts.x > 1920 / 3 && w1.opts.y >= 64, JSON.stringify({ x: w1.opts.x, y: w1.opts.y }));
check("1 · loads the dev URL with #popout/programlog (PopoutRenderer's route)", w1.loaded === "http://127.0.0.1:1420/#popout/programlog", w1.loaded);
check("1 · no bounds file yet (nothing persisted until the user moves/resizes)", Object.keys(files).length === 0);

// (2) second open while it exists: reuse
const w2 = api.openPopoutWindow("programlog");
check("2 · a second open REUSES the window: show+focus, still ONE BrowserWindow", w2 === w1 && windows.length === 1 && w1.shown === 1 && w1.focused === 1);

// (3) move/resize → persisted under "programlog"
w1.moveTo(300, 200, 1000, 700);
const saved = JSON.parse(files["C:\\fake\\userData\\popout-bounds.json"] || files[path.join("C:/fake/userData", "popout-bounds.json")] || "{}");
check("3 · moved/resized → popout-bounds.json carries programlog {300,200,1000,700}", saved.programlog && saved.programlog.x === 300 && saved.programlog.y === 200 && saved.programlog.width === 1000 && saved.programlog.height === 700, JSON.stringify(saved));
check("3 · loadPopoutBounds reads it back", JSON.stringify(api.loadPopoutBounds().programlog) === JSON.stringify({ x: 300, y: 200, width: 1000, height: 700 }));

// (4) close, reopen → restored bounds
w1.close();
const w3 = api.openPopoutWindow("programlog");
check("4 · after close, reopen creates a NEW window with the saved bounds", w3 !== w1 && windows.filter(w => !w.destroyed).length === 1 && w3.opts.x === 300 && w3.opts.y === 200 && w3.opts.width === 1000 && w3.opts.height === 700, JSON.stringify(w3.opts));
check("4 · the other panels' bounds are untouched by programlog's save", Object.keys(api.loadPopoutBounds()).join(",") === "programlog");

// (5) saved bounds that no longer overlap any display are ignored → default placement again
w3.close();
files[Object.keys(files)[0]] = JSON.stringify({ programlog: { x: 5000, y: 5000, width: 800, height: 600 } });
check("5 · boundsOnScreen rejects an off-screen rectangle", api.boundsOnScreen({ x: 5000, y: 5000, width: 800, height: 600 }) === false && api.boundsOnScreen({ x: 300, y: 200, width: 1000, height: 700 }) === true);
const w4 = api.openPopoutWindow("programlog");
check("5 · reopen with off-screen saved bounds falls back to the default placement (on screen)", w4.opts.x + w4.opts.width <= 1920 && w4.opts.y + w4.opts.height <= 1040 && w4.opts.x >= 0 && w4.opts.y >= 0, JSON.stringify(w4.opts));
w4.close();

// (6) two displays: a first open lands on the secondary, 60px in
displays = [{ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }, { id: 2, workArea: { x: 1920, y: 0, width: 2560, height: 1400 } }];
delete files[Object.keys(files)[0]];
const w5 = api.openPopoutWindow("programlog");
check("6 · with a second monitor a first open lands there (x = secondary + 60) at full POPOUT_SIZES", w5.opts.x === 1980 && w5.opts.y === 60 && w5.opts.width === size.width && w5.opts.height === size.height, JSON.stringify(w5.opts));
w5.close();

// (7) a different panel's window does not satisfy programlog's dedupe
api.openPopoutWindow("logs");
const w6 = api.openPopoutWindow("programlog");
check("7 · dedupe is per panel: a Play Log window open does not stand in for the Program Log", w6.title === "popout:programlog" && windows.filter(w => !w.destroyed).length === 2);

// ── slice 5 — the Calendar is gone; every door points at the Program Log; no handler was deleted ──
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]);
const srcFiles = walk(path.join(root, "src")).filter(f => /\.(tsx?|js)$/.test(f));
const mentions = srcFiles.filter(f => /BroadcastCalendar/.test(fs.readFileSync(f, "utf8")));
check("5 · BroadcastCalendar.tsx is gone and nothing under src/ names it", !fs.existsSync(path.join(root, "src", "components", "BroadcastCalendar.tsx")) && mentions.length === 0, mentions.join(", "));
check("5 · App.tsx: no CALENDAR tab, no calendar dock case, no calendar hamburger entry, no calendar workspace route", !/label: "CALENDAR"/.test(appTsx) && !/progPanel === "calendar"/.test(appTsx) && !/panel: "calendar"/.test(appTsx) && !/panel === "calendar"/.test(appTsx) && !/"calendar" \|/.test(appTsx));
check("5 · App.tsx: ether:open-programlog docks the Program Log (the old ether:open-calendar is gone)", /window\.addEventListener\("ether:open-programlog", toProgramLog\)/.test(appTsx) && /const toProgramLog = \(\) => \{ setPanel\("live"\); setShowCarts\(false\); setProgPanel\("programlog"\); \}/.test(appTsx) && !/open-calendar/.test(appTsx));
check("5 · App.tsx: the 'go build it' jump docks the Program Log", /setProgPanel\("programlog"\);\s*\/\/ dock the Program Log — Fill Day builds it/.test(appTsx));
const health = fs.readFileSync(path.join(root, "src", "components", "health", "HealthDashboard.tsx"), "utf8");
check("5 · Health Monitor's Runway card opens the Program Log", /openPanel\("programlog"\)/.test(health) && !/openPanel\("calendar"\)/.test(health) && /Click to open the Program Log/.test(health));
check("5 · PopoutRenderer: no calendar case/title; the programlog pop-out carries the progress bar", !/case "calendar"/.test(popTsx) && !/"calendar":\s*"Calendar"/.test(popTsx) && /<ProgramLog onClose=\{\(\) => window\.close\(\)\} \/><GenerateProgressBar \/>/.test(popTsx));
const ws = fs.readFileSync(path.join(root, "src", "components", "schedule", "ScheduleWorkspace.tsx"), "utf8");
check("5 · Schedule Manager's log pane hosts <ProgramLog embedded> (the ninth door the proposal did not list)", /<ProgramLog embedded key=\{hub\.revision\} \/>/.test(ws) && !/BroadcastCalendar/.test(ws));
check("5 · main.js: no calendar pop-out size/title left", !/"calendar":\s*\{ width/.test(main) && !/"calendar":\s*"Calendar"/.test(main));
const handlersKept = ["schedule:get", "schedule:generateDay", "schedule:generateDays", "schedule:generateCancel", "schedule:clearDay", "schedule:moveRow", "schedule:editRowFields", "schedule:deleteRow", "schedule:checkRow", "schedule:setRowSource", "schedule:insertVoiceTrack", "schedule:playhead-view"];
const missingH = handlersKept.filter(h => !main.includes(`ipcMain.handle('${h}'`) && !main.includes(`ipcMain.handle("${h}"`));
check("5 · NO IPC handler was deleted — all " + handlersKept.length + " schedule:* handlers still registered", missingH.length === 0, "missing: " + missingH.join(", "));
const userFacing = srcFiles.map(f => [f, fs.readFileSync(f, "utf8")]).flatMap(([f, t]) => t.split("\n").map((l, i) => [f, i + 1, l])).filter(([, , l]) => /Calendar/.test(l) && !/^\s*(\/\/|\*|\{\/\*)/.test(l) && !/calendar re-cue|CalendarDays|calendarDay|since-retired Calendar/.test(l));
check("5 · no user-facing string in src/ still points the operator at 'the Calendar'", userFacing.length === 0, userFacing.map(([f, i]) => path.relative(root, f) + ":" + i).join(", "));

console.log(`=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
