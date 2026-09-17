// A play the engine REFUSED must reach the Health Monitor (2026-09-16). Until this, main.js routed
// engine `error` events only when `where === "play-skip"`; a `where: "resume-playout"` refusal fell
// through the handler and vanished — the operator's only trace was a line in the daemon log.
// Receipts: docs/ovevents-crash-loop-alarm-2026-09-15.md §5 addendum / §6.
//
// Two halves, both main-side:
//   1. the health monitor's `noteRefusal` sense — per-station RED with a named reason, a snapshot field
//      carrying deck/title/file/time, and a ledger line in health-events.jsonl;
//   2. the route in main.js — the daemon event handler must hand a where:"resume-playout" error to it.
//      main.js cannot be loaded outside Electron, so the route is pinned as a source contract.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const { createHealthMonitor } = require_("./audio-health.js");

function monitor() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ether-health-refusal-"));
  const h = createHealthMonitor({
    logDir: dir,
    stationName: (id) => (id === 2 ? "halloVeen" : ""),
    uuidOf: (id) => `uuid-${id}`,
  });
  return { h, dir };
}

describe("audio-health: a refused play is a sense, not a log line", () => {
  it("noteRefusal → station RED with a named reason, lastRefusal in the snapshot, a ledger line", () => {
    const { h, dir } = monitor();
    h.noteRefusal(2, { where: "resume-playout", kind: "refused", deck: "B", title: "I'm In Love With a Monster", filePath: "", error: "play refused — deck B has no loaded source" });
    const snap = h.getSnapshot();
    const s = snap.stations.find(x => x.stationId === 2);
    expect(s).toBeTruthy();
    expect(s.lastRefusal).toMatchObject({ deck: "B", title: "I'm In Love With a Monster", kind: "refused" });
    expect(typeof s.lastRefusal.at).toBe("string");
    // The ledger names it with station, deck, title and time.
    const lines = fs.readFileSync(path.join(dir, "health-events.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l));
    const ev = lines.find(l => l.type === "play-refused");
    expect(ev).toMatchObject({ type: "play-refused", stationId: 2, stationName: "halloVeen", deck: "B", title: "I'm In Love With a Monster", kind: "refused" });
    expect(ev.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("an unplayable row skipped in recovery is the same sense with kind 'unplayable'", () => {
    const { h } = monitor();
    h.noteRefusal(2, { where: "resume-playout", kind: "unplayable", deck: "A", title: "Missing Song", filePath: "C:\\gone.mp3", error: "skipped unplayable: C:\\gone.mp3" });
    const s = h.getSnapshot().stations.find(x => x.stationId === 2);
    expect(s.lastRefusal).toMatchObject({ deck: "A", title: "Missing Song", filePath: "C:\\gone.mp3", kind: "unplayable" });
  });

  it("main.js routes where:'resume-playout' engine errors to noteRefusal (source contract — main.js only loads under Electron)", () => {
    const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "main.js"), "utf8");
    const route = /m\.event === "error" && m\.where === "resume-playout"[\s\S]{0,600}?_health\.noteRefusal\(m\.stationId, m\)/;
    expect(route.test(src)).toBe(true);
    // And the loadskip route now carries deck + file to library-health.
    expect(/_libHealth\.noteSkip\(m\.stationId, m\.title, m\.reason, \{ deck: m\.deck, filePath: m\.filePath \}\)/.test(src)).toBe(true);
  });
});
