// The engine ships every app file it loads (2026-10-27, 4.6.66: engine.js required ../electron/catalogue, which was never
// unpacked or staged — every song read as unplayable and the queue never filled on OV). audiod/engine-fingerprint.js
// daemonAppFiles, audiod/stage-engine.js stagePlan, electron-builder.json. docs/engine-missing-catalogue-4.6.66-2026-10-27.md
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
const FP = require("./engine-fingerprint");

const ROOT = path.join(__dirname, "..");
const builder = JSON.parse(fs.readFileSync(path.join(ROOT, "electron-builder.json"), "utf8"));
const appFiles = FP.daemonAppFiles(__dirname);
// electron-builder glob → RegExp (only the forms this config uses: **, *, literal paths).
const globRe = (g) => new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\/?/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*") + "$");
const matchesAny = (rel, globs) => globs.some(g => !g.startsWith("!") && globRe(g).test(rel));
const excluded = (rel, globs) => globs.some(g => g.startsWith("!") && globRe(g.slice(1).replace(/^\*\*\//, "**/")).test(rel));

describe("every file the engine loads, transitively", () => {
  it("is derived from the requires — the catalogue and the asset-delete chain included", () => {
    for (const f of ["electron/catalogue.js", "electron/audio-library-index.js", "electron/sync/mutation-writer.js",
      "electron/sync/synced-tables.js", "electron/sync/handlers/asset-mirror.js", "electron/sync/handlers/library_asset.js",
      "electron/asset-types.js", "shared/asset-types.json", "electron/profile-paths.js"]) expect(appFiles).toContain(f);
    for (const f of appFiles) expect(fs.existsSync(path.join(ROOT, f)), `${f} is required by the engine but not in the tree`).toBe(true);
  });
  it("is packaged and unpacked (the staged engine runs as plain Node and cannot read inside app.asar)", () => {
    for (const f of appFiles) {
      expect(matchesAny(f, builder.files) && !excluded(f, builder.files), `${f} is not in electron-builder.json "files"`).toBe(true);
      expect(matchesAny(f, builder.asarUnpack), `${f} is not in electron-builder.json "asarUnpack"`).toBe(true);
    }
  });
  it("is in the stage plan, from the install's app.asar.unpacked", () => {
    const src = fs.readFileSync(path.join(__dirname, "stage-engine.js"), "utf8");
    expect(src).toMatch(/for \(const rel of FP\.daemonAppFiles\(audiod\)\) plan\.push\(/);
  });
  it("and in the engine fingerprint, so a changed file re-stages", () => {
    const src = fs.readFileSync(path.join(__dirname, "engine-fingerprint.js"), "utf8");
    expect(src).toMatch(/for \(const rel of daemonAppFiles\(audiod\)\) lines\.push\(/);
  });
  it("a comment is not a require, and node_modules / native / audiod files are not listed here", () => {
    expect(appFiles.every(f => /^(electron|shared)\//.test(f))).toBe(true);
  });
});
