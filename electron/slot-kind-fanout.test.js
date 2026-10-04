// SLOT KIND REACHES THE ENGINE (2026-10-04). Nothing in the app ever called setSlotKind, so a fader dialled to
// Sweeper ran in the engine as a Source — on the aux bus, not summed (and ducked) with the music — and a restarted
// daemon started every source fader as Source regardless of the board. Two halves:
//   1. the board's kind change pushes setSlotKind, the same shape as its duck toggle pushes setDuck;
//   2. the boot/daemon-connect fan-out (armAllStationDuckers) pushes every source row's stored kind, BEFORE its duck
//      flag — a Sweeper must never arm the ducker, and the engine decides that from the kind.
// main.js and FaderSection.tsx are not importable here; pinned as source contracts (CRLF-normalised).
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const read = (p) => fs.readFileSync(path.join(here, p), "utf8").replace(/\r\n/g, "\n");
const main = read("main.js");
const fader = read(path.join("..", "src", "components", "FaderSection.tsx"));

describe("slot kind reaches the engine", () => {
  it("the board's kind change pushes setSlotKind after saving", () => {
    const h = /const onSetSourceKind = useCallback\(async \(slot: string, kind: SourceKind \| ""\) => \{([\s\S]*?)\n  \}, \[/.exec(fader);
    expect(h).toBeTruthy();
    expect(h[1]).toMatch(/ether\?\.audio\?\.setSlotKind\?\.\(stationId, slot, kind\)/);
    expect(h[1].indexOf("saveDeckConfigs")).toBeLessThan(h[1].indexOf("setSlotKind"));
  });

  it("the fan-out reads each row's kind and pushes it for source rows, before the duck flag", () => {
    const fn = /function armAllStationDuckers\(reason, opts\) \{([\s\S]*?)\n\}\n/.exec(main);
    expect(fn).toBeTruthy();
    const body = fn[1];
    expect(body).toMatch(/COALESCE\(kind,''\) AS kind/);
    expect(body).toMatch(/audiodClient\.cmd\('setSlotKind', \{ stationId: r\.station_id, deck: r\.slot, kind: r\.kind \}\)\.catch\(/);
    expect(body).toMatch(/audio\.audioSetSlotKind\(r\.station_id, r\.slot, String\(r\.kind\)\)/);
    expect(body.indexOf("setSlotKind")).toBeLessThan(body.indexOf("'setDuck'"));
  });
});
