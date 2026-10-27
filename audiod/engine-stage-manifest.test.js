// Every relative require in the engine is in the engine's stage manifest (Jeff, 2026-10-27: "A test that fails on 4.6.66:
// every relative require in the engine must be in the engine stage manifest.").
//
// End to end, against a source tree: lay out an install's app.asar.unpacked the way electron-builder does (this tree's own
// electron-builder.json "asarUnpack" and "files"), run that tree's REAL audiod/stage-engine.js into a temp dir, read the
// stage-manifest.json it wrote, and check it against the requires — found here by an independent walk (not the
// derivation under test): every relative require from the daemon's entry point, transitively, string literals and
// path.join(__dirname, …) alike.
//
// ETHER_ENGINE_TREE=<a checkout> runs it against another tree. On 4.6.66 (f901541) it fails: electron/catalogue.js (and
// the asset-delete chain) are required but not staged.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const TREE = process.env.ETHER_ENGINE_TREE ? path.resolve(process.env.ETHER_ENGINE_TREE) : path.join(__dirname, "..");
const builder = JSON.parse(fs.readFileSync(path.join(TREE, "electron-builder.json"), "utf8"));
const globRe = (g) => new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\/?/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*") + "$");
const inc = (rel, globs) => globs.some(g => !g.startsWith("!") && globRe(g).test(rel));
const exc = (rel, globs) => globs.some(g => g.startsWith("!") && (globRe(g.slice(1)).test(rel) || globRe("**/" + g.slice(1).replace(/^\*\*\//, "")).test(rel)));
const packaged = (rel) => inc(rel, builder.files) && !exc(rel, builder.files);
const unpackedByBuilder = (rel) => packaged(rel) && inc(rel, builder.asarUnpack);

// The independent walk: relative requires from audiod/ether-audiod.js, transitively, within the tree.
function requiredFiles() {
  const RE = /require\(\s*(?:["'](\.{1,2}\/[^"']+)["']|path\.join\(\s*__dirname\s*((?:\s*,\s*["'][^"']+["'])+)\s*\))\s*\)/g;
  const seen = new Set(), q = ["audiod/ether-audiod.js"];
  while (q.length) {
    const rel = q.shift(); if (seen.has(rel)) continue; seen.add(rel);
    if (!/\.js$/.test(rel)) continue;
    let src; try { src = fs.readFileSync(path.join(TREE, rel), "utf8"); } catch { continue; }
    for (const m of src.matchAll(RE)) {
      const r = m[1] || "./" + [...m[2].matchAll(/["']([^"']+)["']/g)].map(x => x[1]).join("/");
      let t = path.posix.normalize(path.posix.join(path.posix.dirname(rel), r));
      if (!/\.(js|json|node)$/.test(t)) t += ".js";
      if (t.startsWith("..") || t.includes("node_modules/") || /[<>]/.test(t)) continue;
      q.push(t);
    }
  }
  return [...seen].sort();
}

let tmp, manifest, required;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ether-stage-manifest-"));
  const srcRoot = path.join(tmp, "install"), unpacked = path.join(srcRoot, "resources", "app.asar.unpacked");
  fs.mkdirSync(unpacked, { recursive: true });
  fs.writeFileSync(path.join(srcRoot, "Ether.exe"), "runtime");
  // Lay out app.asar.unpacked as electron-builder would from this tree (node_modules left out: ffmpeg is optional to the stage).
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(TREE, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!["node_modules", ".git", "target", "dist", "dist-electron", "docs", "src"].includes(e.name)) walk(rel); }
      else if (unpackedByBuilder(rel)) { const d = path.join(unpacked, rel); fs.mkdirSync(path.dirname(d), { recursive: true }); fs.copyFileSync(path.join(TREE, rel), d); }
    }
  };
  for (const top of ["audiod", "electron", "shared", "native", "watchdog"]) if (fs.existsSync(path.join(TREE, top))) walk(top);
  const { stageEngine } = require_(path.join(TREE, "audiod", "stage-engine.js"));
  const stage = path.join(tmp, "engine");
  stageEngine({ srcRoot, unpacked, version: "test", baseDir: stage, platform: "win32" });
  try { manifest = JSON.parse(fs.readFileSync(path.join(stage, "stage-manifest.json"), "utf8")); } catch { manifest = null; }
  required = requiredFiles();
});
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

describe(`the engine stage manifest (${path.basename(TREE)})`, () => {
  it("staging succeeded and wrote a manifest", () => { expect(manifest && manifest.dst).toBeTruthy(); });
  it("the walk finds the engine's requires (sanity: the catalogue rule's file is among them on a tree that has it)", () => {
    expect(required).toContain("audiod/engine.js");
    expect(required.length).toBeGreaterThan(10);
  });
  it("every relative require in the engine is in the stage manifest", () => {
    const staged = new Set(Object.keys((manifest && manifest.dst) || {}).map(k => k.split(path.sep).join("/")));
    const missing = required.filter(r => !staged.has(r));
    expect(missing, `required by the engine but NOT staged: ${missing.join(", ")}`).toEqual([]);
  });
});
