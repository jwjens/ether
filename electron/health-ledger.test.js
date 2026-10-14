// The one health log writer (2026-10-13, ovowforestmusic: two unrotated files, 415 MB + 375 MB, written with
// appendFileSync on main). One file, written in the background, rotated by size, the old copies archived then deleted
// after their days. docs/air-machine-stalls-plan-2026-10-13.md §3.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const { createLedger } = require_("./health-ledger.js");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ledger-"));
const lines = (p) => fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

describe("health ledger", () => {
  it("append() does not touch the disk on the caller's turn; the line lands in the background", async () => {
    const d = tmp();
    const L = createLedger({ dir: () => d, settings: () => ({ maxMb: 50, keep: 5, archiveDays: 30 }) });
    L.append({ kind: "a", n: 1 });
    expect(fs.existsSync(path.join(d, "health-events.jsonl"))).toBe(false);   // nothing written synchronously
    await L.flush();
    expect(lines(path.join(d, "health-events.jsonl"))).toEqual([{ kind: "a", n: 1 }]);
  });

  it("rotates by size and keeps only N old files", async () => {
    const d = tmp();
    const maxMb = 1 / 1024;   // 1 KB
    const L = createLedger({ dir: () => d, settings: () => ({ maxMb, keep: 2, archiveDays: 30 }) });
    for (let i = 0; i < 40; i++) { L.append({ kind: "x", i, pad: "p".repeat(100) }); await L.flush(); }
    const names = fs.readdirSync(d).sort();
    expect(names).toEqual(["health-events.1.jsonl", "health-events.2.jsonl", "health-events.jsonl"]);
    for (const n of names) expect(fs.statSync(path.join(d, n)).size).toBeLessThanOrEqual(1024 + 200);
    // the newest line is in the live file
    expect(lines(path.join(d, "health-events.jsonl")).pop().i).toBe(39);
  });

  it("first pass: the old logs\\ copy and an over-size file become archives (not deleted); archives past their days go", async () => {
    const d = tmp();
    fs.mkdirSync(path.join(d, "logs"));
    fs.writeFileSync(path.join(d, "logs", "health-events.jsonl"), "{\"old\":1}\n");
    fs.writeFileSync(path.join(d, "health-events.jsonl"), "x".repeat(3000));
    const stale = path.join(d, "health-events.archive-20200101-000000.jsonl");
    fs.writeFileSync(stale, "{}\n");
    const old = new Date(Date.now() - 40 * 86400000); fs.utimesSync(stale, old, old);
    const L = createLedger({ dir: () => d, settings: () => ({ maxMb: 1 / 1024, keep: 5, archiveDays: 30 }) });
    L.append({ kind: "new" });
    await L.flush();
    expect(fs.existsSync(path.join(d, "logs", "health-events.jsonl"))).toBe(false);          // no second copy
    expect(fs.readdirSync(path.join(d, "logs")).some((n) => n.startsWith("health-events.archive-"))).toBe(true);
    const arch = fs.readdirSync(d).filter((n) => n.startsWith("health-events.archive-"));
    expect(arch.length).toBe(1);                                                                // the big one, kept
    expect(fs.statSync(path.join(d, arch[0])).size).toBe(3000);
    expect(fs.existsSync(stale)).toBe(false);                                                   // 40 days > 30 → deleted
    expect(lines(path.join(d, "health-events.jsonl"))).toEqual([{ kind: "new" }]);
  });

  it("no settings yet → never rotates or deletes on a guessed number", async () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, "health-events.jsonl"), "x".repeat(5000) + "\n");
    const L = createLedger({ dir: () => d, settings: () => ({ maxMb: null, keep: null, archiveDays: null }) });
    L.append({ kind: "k" }); await L.flush();
    expect(fs.readdirSync(d)).toEqual(["health-events.jsonl"]);
  });

  it("a full queue drops lines and then says how many", async () => {
    const d = tmp();
    let block;
    const gate = new Promise((r) => { block = r; });
    const fsp = { ...fs.promises, appendFile: async (...a) => { await gate; return fs.promises.appendFile(...a); } };
    const L = createLedger({ dir: () => d, settings: () => ({ maxMb: 50, keep: 5, archiveDays: 30 }), fsp });
    for (let i = 0; i < 6000; i++) L.append({ i });
    block();
    await L.flush();
    const all = lines(path.join(d, "health-events.jsonl"));
    const note = all.find((l) => l.kind === "health-log-dropped");
    expect(note).toBeTruthy();
    expect(all.length - 1 + note.lines).toBe(6000);
  });
});
