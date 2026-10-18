// Today's hard-coded pages, read from the tree — the four lists S5 freezes (docs/screen-builder-design-2026-10-18.md
// §3 S5): the dashboard's `type Panel` union, the pop-out router's cases, the ☰ list, and every `new BrowserWindow(`
// site in electron/. Static on purpose: it runs in CI with no Electron.
import fs from "fs";
import path from "path";

export const ROOT = path.join(__dirname, "..", "..", "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r/g, "");

/** Source with comments blanked (line count kept), so prose that names a page is not a page. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " "))
    .split("\n").map(l => l.replace(/(^|\s)\/\/.*$/, "")).join("\n");
}

/** The members of `type Panel = "live" | ...;` in src/App.tsx. */
export function panelUnion(): string[] {
  const m = read("src/App.tsx").match(/type Panel = ([^;]+);/);
  if (!m) throw new Error("type Panel not found in src/App.tsx — has it moved?");
  return [...m[1].matchAll(/"([^"]+)"/g)].map(x => x[1]);
}

/** The `case "...":` keys of PopoutRenderer's router. */
export function popoutCases(): string[] {
  return [...code(read("src/components/PopoutRenderer.tsx")).matchAll(/case "([^"]+)":/g)].map(x => x[1]);
}

/** The ☰ entries, parsed exactly as src/lib/drawerDoors.test.ts parses them: "key → panel". */
export function drawerEntries(): string[] {
  const app = read("src/App.tsx");
  const anchor = app.indexOf("ONE LIST, AND EVERY ENTRY IS A WINDOW");
  if (anchor < 0) throw new Error('the ☰ list anchor "ONE LIST, AND EVERY ENTRY IS A WINDOW" is gone from App.tsx');
  const list = app.slice(anchor, app.indexOf("] as const).map(item =>", anchor));
  return [...list.matchAll(/\{ key: "([^"]+)",\s*emoji: "[^"]*",\s*label: "([^"]+)",\s*panel: "([^"]+)" \}/g)]
    .map(m => `${m[1]} → ${m[3]}`);
}

function jsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules" && e.name !== "tests") out.push(...jsFiles(rel)); }
    else if (/\.(c?js)$/.test(e.name)) out.push(rel);
  }
  return out;
}

/** Every `new BrowserWindow(` in electron/, named "<file>: <enclosing function or ipcMain channel>". */
export function windowSites(): string[] {
  const out: string[] = [];
  for (const f of jsFiles("electron")) {
    const lines = code(read(f)).split("\n");
    lines.forEach((l, i) => {
      if (!l.includes("new BrowserWindow(")) return;
      let owner = "(top level)";
      for (let k = i; k >= 0; k--) {
        const fn = lines[k].match(/function\s+([A-Za-z0-9_$]+)\s*\(/);
        const ipc = lines[k].match(/ipcMain\.(?:handle|on|once)\(\s*["'`]([^"'`]+)["'`]/);
        if (fn) { owner = fn[1]; break; }
        if (ipc) { owner = ipc[1]; break; }
      }
      out.push(`${f}: ${owner}`);
    });
  }
  return out;
}
