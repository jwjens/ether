// CARTS OFF THE PA AFTER 4.6.55 (OV, 2026-10-04). d14fec8 pushed every source row's stored kind into the engine at
// boot / daemon connect and on a kind change. Station 2's cart/sweeper channel E is stored as kind "jingle" (the
// board's Sweeper entry), which the engine maps to SlotKind::Sweeper — no aux tap, summed into the programme — so on
// the first 4.6.55 start E left the aux output that feeds the PA. Through 4.6.52 nothing ever sent a kind and every
// source fader ran as SlotKind::Source, on the aux, which is what the station is built around and what Jeff requires:
// "carts announcements jukebox sweepers link they all are just input sources and need to work interchangeably on all
// faders." Reverted; this pins it: the app never re-routes a source fader by its kind.
// main.js / FaderSection.tsx are not importable here; source contracts (CRLF-normalised).
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const read = (p) => fs.readFileSync(path.join(here, p), "utf8").replace(/\r\n/g, "\n");
const main = read("main.js");
const fader = read(path.join("..", "src", "components", "FaderSection.tsx"));

describe("a source fader is never re-routed by its kind", () => {
  it("the boot / daemon-connect fan-out sends no slot kind", () => {
    const fn = /function armAllStationDuckers\(reason, opts\) \{([\s\S]*?)\n\}\n/.exec(main);
    expect(fn).toBeTruthy();
    expect(fn[1]).not.toMatch(/setSlotKind|SetSlotKind/);
  });
  it("changing a fader's kind on the board saves it and sends no slot kind to the engine", () => {
    const h = /const onSetSourceKind = useCallback\(async \(slot: string, kind: SourceKind \| ""\) => \{([\s\S]*?)\n  \}, \[/.exec(fader);
    expect(h).toBeTruthy();
    expect(h[1]).toMatch(/saveDeckConfigs/);
    expect(h[1]).not.toMatch(/setSlotKind/);
  });
  it("nothing in main or the board calls setSlotKind except the (unused) IPC handler itself", () => {
    const calls = (main.match(/setSlotKind/g) || []).length;
    expect(calls).toBe(1);   // ipcMain.handle("audio:set-slot-kind", … audiodClient.cmd("setSlotKind", …))
    expect(/ipcMain\.handle\("audio:set-slot-kind"/.test(main)).toBe(true);
    expect(fader).not.toMatch(/setSlotKind/);
  });
});
