// THE RELEASE CHECK (Jeff, 2026-10-28): "the installer's engine file must be built from the same commit as the app, and
// the build fails if native/ether-audio.node is older than the engine source." engine-source-fp.js + engine-pack.js.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const FP = require("./engine-source-fp");
const { beforePack, afterPack } = require("./engine-pack");
const { Arch } = require("builder-util");
const ROOT = path.join(__dirname, "..");
const NATIVE = path.join(ROOT, "native");
const PE = Buffer.from([0x4d, 0x5a, 0x90, 0x00]);
const engineWith = (fp) => Buffer.concat([PE, Buffer.alloc(64), fp ? Buffer.from(`${FP.MARK}${fp}:END`) : Buffer.alloc(0), Buffer.alloc(64)]);

function tmpNative() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "engine-fp-"));
  fs.mkdirSync(path.join(d, "src", "sub"), { recursive: true });
  fs.writeFileSync(path.join(d, "src", "lib.rs"), "fn a() {}\r\n");
  fs.writeFileSync(path.join(d, "src", "sub", "b.rs"), "fn b() {}\n");
  fs.writeFileSync(path.join(d, "cargo.toml"), "[package]\n");
  fs.writeFileSync(path.join(d, "Cargo.lock"), "lock\n");
  fs.writeFileSync(path.join(d, "build.rs"), "fn main() {}\n");
  return d;
}

describe("the engine source fingerprint", () => {
  it("THE COMMITTED ENGINE (native/ether-audio.node) is built from the engine source in this tree", () => {
    // Fails when the engine source changes and the engine file is not rebuilt — the file is older than the source.
    expect(FP.binaryFingerprint(path.join(NATIVE, "ether-audio.node")), "rebuild native/ether-audio.node from this source").toBe(FP.sourceFingerprint(NATIVE));
  });
  it("changes when any engine source file changes, and not for line endings", () => {
    const d = tmpNative();
    const a = FP.sourceFingerprint(d);
    fs.writeFileSync(path.join(d, "src", "lib.rs"), "fn a() {}\n");
    expect(FP.sourceFingerprint(d)).toBe(a);                       // \r\n vs \n: same source
    fs.writeFileSync(path.join(d, "src", "sub", "b.rs"), "fn b() { 1; }\n");
    expect(FP.sourceFingerprint(d)).not.toBe(a);
    const b = FP.sourceFingerprint(d);
    fs.writeFileSync(path.join(d, "Cargo.lock"), "lock 2\n");
    expect(FP.sourceFingerprint(d)).not.toBe(b);
  });
  it("reads the mark from a binary, and says none when there is none", () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "engine-fp-")), "e.node");
    fs.writeFileSync(f, engineWith("0123456789abcdef"));
    expect(FP.binaryFingerprint(f)).toBe("0123456789abcdef");
    fs.writeFileSync(f, engineWith(null));
    expect(FP.binaryFingerprint(f)).toBeNull();
  });
});

describe("the build fails on an engine file that is not built from the source being packaged", () => {
  function packed(engine) {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "engine-fp-pack-"));
    const native = path.join(out, "resources", "app.asar.unpacked", "native");
    fs.mkdirSync(native, { recursive: true });
    fs.writeFileSync(path.join(native, "ether-audio.node"), engine);
    return { electronPlatformName: "win32", arch: Arch.x64, appOutDir: out, packager: { appInfo: { productFilename: "Ether" } } };
  }
  it("afterPack: an engine from older source fails", async () => {
    await expect(afterPack(packed(engineWith("0000000000000000")))).rejects.toThrow(/NOT built from the engine source being packaged/);
  });
  it("afterPack: an engine with no fingerprint (built before the check) fails", async () => {
    await expect(afterPack(packed(engineWith(null)))).rejects.toThrow(/carries no source fingerprint/);
  });
  it("beforePack (Windows) checks native/ether-audio.node before anything is packed", () => {
    const src = fs.readFileSync(path.join(__dirname, "engine-pack.js"), "utf8");
    expect(src).toMatch(/assertEngineMatchesSource\(ENGINE, path\.join\(ROOT, "native"\), "native\/ether-audio\.node"\)/);
    expect(typeof beforePack).toBe("function");
  });
});
