// Every "are you sure?" uses Ether's own confirm window, which works in the installed app (Jeff, 2026-10-30). The
// browser's window.confirm silently does nothing in the packaged build, so no desktop code may call it.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { etherConfirm, etherConfirmController } from "./etherConfirm";

const SRC = join(__dirname, "..");
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.(tsx?|jsx?)$/.test(n) && !/\.test\./.test(n) ? [p] : [];
  });
}

describe("Ether's confirm window", () => {
  it("answers true only on confirm, false on cancel", async () => {
    const yes = etherConfirm("Delete A?", { danger: true });
    expect(etherConfirmController.pending()).toMatchObject({ message: "Delete A?", danger: true });
    etherConfirmController.answer(true);
    expect(await yes).toBe(true);
    const no = etherConfirm("Delete B?");
    etherConfirmController.answer(false);
    expect(await no).toBe(false);
  });
  it("is mounted at every window's root", () => {
    expect(readFileSync(join(SRC, "main.tsx"), "utf8")).toMatch(/<EtherConfirmHost \/>/);
  });
  it("no desktop code calls the browser's confirm()", () => {
    const offenders: string[] = [];
    for (const f of files(SRC)) {
      readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, "");
        if (/^\s*\*/.test(line)) return;
        if (/(?<![A-Za-z0-9_.$])(window\.)?confirm\(/.test(code)) offenders.push(`${f}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
