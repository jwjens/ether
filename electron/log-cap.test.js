// The startup log can't grow past a set size (Jeff, 2026-10-23). electron/log-cap.js.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
const { createCappedLog } = require("./log-cap");

let dir, file;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "logcap-")); file = path.join(dir, "ether-startup.log"); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const line = (i) => `line ${String(i).padStart(6, "0")} ${"x".repeat(40)}\n`;   // 53 bytes

describe("createCappedLog", () => {
  it("never lets the file and its previous pass twice the cap", () => {
    const log = createCappedLog(file, { capBytes: 1000 });
    for (let i = 0; i < 500; i++) log.append(line(i));
    expect(fs.statSync(file).size).toBeLessThanOrEqual(1000 + 53);
    expect(fs.statSync(file + ".1").size).toBeLessThanOrEqual(1000 + 53);
    expect(fs.readFileSync(file, "utf8")).toContain(line(499));     // the newest line is kept
  });

  it("an oversized file from an older build is cut to its newest part at the first write", () => {
    fs.writeFileSync(file, Array.from({ length: 2000 }, (_, i) => line(i)).join(""));   // ~106 KB
    const log = createCappedLog(file, { capBytes: 1000 });
    log.append("new session\n");
    expect(fs.readFileSync(file, "utf8")).toBe("new session\n");
    const prev = fs.readFileSync(file + ".1", "utf8");
    expect(prev.length).toBe(1000);
    expect(prev.endsWith(line(1999))).toBe(true);                     // the old file's last lines survive
  });

  it("under the cap nothing rotates", () => {
    const log = createCappedLog(file, { capBytes: 10_000 });
    for (let i = 0; i < 10; i++) log.append(line(i));
    expect(fs.existsSync(file + ".1")).toBe(false);
    expect(fs.statSync(file).size).toBe(530);
  });
});
