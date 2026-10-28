// "Preferences" is called "Settings" everywhere the user sees it (Jeff, 2026-10-28): menus, ☰, buttons, window titles, the
// Patch Bay pointers, help docs and the Links section. Code names (webPreferences, seedDuckPreferences…) and comments are not
// user-facing and are not part of this.
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const ROOT = path.join(__dirname, "..", "..");
const WORD = /(?<![A-Za-z0-9_$])Preferences(?![A-Za-z0-9_$])/;

function files(dir: string, re: RegExp, out: string[] = []): string[] {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, e.name);
    if (e.isDirectory()) { if (!["node_modules", "tests"].includes(e.name)) files(rel, re, out); }
    else if (re.test(e.name) && !/\.test\.|smoke-/.test(e.name)) out.push(rel);
  }
  return out;
}
/** The word outside comments: strip // line comments (not URLs), block comment lines and JSX comments. */
function visible(src: string): string[] {
  const hits: string[] = [];
  let inBlock = false;
  for (const line of src.replace(/\r/g, "").split("\n")) {
    const t = line.trim();
    if (inBlock) { if (t.includes("*/")) inBlock = false; continue; }
    if (t.startsWith("//") || t.startsWith("*")) continue;
    if (t.startsWith("/*")) { if (!t.includes("*/")) inBlock = true; continue; }
    const code = line.replace(/\{\/\*.*?\*\/\}/g, "").replace(/(^|[^:"'`])\/\/.*$/, "$1");
    if (WORD.test(code)) hits.push(line.trim());
  }
  return hits;
}

describe("the app says Settings, never Preferences", () => {
  it("no user-facing \"Preferences\" in the app (renderer, main, engine messages)", () => {
    const found: string[] = [];
    for (const f of [...files("src", /\.(ts|tsx)$/), ...files("electron", /\.(js|cjs)$/), ...files("audiod", /\.js$/)]) {
      for (const h of visible(fs.readFileSync(path.join(ROOT, f), "utf8"))) found.push(`${f}: ${h.slice(0, 120)}`);
    }
    expect(found).toEqual([]);
  });
  it("the native menu item is Settings", () => {
    expect(fs.readFileSync(path.join(ROOT, "electron", "main.js"), "utf8")).toMatch(/\{ label: "Settings", click: \(\) => send\("file:preferences"\) \}/);
  });
  it("no help doc says Preferences (the dated audit records are history and keep their words)", () => {
    const bad = fs.readdirSync(path.join(ROOT, "docs")).filter(f => /^help-.*\.md$/.test(f) && !/^help-audit/.test(f))
      .filter(f => WORD.test(fs.readFileSync(path.join(ROOT, "docs", f), "utf8")));
    expect(bad).toEqual([]);
  });
});
