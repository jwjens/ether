// SINGLE-KEY SHORTCUTS IGNORE CTRL / ALT / META (Jeff, 2026-10-18; src/lib/plainKey.ts).
//
// 1. isPlainKey and the dashboard's mapping (appShortcut): Ctrl+S, Ctrl+A and Ctrl/Alt/Meta + every dashboard shortcut
//    do nothing; the plain keys do what they do today; Shift+/ still opens the sheet.
// 2. STATIC: every keydown handler in src/ that acts on a single key goes through isPlainKey (or appShortcut, which
//    does) BEFORE its first single-key test. A key test on a line that itself requires Ctrl/Meta is a deliberate
//    combination (Ctrl+Z, Ctrl+C…) and is left alone. A handler whose only keys are Escape / Enter / Tab (close a menu,
//    commit a text box) is not a shortcut handler.
//
// Behaviour through real components (the cart wall, KeyboardHelp, macro hotkeys, the fader keys) is in
// src/lib/plainKey.behaviour.test.tsx.
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { isPlainKey } from "./plainKey";
import { appShortcut } from "./appShortcuts";

const MODS = [{ ctrlKey: true }, { altKey: true }, { metaKey: true }, { ctrlKey: true, shiftKey: true }, { ctrlKey: true, altKey: true }];

describe("isPlainKey", () => {
  it("plain and Shift are plain; Ctrl, Alt, Meta (and AltGr = Ctrl+Alt) are not", () => {
    expect(isPlainKey({})).toBe(true);
    expect(isPlainKey({ shiftKey: true } as any)).toBe(true);
    for (const m of MODS) expect(isPlainKey(m)).toBe(false);
  });
});

describe("the dashboard's single-key shortcuts (App.tsx handleKey → appShortcut)", () => {
  const TODAY: [string, string, ReturnType<typeof appShortcut>][] = [
    ["KeyL", "l", "library"], ["KeyS", "s", "clocks"], ["KeyG", "g", "logs"], ["KeyA", "a", "toggleAuto"], ["Escape", "Escape", "close"],
  ];
  it("Ctrl+S does not open Clocks and Ctrl+A does not toggle automation", () => {
    expect(appShortcut({ code: "KeyS", ctrlKey: true })).toBeNull();
    expect(appShortcut({ code: "KeyA", ctrlKey: true })).toBeNull();
  });
  it("Ctrl / Alt / Meta + every dashboard shortcut does nothing", () => {
    for (const [code] of TODAY) for (const m of MODS) expect(appShortcut({ code, ...m }), `${JSON.stringify(m)} ${code}`).toBeNull();
    for (const m of MODS) expect(appShortcut({ code: "Slash", shiftKey: true, ...m })).toBeNull();
  });
  it("the same keys unmodified do what they do today; Shift keeps working", () => {
    for (const [code, , action] of TODAY) expect(appShortcut({ code })).toBe(action);
    expect(appShortcut({ code: "KeyL", shiftKey: true })).toBe("library");
    expect(appShortcut({ code: "Slash", shiftKey: true })).toBe("toggleShortcuts");
    expect(appShortcut({ code: "Slash" })).toBeNull();
  });
  it("App's handler dispatches on appShortcut, and appShortcut checks isPlainKey first", () => {
    const app = fs.readFileSync(path.join(__dirname, "..", "App.tsx"), "utf8");
    const start = app.indexOf("const handleKey = (e: KeyboardEvent)");
    const handler = app.slice(start, app.indexOf('window.addEventListener("keydown", handleKey)', start));
    expect(handler).toMatch(/switch \(appShortcut\(e\)\)/);
    const map = fs.readFileSync(path.join(__dirname, "appShortcuts.ts"), "utf8");
    const body = map.slice(map.indexOf("export function appShortcut"));
    expect(body.indexOf("if (!isPlainKey(e)) return null;")).toBeGreaterThan(0);
    expect(body.indexOf("if (!isPlainKey(e)) return null;")).toBeLessThan(body.indexOf("switch (e.code)"));
  });
});

// ── static: every keydown handler in src/ ───────────────────────────────────────────────────────────────────────

const SRC = path.join(__dirname, "..");

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return files(p);
    return /\.(tsx?)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && !p.includes(`${path.sep}proof${path.sep}`) ? [p] : [];
  });
}

/** Comments and one-line '…' / "…" strings blanked (length kept), so braces inside them do not count. Template
 *  literals are left as they are: their ${} braces balance, and an apostrophe in JSX text must not open one. */
function maskForBraces(s: string): string {
  // strings first: accept="audio/*" must not open a block comment
  return s
    .replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, m => m[0] + " ".repeat(m.length - 2) + m[m.length - 1])
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length));
}

/** The text of the block that opens at the first "{" at or after `from`. */
function blockAt(src: string, masked: string, from: number): string {
  const open = masked.indexOf("{", from);
  if (open < 0) return "";
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === "{") depth++;
    else if (masked[i] === "}") { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  return src.slice(open);
}

interface Handler { where: string; body: string }

function keyHandlers(): Handler[] {
  const out: Handler[] = [];
  for (const f of files(SRC)) {
    const src = fs.readFileSync(f, "utf8").replace(/\r/g, "");
    const masked = maskForBraces(src);
    const rel = path.relative(path.join(SRC, ".."), f).replace(/\\/g, "/");
    const lineOf = (i: number) => src.slice(0, i).split("\n").length;
    // addEventListener("keydown", name) → the nearest definition of `name` above it
    for (const m of src.matchAll(/addEventListener\(\s*["']keydown["']\s*,\s*([A-Za-z_$][\w$]*)/g)) {
      const name = m[1];
      const defs = [...src.slice(0, m.index).matchAll(new RegExp(`(?:const|let)\\s+${name}\\s*=|function\\s+${name}\\s*\\(`, "g"))];
      const d = defs[defs.length - 1];
      expect(d, `${rel}:${lineOf(m.index!)} — cannot find the handler "${name}"`).toBeTruthy();
      const start = d![0].startsWith("function") ? d!.index! : src.indexOf("=>", d!.index!);
      out.push({ where: `${rel}:${lineOf(d!.index!)} (window/element keydown ${name})`, body: blockAt(src, masked, start) });
    }
    // JSX onKeyDown={e => { ... }} inline, and onKeyDown = (...) => { ... } / useCallback definitions
    for (const m of src.matchAll(/onKeyDown=\{\s*(?:async\s*)?\(?\s*\w*\s*(?::[^)]*)?\)?\s*=>/g)) {
      out.push({ where: `${rel}:${lineOf(m.index!)} (JSX onKeyDown)`, body: blockAt(src, masked, m.index! + m[0].length - 2) || src.slice(m.index!, src.indexOf("\n", m.index!)) });
    }
    for (const m of src.matchAll(/const\s+onKeyDown\s*=\s*(?:useCallback\()?\s*\(/g)) {
      out.push({ where: `${rel}:${lineOf(m.index!)} (onKeyDown definition)`, body: blockAt(src, masked, src.indexOf("=>", m.index!)) });
    }
  }
  return out;
}

const KEY_TEST = /(?:\b(?:e|ev|event)\.(?:key|code)|\bkk?\b|\bcode\b)\s*(?:===|==|>=|<=)\s*["'`]([^"'`]+)["'`]|===\s*(?:e|ev)\.(?:key|code)\b|\bswitch\s*\(\s*(?:e|ev)\.(?:key|code)\s*\)/;
const NOT_A_SHORTCUT = new Set(["Escape", "escape", "Enter", "Tab"]);

/** The first line of a handler that tests a single key without a Ctrl/Meta requirement on that same line. */
function firstUnguardedKeyTest(body: string): { line: string; at: number } | null {
  let at = 0;
  for (const line of body.split("\n")) {
    const m = line.match(KEY_TEST);
    if (m) {
      // only the literals a KEY is compared with ("CLEAR" typed into a box is not a key)
      const literals = [...line.matchAll(/(?:\b(?:e|ev|event)\.(?:key|code)|\bkk?\b|\bcode\b)\s*(?:===|==|>=|<=)\s*["'`]([^"'`]+)["'`]/g)].map(x => x[1]);
      const combo = /ctrlKey|metaKey/.test(line) && !/!e\.(ctrlKey|metaKey)/.test(line);
      const dismiss = literals.length > 0 && literals.every(l => NOT_A_SHORTCUT.has(l)) && !/===\s*(?:e|ev)\./.test(line);
      if (!combo && !dismiss) return { line: line.trim(), at };
    }
    at += line.length + 1;
  }
  return null;
}

describe("STATIC — every single-key shortcut handler in src/ goes through isPlainKey", () => {
  const handlers = keyHandlers();
  it("the scan finds the handlers (it is not silently empty)", () => {
    expect(handlers.length).toBeGreaterThan(30);
  });
  it("each handler that tests a single key checks isPlainKey (or routes through appShortcut) before it", () => {
    const bad: string[] = [];
    for (const h of handlers) {
      const first = firstUnguardedKeyTest(h.body);
      if (!first) continue;   // dismiss-only, text-box keys, or Ctrl/Meta combinations only
      const guard = h.body.search(/isPlainKey\(|appShortcut\(/);
      const sameLine = /isPlainKey\(|\bplain\s*&&/.test(first.line);
      if (!sameLine && (guard < 0 || guard > first.at)) bad.push(`${h.where}: "${first.line}"`);
    }
    expect(bad, "single-key handlers with no isPlainKey before their first key test").toEqual([]);
  });
  it("the shortcut handlers found today are all guarded (the list Jeff asked for)", () => {
    const guarded = handlers.filter(h => /isPlainKey\(|appShortcut\(/.test(h.body)).map(h => h.where.split(" ")[0].replace(/:\d+$/, ""));
    for (const f of [
      "src/App.tsx", "src/components/DeckConfigurator.tsx", "src/components/BroadcastEditor.tsx", "src/components/MacroEngine.tsx",
      "src/components/PhoneDesk.tsx", "src/components/ProducerDeskWindow.tsx", "src/components/ReelSplitter.tsx", "src/components/ShowPlus.tsx",
      "src/components/StudioPro.tsx", "src/components/TrackEditor.tsx", "src/components/UserLogin.tsx",
      "src/components/VideoEngine/VideoEngineCanvas.tsx", "src/components/VoiceTracker.tsx", "src/components/KeyboardHelp.tsx",
      "src/components/TakeEditor.tsx", "src/lib/useFaderControl.ts",
    ]) expect(guarded, f).toContain(f);
  });
});
